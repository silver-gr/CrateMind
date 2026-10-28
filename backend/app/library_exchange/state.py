"""Atomic exchange state; no application database/config imports."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path


def atomic_json(path: Path, value: dict) -> None:
    from ..services.backup import _atomic_replace

    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=".pending-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        _atomic_replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def load_state(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("version") != 1:
        raise ValueError("Μη έγκυρη κατάσταση ανταλλαγής βιβλιοθήκης.")
    return value


def initial_state(lineage_id: str, logical_roots: list[dict] | None = None) -> dict:
    return {"version": 1, "lineage_id": lineage_id, "baseline_snapshot_id": None,
            "baseline_parent_snapshot_id": None, "baseline_digest": None,
            "baseline_schema_fingerprint": None, "baseline_archive": None,
            "logical_roots": logical_roots or [], "history": []}
