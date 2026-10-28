"""Explicit, stopped-source adoption of the retired Deno desktop catalog.

Only private copies are opened by SQLite. The bounded source descriptor is a
snapshot of desktop/src/db/schema.sql and migrations.ts, shipped in the frozen
application; discovery never searches checkouts, .env files or music folders.
"""
from __future__ import annotations

import copy
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import uuid
from collections import Counter
from contextlib import ExitStack, closing, contextmanager
from dataclasses import dataclass
from pathlib import Path

from ..library_exchange import operations as exchange
from ..library_exchange.state import atomic_json, initial_state, load_state
from ..services.backup import create_backup, verify_backup
from ..services.dataset_access import DatasetLease
from ..services.schema_contract import (
    EXCLUDED_VALUE_TABLES,
    inspect_schema,
    load_schema_contract,
    validate_schema_compatibility,
)

CONTRACT_PATH = Path(__file__).with_name("deno_schema_contract.json")


@dataclass(frozen=True)
class SourcePreview:
    source: Path
    supported: bool
    schema_version: int | None = None
    table_counts: dict | None = None
    logical_roots: list | None = None
    reason: str | None = None

    def to_dict(self) -> dict:
        return {"source": str(self.source), "supported": self.supported,
                "schema_version": self.schema_version, "table_counts": self.table_counts,
                "logical_roots": self.logical_roots, "reason": self.reason}


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _source_path(source: Path | str) -> Path:
    path = Path(source).expanduser()
    if path.is_symlink() or not path.is_file():
        raise ValueError("Η πηγή Deno πρέπει να είναι κανονικό αρχείο βάσης δεδομένων.")
    return path.resolve(strict=True)


@contextmanager
def _private_source(source: Path):
    originals = {"catalog": source}
    before = exchange._source_signatures(originals)
    with tempfile.TemporaryDirectory(prefix="cratemind-deno-source-") as temporary:
        target = Path(temporary) / "catalog.sqlite"
        for suffix in ("", "-wal"):
            original = Path(str(source) + suffix)
            if original.exists():
                if original.is_symlink() or not original.is_file():
                    raise ValueError("Μη ασφαλές αρχείο πηγής Deno.")
                shutil.copyfile(original, Path(str(target) + suffix))
        if exchange._source_signatures(originals) != before:
            raise ValueError("Η πηγή Deno γράφεται ακόμη. Κλείστε την παλιά εφαρμογή.")
        yield target, before
        if exchange._source_signatures(originals) != before:
            raise ValueError("Η πηγή Deno άλλαξε. Κλείστε την παλιά εφαρμογή και επαναλάβετε.")


def _recognized_schema(catalog: Path) -> tuple[int, dict]:
    with closing(sqlite3.connect(catalog)) as db:
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("Η πηγή Deno απέτυχε στον έλεγχο ακεραιότητας.")
        versions = [row[0] for row in db.execute("SELECT version FROM schema_migrations ORDER BY version")]
        if versions not in ([1], [1, 2], [1, 2, 3]):
            raise ValueError("Μη υποστηριζόμενη έκδοση βάσης Deno.")
        version = versions[-1]
    contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    if contract.get("version") != 1:
        raise ValueError("Μη έγκυρο συμβόλαιο πηγής Deno.")
    expected = copy.deepcopy(contract["base_schema"])
    if version >= 2:
        expected["tables"].update(contract["soundcloud_tables"])
    actual = inspect_schema(catalog)
    # Some catalogs acquired listening cues through the shared Python service.
    # Accept that precise production table, never an unrecognized extension.
    if "track_cues" in actual["tables"]:
        expected["tables"]["track_cues"] = load_schema_contract()["normalized_catalog_schema"]["tables"]["track_cues"]
    # Migration 3 only adds these two columns; older releases lacked them.
    if version < 3:
        for column in ("bpm_consensus", "bpm_consensus_sources"):
            if column not in actual["tables"].get("tracks", {}).get("columns", {}):
                expected["tables"]["tracks"]["columns"].pop(column, None)
    if actual != expected:
        raise ValueError("Μη αναγνωρίσιμο σχήμα Deno. Απαιτείται ενημέρωση πριν από τη μεταφορά.")
    with closing(sqlite3.connect(catalog)) as db:
        if db.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("Η πηγή Deno έχει μη έγκυρες σχέσεις εγγραφών.")
    return version, actual


