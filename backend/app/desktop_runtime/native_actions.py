"""Small authenticated HTTP bridge to fixed native actions; no generic shell."""
from __future__ import annotations

from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/desktop")


class NativeAction(BaseModel):
    action: str
    arguments: dict = Field(default_factory=dict)


@router.post("/native-actions")
def native_action(req: NativeAction, request: Request):
    arguments = req.arguments
    if req.action in {"pick_library_roots", "pick_export_dir"}:
        if arguments:
            raise HTTPException(422, "Μη έγκυρες παράμετροι επιλογής φακέλου.")
    elif req.action == "open_external":
        url = arguments.get("url", "")
        if set(arguments) != {"url"} or not isinstance(url, str) or len(url) > 4096:
            raise HTTPException(422, "Μη έγκυρος σύνδεσμος.")
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise HTTPException(422, "Επιτρέπονται μόνο σύνδεσμοι http/https.")
    elif req.action == "reveal_path" and set(arguments) == {"recording"}:
        # A set recording, by its file name in the export folder; never a path from the renderer.
        from ..config import get_settings
        name = arguments["recording"]
        from ..services.recorder import RECORDING_NAME
        if type(name) is not str or not RECORDING_NAME.fullmatch(name):
            raise HTTPException(422, "Μη έγκυρο όνομα εγγραφής.")
        path = get_settings().output_path.resolve() / name
        if path.is_symlink() or not path.is_file():
            raise HTTPException(404, "Δεν βρέθηκε το αρχείο της εγγραφής.")
        arguments = {"path": str(path)}
    elif req.action == "reveal_path":
        # The renderer identifies a library asset; it cannot supply an OS path.
        if set(arguments) != {"track_id"} or type(arguments["track_id"]) is not int:
            raise HTTPException(422, "Απαιτείται αναγνωριστικό κομματιού.")
        from sqlmodel import Session
        from ..db import get_engine
        from ..models import Track
        from ..services.library_paths import resolve_source_path
        with Session(get_engine()) as session:
            track = session.get(Track, arguments["track_id"])
            if track is None:
                raise HTTPException(404, "Δεν βρέθηκε το κομμάτι.")
            try:
                path = resolve_source_path(track.absolute_path)
                if not path.is_file():
                    raise OSError("missing")
            except OSError as exc:
                raise HTTPException(409, "Ο φάκελος του κομματιού δεν είναι διαθέσιμος.") from exc
        arguments = {"path": str(Path(path).resolve())}
    elif req.action in {"master_host_scan", "master_host_stop", "master_host_editor"}:
        if arguments:
            raise HTTPException(422, "Μη έγκυρες παράμετροι plugin.")
    elif req.action == "master_host_start":
        # The native shell re-validates the path against the two VST3 folders before loading anything.
        path, rate = arguments.get("path"), arguments.get("sample_rate")
        if (set(arguments) != {"path", "sample_rate"} or type(path) is not str or not 0 < len(path) <= 4096
                or not path.lower().endswith(".vst3") or type(rate) is not int or not 8000 <= rate <= 384000):
            raise HTTPException(422, "Μη έγκυρες παράμετροι plugin.")
    else:
        raise HTTPException(422, "Μη διαθέσιμη ενέργεια εφαρμογής.")
    try:
        return request.app.state.parent_protocol.request(req.action, arguments)
    except (ValueError, TimeoutError) as exc:
        raise HTTPException(503, str(exc)) from exc
