"""Pre-import dataset selection. This module never opens a database or reads .env."""
from __future__ import annotations

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path


class DatasetConfigurationError(ValueError):
    """The selected generation or an explicit path is inconsistent."""


@dataclass(frozen=True)
class ActiveDataset:
    dataset_root: Path
    generation: str
    generation_dir: Path
    catalog_path: Path
    identity_path: Path | None
    cache_path: Path
    exchange_state_path: Path
    exports_path: Path


def retired_source_marker(catalog_path: Path | str) -> Path:
    """Enrollment leaves this non-secret marker beside each retired original."""
    path = Path(catalog_path).expanduser().resolve()
    return path.with_name(path.name + ".cratemind-enrolled.json")


def reject_retired_source(catalog_path: Path | str) -> None:
    if retired_source_marker(catalog_path).exists():
        raise DatasetConfigurationError(
            "Αυτή η αρχική βάση έχει μεταφερθεί. Ορίστε CRATEMIND_DATASET_ROOT "
            "για να ανοίξετε την ενεργή βιβλιοθήκη."
        )


def _member(directory: Path, value: object, label: str) -> Path:
    if not isinstance(value, str) or not value or Path(value).is_absolute():
        raise DatasetConfigurationError(f"Μη έγκυρη διαδρομή {label} στην ενεργή βιβλιοθήκη.")
    relative = Path(value)
    if ".." in relative.parts or "\\" in value or ":" in value:
        raise DatasetConfigurationError(f"Μη ασφαλής διαδρομή {label}.")
    path = (directory / relative).resolve()
    if not path.is_relative_to(directory):
        raise DatasetConfigurationError(f"Η διαδρομή {label} είναι εκτός της ενεργής γενιάς.")
    return path


def resolve_active_dataset(
    dataset_root: Path | str,
    explicit_overrides: Mapping[str, str | Path | None] | None = None,
) -> ActiveDataset:
    root = Path(dataset_root).expanduser().resolve(strict=True)
    pointer = root / "active.json"
    try:
        if pointer.stat().st_size > 64 * 1024:
            raise ValueError("oversized active pointer")
        value = json.loads(pointer.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or value.get("version", 1) != 1:
            raise ValueError("unsupported active pointer")
        generation = value.get("generation")
        if not isinstance(generation, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}", generation):
            raise ValueError("invalid generation")
        directory = (root / "datasets" / generation).resolve(strict=True)
        if not directory.is_relative_to(root / "datasets"):
            raise ValueError("generation escapes dataset root")
        catalog = _member(directory, value.get("catalog", "catalog.sqlite"), "catalog")
        # Missing/null means no identity partner, even if an unrelated file exists.
        identity_value = value.get("identity")
        identity = _member(directory, identity_value, "identity") if identity_value is not None else None
        if not catalog.is_file() or (identity is not None and not identity.is_file()):
            raise ValueError("missing database partner")
        if identity == catalog:
            raise ValueError("database partners must be distinct")
    except (OSError, ValueError, TypeError) as exc:
        if isinstance(exc, DatasetConfigurationError):
            raise
        raise DatasetConfigurationError("Η ενεργή βιβλιοθήκη δεν είναι έγκυρη ή είναι ελλιπής.") from exc
    overrides = explicit_overrides or {}
    for names, expected in (
        (("db_path", "CRATEMIND_DB_PATH", "catalog_path"), catalog),
        (("identity_db_path", "CRATEMIND_IDENTITY_DB_PATH", "identity_path"), identity),
    ):
        for name in names:
            explicit = overrides.get(name)
            if explicit is not None and str(explicit) and (
                expected is None or Path(explicit).expanduser().resolve() != expected
            ):
                raise DatasetConfigurationError(f"Το {name} δεν ανήκει στην ενεργή βιβλιοθήκη.")
    return ActiveDataset(root, generation, directory, catalog, identity,
                         _member(directory, "cache", "cache"),
                         _member(directory, "exchange-state.json", "exchange state"),
                         _member(directory, "exports", "exports"))