def preview_deno_source(source: Path | str) -> SourcePreview:
    source = _source_path(source)
    with _private_source(source) as (private, _signatures):
        version, schema = _recognized_schema(private)
        with closing(sqlite3.connect(private)) as db:
            counts = {name: db.execute(f"SELECT COUNT(*) FROM {_quote(name)}").fetchone()[0]
                      for name in schema["tables"]
                      if name not in EXCLUDED_VALUE_TABLES and name != "schema_migrations"}
        roots = exchange._logical_roots(private, [])
        return SourcePreview(source, True, version, counts, roots)


def inspect_deno_sources(*, home: Path | None = None, platform: str | None = None,
                         environ: dict | None = None) -> list[SourcePreview]:
    """Inspect only the historical OS app-data filename, without source writes."""
    env = os.environ if environ is None else environ
    home = Path.home() if home is None else Path(home)
    platform = sys.platform if platform is None else platform
    if platform == "darwin":
        directory = home / "Library/Application Support/CrateMind"
    elif platform == "win32":
        directory = Path(env["APPDATA"]) / "CrateMind" if env.get("APPDATA") else home / "AppData/Roaming/CrateMind"
    else:
        directory = Path(env["XDG_DATA_HOME"]) / "CrateMind" if env.get("XDG_DATA_HOME") else home / ".local/share/CrateMind"
    candidates = [directory / "cratemind.sqlite"]
    result = []
    for source in candidates:
        if not source.exists():
            continue
        try:
            result.append(preview_deno_source(source))
        except (ValueError, OSError, sqlite3.Error) as exc:
            result.append(SourcePreview(source, False, reason=str(exc)))
    return result


def _copy_values(source: Path, target: Path, schema: dict) -> None:
    """Copy original values explicitly; SQLite applies only target affinities."""
    with (
        closing(sqlite3.connect(source)) as original,
        closing(sqlite3.connect(target)) as destination,
        destination,
    ):
        for name, descriptor in schema["tables"].items():
            if (name in EXCLUDED_VALUE_TABLES and name != "track_search") or name == "schema_migrations":
                continue
            columns = [column for column, spec in descriptor["columns"].items() if not spec["hidden"]]
            if name == "track_search":
                columns.insert(0, "rowid")
            names = ",".join(map(_quote, columns))
            select = f"SELECT {names} FROM {_quote(name)}"
            destination.executemany(
                f"INSERT INTO {_quote(name)} ({names}) VALUES ({','.join('?' for _ in columns)})",
                original.execute(select),
            )
            # Compare the original projection, including NULLs and row
            # multiplicity; newly introduced nullable fields are separate.
            before = original.execute(select).fetchall()
            after = destination.execute(select).fetchall()
            # Numeric equality allows the intentional INTEGER -> REAL
            # production affinity for artist energy, preserving its value.
            if Counter(before) != Counter(after):
                raise ValueError(f"Η μεταφορά δεν διατήρησε τις τιμές: {name}")
        if destination.execute("PRAGMA foreign_key_check").fetchall():
            raise ValueError("Η μεταφορά έχει μη έγκυρες σχέσεις εγγραφών.")


