"""M3U8 playlist export. Writes into the output folder; never overwrites
source files. Refuses to clobber an existing export unless overwrite=True."""
from __future__ import annotations

from pathlib import Path

from ..models import Track


def export_m3u(tracks: list[Track], dest: Path, overwrite: bool = False) -> Path:
    if dest.exists() and not overwrite:
        raise FileExistsError(f"{dest} exists (pass overwrite=true to replace)")
    dest.parent.mkdir(parents=True, exist_ok=True)
    lines = ["#EXTM3U"]
    for t in tracks:
        dur = int(t.duration) if t.duration else -1
        label = f"{t.artist or 'Unknown'} - {t.title or t.file_name}"
        lines.append(f"#EXTINF:{dur},{label}")
        lines.append(t.absolute_path)
    dest.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return dest
