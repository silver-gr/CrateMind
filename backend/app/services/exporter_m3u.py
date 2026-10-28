"""M3U8 playlist export. Writes into the output folder; never overwrites
source files. Refuses to clobber an existing export unless overwrite=True."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

from ..models import Track
from .library_paths import PathResolutionError, mapping_context, resolve_source_path


class UnavailableSourcesError(ValueError):
    def __init__(self, failures: list[dict]):
        self.failures = failures
        names = ", ".join(item["logical_path"] for item in failures)
        super().__init__(f"Μη διαθέσιμα αρχεία για export: {names}")


def export_m3u(tracks: list[Track], dest: Path, overwrite: bool = False) -> Path:
    if dest.exists() and not overwrite:
        raise FileExistsError(f"{dest} exists (pass overwrite=true to replace)")
    mappings, strict = mapping_context()
    paths, failures = [], []
    for track in tracks:
        try:
            path = resolve_source_path(track.absolute_path)
            if strict and not path.is_file():
                raise PathResolutionError(track.absolute_path, "missing")
            paths.append(path)
        except OSError as error:
            failures.append({"track_id": track.id, "logical_path": track.absolute_path,
                             "state": getattr(error, "state", "unavailable")})
    if failures:
        raise UnavailableSourcesError(failures)
    if any(mapping.local_prefix and dest.resolve().is_relative_to(
        Path(mapping.local_prefix).resolve()) for mapping in mappings
    ):
        raise UnavailableSourcesError([{"track_id": None, "logical_path": str(dest),
                                        "state": "source_root_destination"}])
    lines = ["#EXTM3U"]
    for t, path in zip(tracks, paths, strict=True):
        dur = int(t.duration) if t.duration else -1
        label = f"{t.artist or 'Unknown'} - {t.title or t.file_name}"
        lines.append(f"#EXTINF:{dur},{label}")
        lines.append(str(path))
    dest.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=dest.parent,
                                         delete=False) as handle:
            temporary = Path(handle.name)
            handle.write("\n".join(lines) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        if overwrite:
            os.replace(temporary, dest)
        else:
            # Atomic no-clobber publication: an export racing us cannot be lost.
            os.link(temporary, dest)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return dest
