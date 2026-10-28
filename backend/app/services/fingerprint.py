"""Acoustic fingerprinting via fpcalc / Chromaprint. Optional — no-op when the
binary is absent."""
from __future__ import annotations

import json
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from sqlmodel import Session, select

from ..models import Fingerprint, Track
from .library_paths import resolve_media_path, resolve_source_path
from .media_tools import media_tools


def compute(path: Path, fpcalc: str | None) -> dict | None:
    if not fpcalc:
        return None
    try:
        path = resolve_media_path(path)
        proc = media_tools.run(fpcalc, ["-json", str(path)], timeout_s=60)
    except (subprocess.TimeoutExpired, OSError, ValueError):
        return None
    if proc.returncode != 0 or not proc.stdout:
        return None
    try:
        data = json.loads(proc.stdout)
    except (json.JSONDecodeError, ValueError):
        return None
    fp = data.get("fingerprint")
    if not fp:
        return None
    return {"chromaprint": fp, "duration_seconds": data.get("duration")}


def fingerprint_track(session: Session, track: Track, fpcalc: str | None) -> bool:
    try:
        path = resolve_source_path(track.absolute_path)
    except OSError:
        return False
    result = compute(path, fpcalc)
    if result is None:
        return False
    existing = session.get(Fingerprint, track.id)
    if existing is None:
        existing = Fingerprint(track_id=track.id)
    existing.chromaprint = result["chromaprint"]
    existing.duration_seconds = result["duration_seconds"]
    existing.fingerprinted_at = datetime.now(UTC)
    session.add(existing)
    session.commit()
    return True


def fingerprint_all(session: Session, fpcalc: str | None) -> int:
    if not fpcalc:
        return 0
    tracks = session.exec(select(Track).where(Track.missing == False)).all()
    done = 0
    for tr in tracks:
        if session.get(Fingerprint, tr.id) is not None:
            continue
        if fingerprint_track(session, tr, fpcalc):
            done += 1
    return done
