"""Complete handoff tests use only production-generated temporary databases."""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from app.library_exchange import operations as exchange
from app.library_exchange.manifest import inspect_archive, state_digest
from app.library_exchange.state import load_state
from app.services.active_dataset import resolve_active_dataset, retired_source_marker
from app.services.dataset_access import (
    DatasetBusyError,
    DatasetLease,
    MaintenanceBusyError,
    MaintenanceCoordinator,
)
from app.services.schema_contract import load_schema_contract


def add_tag(dataset, value):
    with sqlite3.connect(dataset.catalog_path) as db:
        db.execute("INSERT INTO tags(name) VALUES (?)", (value,))


def tags(dataset):
    with sqlite3.connect(dataset.catalog_path) as db:
        return [row[0] for row in db.execute("SELECT name FROM tags ORDER BY name")]


def export(root, path):
    return exchange.export_exchange(root, path)


def test_two_way_lineage_repeated_immutable_export_and_replay(tmp_path):
    a, b = tmp_path / "A", tmp_path / "B"
    first = exchange.initialize_empty(a)
    add_tag(first, "Ενέργεια")
    s0 = export(a, tmp_path / "S0.cmexchange")
    adopted = exchange.apply_import(exchange.prepare_import(s0.path, b), b)
    assert tags(adopted.dataset) == ["Ενέργεια"]
    repeated = export(a, tmp_path / "S0-again.cmexchange")
    assert repeated.reused
    assert repeated.manifest == s0.manifest
    assert repeated.path.read_bytes() == s0.path.read_bytes()
    s0.path.unlink()  # external archive loss cannot break unchanged re-export
    assert export(a, tmp_path / "S0-third.cmexchange").reused
    add_tag(adopted.dataset, "Νυχτερινό")
    s1 = export(b, tmp_path / "S1.cmexchange")
    assert s1.manifest.parent_snapshot_id == s0.manifest.snapshot_id
    returned = exchange.apply_import(exchange.prepare_import(s1.path, a), a)
    assert returned.dataset.generation != first.generation
    assert tags(returned.dataset) == ["Ενέργεια", "Νυχτερινό"]
    assert first.catalog_path.exists()  # rollback generation retained
    assert exchange.apply_import(exchange.prepare_import(s1.path, a), a).no_op
    with pytest.raises(ValueError, match="παλαιότερο"):
        exchange.apply_import(exchange.prepare_import(repeated.path, a), a)


def test_local_edits_refuse_then_explicit_replacement_archives_and_continues(tmp_path):
    a, b = tmp_path / "A", tmp_path / "B"
    first = exchange.initialize_empty(a)
    add_tag(first, "base")
    s0 = export(a, tmp_path / "base.cmexchange")
    adopted = exchange.apply_import(exchange.prepare_import(s0.path, b), b)
    add_tag(first, "local-only")
    add_tag(adopted.dataset, "incoming-only")
    s1 = export(b, tmp_path / "incoming.cmexchange")
    preview = exchange.prepare_import(s1.path, a)
    assert preview.conflict
    with pytest.raises(ValueError):
        exchange.apply_import(preview, a)
    with pytest.raises(ValueError):
        exchange.apply_import(preview, a, decision="replace", confirmation_digest="stale")
    replaced = exchange.apply_import(preview, a, decision="replace", confirmation_digest=preview.local_digest)
    assert tags(replaced.dataset) == ["base", "incoming-only"]
    assert tags(first) == ["base", "local-only"]
    archived = inspect_archive(replaced.conflict_archive, tmp_path / "conflict-view")
    assert archived.state_digest == preview.local_digest
    with sqlite3.connect(tmp_path / "conflict-view/backup/catalog.sqlite") as db:
        assert db.execute("SELECT name FROM tags WHERE name='local-only'").fetchone()
    add_tag(replaced.dataset, "next")
    s2 = export(a, tmp_path / "next.cmexchange")
    assert s2.manifest.parent_snapshot_id == s1.manifest.snapshot_id
    assert tags(exchange.apply_import(exchange.prepare_import(s2.path, b), b).dataset) == ["base", "incoming-only", "next"]


def test_preview_staleness_busy_idle_service_and_mutated_archive_refused(tmp_path):
    a, b = tmp_path / "A", tmp_path / "B"
    source = exchange.initialize_empty(a)
    add_tag(source, "base")
    s0 = export(a, tmp_path / "source.cmexchange")
    local = exchange.initialize_empty(b)
    preview = exchange.prepare_import(s0.path, b)
    with DatasetLease.acquire(b, "idle-service"), pytest.raises(DatasetBusyError):
        exchange.apply_import(preview, b)
    add_tag(local, "changed-after-preview")
    with pytest.raises(ValueError, match="νέα προεπισκόπηση"):
        exchange.apply_import(preview, b)
    preview = exchange.prepare_import(s0.path, b)
    with preview.archive_path.open("ab") as stream:
        stream.write(b"changed")
    with pytest.raises(ValueError, match="άλλαξε"):
        exchange.apply_import(preview, b)
    assert tags(local) == ["changed-after-preview"]


def test_export_waits_for_operation_reservation_and_uses_existing_service_lease(tmp_path):
    root = tmp_path / "A"
    exchange.initialize_empty(root)
    coordinator = MaintenanceCoordinator()
    reservation = coordinator.start_operation("scan-final-sync")
    with DatasetLease.acquire(root, "service") as lease:
        with pytest.raises(MaintenanceBusyError), coordinator.enter_maintenance(0):
            exchange.export_exchange(root, tmp_path / "busy.cmexchange", lease=lease, coordinator=coordinator)
        reservation.close()
        result = exchange.export_exchange(root, tmp_path / "ready.cmexchange", lease=lease, coordinator=coordinator)
        assert result.path.exists()