def adopt_deno_source(source: Path | str, new_dataset: Path | str, *,
                      require_stopped: bool = False) -> exchange.VerifiedDataset:
    """Establish S0 in an explicit new root, leaving source files untouched.

    The retired Deno binary does not honor DatasetLease. require_stopped is an
    explicit operator precondition; signatures detect changes during copying.
    """
    if not require_stopped:
        raise ValueError("Κλείστε την παλιά εφαρμογή Deno και επιβεβαιώστε --require-stopped.")
    source = _source_path(source)
    raw_root = Path(new_dataset).expanduser()
    if raw_root.is_symlink():
        raise ValueError("Ο νέος φάκελος δεν μπορεί να είναι συμβολικός σύνδεσμος.")
    root = raw_root.resolve()
    if root.is_relative_to(source.parent) or source.is_relative_to(root):
        raise ValueError("Ο νέος φάκελος πρέπει να βρίσκεται εκτός της αρχικής βιβλιοθήκης Deno.")
    with ExitStack() as stack:
        private, signatures = stack.enter_context(_private_source(source))
        _version, schema = _recognized_schema(private)
        roots = exchange._logical_roots(private, [])
        for descriptor in roots:
            logical = Path(descriptor["logical_prefix"])
            if logical.is_absolute() and root.is_relative_to(logical.resolve()):
                raise ValueError("Ο νέος φάκελος πρέπει να βρίσκεται εκτός της μουσικής βιβλιοθήκης.")
        root.mkdir(parents=True, exist_ok=True)
        held = stack.enter_context(DatasetLease.acquire(root, "deno-adoption"))
        exchange.recover_exchange_intent(root)
        receipt = root / "deno-adoption.json"
        if receipt.exists():
            record = json.loads(receipt.read_text())
            if record.get("source") != str(source) or record.get("source_signatures") != signatures:
                raise FileExistsError("Ο φάκελος περιέχει άλλη μεταφορά Deno.")
            generation = record["generation"]
            if record.get("version") != 1 or not isinstance(generation, str) or not re.fullmatch(r"[a-f0-9]{32}", generation):
                raise ValueError("Μη έγκυρη εκκρεμής μεταφορά Deno.")
            # A crash after the verified generation/receipt but before pointer
            # publication resumes without opening or changing the source DB.
            catalog = root / "datasets" / generation / "catalog.sqlite"
            validate_schema_compatibility(catalog)
            if not (root / "active.json").exists():
                exchange._pointer(root, generation, False)
            dataset = exchange.resolve_active_dataset(root)
            if dataset.generation != generation:
                raise FileExistsError("Η ενεργή βιβλιοθήκη έχει αλλάξει μετά τη μεταφορά Deno.")
            state = load_state(dataset.exchange_state_path)
            if state["baseline_snapshot_id"] is not None:
                return exchange.VerifiedDataset(dataset, state["baseline_snapshot_id"],
                                                Path(state["baseline_archive"]), no_op=True)
        else:
            if (root / "active.json").exists():
                raise FileExistsError("Η βιβλιοθήκη υπάρχει ήδη. Χρησιμοποιήστε την προεπισκόπηση ανταλλαγής.")
            backup = create_backup(private, root / "exchange/deno-source-backups", identity_path=None,
                                   keep=None, reuse=False)
            verify_backup(backup)
            generation = uuid.uuid4().hex
            directory = root / "datasets" / generation
            directory.mkdir(parents=True)
            catalog = directory / "catalog.sqlite"
            exchange._schema_initialize(catalog, None)
            _copy_values(backup / "catalog.sqlite", catalog, schema)
            validate_schema_compatibility(catalog)
            # The original ledger and derived state remain in the complete
            # verified backup. They are not production catalog tables.
            atomic_json(directory / "exchange-state.json", initial_state(str(uuid.uuid4()), roots))
            if exchange._source_signatures({"catalog": source}) != signatures:
                raise ValueError("Η πηγή Deno άλλαξε πριν από τη δημοσίευση.")
            atomic_json(receipt, {"version": 1, "source": str(source),
                                  "source_signatures": signatures, "generation": generation,
                                  "source_backup": str(backup)})
            exchange._pointer(root, generation, False)
        result = exchange.export_exchange(root, root / "exchange/onboarding.cmexchange", lease=held)
        return exchange.VerifiedDataset(exchange.resolve_active_dataset(root), result.manifest.snapshot_id,
                                        result.path)
