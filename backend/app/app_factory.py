"""Application construction. Importing this module does not open a database."""
from __future__ import annotations

import os
import sys
import time
from contextlib import ExitStack, asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .runtime_profile import DEFERRED_ROUTES, RuntimeProfile, runtime_profile


def unavailable():
    return JSONResponse(status_code=501, content={
        "detail": "Αυτή η λειτουργία είναι διαθέσιμη στη web εφαρμογή. Τα αποθηκευμένα αποτελέσματα παραμένουν διαθέσιμα εδώ.",
        "code": "web_workflow_required",
    })


@asynccontextmanager
async def lifespan(app: FastAPI):
    from .config import get_settings
    from .db import backup_on_launch, get_engine, init_db, launch_phase, migrate_fts_index
    from .jobs.worker import recover_orphan_jobs
    from .services.dataset_access import DatasetLease
    from sqlmodel import Session

    with ExitStack() as stack:
        if getattr(app.state, "owns_dataset_lease", False):
            from .services.dataset_access import maintenance_coordinator
            def release_when_idle():
                # A daemon job can outlive ASGI shutdown. Keep OS ownership
                # until it finishes or the process exits, never expose its pair.
                if not maintenance_coordinator.active_operations:
                    app.state.dataset_lease.release()
                else:
                    import threading
                    def drain():
                        from .services.dataset_access import MaintenanceBusyError
                        while True:
                            try:
                                with maintenance_coordinator.enter_maintenance(timeout_s=5):
                                    app.state.dataset_lease.release()
                                return
                            except MaintenanceBusyError:
                                continue
                    threading.Thread(target=drain, daemon=True, name="dataset-shutdown-drain").start()
            stack.callback(release_when_idle)
        stack.enter_context(runtime_profile(app.state.runtime_profile))
        settings = get_settings()
        launch_phase.clear()
        init_seconds = 0.0
        if settings.dataset_root:
            lease = getattr(app.state, "dataset_lease", None)
            if lease is None:
                lease = stack.enter_context(DatasetLease.acquire(settings.dataset_root, "service"))
                app.state.dataset_lease = lease
            if settings.db_file.is_file():
                backup_on_launch()  # before additive startup migrations
        mark = time.perf_counter()
        init_db()
        if settings.dataset_root:
            from .services.identity_library import database_path
            from .services.schema_contract import initialize_known_identity_schema
            import sqlite3
            identity = database_path(settings.db_file)
            if identity.is_file():
                with sqlite3.connect(identity) as connection:
                    initialize_known_identity_schema(connection)
        init_seconds = time.perf_counter() - mark
        if not settings.dataset_root:
            backup_on_launch()
        migrate_fts_index()  # after the launch backup in both branches
        print(f"CrateMind backend phase: backup={launch_phase.get('backup', 'none')} "
              + " ".join(f"{key}={launch_phase.get(key, 0.0):.2f}s"
                         for key in ('decide', 'copy', 'verify', 'prune'))
              + f" init_db={init_seconds:.2f}s"
              + f" fts_rebuild={launch_phase.get('fts_rebuild', 0.0):.2f}s", file=sys.stderr, flush=True)
        with Session(get_engine()) as session:
            recover_orphan_jobs(session)
        yield


class RuntimeBoundary:
    """Track complete HTTP mutations, including their final identity update."""

    def __init__(self, app, profile: RuntimeProfile):
        self.app, self.profile = app, profile

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        from .services.dataset_access import maintenance_coordinator, DatasetBusyError

        path = scope.get("path", "")
        exchange = path.startswith(("/api/exchange/", "/api/desktop/"))
        mutation = scope.get("method") not in {"GET", "HEAD", "OPTIONS"}
        mutation |= path == "/api/scan/status" or path.startswith("/api/identity/")
        with runtime_profile(self.profile), ExitStack() as stack:
            try:
                if mutation and not exchange:
                    stack.enter_context(maintenance_coordinator.operation(path))
            except DatasetBusyError:
                return await JSONResponse(status_code=409, content={
                    "detail": "Η βιβλιοθήκη ετοιμάζεται για μεταφορά. Δοκίμασε ξανά σε λίγο.",
                    "code": "dataset_busy",
                })(scope, receive, send)
            await self.app(scope, receive, send)


