"""Strict exchange envelope and bounded, private ZIP extraction."""
from __future__ import annotations

import hashlib
import json
import shutil
import stat
import uuid
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path

from ..services.backup import verify_backup
from ..services.schema_contract import (
    canonical_database_values,
    make_schema_contract,
    validate_schema_compatibility,
)

MAX_METADATA_BYTES = 4 * 1024 * 1024
MAX_DATABASE_BYTES = 64 * 1024 * 1024 * 1024
ALLOWED_MEMBERS = frozenset({"exchange.json", "backup/manifest.json", "backup/catalog.sqlite", "backup/identity.sqlite"})


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def canonical(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def normalized_roots(roots: list[dict]) -> list[dict]:
    if not isinstance(roots, list) or len(roots) > 10000:
        raise ValueError("Μη έγκυρη λίστα λογικών φακέλων.")
    values = []
    for root in roots:
        if not isinstance(root, dict) or set(root) != {"root_key", "logical_prefix", "logical_flavor"}:
            raise ValueError("Μη έγκυρη περιγραφή λογικού φακέλου.")
        if not all(isinstance(value, str) and value for value in root.values()):
            raise ValueError("Κενή περιγραφή λογικού φακέλου.")
        if root["logical_flavor"] not in {"posix", "windows"}:
            raise ValueError("Μη έγκυρος τύπος λογικής διαδρομής.")
        values.append(dict(root))
    if len({root["root_key"] for root in values}) != len(values):
        raise ValueError("Διπλό αναγνωριστικό λογικού φακέλου.")
    from ..services.library_paths import parse_mappings
    parse_mappings({"version": 1, "library_roots": values})
    return sorted(values, key=lambda item: canonical(item))


def state_digest(catalog: Path, identity: Path | None, logical_roots: list[dict]) -> str:
    value = {"serialization_version": 1, "catalog": canonical_database_values(catalog),
             "identity": canonical_database_values(identity) if identity is not None else {},
             "logical_roots": normalized_roots(logical_roots)}
    return hashlib.sha256(canonical(value)).hexdigest()


@dataclass(frozen=True)
class ExchangeManifestV1:
    format_version: int
    lineage_id: str
    snapshot_id: str
    parent_snapshot_id: str | None
    schema_contract: dict
    logical_roots: list[dict]
    state_digest: str
    files: dict

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, value: dict) -> ExchangeManifestV1:
        if not isinstance(value, dict) or set(value) != set(cls.__dataclass_fields__) or value.get("format_version") != 1:
            raise ValueError("Μη υποστηριζόμενη μορφή ανταλλαγής.")
        for name in ("lineage_id", "snapshot_id", "parent_snapshot_id"):
            if value[name] is None and name == "parent_snapshot_id":
                continue
            try:
                uuid.UUID(value[name])
            except (ValueError, TypeError, AttributeError) as exc:
                raise ValueError("Μη έγκυρο αναγνωριστικό ανταλλαγής.") from exc
        if value["snapshot_id"] == value["parent_snapshot_id"]:
            raise ValueError("Μη έγκυρη αλυσίδα στιγμιοτύπων.")
        if not isinstance(value["state_digest"], str) or len(value["state_digest"]) != 64:
            raise ValueError("Μη έγκυρο αποτύπωμα βιβλιοθήκης.")
        normalized_roots(value["logical_roots"])
        return cls(**value)


def inspect_archive(archive: Path, destination: Path) -> ExchangeManifestV1:
    """Extract exactly the complete verified backup into NEW private staging."""
    if destination.exists() and any(destination.iterdir()):
        raise FileExistsError("Private exchange staging must be empty")
    destination.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(archive) as source:
            entries = source.infolist()
            names = [entry.filename for entry in entries]
            required = {"exchange.json", "backup/manifest.json", "backup/catalog.sqlite"}
            if len(names) != len(set(names)) or not required <= set(names) or not set(names) <= ALLOWED_MEMBERS:
                raise ValueError("Μη ασφαλή ή ελλιπή αρχεία ανταλλαγής.")
            for entry in entries:
                mode = entry.external_attr >> 16
                if entry.is_dir() or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in {0, stat.S_IFREG}):
                    raise ValueError("Μη επιτρεπόμενος τύπος αρχείου ανταλλαγής.")
                limit = MAX_METADATA_BYTES if entry.filename.endswith(".json") else MAX_DATABASE_BYTES
                if entry.file_size < 0 or entry.file_size > limit or entry.flag_bits & 1:
                    raise ValueError("Μη επιτρεπόμενο μέγεθος/κρυπτογράφηση ανταλλαγής.")
            total = sum(entry.file_size for entry in entries)
            if shutil.disk_usage(destination).free < total + max(64 * 1024 * 1024, total // 10):
                raise OSError("Ανεπαρκής χώρος για την ανταλλαγή βιβλιοθήκης.")
            for entry in entries:
                target = destination / entry.filename
                target.parent.mkdir(parents=True, exist_ok=True)
                remaining = entry.file_size
                with source.open(entry) as reader, target.open("xb") as writer:
                    while chunk := reader.read(min(1024 * 1024, remaining + 1)):
                        remaining -= len(chunk)
                        if remaining < 0:
                            raise ValueError("Το αρχείο υπερβαίνει το δηλωμένο μέγεθος.")
                        writer.write(chunk)
                if remaining:
                    raise ValueError("Το αρχείο ανταλλαγής είναι ελλιπές.")
        manifest = ExchangeManifestV1.from_dict(json.loads((destination / "exchange.json").read_text()))
        backup = verify_backup(destination / "backup")
        if backup["databases"] != manifest.files:
            raise ValueError("Τα αρχεία δεν συμφωνούν με το manifest ανταλλαγής.")
        actual_names = required | ({"backup/identity.sqlite"} if "identity" in manifest.files else set())
        if set(names) != actual_names:
            raise ValueError("Η προαιρετική βάση identity δεν συμφωνεί με το manifest.")
        catalog = destination / "backup/catalog.sqlite"
        identity = destination / "backup/identity.sqlite" if "identity" in manifest.files else None
        validate_schema_compatibility(catalog, identity)
        if make_schema_contract(catalog, identity) != manifest.schema_contract:
            raise ValueError("Το σχήμα δεν συμφωνεί με το manifest ανταλλαγής.")
        if state_digest(catalog, identity, manifest.logical_roots) != manifest.state_digest:
            raise ValueError("Το περιεχόμενο δεν συμφωνεί με το αποτύπωμα ανταλλαγής.")
        return manifest
    except BaseException:
        shutil.rmtree(destination, ignore_errors=True)
        raise
