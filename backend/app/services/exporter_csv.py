"""CSV export of tracks + DJ profile for audit/review/sharing."""
from __future__ import annotations

import csv
from collections import defaultdict
from pathlib import Path

from sqlmodel import Session, select

from ..models import Facet, Tag, Track, TrackDJProfile, TrackTag
from .tempo import bpm_source, effective_bpm

_COLUMNS = [
    "id", "artist", "title", "album", "label", "year", "genre", "bpm",
    "key_text", "duration", "energy", "intensity", "darkness", "valence", "melody",
    "weirdness", "mixability", "confidence", "set_role", "transition_role",
    "psy_substyle", "personal_status", "absolute_path", "effective_bpm", "bpm_source",
]


def _facet_columns(session: Session) -> tuple[list[tuple[str, str, Facet]], dict[int, dict[str, list[str]]]]:
    """One column per vocabulary in (sort_order, id) order, keyed facet:<id> so
    equal labels never collide; a label repeating another vocabulary or a base
    column is shown as «label (2)».
    Cells come from one read over all vocabulary tags (no per-track binding)."""
    facets = session.exec(select(Facet).order_by(Facet.sort_order, Facet.id)).all()
    columns, seen = [], defaultdict(int, dict.fromkeys(_COLUMNS, 1))  # never repeat a base column
    for facet in facets:
        seen[facet.label] += 1
        header = facet.label if seen[facet.label] == 1 else f"{facet.label} ({seen[facet.label]})"
        columns.append((f"facet:{facet.id}", header, facet))
    cells: dict[int, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    by_key = {facet.key: f"facet:{facet.id}" for facet in facets}
    if by_key:
        rows = session.exec(
            select(TrackTag.track_id, Tag.category, Tag.name).join(Tag, Tag.id == TrackTag.tag_id)
            .where(Tag.category.in_(list(by_key))).order_by(Tag.id)
        ).all()
        for track_id, key, name in rows:
            if name.startswith(f"{key}:"):
                cells[track_id][by_key[key]].append(name[len(key) + 1:])
    return columns, cells


def export_csv(session: Session, tracks: list[Track], dest: Path, overwrite: bool = False) -> Path:
    if dest.exists() and not overwrite:
        raise FileExistsError(f"{dest} exists (pass overwrite=true to replace)")
    dest.parent.mkdir(parents=True, exist_ok=True)
    facet_columns, facet_cells = _facet_columns(session)
    fieldnames = _COLUMNS + [field for field, _header, _facet in facet_columns]
    # Excel opens a double-clicked .csv with the system list separator and code page. The BOM makes
    # it read UTF-8; ';' is the list separator under Greek regional settings (whose decimal is ',').
    # No "sep=" line: with one, Excel ignores the BOM.
    with dest.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, delimiter=";")
        writer.writerow({**{c: c for c in _COLUMNS}, **{field: header for field, header, _facet in facet_columns}})
        for t in tracks:
            prof = session.get(TrackDJProfile, t.id)
            row = {c: getattr(t, c, None) for c in _COLUMNS}
            row["effective_bpm"] = effective_bpm(t)
            row["bpm_source"] = bpm_source(t)
            if prof:
                for c in _COLUMNS:
                    if hasattr(prof, c) and getattr(prof, c) is not None:
                        row[c] = getattr(prof, c)
            for field, values in facet_cells.get(t.id, {}).items():
                row[field] = "; ".join(values)
            writer.writerow(row)
    return dest