def test_full_identity_and_catalog_values_survive_roundtrip(tmp_path):
    root = tmp_path / "A"
    dataset = exchange.initialize_empty(root)
    identity = dataset.generation_dir / "identity.sqlite"
    with sqlite3.connect(identity) as db:
        for sql in load_schema_contract()["initialization_sql"]["identity"]:
            db.execute(sql)
        db.execute("INSERT INTO recordings VALUES('chosen','Track','ACCEPTED')")
        db.execute("INSERT INTO canonical_events(recording_id,action,after_json,created_at) VALUES('chosen','edit','{\"title\":\"Human\"}','now')")
        db.execute("INSERT INTO metadata VALUES('provider','{\"bpm\":123,\"source\":\"Spotify\"}')")
    pointer = json.loads((root / "active.json").read_text())
    pointer["identity"] = "identity.sqlite"
    (root / "active.json").write_text(json.dumps(pointer))
    dataset = resolve_active_dataset(root)
    bundle = export(root, tmp_path / "paired.cmexchange")
    clone = exchange.apply_import(exchange.prepare_import(bundle.path, tmp_path / "B"), tmp_path / "B").dataset
    assert state_digest(dataset.catalog_path, identity, []) == state_digest(clone.catalog_path, clone.identity_path, [])


def test_enrollment_preserves_source_wal_bytes_and_markers_and_cli(tmp_path):
    original = tmp_path / "original.sqlite"
    schema = load_schema_contract()["initialization_sql"]["catalog"]
    connection = sqlite3.connect(original)
    for statement in schema:
        connection.execute(statement)
    connection.commit()
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA wal_autocheckpoint=0")
    connection.execute("INSERT INTO tags(name) VALUES('WAL-only')")
    connection.commit()
    paths = [original, Path(str(original) + "-wal"), Path(str(original) + "-shm")]
    before = {str(path): (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns) for path in paths}
    try:
        result = exchange.enroll(original, None, tmp_path / "enrolled")
        assert tags(result.dataset) == ["WAL-only"]
        assert retired_source_marker(original).exists()
        assert {str(path): (hashlib.sha256(path.read_bytes()).hexdigest(), path.stat().st_mtime_ns) for path in paths} == before
        assert result.archive_path.exists()
        env = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1]))
        command = [sys.executable, "-m", "app.library_exchange.cli", "inspect", "--bundle", str(result.archive_path)]
        process = subprocess.run(command, capture_output=True, text=True, env=env, check=False)
        assert process.returncode == 0, process.stderr
        assert json.loads(process.stdout)["manifest"]["snapshot_id"] == result.snapshot_id
    finally:
        connection.close()


def test_additive_null_column_import_remains_clean_and_missing_column_materializes(tmp_path):
    a, b = tmp_path / "old", tmp_path / "new"
    source = exchange.initialize_empty(a)
    add_tag(source, "old-schema")
    with sqlite3.connect(source.catalog_path) as db:
        db.execute("ALTER TABLE tracks DROP COLUMN cyanite_error")
    old = export(a, tmp_path / "old.cmexchange")
    adopted = exchange.apply_import(exchange.prepare_import(old.path, b), b)
    with sqlite3.connect(adopted.dataset.catalog_path) as db:
        assert "cyanite_error" in {row[1] for row in db.execute("PRAGMA table_info(tracks)")}
    state = load_state(adopted.dataset.exchange_state_path)
    assert state["incoming_digest"] == state["post_initialization_digest"]
    assert state_digest(adopted.dataset.catalog_path, None, []) == old.manifest.state_digest


def test_empty_initializer_never_imports_application_db(tmp_path):
    source = """
import sys
from app.library_exchange.operations import initialize_empty
assert 'app.db' not in sys.modules
initialize_empty(sys.argv[1])
assert 'app.db' not in sys.modules
"""
    process = subprocess.run([sys.executable, "-c", source, str(tmp_path / "empty")],
                             capture_output=True, text=True, check=False)
    assert process.returncode == 0, process.stderr


def test_expired_preview_refused_and_load_is_root_bound(tmp_path, monkeypatch):
    root = tmp_path / "A"
    exchange.initialize_empty(root)
    snapshot = export(root, tmp_path / "base.cmexchange")
    preview = exchange.prepare_import(snapshot.path, tmp_path / "B")
    assert exchange.load_import_preview(tmp_path / "B", preview.preview_id) == preview
    with monkeypatch.context() as patch:
        patch.setattr(exchange.time, "time", lambda: preview.expires_at + 1)
        with pytest.raises(ValueError, match="έληξε"):
            exchange.apply_import(preview, tmp_path / "B")
        with pytest.raises(ValueError, match="έληξε"):
            exchange.load_import_preview(tmp_path / "B", preview.preview_id)


def test_preview_requires_stopped_owner_or_exact_service_lease(tmp_path):
    root = tmp_path / "A"
    exchange.initialize_empty(root)
    result = export(root, tmp_path / "snapshot.cmexchange")
    with DatasetLease.acquire(root, "idle-service") as lease:
        with pytest.raises(DatasetBusyError):
            exchange.prepare_import(result.path, root)
        preview = exchange.prepare_import(result.path, root, lease=lease)
        assert preview.status == "replay"
