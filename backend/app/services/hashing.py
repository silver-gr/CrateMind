"""Content hashing for track identity (see models.Track identity strategy)."""
from __future__ import annotations

import hashlib
from pathlib import Path

from .library_paths import resolve_media_path

_HEAD_TAIL = 256 * 1024  # 256 KiB from each end


def quick_hash(path: Path) -> str | None:
    """Fast content fingerprint: size + first/last N bytes. Stable for a file
    whose bytes don't change. Returns None if unreadable."""
    try:
        path = resolve_media_path(path)
        size = path.stat().st_size
        h = hashlib.sha256()
        h.update(str(size).encode())
        with path.open("rb") as f:
            head = f.read(_HEAD_TAIL)
            h.update(head)
            if size > _HEAD_TAIL:
                f.seek(max(0, size - _HEAD_TAIL))
                h.update(f.read(_HEAD_TAIL))
        return h.hexdigest()
    except OSError:
        return None


def full_hash(path: Path) -> str | None:
    """Full SHA256 of the file. Slower; optional."""
    try:
        path = resolve_media_path(path)
        h = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None
