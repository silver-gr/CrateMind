"""CrateMind FastAPI app."""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .config import get_settings
from .db import backup_on_launch, init_db
from .api import duplicates, export, scan, searches, sets, tags, tracks


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    backup_on_launch()  # snapshot DB before this session makes changes
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
for module in (scan, tracks, tags, duplicates, sets, searches, export):
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
