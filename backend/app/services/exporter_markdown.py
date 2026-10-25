"""Markdown setlist export — for notes, posts, event reviews."""
from __future__ import annotations

from pathlib import Path

from ..models import DJSet, Track
from .tempo import effective_bpm


def _fmt_dur(seconds: float | None) -> str:
    if not seconds:
        return "--:--"
    m, s = divmod(int(seconds), 60)
    return f"{m}:{s:02d}"


def export_markdown(dj_set: DJSet, tracks: list[Track], dest: Path, overwrite: bool = False) -> Path:
    if dest.exists() and not overwrite:
        raise FileExistsError(f"{dest} exists (pass overwrite=true to replace)")
    dest.parent.mkdir(parents=True, exist_ok=True)
    lines = [f"# {dj_set.title}", ""]
    if dj_set.date:
        lines.append(f"**Date:** {dj_set.date}")
    total = sum(t.duration or 0 for t in tracks)
    lines.append(f"**Tracks:** {len(tracks)} · **Duration:** {_fmt_dur(total)}")
    lines.append("")
    for i, t in enumerate(tracks, 1):
        tempo = effective_bpm(t)
        bpm = f" — {tempo:g} BPM" if tempo is not None else ""
        key = f" — {t.key_text}" if t.key_text else ""
        lines.append(f"{i}. {t.artist or 'Unknown'} — {t.title or t.file_name}"
                     f" ({_fmt_dur(t.duration)}){bpm}{key}")
    if dj_set.notes:
        lines += ["", "## Notes", "", dj_set.notes]
    dest.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return dest
