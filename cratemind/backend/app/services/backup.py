"""JSON backup of canonical custom metadata (the data CrateMind owns).

This is the portable, human-readable backup of taste metadata, tags, sets,
pair notes and play history — independent of the SQLite file.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlmodel import Session, select

from ..models import (
    DJSet,
    PlayEvent,
    SetTrack,
    Tag,
    Track,
    TrackDJProfile,
    TrackPairNote,
    TrackTag,
)


def _dump(rows: list[Any]) -> list[dict]:
    return [r.model_dump(mode="json") for r in rows]


def export_json(session: Session, dest: Path, overwrite: bool = True) -> Path:
    if dest.exists() and not overwrite:
        raise FileExistsError(f"{dest} exists (pass overwrite=true to replace)")
    dest.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "exported_at": datetime.utcnow().isoformat(),
        "version": 1,
        "tracks": _dump(session.exec(select(Track)).all()),
        "profiles": _dump(session.exec(select(TrackDJProfile)).all()),
        "tags": _dump(session.exec(select(Tag)).all()),
        "track_tags": _dump(session.exec(select(TrackTag)).all()),
        "sets": _dump(session.exec(select(DJSet)).all()),
        "set_tracks": _dump(session.exec(select(SetTrack)).all()),
        "pair_notes": _dump(session.exec(select(TrackPairNote)).all()),
        "play_events": _dump(session.exec(select(PlayEvent)).all()),
    }
    dest.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")
    return dest
