"""Single authenticated origin for shared APIs, frontend and native media."""
from __future__ import annotations

import re
import socket

from fastapi import BackgroundTasks, Body, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

from .auth import DesktopAuth
from .config import read_config, patch_config
from .preferences import read_preferences, patch_preferences


def create_desktop_app(init: dict, paths, protocol, lease, port: int):
    from ..app_factory import create_app
    from ..runtime_profile import RuntimeProfile
    from .native_actions import router

    app = create_app(RuntimeProfile.DESKTOP_CORE, dataset_lease=lease)
    app.state.dataset_lease = lease
    app.state.parent_protocol = protocol
    app.state.desktop_paths = paths
    app.include_router(router)

    @app.get("/api/desktop/health", include_in_schema=False)
    def desktop_health():
        return {"status": "ok", "launch_id": init["launch_id"], "protocol_version": 1}

    @app.get("/api/desktop/preferences")
    def preferences():
        return read_preferences(paths.app_data)

    @app.patch("/api/desktop/preferences")
    def update_preferences(patch: dict = Body(...)):
        try:
            return patch_preferences(paths.app_data, patch)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/api/desktop/config")
    def config():
        value = read_config(paths.app_data)
        return {key: value[key] for key in ("version", "revision", "library_roots")}

    @app.patch("/api/desktop/config")
    def update_config(tasks: BackgroundTasks, patch: dict = Body(...)):
        try:
            value = patch_config(paths.app_data, patch)
        except (ValueError, OSError, RuntimeError) as exc:
            raise HTTPException(422, str(exc)) from exc
        tasks.add_task(protocol.notify, "restart_for_config", {"revision": value["revision"]})
        return {key: value[key] for key in ("version", "revision", "library_roots")}

    # Imported after the shared runtime and its paths have been established.
    from .exchange_control import install_exchange_routes
    install_exchange_routes(app, paths, protocol, lease)

    @app.get("/{asset_path:path}", include_in_schema=False)
    def frontend(asset_path: str, request: Request):
        if asset_path == "api" or asset_path.startswith("api/"):
            return JSONResponse(status_code=404, content={"detail": "Δεν βρέθηκε"})
        candidate = (paths.frontend / asset_path).resolve()
        root = paths.frontend.resolve()
        if not candidate.is_relative_to(root):
            raise HTTPException(404, "Δεν βρέθηκε")
        if candidate.is_file() and candidate.name != "index.html":
            return FileResponse(candidate)
        if "." in asset_path.rsplit("/", 1)[-1] and not asset_path.endswith("index.html"):
            raise HTTPException(404, "Δεν βρέθηκε")
        index = root / "index.html"
        if not index.is_file():
            raise HTTPException(503, "Λείπει η ενσωματωμένη διεπαφή της εφαρμογής.")
        html = index.read_text(encoding="utf-8")
        theme = read_preferences(paths.app_data).get("cratemind-theme", "dark")
        theme = theme if theme in {"light", "dark"} else "dark"
        # Match both data attribute and class before the first CSS paint.
        def themed_root(match):
            attributes = re.sub(r'\s(?:class|data-theme|data-desktop)="[^"]*"', "", match.group(1))
            return f'<html{attributes} class="{theme}" data-desktop="true" data-theme="{theme}">'
        html = re.sub(r"<html\b([^>]*)>", themed_root, html, count=1)
        return HTMLResponse(html)

    return DesktopAuth(app, port=port, launch_id=init["launch_id"], secret=init["session_secret"],
                       diagnostics=(paths.app_data / ".cratemind-qa-fixture").is_file())


def bind_loopback() -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    sock.listen(128)
    return sock