def create_app(profile: RuntimeProfile | None = None, *, dataset_lease=None) -> FastAPI:
    """Select/recover an enrolled dataset under its lease before router/db imports."""
    from .config import Settings, get_settings
    from .runtime_profile import get_runtime_profile
    profile = RuntimeProfile(profile or get_runtime_profile())
    own_lease = False
    with runtime_profile(profile):
        raw = Settings(_env_file=None) if profile is RuntimeProfile.DESKTOP_CORE else Settings()
        if raw.dataset_root and dataset_lease is None:
            from .services.dataset_access import DatasetLease
            from .library_exchange.operations import recover_exchange_intent
            dataset_lease = DatasetLease.acquire(raw.dataset_root, "web-service")
            own_lease = True
            try:
                recover_exchange_intent(raw.dataset_root)
                get_settings.cache_clear()
            except BaseException:
                dataset_lease.release()
                raise
        try:
            app = _build_app(profile)
        except BaseException:
            if own_lease:
                dataset_lease.release()
            raise
        app.state.dataset_lease = dataset_lease
        app.state.owns_dataset_lease = own_lease
        if profile is RuntimeProfile.WEB and raw.dataset_root:
            from types import SimpleNamespace
            from pathlib import Path
            from .desktop_runtime.exchange_control import install_exchange_routes
            install_exchange_routes(app, SimpleNamespace(app_data=Path(raw.dataset_root).resolve()),
                                    None, dataset_lease)
        return app


def _build_app(profile: RuntimeProfile) -> FastAPI:
    with runtime_profile(profile):
        from .config import get_settings
        from .api import artists, djay, duplicates, export, facets, identity, scan, searches, sets, tags, tracks

        app = FastAPI(title="CrateMind", version="0.4.0", lifespan=lifespan)
        app.state.runtime_profile = profile
        from .runtime_errors import WebWorkflowRequired

        @app.exception_handler(WebWorkflowRequired)
        async def web_workflow_required(_request, _error):
            return unavailable()
        app.add_middleware(RuntimeBoundary, profile=profile)
        if profile is RuntimeProfile.WEB:
            app.add_middleware(CORSMiddleware, allow_origins=get_settings().cors_list,
                               allow_credentials=True, allow_methods=["*"], allow_headers=["*"])
            from .api import analysis, soundcloud
            app.include_router(analysis.router, prefix="/api")
            app.include_router(soundcloud.router, prefix="/api")
        else:
            from .api import legacy_import
            app.include_router(legacy_import.router, prefix="/api")
            for method, path in DEFERRED_ROUTES:
                app.add_api_route(path, unavailable, methods=[method])
        for module in (scan, tracks, tags, facets, duplicates, sets, searches, export, artists, identity, djay):
            if profile is RuntimeProfile.DESKTOP_CORE:
                from fastapi import APIRouter
                router = APIRouter()
                router.routes = [r for r in module.router.routes if not any(
                    path == "/api" + r.path and method in r.methods
                    for method, path in DEFERRED_ROUTES)]
                app.include_router(router, prefix="/api")
            else:
                app.include_router(module.router, prefix="/api")

        @app.get("/api/health")
        def health():
            s = get_settings()
            return {"status": "ok", "library_roots": [str(r) for r in s.roots],
                    "ffprobe": bool(s.ffprobe), "fpcalc": bool(s.fpcalc),
                    "ffmpeg": bool(s.ffmpeg), "db": str(s.db_file)}

        @app.get("/api/settings")
        def read_settings():
            s = get_settings()
            return {"library_roots": [str(r) for r in s.roots], "output_dir": str(s.output_path),
                    "db_path": str(s.db_file), "backup_dir": str(s.backup_path),
                    "ffprobe": s.ffprobe, "fpcalc": s.fpcalc, "ffmpeg": s.ffmpeg}

        @app.get("/api/capabilities")
        def capabilities():
            from .services.identity_library import database_path
            desktop = profile is RuntimeProfile.DESKTOP_CORE
            return {
                "identity": bool(os.environ.get("CRATEMIND_IDENTITY_DB_PATH"))
                            or database_path(get_settings().db_file).is_file(),
                "analysis": True, "artist_enrichment": True,
                "backup_import": desktop, "complete_backup": True,
                "provider_workflows": not desktop, "library_exchange": bool(get_settings().dataset_root),
                "native_dialogs": desktop,
            }
        return app
