"""Acoustic fingerprinting via fpcalc / Chromaprint. Optional — no-op when the
binary is absent."""
from __future__ import annotations

import json
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Optional

from sqlmodel import Session, select

from ..models import Fingerprint, Track


def compute(path: Path, fpcalc: Optional[str]) -> Optional[dict]:
    if not fpcalc:
        return None
    try:
        proc = subprocess.run(
            [fpcalc, "-json", str(path)], capture_output=True, timeout=60
        )
    except (subprocess.TimeoutExpired, OSError):
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


def fingerprint_track(session: Session, track: Track, fpcalc: Optional[str]) -> bool:
    result = compute(Path(track.absolute_path), fpcalc)
    if result is None:
        return False
    existing = session.get(Fingerprint, track.id)
    if existing is None:
        existing = Fingerprint(track_id=track.id)
    existing.chromaprint = result["chromaprint"]
    existing.duration_seconds = result["duration_seconds"]
    existing.fingerprinted_at = datetime.utcnow()
    session.add(existing)
    session.commit()
    return True


def fingerprint_all(session: Session, fpcalc: Optional[str]) -> int:
    if not fpcalc:
        return 0
    tracks = session.exec(select(Track).where(Track.missing == False)).all()  # noqa: E712
    done = 0
    for tr in tracks:
        if session.get(Fingerprint, tr.id) is not None:
            continue
        if fingerprint_track(session, tr, fpcalc):
            done += 1
    return done
