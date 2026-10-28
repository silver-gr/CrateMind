"""Per-device preferences outside the exchanged datasets."""
from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path

_lock = threading.RLock()


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, staging = tempfile.mkstemp(prefix="." + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(staging, path)
        from ..services.backup import _sync_directory
        _sync_directory(path.parent)
    finally:
        Path(staging).unlink(missing_ok=True)


def read_preferences(root: Path) -> dict[str, str]:
    path = root / "preferences.json"
    with _lock:
        if not path.exists():
            return {}
        if path.stat().st_size > 512 * 1024:
            raise ValueError("Το αρχείο προτιμήσεων είναι πολύ μεγάλο.")
        values = json.loads(path.read_text(encoding="utf-8"))
        return validate_preferences(values)


def validate_preferences(values: dict) -> dict[str, str]:
    if not isinstance(values, dict) or len(values) > 128:
        raise ValueError("Μη έγκυρες προτιμήσεις.")
    for key, value in values.items():
        if not isinstance(key, str) or not key.startswith(("cratemind", "cm:")):
            raise ValueError("Μη έγκυρο όνομα προτίμησης.")
        if value is not None and (not isinstance(value, str) or len(value) > 32768):
            raise ValueError("Μη έγκυρη τιμή προτίμησης.")
    return values


def patch_preferences(root: Path, patch: dict) -> dict[str, str]:
    validate_preferences(patch)
    with _lock:
        values = read_preferences(root)
        for key, value in patch.items():
            if value is None:
                values.pop(key, None)
            else:
                values[key] = value
        validate_preferences(values)
        atomic_json(root / "preferences.json", values)
        return values
