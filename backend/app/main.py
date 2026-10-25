"""CrateMind FastAPI app."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .db import backup_on_launch, init_db
from .api import (
    analysis,
    artists,
    duplicates,
    export,
    scan,
    searches,
    sets,
    soundcloud,
    identity,
    tags,
    tracks,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    backup_on_launch()  # snapshot DB before this session makes changes
    from sqlmodel import Session

    from .db import get_engine
    from .jobs.worker import recover_orphan_jobs

    with Session(get_engine()) as session:
        recover_orphan_jobs(session)
    yield


app = FastAPI(title="CrateMind", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=get_settings().cors_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

API_PREFIX = "/api"
for module in (
    scan,
    analysis,
    tracks,
    tags,
    duplicates,
    sets,
    searches,
    export,
    artists,
    soundcloud,
    identity,
):
    app.include_router(module.router, prefix=API_PREFIX)


@app.get("/api/health")
def health():
    settings = get_settings()
    return {
        "status": "ok",
        "library_roots": [str(r) for r in settings.roots],
        "ffprobe": bool(settings.ffprobe),
        "fpcalc": bool(settings.fpcalc),
        "ffmpeg": bool(settings.ffmpeg),
        "db": str(settings.db_file),
    }


@app.get("/api/settings")
def read_settings():
    s = get_settings()
    return {
        "library_roots": [str(r) for r in s.roots],
        "output_dir": str(s.output_path),
        "db_path": str(s.db_file),
        "backup_dir": str(s.backup_path),
        "ffprobe": s.ffprobe,
        "fpcalc": s.fpcalc,
        "ffmpeg": s.ffmpeg,
    }


@app.get("/api/capabilities")
def capabilities():
    """Expose supported workflows for the shared Python/desktop frontend."""
    import os

    from .services.identity_library import database_path

    return {
        # An explicitly configured but broken installation must remain visible
        # so its read error is surfaced instead of hiding the configured feature.
        "identity": bool(os.environ.get("CRATEMIND_IDENTITY_DB_PATH"))
                    or database_path(get_settings().db_file).is_file(),
        "analysis": True,
        "artist_enrichment": True,
        "backup_import": False,
        "complete_backup": True,
    }
