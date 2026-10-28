from __future__ import annotations

import shutil
import stat
import zipfile

import pytest

from app.library_exchange import operations as exchange
from app.library_exchange.manifest import inspect_archive
from app.library_exchange.state import load_state
from app.services.active_dataset import resolve_active_dataset


def bundle(tmp_path):
    dataset = exchange.initialize_empty(tmp_path / "A")
    result = exchange.export_exchange(dataset.dataset_root, tmp_path / "valid.cmexchange")
    return dataset, result


@pytest.mark.parametrize("name", ["../escape", "/absolute", "backup/../escape", "unexpected"])
def test_unsafe_archive_members_refused_before_extract(tmp_path, name):
    _dataset, valid = bundle(tmp_path)
    invalid = tmp_path / "unsafe.cmexchange"
    shutil.copyfile(valid.path, invalid)
    with zipfile.ZipFile(invalid, "a") as output:
        output.writestr(name, b"bad")
    with pytest.raises(ValueError):
        inspect_archive(invalid, tmp_path / "extracted")
    assert not (tmp_path / "extracted").exists()


def test_duplicate_symlink_truncation_checksum_and_low_space(tmp_path, monkeypatch):
    _dataset, valid = bundle(tmp_path)
    for kind in ("duplicate", "symlink", "checksum", "truncated"):
        invalid = tmp_path / f"{kind}.cmexchange"
        with zipfile.ZipFile(valid.path) as source, zipfile.ZipFile(invalid, "w") as target:
            for entry in source.infolist():
                data = source.read(entry)
                if kind == "checksum" and entry.filename == "backup/catalog.sqlite":
                    data = b"broken" + data[6:]
                if kind == "symlink" and entry.filename == "backup/catalog.sqlite":
                    entry.external_attr = (stat.S_IFLNK | 0o777) << 16
                target.writestr(entry, data)
            if kind == "duplicate":
                with pytest.warns(UserWarning):
                    target.writestr("exchange.json", b"{}")
        if kind == "truncated":
            invalid.write_bytes(invalid.read_bytes()[:100])
        with pytest.raises((ValueError, zipfile.BadZipFile)):
            inspect_archive(invalid, tmp_path / f"extract-{kind}")
    with monkeypatch.context() as patch:
        patch.setattr(shutil, "disk_usage", lambda path: shutil._ntuple_diskusage(1, 1, 0))
        with pytest.raises(OSError):
            inspect_archive(valid.path, tmp_path / "low-space")


def test_export_failure_does_not_advance_baseline_and_recovers_published_intent(tmp_path, monkeypatch):
    dataset, first = bundle(tmp_path)
    import sqlite3
    with sqlite3.connect(dataset.catalog_path) as db:
        db.execute("INSERT INTO tags(name) VALUES('edit')")
    old_state = load_state(dataset.exchange_state_path)
    with monkeypatch.context() as patch:
        patch.setattr(exchange, "_copy_publish", lambda *args: (_ for _ in ()).throw(OSError("publish failed")))
        with pytest.raises(OSError):
            exchange.export_exchange(dataset.dataset_root, tmp_path / "failed.cmexchange")
    assert load_state(dataset.exchange_state_path) == old_state
    assert exchange.recover_exchange_intent(dataset.dataset_root).action == "export_abandoned"
    with monkeypatch.context() as patch:
        real_atomic = exchange.atomic_json
        def fail_baseline(path, value):
            if path == dataset.exchange_state_path:
                raise OSError("baseline interrupted")
            return real_atomic(path, value)
        patch.setattr(exchange, "atomic_json", fail_baseline)
        with pytest.raises(OSError):
            exchange.export_exchange(dataset.dataset_root, tmp_path / "published.cmexchange")
    assert load_state(dataset.exchange_state_path) == old_state
    assert exchange.recover_exchange_intent(dataset.dataset_root).action == "export_committed"
    assert load_state(dataset.exchange_state_path)["baseline_snapshot_id"] != first.manifest.snapshot_id


def test_import_pointer_failure_leaves_previous_generation_selected(tmp_path, monkeypatch):
    _dataset, valid = bundle(tmp_path)
    root = tmp_path / "B"
    original = exchange.initialize_empty(root)
    preview = exchange.prepare_import(valid.path, root)
    with monkeypatch.context() as patch:
        patch.setattr(exchange, "_pointer", lambda *args: (_ for _ in ()).throw(OSError("switch interrupted")))
        with pytest.raises(OSError):
            exchange.apply_import(preview, root)
    assert resolve_active_dataset(root) == original
    assert exchange.recover_exchange_intent(root).action == "import_abandoned"
    # Replay the same verified preview after recovery; old DB remained intact.
    assert exchange.apply_import(preview, root).dataset.generation != original.generation


def test_conflict_archive_failure_prevents_replacement(tmp_path, monkeypatch):
    dataset, valid = bundle(tmp_path)
    incoming = exchange.apply_import(exchange.prepare_import(valid.path, tmp_path / "B"), tmp_path / "B")
    import sqlite3
    with sqlite3.connect(dataset.catalog_path) as db:
        db.execute("INSERT INTO tags(name) VALUES('local')")
    with sqlite3.connect(incoming.dataset.catalog_path) as db:
        db.execute("INSERT INTO tags(name) VALUES('incoming')")
    changed = exchange.export_exchange(incoming.dataset.dataset_root, tmp_path / "changed.cmexchange")
    preview = exchange.prepare_import(changed.path, dataset.dataset_root)
    with monkeypatch.context() as patch:
        patch.setattr(exchange, "_write_archive", lambda *args: (_ for _ in ()).throw(OSError("archive failure")))
        with pytest.raises(OSError):
            exchange.apply_import(preview, dataset.dataset_root, decision="replace", confirmation_digest=preview.local_digest)
    assert resolve_active_dataset(dataset.dataset_root) == dataset
