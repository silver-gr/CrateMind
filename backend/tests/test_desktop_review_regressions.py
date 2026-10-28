"""Regression proofs for independently reproduced migration review findings."""
import hashlib
import json
import os
import sqlite3
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.library_exchange import operations as exchange
from app.library_exchange.state import atomic_json, load_state
from app.services.active_dataset import resolve_active_dataset, retired_source_marker
from app.services.dataset_access import DatasetLease
from app.services.schema_contract import load_schema_contract


def test_enrollment_recovers_between_retirement_markers_and_active_pointer(tmp_path, monkeypatch):
    original, root = tmp_path / "original.sqlite", tmp_path / "replica"
    with sqlite3.connect(original) as db:
        for sql in load_schema_contract()["initialization_sql"]["catalog"]:
            db.execute(sql)
        db.execute("INSERT INTO tags(name) VALUES('preserved')")
    before = (hashlib.sha256(original.read_bytes()).hexdigest(), original.stat().st_mtime_ns)
    with monkeypatch.context() as patch:
        def interrupted(*args):
            raise OSError("pointer publication interrupted")
        patch.setattr(exchange, "_pointer", interrupted)
        with pytest.raises(OSError):
            exchange.enroll(original, None, root)
    assert (root / "enrollment-intent.json").is_file()
    with DatasetLease.acquire(root, "recovery"):
        assert exchange.recover_exchange_intent(root).action == "enrollment_committed"
    assert resolve_active_dataset(root).catalog_path.is_file()
    assert retired_source_marker(original).is_file()
    resumed = exchange.enroll(original, None, root)
    assert resumed.archive_path.is_file()
    assert len(list((root / "datasets").iterdir())) == 1
    assert before == (hashlib.sha256(original.read_bytes()).hexdigest(), original.stat().st_mtime_ns)


def test_replayed_id_requires_exact_original_content_but_allows_local_edits(tmp_path):
    root = tmp_path / "replica"
    dataset = exchange.initialize_empty(root)
    result = exchange.export_exchange(root, tmp_path / "baseline.cmexchange")
    state = load_state(dataset.exchange_state_path)
    assert exchange._import_status(result.manifest, state, "locally-dirty")[0] == "replay"
    for altered in (replace(result.manifest, state_digest="0" * 64),
                    replace(result.manifest, parent_snapshot_id="another-parent")):
        with pytest.raises(ValueError, match="διαφορετικό περιεχόμενο"):
            exchange._import_status(altered, state, state["baseline_digest"])


def test_shared_export_refuses_music_and_internal_archives_and_overwrite(tmp_path):
    root, music = tmp_path / "replica", tmp_path / "music"
    music.mkdir()
    dataset = exchange.initialize_empty(root)
    state = load_state(dataset.exchange_state_path)
    state["logical_roots"] = [{"root_key": "source", "logical_prefix": str(music), "logical_flavor": "posix"}]
    atomic_json(dataset.exchange_state_path, state)
    for dest in (music / "bad.cmexchange", root / "exchange/archive/bad.cmexchange"):
        with pytest.raises(ValueError):
            exchange.export_exchange(root, dest)
        assert not dest.exists()
    existing = tmp_path / "existing.cmexchange"
    existing.write_bytes(b"previous user file")
    with pytest.raises(FileExistsError):
        exchange.export_exchange(root, existing)
    assert existing.read_bytes() == b"previous user file"


@pytest.mark.skipif(os.name == "nt", reason="POSIX directory permission invariant")
def test_detached_preview_is_private_even_with_public_umask(tmp_path):
    root = tmp_path / "replica"
    exchange.initialize_empty(root)
    bundle = exchange.export_exchange(root, tmp_path / "one.cmexchange")
    old_umask = os.umask(0o022)
    try:
        preview = exchange.prepare_import(bundle.path)
    finally:
        os.umask(old_umask)
    assert preview.archive_path.parent.stat().st_mode & 0o077 == 0


