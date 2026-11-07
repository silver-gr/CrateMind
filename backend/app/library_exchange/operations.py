"""Paired snapshots, serial lineage, stopped imports and crash recovery."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import tempfile
import time
import uuid
import zipfile
from contextlib import nullcontext
from dataclasses import dataclass
from pathlib import Path

from ..services.active_dataset import ActiveDataset, resolve_active_dataset, retired_source_marker
from ..services.backup import (
    _atomic_replace,
    _fsync,
    _sync_directory,
    create_backup,
    restore_backup,
    verify_backup,
)
from ..services.dataset_access import (
    DatasetLease,
    HeldLease,
    MaintenanceCoordinator,
    maintenance_coordinator,
)
from ..services.schema_contract import (
    canonical_database_values,
    load_schema_contract,
    make_schema_contract,
    validate_schema_compatibility,
)
from .manifest import (
    ExchangeManifestV1,
    canonical,
    inspect_archive,
    normalized_roots,
    sha256,
    state_digest,
)
from .state import atomic_json, initial_state, load_state


@dataclass(frozen=True)
class ExchangeResult:
    path: Path
    manifest: ExchangeManifestV1
    reused: bool = False

    def to_dict(self) -> dict:
        return {"path": str(self.path), "manifest": self.manifest.to_dict(), "reused": self.reused}


@dataclass(frozen=True)
class VerifiedDataset:
    dataset: ActiveDataset
    snapshot_id: str | None
    archive_path: Path | None = None
    conflict_archive: Path | None = None
    no_op: bool = False
    path_mappings_file: Path | None = None

    def to_dict(self) -> dict:
        return {"dataset_root": str(self.dataset.dataset_root), "generation": self.dataset.generation,
                "catalog_path": str(self.dataset.catalog_path),
                "identity_path": str(self.dataset.identity_path) if self.dataset.identity_path else None,
                "snapshot_id": self.snapshot_id,
                "archive_path": str(self.archive_path) if self.archive_path else None,
                "conflict_archive": str(self.conflict_archive) if self.conflict_archive else None,
                "no_op": self.no_op,
                "path_mappings_file": str(self.path_mappings_file) if self.path_mappings_file else None,
                "CRATEMIND_PATH_MAPPINGS_FILE": str(self.path_mappings_file) if self.path_mappings_file else None}


@dataclass(frozen=True)
class ImportPreview:
    preview_id: str
    dataset_root: Path | None
    archive_path: Path
    archive_digest: str
    manifest: ExchangeManifestV1
    local_digest: str | None
    local_snapshot_id: str | None
    local_generation: str | None
    status: str
    reason: str
    expires_at: float
    local_lineage_id: str | None = None
    change_summary: tuple[dict, ...] = ()

    @property
    def conflict(self) -> bool:
        return self.status == "conflict"

    def to_dict(self) -> dict:
        return {"preview_id": self.preview_id, "manifest": self.manifest.to_dict(),
                "local_lineage_id": self.local_lineage_id, "change_summary": list(self.change_summary),
                "local_digest": self.local_digest, "local_snapshot_id": self.local_snapshot_id,
                "local_generation": self.local_generation, "status": self.status,
                "conflict": self.conflict, "reason": self.reason,
                "archive_digest": self.archive_digest, "expires_at": self.expires_at}


@dataclass(frozen=True)
class RecoveryReport:
    recovered: bool
    action: str

    def to_dict(self) -> dict:
        return {"recovered": self.recovered, "action": self.action}


def _ownership(root: Path, lease: HeldLease | None):
    root.mkdir(parents=True, exist_ok=True)
    if lease is not None:
        if lease.dataset_root != root.resolve() or lease._stream.closed:
            raise ValueError("Invalid dataset lease")
        return nullcontext(lease)
    return DatasetLease.acquire(root, "library-exchange")


def _pointer(root: Path, generation: str, identity: bool) -> None:
    atomic_json(root / "active.json", {"version": 1, "generation": generation,
                                      "catalog": "catalog.sqlite",
                                      "identity": "identity.sqlite" if identity else None})


def _widen_legacy_artist_energy(connection: sqlite3.Connection) -> None:
    """Upgrade the historical INTEGER energy columns on a private copy only.

    SQLite needs a table rebuild to change affinity. Preserve every original
    column/constraint/index and verify all row values before committing it.
    """
    row = connection.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='artist_profiles'").fetchone()
    if row is None:
        return
    kinds = {item[1]: item[2].upper() for item in connection.execute('PRAGMA table_info(artist_profiles)')}
    legacy = [name for name in ('energy_min', 'energy_max') if kinds.get(name) == 'INTEGER']
    if not legacy:
        return
    from collections import Counter
    before = connection.execute('SELECT * FROM artist_profiles').fetchall()
    indexes = [item[0] for item in connection.execute("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='artist_profiles' AND sql IS NOT NULL")]
    ddl = row[0]
    for name in legacy:
        ddl, count = re.subn(rf'\b{re.escape(name)}\s+INTEGER\b', f'{name} FLOAT', ddl, count=1, flags=re.IGNORECASE)
        if count != 1:
            raise ValueError('Μη αναγνωρίσιμη παλιά στήλη energy στο ιδιωτικό αντίγραφο.')
    temporary = 'cm_artist_energy_' + uuid.uuid4().hex
    ddl, count = re.subn(r'^(CREATE TABLE\s+)(?:"artist_profiles"|artist_profiles)\b',
                        lambda match: match.group(1) + temporary, ddl, count=1, flags=re.IGNORECASE)
    if count != 1:
        raise ValueError('Μη αναγνωρίσιμη παλιά δομή artist_profiles.')
    connection.execute('BEGIN IMMEDIATE')
    try:
        connection.execute(ddl)
        connection.execute(f'INSERT INTO "{temporary}" SELECT * FROM artist_profiles')
        if Counter(before) != Counter(connection.execute(f'SELECT * FROM "{temporary}"').fetchall()):
            raise ValueError('Η αλλαγή energy δεν διατήρησε όλες τις τιμές.')
        connection.execute('DROP TABLE artist_profiles')
        connection.execute(f'ALTER TABLE "{temporary}" RENAME TO artist_profiles')
        for statement in indexes:
            connection.execute(statement)
        if connection.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('Η αλλαγή energy δεν διατήρησε τις σχέσεις εγγραφών.')
        connection.commit()
    except BaseException:
        connection.rollback()
        raise


def _schema_initialize(catalog: Path, identity: Path | None) -> None:
    """Apply generated, supported additive DDL only to a private generation."""
    contract = load_schema_contract()
    for label, path in (("catalog", catalog), ("identity", identity)):
        if path is None:
            continue
        descriptor = contract[f"normalized_{label}_schema"]
        statements = contract["initialization_sql"][label]
        with sqlite3.connect(path) as connection:
            if label == 'catalog':
                _widen_legacy_artist_energy(connection)
            for statement in statements:
                if "TABLE " in statement.split("(", 1)[0].upper():
                    statement = re.sub(r"^(CREATE (?:VIRTUAL )?TABLE)\s+", r"\1 IF NOT EXISTS ",
                                       statement, count=1, flags=re.IGNORECASE)
                    connection.execute(statement)
            for table, schema in descriptor["tables"].items():
                quoted = '"' + table.replace('"', '""') + '"'
                existing = {row[1] for row in connection.execute(f"PRAGMA table_xinfo({quoted})")}
                for column, spec in schema["columns"].items():
                    if column in existing:
                        continue
                    if spec["primary_key"] or spec["hidden"] or spec["autoincrement"] or spec["generated"]:
                        raise ValueError("Η αλλαγή σχήματος απαιτεί νεότερη διαδικασία μεταφοράς.")
                    quoted_column = '"' + column.replace('"', '""') + '"'
                    ddl = f"ALTER TABLE {quoted} ADD COLUMN {quoted_column} {spec['affinity']}"
                    if spec["not_null"]:
                        ddl += " NOT NULL"
                    if spec["default"] is not None:
                        ddl += " DEFAULT " + spec["default"]
                    if spec["collation"] != "binary":
                        ddl += ' COLLATE "' + spec["collation"].replace('"', '""') + '"'
                    connection.execute(ddl)
            for statement in statements:
                if "TABLE " not in statement.split("(", 1)[0].upper():
                    statement = re.sub(r"^(CREATE (?:UNIQUE )?INDEX)\s+", r"\1 IF NOT EXISTS ",
                                       statement, count=1, flags=re.IGNORECASE)
                    connection.execute(statement)


def initialize_empty(dataset_root: Path | str, *, lease: HeldLease | None = None) -> ActiveDataset:
    root = Path(dataset_root).expanduser().resolve()
    with _ownership(root, lease):
        if (root / "active.json").exists():
            return resolve_active_dataset(root)
        generation = uuid.uuid4().hex
        directory = root / "datasets" / generation
        directory.mkdir(parents=True)
        catalog = directory / "catalog.sqlite"
        _schema_initialize(catalog, None)
        validate_schema_compatibility(catalog)
        atomic_json(directory / "exchange-state.json", initial_state(str(uuid.uuid4())))
        _pointer(root, generation, False)
        return resolve_active_dataset(root)


def _logical_roots(catalog: Path, configured: list[dict]) -> list[dict]:
    roots = normalized_roots(configured)
    with sqlite3.connect(catalog.resolve().as_uri() + "?mode=ro", uri=True) as db:
        columns = {row[1] for row in db.execute("PRAGMA table_info(tracks)")}
        prefixes = db.execute("SELECT DISTINCT volume_root FROM tracks WHERE volume_root IS NOT NULL AND volume_root!=''").fetchall() if "volume_root" in columns else []
    seen = {(root["logical_prefix"], root["logical_flavor"]) for root in roots}
    for (prefix,) in prefixes:
        flavor = "windows" if "\\" in prefix or (len(prefix) > 1 and prefix[1] == ":") else "posix"
        if (prefix, flavor) not in seen:
            root_key = hashlib.sha256(canonical([prefix, flavor])).hexdigest()[:24]
            roots.append({"root_key": root_key, "logical_prefix": prefix, "logical_flavor": flavor})
            seen.add((prefix, flavor))
    return normalized_roots(roots)


def _snapshot(dataset: ActiveDataset, *, logical_roots: list[dict] | None = None):
    state = load_state(dataset.exchange_state_path)
    backup = create_backup(dataset.catalog_path, dataset.dataset_root / "exchange/snapshots",
                           identity_path=dataset.identity_path, keep=2, reuse=False)
    record = verify_backup(backup)
    catalog = backup / "catalog.sqlite"
    identity = backup / "identity.sqlite" if "identity" in record["databases"] else None
    validate_schema_compatibility(catalog, identity)
    roots = _logical_roots(catalog, state["logical_roots"] if logical_roots is None else logical_roots)
    return backup, record, roots, state_digest(catalog, identity, roots), make_schema_contract(catalog, identity)


def _copy_publish(source: Path, destination: Path) -> None:
    if destination.is_symlink():
        raise ValueError("Ο προορισμός ανταλλαγής δεν μπορεί να είναι συμβολικός σύνδεσμος.")
    if destination.exists():
        if destination.is_file() and sha256(source) == sha256(destination):
            return
        raise FileExistsError("Το αρχείο ανταλλαγής υπάρχει ήδη με διαφορετικό περιεχόμενο.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=".exchange-pending-", dir=destination.parent)
    os.close(descriptor)
    temporary = Path(name)
    try:
        shutil.copyfile(source, temporary)
        _fsync(temporary)
        _atomic_replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def _write_archive(backup: Path, manifest: ExchangeManifestV1, archive: Path) -> None:
    archive.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=".archive-pending-", dir=archive.parent)
    os.close(descriptor)
    temporary = Path(name)
    try:
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_STORED) as output:
            output.writestr("exchange.json", canonical(manifest.to_dict()))
            output.write(backup / "manifest.json", "backup/manifest.json")
            for record in manifest.files.values():
                output.write(backup / record["file"], "backup/" + record["file"])
        _fsync(temporary)
        # Verify the completed standalone container before publication.
        with tempfile.TemporaryDirectory(prefix="verify-", dir=archive.parent) as directory:
            inspect_archive(temporary, Path(directory) / "extracted")
        _atomic_replace(temporary, archive)
    finally:
        temporary.unlink(missing_ok=True)


def _advance(state: dict, manifest: ExchangeManifestV1, archive: Path) -> dict:
    updated = dict(state)
    updated.update({"lineage_id": manifest.lineage_id, "baseline_snapshot_id": manifest.snapshot_id,
                    "baseline_parent_snapshot_id": manifest.parent_snapshot_id,
                    "baseline_digest": manifest.state_digest,
                    "incoming_digest": manifest.state_digest,
                    "baseline_schema_fingerprint": manifest.schema_contract["fingerprint"],
                    "baseline_archive": str(archive), "logical_roots": manifest.logical_roots,
                    "history": list(state.get("history", [])) + [manifest.snapshot_id]})
    return updated



def _prune_archives(root: Path, protected: Path, keep: int = 10) -> None:
    archives = sorted((root / "exchange/archive").glob("*.cmexchange"), key=lambda path: path.stat().st_mtime_ns, reverse=True)
    for archive in archives[keep:]:
        if archive != protected:
            archive.unlink()


def export_exchange(
    dataset_root: Path | str, output: Path | str, *, lease: HeldLease | None = None,
    coordinator: MaintenanceCoordinator = maintenance_coordinator, logical_roots: list[dict] | None = None,
) -> ExchangeResult:
    root = Path(dataset_root).expanduser().resolve()
    raw_destination = Path(output).expanduser()
    if raw_destination.is_symlink():
        raise ValueError("Μη ασφαλής προορισμός ανταλλαγής.")
    destination = raw_destination.resolve()
    if destination.is_relative_to(root) and not (
        destination.is_relative_to(root / "exports") or destination == root / "exchange/onboarding.cmexchange"
    ):
        raise ValueError("Δεν επιτρέπεται export πάνω στα εσωτερικά αρχεία της βιβλιοθήκης.")
    for config in (root / "desktop-config.json", root / "web-path-mappings.json"):
        if config.is_file():
            from ..services.library_paths import parse_mappings
            for mapping in parse_mappings(json.loads(config.read_text())):
                if mapping.local_prefix and destination.is_relative_to(Path(mapping.local_prefix).resolve()):
                    raise ValueError("Το export πρέπει να βρίσκεται εκτός της μουσικής βιβλιοθήκης.")
    if destination.suffix != ".cmexchange":
        raise ValueError("Η πλήρης ανταλλαγή απαιτεί κατάληξη .cmexchange.")
    with _ownership(root, lease), coordinator.enter_maintenance():
        recover_exchange_intent(root)
        dataset = resolve_active_dataset(root)
        state = load_state(dataset.exchange_state_path)
        for descriptor in state["logical_roots"]:
            logical = Path(descriptor["logical_prefix"])
            if logical.is_absolute() and destination.is_relative_to(logical.resolve()):
                raise ValueError("Το export πρέπει να βρίσκεται εκτός της μουσικής βιβλιοθήκης.")
        backup, record, roots, digest, schema = _snapshot(dataset, logical_roots=logical_roots)
        if digest == state["baseline_digest"] and schema["fingerprint"] == state["baseline_schema_fingerprint"]:
            archive = Path(state["baseline_archive"])
            with tempfile.TemporaryDirectory(prefix="replay-", dir=root / "exchange") as directory:
                manifest = inspect_archive(archive, Path(directory) / "extracted")
            if destination != archive:
                _copy_publish(archive, destination)
            return ExchangeResult(destination, manifest, True)
        manifest = ExchangeManifestV1(1, state["lineage_id"], str(uuid.uuid4()), state["baseline_snapshot_id"],
                                      schema, roots, digest, record["databases"])
        archive = root / "exchange/archive" / (manifest.snapshot_id + ".cmexchange")
        _write_archive(backup, manifest, archive)
        updated = _advance(state, manifest, archive)
        intent = {"version": 1, "kind": "export", "generation": dataset.generation,
                  "output": str(destination), "archive": str(archive), "archive_digest": sha256(archive),
                  "old_state": state, "new_state": updated}
        atomic_json(root / "exchange-intent.json", intent)
        if destination != archive:
            _copy_publish(archive, destination)
        atomic_json(dataset.exchange_state_path, updated)
        (root / "exchange-intent.json").unlink()
        _sync_directory(root)
        _prune_archives(root, archive)
        return ExchangeResult(destination, manifest)


def recover_exchange_intent(dataset_root: Path | str) -> RecoveryReport:
    """Called while holding the dataset lease, before normal writers start."""
    root = Path(dataset_root).resolve()
    enrollment = root / "enrollment-intent.json"
    if enrollment.exists():
        _finish_enrollment(root, json.loads(enrollment.read_text()))
        return RecoveryReport(True, "enrollment_committed")
    path = root / "exchange-intent.json"
    if not path.exists():
        return RecoveryReport(False, "none")
    intent = json.loads(path.read_text())
    if intent.get("version") != 1:
        raise ValueError("Μη έγκυρη εκκρεμής ανταλλαγή.")
    if intent["kind"] == "export":
        dataset = resolve_active_dataset(root)
        if dataset.generation != intent["generation"]:
            raise ValueError("Η γενιά άλλαξε κατά τη δημοσίευση της ανταλλαγής.")
        state = load_state(dataset.exchange_state_path)
        if state not in (intent["old_state"], intent["new_state"]):
            raise ValueError("Η κατάσταση άλλαξε κατά τη δημοσίευση της ανταλλαγής.")
        output = Path(intent["output"])
        published = output.is_file() and sha256(output) == intent["archive_digest"]
        if published:
            atomic_json(dataset.exchange_state_path, intent["new_state"])
        elif state == intent["new_state"]:
            # Once baseline committed, a deleted external copy cannot roll it
            # back: the immutable internal archive remains authoritative.
            archive = Path(intent["archive"])
            if not archive.is_file() or sha256(archive) != intent["archive_digest"]:
                raise ValueError("Λείπει το δημοσιευμένο εσωτερικό στιγμιότυπο.")
        path.unlink()
        _sync_directory(root)
        return RecoveryReport(True, "export_committed" if published else "export_abandoned")
    if intent["kind"] == "import":
        pointer = json.loads((root / "active.json").read_text()) if (root / "active.json").exists() else None
        if pointer and pointer.get("generation") == intent["new_generation"]:
            resolve_active_dataset(root)
            action = "import_committed"
        elif (pointer or {}).get("generation") == intent["old_generation"]:
            action = "import_abandoned"
        else:
            raise ValueError("Μη αναμενόμενη ενεργή γενιά κατά την ανάκτηση.")
        path.unlink()
        _sync_directory(root)
        return RecoveryReport(True, action)
    raise ValueError("Μη υποστηριζόμενη εκκρεμής ανταλλαγή.")


def _import_status(manifest: ExchangeManifestV1, state: dict | None, digest: str | None):
    if state is None or (state["baseline_snapshot_id"] is None and not digest):
        return "ready", "Νέα βιβλιοθήκη: θα υιοθετηθεί η εισερχόμενη έκδοση."
    if manifest.lineage_id != state["lineage_id"]:
        return "conflict", "Η εισερχόμενη βιβλιοθήκη έχει διαφορετική ιστορία."
    if manifest.snapshot_id == state["baseline_snapshot_id"]:
        if (manifest.state_digest != state["baseline_digest"] or
            manifest.schema_contract["fingerprint"] != state["baseline_schema_fingerprint"] or
            manifest.parent_snapshot_id != state["baseline_parent_snapshot_id"]):
            raise ValueError("Το αναγνωριστικό στιγμιοτύπου αντιστοιχεί σε διαφορετικό περιεχόμενο.")
        return "replay", "Το στιγμιότυπο έχει ήδη εφαρμοστεί."
    if manifest.snapshot_id in state["history"]:
        return "stale", "Το στιγμιότυπο είναι παλαιότερο από την τρέχουσα βιβλιοθήκη."
    if digest != state["baseline_digest"]:
        return "conflict", "Υπάρχουν τοπικές αλλαγές που δεν έχουν εξαχθεί."
    if manifest.parent_snapshot_id != state["baseline_snapshot_id"]:
        return "conflict", "Η εισερχόμενη έκδοση δεν συνεχίζει το τρέχον στιγμιότυπο."
    return "ready", "Η εισερχόμενη έκδοση συνεχίζει την τρέχουσα βιβλιοθήκη."


def _change_summary(local_backup: Path | None, incoming_backup: Path) -> tuple[dict, ...]:
    from collections import Counter
    labels = {"tracks": "Κομμάτια και αποτελέσματα ανάλυσης", "track_cues": "Cues",
              "tags": "Tags", "track_tags": "Tags κομματιών", "track_dj_profile": "Προφίλ κομματιών",
              "sets": "Sets", "set_tracks": "Κομμάτια των sets", "track_pair_notes": "Σημειώσεις μεταβάσεων",
              "set_transitions": "Μεταβάσεις set",
              "play_events": "Ιστορικό αναπαραγωγής", "artist_profiles": "Προφίλ καλλιτεχνών",
              "artist_reviews": "Αποφάσεις για καλλιτέχνες", "saved_searches": "Αποθηκευμένες αναζητήσεις",
              "entities": "Παρατηρήσεις πηγών", "recordings": "Ηχογραφήσεις",
              "identity_acceptances": "Επιβεβαιωμένες ταυτότητες", "identity_rejections": "Απορριφθείσες ταυτότητες",
              "collections": "Συλλογές", "memberships": "Περιεχόμενα συλλογών",
              "canonical_events": "Αποφάσεις βιβλιοθήκης", "canonical_recordings": "Επιλεγμένα μεταδεδομένα",
              "soundcloud_tracks": "Αποθηκευμένα στοιχεία SoundCloud",
              "track_soundcloud_matches": "Αντιστοιχίσεις SoundCloud",
              "track_beatgrids": "Beatgrids από djay",
              "track_downbeats": "Downbeat κομματιών",
              "facets": "Λεξιλόγια"}
    result = []
    for database in ("catalog", "identity"):
        local_path = local_backup / f"{database}.sqlite" if local_backup else None
        incoming_path = incoming_backup / f"{database}.sqlite"
        local = canonical_database_values(local_path) if local_path and local_path.is_file() else {}
        incoming = canonical_database_values(incoming_path) if incoming_path.is_file() else {}
        for table in sorted(local.keys() | incoming.keys()):
            left = Counter(canonical(row) for row in local.get(table, []))
            right = Counter(canonical(row) for row in incoming.get(table, []))
            local_only, incoming_only = sum((left - right).values()), sum((right - left).values())
            if local_only or incoming_only:
                result.append({"database": database, "table": table,
                    "label": labels.get(table, "Άλλα στοιχεία ταυτοποίησης" if database == "identity" else "Άλλα στοιχεία βιβλιοθήκης"),
                    "local_rows": sum(left.values()), "incoming_rows": sum(right.values()),
                    "local_only": local_only, "incoming_only": incoming_only})
    return tuple(result)


def prepare_import(
    bundle: Path | str, dataset_root: Path | str | None = None, *,
    coordinator: MaintenanceCoordinator = maintenance_coordinator, lease: HeldLease | None = None,
) -> ImportPreview:
    root = Path(dataset_root).expanduser().resolve() if dataset_root is not None else None
    preview_id = uuid.uuid4().hex
    staging_root = root / "exchange/previews" if root is not None else Path(tempfile.mkdtemp(prefix="cratemind-exchange-preview-"))
    staging = staging_root / preview_id
    staging.mkdir(parents=True, mode=0o700)
    archive = staging / "incoming.cmexchange"
    try:
        # Copy once; later helper consumes this immutable private input, never
        # the caller's changeable external path.
        shutil.copyfile(bundle, archive)
        manifest = inspect_archive(archive, staging / "verified")
        state, digest, generation, backup = None, None, None, None
        ownership = _ownership(root, lease) if root is not None else nullcontext()
        with ownership, coordinator.enter_maintenance():
            if root is not None and (root / "active.json").exists():
                dataset = resolve_active_dataset(root)
                generation = dataset.generation
                state = load_state(dataset.exchange_state_path)
                backup, _record, _roots, digest, _schema = _snapshot(dataset)
                if state["baseline_snapshot_id"] is None:
                    # A newly initialized schema-only destination may adopt an
                    # incoming lineage; human/provider data requires conflict.
                    values = canonical_database_values(backup / "catalog.sqlite")
                    if not values and dataset.identity_path is None:
                        digest = None
            changes = _change_summary(backup, staging / "verified/backup")
        status, reason = _import_status(manifest, state, digest)
        preview = ImportPreview(preview_id, root, archive, sha256(archive), manifest, digest,
                                state["baseline_snapshot_id"] if state else None, generation, status, reason,
                                time.time() + 15 * 60, state["lineage_id"] if state else None, changes)
        payload = preview.to_dict() | {"dataset_root": str(root) if root else None,
                                      "archive_path": str(archive)}
        atomic_json(staging / "preview.json", payload)
        return preview
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise


def load_import_preview(dataset_root: Path | str, preview_id: str) -> ImportPreview:
    if len(preview_id) != 32 or any(character not in "0123456789abcdef" for character in preview_id):
        raise ValueError("Μη έγκυρη προεπισκόπηση ανταλλαγής.")
    root = Path(dataset_root).resolve()
    staging = root / "exchange/previews" / preview_id
    value = json.loads((staging / "preview.json").read_text())
    if value["dataset_root"] != str(root) or value["archive_path"] != str(staging / "incoming.cmexchange"):
        raise ValueError("Η προεπισκόπηση δεν ανήκει στην ενεργή βιβλιοθήκη.")
    if time.time() > value["expires_at"]:
        raise ValueError("Η προεπισκόπηση έληξε. Απαιτείται νέα προεπισκόπηση.")
    return ImportPreview(preview_id, root, Path(value["archive_path"]), value["archive_digest"],
                         ExchangeManifestV1.from_dict(value["manifest"]), value["local_digest"],
                         value["local_snapshot_id"], value["local_generation"], value["status"], value["reason"], value["expires_at"],
                         value.get("local_lineage_id"), tuple(value.get("change_summary", [])))


def apply_import(
    preview: ImportPreview, stopped_paths: Path | str, *, decision: str = "import",
    confirmation_digest: str | None = None,
) -> VerifiedDataset:
    root = Path(stopped_paths).expanduser().resolve()
    if preview.dataset_root is not None and preview.dataset_root != root:
        raise ValueError("Η προεπισκόπηση ανήκει σε διαφορετική βιβλιοθήκη.")
    if time.time() > preview.expires_at:
        raise ValueError("Η προεπισκόπηση έληξε. Απαιτείται νέα προεπισκόπηση.")
    if decision not in {"import", "replace"}:
        raise ValueError("Μη υποστηριζόμενη απόφαση ανταλλαγής.")
    with _ownership(root, None):
        recover_exchange_intent(root)
        if sha256(preview.archive_path) != preview.archive_digest:
            raise ValueError("Το αρχείο άλλαξε μετά την προεπισκόπηση.")
        staging = Path(tempfile.mkdtemp(prefix=".import-", dir=root))
        try:
            manifest = inspect_archive(preview.archive_path, staging / "verified")
            if manifest != preview.manifest:
                raise ValueError("Το manifest άλλαξε μετά την προεπισκόπηση.")
            dataset = resolve_active_dataset(root) if (root / "active.json").exists() else None
            state, digest, backup = None, None, None
            if dataset is not None:
                state = load_state(dataset.exchange_state_path)
                backup, _record, roots, digest, schema = _snapshot(dataset)
                if state["baseline_snapshot_id"] is None and not canonical_database_values(backup / "catalog.sqlite") and dataset.identity_path is None:
                    digest = None
            if (dataset.generation if dataset else None) != preview.local_generation or digest != preview.local_digest or (state["baseline_snapshot_id"] if state else None) != preview.local_snapshot_id:
                raise ValueError("Η τοπική βιβλιοθήκη άλλαξε. Απαιτείται νέα προεπισκόπηση.")
            status, reason = _import_status(manifest, state, digest)
            if status == "replay":
                return VerifiedDataset(dataset, manifest.snapshot_id, no_op=True)
            if status == "stale":
                raise ValueError(reason)
            conflict_archive = None
            if status == "conflict":
                if decision != "replace" or confirmation_digest != digest:
                    raise ValueError(reason + " Απαιτείται επιβεβαίωση της τρέχουσας προεπισκόπησης.")
                local_manifest = ExchangeManifestV1(1, state["lineage_id"], str(uuid.uuid4()), state["baseline_snapshot_id"], schema, roots, digest, verify_backup(backup)["databases"])
                conflict_archive = root / "exchange/conflicts" / (local_manifest.snapshot_id + ".cmexchange")
                _write_archive(backup, local_manifest, conflict_archive)
            elif decision == "replace":
                raise ValueError("Δεν υπάρχει σύγκρουση για αντικατάσταση.")
            generation = uuid.uuid4().hex
            directory = root / "datasets" / generation
            restore_backup(staging / "verified/backup", directory)
            catalog = directory / "catalog.sqlite"
            identity = directory / "identity.sqlite" if "identity" in manifest.files else None
            _schema_initialize(catalog, identity)
            validate_schema_compatibility(catalog, identity)
            archive = root / "exchange/archive" / (manifest.snapshot_id + ".cmexchange")
            _copy_publish(preview.archive_path, archive)
            incoming_state = _advance(state if state and state["lineage_id"] == manifest.lineage_id else initial_state(manifest.lineage_id), manifest, archive)
            incoming_state["post_initialization_digest"] = state_digest(catalog, identity, manifest.logical_roots)
            atomic_json(directory / "exchange-state.json", incoming_state)
            _sync_directory(directory)
            atomic_json(root / "exchange-intent.json", {"version": 1, "kind": "import",
                        "old_generation": dataset.generation if dataset else None, "new_generation": generation})
            _pointer(root, generation, identity is not None)
            (root / "exchange-intent.json").unlink()
            _sync_directory(root)
            return VerifiedDataset(resolve_active_dataset(root), manifest.snapshot_id, archive, conflict_archive)
        finally:
            shutil.rmtree(staging, ignore_errors=True)


def _source_signatures(originals: dict[str, Path]) -> dict:
    result = {}
    for label, original in originals.items():
        for suffix in ("", "-wal"):
            path = Path(str(original) + suffix)
            if path.exists():
                info = path.stat()
                result[label + suffix] = [info.st_size, info.st_mtime_ns, info.st_ino, sha256(path)]
    return result


def _finish_enrollment(root: Path, intent: dict) -> None:
    """Recover the marker/pointer window without reopening original SQLite files."""
    if intent.get("version") != 1 or not re.fullmatch(r"[a-f0-9]{32}", intent.get("generation", "")):
        raise ValueError("Μη έγκυρη εκκρεμής εγγραφή βιβλιοθήκης.")
    originals = {key: Path(value) for key, value in intent["originals"].items()}
    if _source_signatures(originals) != intent["source_signatures"]:
        raise ValueError("Η αρχική βιβλιοθήκη άλλαξε κατά την εγγραφή. Διατηρούνται και τα δύο αντίγραφα.")
    directory = root / "datasets" / intent["generation"]
    identity = directory / "identity.sqlite" if "identity" in originals else None
    validate_schema_compatibility(directory / "catalog.sqlite", identity)
    load_state(directory / "exchange-state.json")
    for original in originals.values():
        atomic_json(retired_source_marker(original), {"version": 1, "dataset_root": str(root)})
    _pointer(root, intent["generation"], identity is not None)
    (root / "enrollment-intent.json").unlink()
    _sync_directory(root)


def enroll(
    catalog: Path | str, identity: Path | str | None, data_dir: Path | str, *,
    logical_roots: list[dict] | None = None,
) -> VerifiedDataset:
    """Enroll explicitly stopped originals; SQLite opens only private copies."""
    root = Path(data_dir).expanduser().resolve()
    originals = {"catalog": Path(catalog).expanduser().resolve(strict=True)}
    if identity is not None:
        originals["identity"] = Path(identity).expanduser().resolve(strict=True)
    if len(set(originals.values())) != len(originals):
        raise ValueError("Catalog and identity must be distinct")
    def signatures():
        return _source_signatures(originals)
    with _ownership(root, None) as held:
        recover_exchange_intent(root)
        if (root / "active.json").exists():
            markers_match = all(retired_source_marker(path).is_file() and
                                json.loads(retired_source_marker(path).read_text()).get("dataset_root") == str(root)
                                for path in originals.values())
            if markers_match:
                dataset = resolve_active_dataset(root)
                state = load_state(dataset.exchange_state_path)
                if state["baseline_snapshot_id"] is None:
                    result = export_exchange(root, root / "exchange/onboarding.cmexchange", lease=held)
                    return VerifiedDataset(dataset, result.manifest.snapshot_id, result.path,
                                           path_mappings_file=root / "web-path-mappings.json")
                return VerifiedDataset(dataset, state["baseline_snapshot_id"], Path(state["baseline_archive"]),
                                       path_mappings_file=root / "web-path-mappings.json")
            raise FileExistsError("Η βιβλιοθήκη έχει ήδη εγγραφεί.")
        if any(retired_source_marker(path).exists() for path in originals.values()):
            raise ValueError("Η αρχική βάση έχει ήδη μεταφερθεί σε ενεργή βιβλιοθήκη.")
        before = signatures()
        staging = Path(tempfile.mkdtemp(prefix=".enroll-", dir=root))
        try:
            for label, original in originals.items():
                target = staging / (label + ".sqlite")
                shutil.copyfile(original, target)
                wal = Path(str(original) + "-wal")
                if wal.exists():
                    shutil.copyfile(wal, Path(str(target) + "-wal"))
            if signatures() != before:
                raise ValueError("Η αρχική βιβλιοθήκη γράφεται ακόμη. Σταματήστε την εφαρμογή.")
            backup = create_backup(staging / "catalog.sqlite", root / "exchange/enrollment-backups",
                                   identity_path=staging / "identity.sqlite" if identity else None, keep=None, reuse=False)
            generation = uuid.uuid4().hex
            directory = root / "datasets" / generation
            restore_backup(backup, directory)
            selected_identity = directory / "identity.sqlite" if identity else None
            _schema_initialize(directory / "catalog.sqlite", selected_identity)
            validate_schema_compatibility(directory / "catalog.sqlite", selected_identity)
            roots = _logical_roots(directory / "catalog.sqlite", logical_roots or [])
            mappings = {"version": 1, "library_roots": [dict(
                descriptor, local_prefix=descriptor["logical_prefix"], enabled=True,
            ) for descriptor in roots]}
            from ..services.library_paths import parse_mappings
            parse_mappings(mappings)
            mappings_path = root / "web-path-mappings.json"
            atomic_json(mappings_path, mappings)
            atomic_json(directory / "exchange-state.json", initial_state(str(uuid.uuid4()), roots))
            if signatures() != before:
                raise ValueError("Η αρχική βιβλιοθήκη άλλαξε κατά την εγγραφή.")
            intent = {"version": 1, "generation": generation,
                      "originals": {label: str(path) for label, path in originals.items()},
                      "source_signatures": before}
            atomic_json(root / "enrollment-intent.json", intent)
            _finish_enrollment(root, intent)
            # The nested export uses the same held service/CLI lease.
            # Enrollment publishes S0 before returning the root to a runner.
        finally:
            shutil.rmtree(staging, ignore_errors=True)
        result = export_exchange(root, root / "exchange/onboarding.cmexchange", lease=held)
        return VerifiedDataset(resolve_active_dataset(root), result.manifest.snapshot_id, result.path,
                               path_mappings_file=mappings_path)


# Compatibility names used by the boot/onboarding adapter.
create_empty_dataset = initialize_empty
