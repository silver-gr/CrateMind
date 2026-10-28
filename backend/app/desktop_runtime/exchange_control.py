"""Complete handoff HTTP adapter. Python remains the sole dataset owner."""
from __future__ import annotations

import tempfile
import time
from pathlib import Path
from typing import Literal

from fastapi import BackgroundTasks, Body, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from ..library_exchange.operations import export_exchange, prepare_import, load_import_preview
from ..services.dataset_access import maintenance_coordinator
from .preferences import atomic_json


class ExchangeCommit(BaseModel):
    preview_id: str
    decision: Literal["import", "replace"] = "import"
    local_digest: str | None = None


def install_exchange_routes(app, paths, protocol, lease):
    prepared: dict[str, tuple[float, str]] = {}

    @app.post("/api/exchange/export")
    def export_library(body: dict = Body(default={})):
        if set(body) - {"choose_destination"}:
            raise HTTPException(422, "Μη έγκυρες παράμετροι export.")
        directory = paths.app_data / "exports"
        if body.get("choose_destination"):
            if protocol is None:
                raise HTTPException(422, "Η επιλογή φακέλου είναι διαθέσιμη στην desktop εφαρμογή.")
            selected = protocol.request("pick_export_dir", {})
            if selected["canceled"]:
                return {"canceled": True}
            directory = Path(selected["value"]).resolve(strict=True)
        from ..config import get_settings
        for root in get_settings().roots:
            if directory.is_relative_to(root.resolve()) or root.resolve().is_relative_to(directory):
                raise HTTPException(422, "Ο φάκελος export πρέπει να είναι εκτός της μουσικής βιβλιοθήκης.")
        output = directory / ("CrateMind-" + time.strftime("%Y%m%d-%H%M%S") + ".cmexchange")
        if output.exists() or output.is_symlink():
            raise HTTPException(409, "Το αρχείο υπάρχει ήδη. Δοκίμασε ξανά σε λίγο.")
        try:
            return export_exchange(paths.app_data, output, lease=lease).to_dict()
        except (ValueError, OSError, RuntimeError) as exc:
            return JSONResponse(status_code=409, content={"detail": str(exc), "code": "exchange_failed"})

    @app.post("/api/exchange/inspect")
    def inspect_library(file: UploadFile):
        try:
            with tempfile.TemporaryDirectory(prefix=".upload-", dir=paths.app_data / "exchange") as temporary:
                archive = Path(temporary) / "incoming.cmexchange"
                size = 0
                with archive.open("xb") as output:
                    while chunk := file.file.read(1024 * 1024):
                        size += len(chunk)
                        if size > 2 * 1024**3:
                            raise ValueError("Το αρχείο ανταλλαγής υπερβαίνει το όριο των 2 GiB.")
                        output.write(chunk)
                preview = prepare_import(archive, paths.app_data, lease=lease)
            expires = int(time.time()) + 600
            decision = "replace" if preview.conflict else "import"
            prepared[preview.preview_id] = (expires, decision)
            atomic_json(paths.app_data / "exchange/previews" / preview.preview_id / "desktop.json",
                        {"expires_at_unix": expires, "decision": decision, "local_digest": preview.local_digest})
            if protocol is not None:
                protocol.emit("EXCHANGE_PREPARED", preview_id=preview.preview_id,
                              digest=preview.archive_digest, decision=decision,
                              expires_at_unix=expires, local_digest=preview.local_digest)
            return preview.to_dict() | {"expires_at_unix": expires}
        except (ValueError, OSError, RuntimeError) as exc:
            return JSONResponse(status_code=409, content={"detail": str(exc), "code": "exchange_invalid"})
        finally:
            file.file.close()

    if protocol is None:
        return  # source web runner imports only while stopped, using the shared CLI

    @app.post("/api/desktop/exchange/commit", status_code=202)
    def commit_library(req: ExchangeCommit, tasks: BackgroundTasks):
        allowed = prepared.get(req.preview_id)
        if allowed is None or allowed[0] <= time.time() or allowed[1] != req.decision:
            raise HTTPException(409, "Η προεπισκόπηση έληξε. Επίλεξε ξανά το αρχείο.")
        preview = load_import_preview(paths.app_data, req.preview_id)
        if req.decision == "replace" and req.local_digest != preview.local_digest:
            raise HTTPException(409, "Η επιβεβαίωση δεν αντιστοιχεί στην τρέχουσα βιβλιοθήκη.")
        guard = None
        try:
            # Admission stays closed from fresh preview through service exit.
            guard = maintenance_coordinator.enter_maintenance(timeout_s=1)
            fresh = prepare_import(preview.archive_path, paths.app_data, lease=lease)
            if fresh.local_digest != preview.local_digest or fresh.local_generation != preview.local_generation:
                raise ValueError("Η βιβλιοθήκη άλλαξε. Απαιτείται νέα προεπισκόπηση.")
        except (ValueError, OSError, RuntimeError) as exc:
            if guard is not None:
                guard.release()
            return JSONResponse(status_code=409, content={"detail": str(exc), "code": "exchange_stale"})
        app.state.exchange_guard = guard
        prepared.pop(req.preview_id)
        # Starlette sends the complete response before running this callback.
        tasks.add_task(protocol.notify, "apply_exchange", {
            "preview_id": req.preview_id, "decision": req.decision, "local_digest": req.local_digest,
        })
        return {"accepted": True, "preview_id": req.preview_id}
