"""Explicit desktop configuration, never discovery of a source checkout/.env."""
from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass
from pathlib import Path

from .preferences import atomic_json


@dataclass(frozen=True)
class DesktopPaths:
    app_data: Path
    resources: Path
    frontend: Path
    config: Path


def read_config(root: Path) -> dict:
    path = root / "desktop-config.json"
    if not path.exists():
        value = {"version": 1, "revision": "initial", "library_roots": []}
    else:
        if path.stat().st_size > 512 * 1024:
            raise ValueError("Το αρχείο ρυθμίσεων είναι πολύ μεγάλο.")
        value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("version") != 1:
        raise ValueError("Μη συμβατή έκδοση ρυθμίσεων.")
    from ..services.library_paths import parse_mappings, reconcile_mappings
    scans = value.get("scan_roots", [])
    if not isinstance(scans, list) or any(not isinstance(path, str) for path in scans):
        raise ValueError("Μη έγκυροι φάκελοι σάρωσης.")
    if (root / "active.json").is_file():
        from ..services.active_dataset import resolve_active_dataset
        from ..library_exchange.state import load_state
        dataset = resolve_active_dataset(root)
        logical_roots = load_state(dataset.exchange_state_path)["logical_roots"]
        from dataclasses import asdict
        prior = list(parse_mappings(value))
        for item in value.get("inactive_library_roots", []):
            prior.extend(parse_mappings({"library_roots": [item]}))
        current = list(reconcile_mappings(prior, logical_roots))
        # Preserve previous local bindings for a deliberate generation rollback.
        inactive = [asdict(item) for item in prior if item not in current]
        value["inactive_library_roots"] = list({json.dumps(item, sort_keys=True): item for item in inactive}.values())
        value["library_roots"] = [asdict(item) for item in current]
    parse_mappings(value)
    return value


def patch_config(root: Path, patch: dict) -> dict:
    if set(patch) - {"library_roots"}:
        raise ValueError("Μη αναγνωρίσιμη ρύθμιση εφαρμογής.")
    value = {**read_config(root), **patch, "revision": uuid.uuid4().hex}
    from ..services.library_paths import parse_mappings
    parse_mappings(value)
    from ..services.dataset_access import maintenance_coordinator
    from ..services.active_dataset import resolve_active_dataset
    from ..library_exchange.state import load_state
    with maintenance_coordinator.enter_maintenance(timeout_s=1):
        dataset = resolve_active_dataset(root)
        state = load_state(dataset.exchange_state_path)
        descriptors = {entry["root_key"]: entry for entry in state["logical_roots"]}
        for entry in value["library_roots"]:
            descriptor = {key: entry[key] for key in ("root_key", "logical_prefix", "logical_flavor")}
            if entry["root_key"] in descriptors and descriptors[entry["root_key"]] != descriptor:
                raise ValueError("Η λογική ταυτότητα υπάρχοντος φακέλου δεν μπορεί να αλλάξει.")
            if "scan_roots" in value and entry["root_key"] not in descriptors:
                value["scan_roots"].append(entry["logical_prefix"])
            descriptors[entry["root_key"]] = descriptor
        updated = list(descriptors.values())
        if updated != state["logical_roots"]:
            atomic_json(dataset.exchange_state_path, {**state, "logical_roots": updated})
        atomic_json(root / "desktop-config.json", value)
    return value


def resolve_desktop_paths(init: dict) -> DesktopPaths:
    root = Path(init["paths"]["app_data"]).resolve()
    resources = Path(init["paths"]["resources"]).resolve(strict=True)
    root.mkdir(parents=True, exist_ok=True)
    if root == resources or root.is_relative_to(resources):
        raise ValueError("Η βιβλιοθήκη δεν μπορεί να αποθηκευτεί στους πόρους της εφαρμογής.")
    for name in ("logs", "backups", "exports", "exchange", "datasets"):
        (root / name).mkdir(exist_ok=True)
    return DesktopPaths(root, resources, resources / "frontend", root / "desktop-config.json")


def configure_environment(init: dict, paths: DesktopPaths) -> None:
    # Never inherit development credentials or a checkout's DB path.
    for key in list(os.environ):
        if key.startswith("CRATEMIND_"):
            del os.environ[key]
    os.environ.update({
        "CRATEMIND_RUNTIME_PROFILE": "desktop-core",
        "CRATEMIND_DATASET_ROOT": str(paths.app_data),
        "CRATEMIND_PATH_MAPPINGS_FILE": str(paths.config),
        "CRATEMIND_RECCOBEATS_ENABLED": "false",
        "CRATEMIND_GETSONGBPM_ENABLED": "false",
        "CRATEMIND_CYANITE_ENABLED": "false",
        "CRATEMIND_ESSENTIA_ENABLED": "false",
        # Spawned analysis children log here (child_diagnostics.install).
        "CRATEMIND_CHILD_LOG_DIR": str(paths.app_data / "logs"),
    })
    for name, value in init["tools"].items():
        if name in {"ffmpeg", "ffprobe", "fpcalc"}:
            os.environ[f"CRATEMIND_{name.upper()}_PATH"] = value
    # Optional enrichment remains available using explicit per-device config.
    config = read_config(paths.app_data)
    atomic_json(paths.config, config)
    os.environ["CRATEMIND_SCAN_ROOTS"] = json.dumps(config.get("scan_roots", []))
    optional = config.get("artist_enrichment", {})
    for name in ("llm1_base_url", "llm1_api_key", "llm1_model", "llm1_model_effort"):
        if isinstance(optional.get(name), str):
            os.environ["CRATEMIND_" + name.upper()] = optional[name]