def test_asset_retirement_uses_mapped_survivor_and_fails_closed(tmp_path, monkeypatch):
    from app import config
    from app.services import manual_identity, library_paths
    music, catalog = tmp_path / "device-B", tmp_path / "catalog.sqlite"
    music.mkdir()
    (music / "survivor.wav").write_bytes(b"immutable audio fixture")
    mappings = tmp_path / "mappings.json"
    atomic_json(mappings, {"version": 1, "library_roots": [{"root_key": "library",
        "logical_prefix": "/__missing_device_A__", "logical_flavor": "posix",
        "local_prefix": str(music), "enabled": True}]})
    with sqlite3.connect(catalog) as db:
        db.executescript("CREATE TABLE tracks(id INTEGER PRIMARY KEY,absolute_path TEXT);"
                         "CREATE TABLE audit_log(id INTEGER,action TEXT,entity_id INTEGER,before_json TEXT,after_json TEXT);")
        db.execute("INSERT INTO tracks VALUES(2,?)", ("/__missing_device_A__/survivor.wav",))
        db.execute("INSERT INTO audit_log VALUES(1,'merge_missing_duplicate',1,?,?)",
                   (json.dumps({"absolute_path": "/__missing_device_A__/obsolete.wav"}), json.dumps({"keep": 2})))
    monkeypatch.setattr(config, "get_settings", lambda: SimpleNamespace(
        db_file=catalog, dataset_root="", path_mappings_file=str(mappings)))
    library_paths._read_mappings.cache_clear()
    with sqlite3.connect(":memory:") as db:
        db.row_factory = sqlite3.Row
        db.executescript("CREATE TABLE entities(id TEXT,service TEXT,metadata_json TEXT,recording_id TEXT);"
                         "CREATE TABLE canonical_events(recording_id TEXT,action TEXT,before_json TEXT,after_json TEXT,created_at TEXT);")
        db.execute("INSERT INTO entities VALUES('local:1','local','{}','local:1')")
        db.commit()
        assert manual_identity.retire(db, "local:1", "local:2")["retired"]
        db.rollback()
        (music / "obsolete.wav").write_bytes(b"still present")
        with pytest.raises(ValueError, match="still exists"):
            manual_identity.retire(db, "local:1", "local:2")
    assert (music / "survivor.wav").read_bytes() == b"immutable audio fixture"


def test_valid_replacement_reconciles_device_roots_and_preserves_old_binding(tmp_path):
    from app.desktop_runtime.config import read_config
    from app.services.library_paths import load_path_mappings, resolve_source_path, PathResolutionError
    from app.library_exchange.manifest import normalized_roots
    with pytest.raises(ValueError):
        normalized_roots([{"root_key": "relative", "logical_prefix": "relative/music", "logical_flavor": "posix"}])
    a, b, music = tmp_path / "A", tmp_path / "B", tmp_path / "local-music"
    music.mkdir()
    first, second = exchange.initialize_empty(a), exchange.initialize_empty(b)
    roots = {}
    for key, dataset in (("A", first), ("B", second)):
        descriptor = {"root_key": key, "logical_prefix": "/Music", "logical_flavor": "posix"}
        roots[key] = descriptor
        atomic_json(dataset.exchange_state_path, {**load_state(dataset.exchange_state_path), "logical_roots": [descriptor]})
    config_file = a / "desktop-config.json"
    atomic_json(config_file, {"version": 1, "revision": "fixture", "library_roots": [
        {**roots["A"], "local_prefix": str(music), "enabled": True}]})
    exchange.export_exchange(a, tmp_path / "A.cmexchange")
    incoming = exchange.export_exchange(b, tmp_path / "B.cmexchange")
    preview = exchange.prepare_import(incoming.path, a)
    assert preview.conflict
    exchange.apply_import(preview, a, decision="replace", confirmation_digest=preview.local_digest)
    config = read_config(a)
    assert config["library_roots"] == [{**roots["B"], "local_prefix": None, "enabled": True}]
    assert config["inactive_library_roots"][0]["root_key"] == "A"
    mappings = load_path_mappings(SimpleNamespace(dataset_root=str(a), path_mappings_file=str(config_file)))
    with pytest.raises(PathResolutionError, match="unmapped"):
        resolve_source_path("/Music/song.wav", mappings)


def test_conflict_preview_explains_changed_state_families(tmp_path):
    root = tmp_path / "A"
    local = exchange.initialize_empty(root)
    baseline = exchange.export_exchange(root, tmp_path / "base.cmexchange")
    clone = exchange.apply_import(exchange.prepare_import(baseline.path, tmp_path / "B"), tmp_path / "B").dataset
    with sqlite3.connect(local.catalog_path) as db:
        db.execute("INSERT INTO tags(name) VALUES('local-only')")
    with sqlite3.connect(clone.catalog_path) as db:
        db.execute("INSERT INTO tags(name) VALUES('incoming-only')")
    incoming = exchange.export_exchange(clone.dataset_root, tmp_path / "incoming.cmexchange")
    preview = exchange.prepare_import(incoming.path, root)
    assert preview.conflict and preview.local_lineage_id == incoming.manifest.lineage_id
    tags = next(item for item in preview.change_summary if item["table"] == "tags")
    assert tags["local_only"] == tags["incoming_only"] == 1
    assert exchange.load_import_preview(root, preview.preview_id).change_summary == preview.change_summary
