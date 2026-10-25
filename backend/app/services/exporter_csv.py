"""CSV export of tracks + DJ profile for audit/review/sharing."""
from __future__ import annotations

import csv
from pathlib import Path

from sqlmodel import Session

from ..models import Track, TrackDJProfile
from .tempo import bpm_source, effective_bpm

_COLUMNS = [
    "id", "artist", "title", "album", "label", "year", "genre", "bpm",
    "key_text", "duration", "energy", "intensity", "darkness", "melody",
    "weirdness", "mixability", "confidence", "set_role", "transition_role",
    "psy_substyle", "personal_status", "absolute_path", "effective_bpm", "bpm_source",
]


def export_csv(session: Session, tracks: list[Track], dest: Path, overwrite: bool = False) -> Path:
    if dest.exists() and not overwrite:
        raise FileExistsError(f"{dest} exists (pass overwrite=true to replace)")
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=_COLUMNS)
        writer.writeheader()
        for t in tracks:
            prof = session.get(TrackDJProfile, t.id)
            row = {c: getattr(t, c, None) for c in _COLUMNS}
            row["effective_bpm"] = effective_bpm(t)
            row["bpm_source"] = bpm_source(t)
            if prof:
                for c in _COLUMNS:
                    if hasattr(prof, c) and getattr(prof, c) is not None:
                        row[c] = getattr(prof, c)
            writer.writerow(row)
    return dest
