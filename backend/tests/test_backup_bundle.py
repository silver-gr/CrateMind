from __future__ import annotations

import json
import shutil
import sqlite3

import pytest

from app.services import backup


def source(path, value='human decision', wal=False):
    connection = sqlite3.connect(path)
    if wal:
        connection.execute('PRAGMA journal_mode=WAL')
        connection.execute('PRAGMA wal_autocheckpoint=0')
    connection.execute('CREATE TABLE decisions(value TEXT)')
    connection.execute('INSERT INTO decisions VALUES (?)', (value,))
    connection.commit()
    return connection


def test_complete_backup_includes_uncheckpointed_wal_and_identity(tmp_path):
    catalog = tmp_path / 'catalog.sqlite'
    identity = tmp_path / 'identity.sqlite'
    with source(catalog, 'keep local', wal=True) as main, source(identity, 'reject match', wal=True):
        main.execute("INSERT INTO decisions VALUES ('new WAL decision')")
        main.commit()
        bundle = backup.create_backup(catalog, tmp_path / 'backups', identity_path=identity)
    manifest = backup.verify_backup(bundle)
    assert set(manifest['databases']) == {'catalog', 'identity'}
    restored = backup.restore_backup(bundle, tmp_path / 'clone')
    with sqlite3.connect(restored / 'catalog.sqlite') as connection:
        assert connection.execute('SELECT value FROM decisions').fetchall() == [('keep local',), ('new WAL decision',)]
        assert connection.execute('PRAGMA integrity_check').fetchone() == ('ok',)
    with sqlite3.connect(restored / 'identity.sqlite') as connection:
        assert connection.execute('SELECT value FROM decisions').fetchone() == ('reject match',)


def test_missing_sibling_identity_is_optional_and_temp_catalog_isolated(tmp_path, monkeypatch):
    monkeypatch.delenv('CRATEMIND_IDENTITY_DB_PATH', raising=False)
    catalog = tmp_path / 'catalog.sqlite'
    source(catalog).close()
    bundle = backup.create_backup(catalog, tmp_path / 'backups')
    assert set(backup.verify_backup(bundle)['databases']) == {'catalog'}


def test_explicit_missing_identity_fails(tmp_path, monkeypatch):
    catalog = tmp_path / 'catalog.sqlite'
    source(catalog).close()
    monkeypatch.setenv('CRATEMIND_IDENTITY_DB_PATH', str(tmp_path / 'missing.sqlite'))
    with pytest.raises(FileNotFoundError):
        backup.create_backup(catalog, tmp_path / 'backups')
    assert not (tmp_path / 'missing.sqlite').exists()


def test_unchanged_reuses_verified_bundle_and_retention_keeps_whole_units(tmp_path):
    catalog = tmp_path / 'catalog.sqlite'
    identity = tmp_path / 'identity.sqlite'
    source(identity).close()
    connection = source(catalog)
    root = tmp_path / 'backups'
    first = backup.create_backup(catalog, root, identity_path=identity, keep=2)
    assert backup.create_backup(catalog, root, identity_path=identity, keep=2) == first
    for value in ('second', 'third'):
        connection.execute('INSERT INTO decisions VALUES (?)', (value,))
        connection.commit()
        backup.create_backup(catalog, root, identity_path=identity, keep=2)
    bundles = list(root.glob('cratemind-*'))
    assert len(bundles) == 2
    assert not first.exists()
    assert all(set(backup.verify_backup(path)['databases']) == {'catalog', 'identity'} for path in bundles)
    connection.close()


def test_low_space_and_failed_publish_preserve_previous_bundle(tmp_path, monkeypatch):
    catalog = tmp_path / 'catalog.sqlite'
    connection = source(catalog)
    root = tmp_path / 'backups'
    previous = backup.create_backup(catalog, root)
    connection.execute("INSERT INTO decisions VALUES ('changed')")
    connection.commit()
    with monkeypatch.context() as patch:
        patch.setattr(backup.shutil, 'disk_usage', lambda path: shutil._ntuple_diskusage(1, 1, 0))
        with pytest.raises(OSError, match='space'):
            backup.create_backup(catalog, root)
    with monkeypatch.context() as patch:
        patch.setattr(backup, '_publish', lambda *args: (_ for _ in ()).throw(OSError('publish failed')))
        with pytest.raises(OSError, match='publish failed'):
            backup.create_backup(catalog, root)
    backup.verify_backup(previous)
    assert list(root.iterdir()) == [previous]
    connection.close()


def test_corrupt_or_unsafe_manifest_cannot_restore_or_overwrite(tmp_path):
    catalog = tmp_path / 'catalog.sqlite'
    source(catalog).close()
    bundle = backup.create_backup(catalog, tmp_path / 'backups')
    occupied = tmp_path / 'occupied'
    occupied.mkdir()
    (occupied / 'precious').write_text('keep')
    with pytest.raises(FileExistsError):
        backup.restore_backup(bundle, occupied)
    manifest_path = bundle / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    manifest['databases']['catalog']['file'] = '../outside.sqlite'
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError):
        backup.restore_backup(bundle, tmp_path / 'clone')
    assert not (tmp_path / 'outside.sqlite').exists()
    assert not (tmp_path / 'clone').exists()


def test_both_writers_are_reserved_during_snapshot_but_readers_work(tmp_path, monkeypatch):
    catalog = tmp_path / 'catalog.sqlite'
    identity = tmp_path / 'identity.sqlite'
    connections = [source(catalog, wal=True), source(identity, wal=True)]
    original = backup._integrity
    checked = []

    def check_with_writers_reserved(path):
        for database in (catalog, identity):
            with sqlite3.connect(database, timeout=0) as writer:
                assert writer.execute('SELECT count(*) FROM decisions').fetchone() == (1,)
                with pytest.raises(sqlite3.OperationalError, match='locked'):
                    writer.execute("INSERT INTO decisions VALUES ('racing writer')")
                checked.append(database)
        original(path)

    monkeypatch.setattr(backup, '_integrity', check_with_writers_reserved)
    bundle = backup.create_backup(catalog, tmp_path / 'backups', identity_path=identity, keep=None)
    assert checked
    monkeypatch.setattr(backup, '_integrity', original)
    backup.verify_backup(bundle)
    for connection in connections:
        connection.close()


def test_restore_checks_disk_and_rejects_corrupt_snapshot(tmp_path, monkeypatch):
    catalog = tmp_path / 'catalog.sqlite'
    source(catalog).close()
    bundle = backup.create_backup(catalog, tmp_path / 'backups')
    with monkeypatch.context() as patch:
        patch.setattr(backup.shutil, 'disk_usage', lambda path: shutil._ntuple_diskusage(1, 1, 0))
        with pytest.raises(OSError, match='space'):
            backup.restore_backup(bundle, tmp_path / 'clone')
    assert not (tmp_path / 'clone').exists()
    with (bundle / 'catalog.sqlite').open('ab') as stream:
        stream.write(b'corrupt')
    with pytest.raises(ValueError, match='checksum'):
        backup.restore_backup(bundle, tmp_path / 'clone')
    assert not (tmp_path / 'clone').exists()


def test_restore_accepts_existing_empty_directory(tmp_path):
    catalog = tmp_path / 'catalog.sqlite'
    source(catalog).close()
    bundle = backup.create_backup(catalog, tmp_path / 'backups')
    destination = tmp_path / 'clone'
    destination.mkdir()
    assert backup.restore_backup(bundle, destination) == destination
    backup.verify_backup(destination)


def test_corrupt_explicit_identity_preserves_previous_and_leaves_no_pending_bundle(tmp_path):
    catalog = tmp_path / 'catalog.sqlite'
    source(catalog).close()
    root = tmp_path / 'backups'
    previous = backup.create_backup(catalog, root, identity_path=None)
    identity = tmp_path / 'broken.sqlite'
    identity.write_bytes(b'not a sqlite database')
    with pytest.raises(sqlite3.DatabaseError):
        backup.create_backup(catalog, root, identity_path=identity)
    assert list(root.iterdir()) == [previous]
    backup.verify_backup(previous)


def test_launch_backup_returns_complete_bundle_and_absent_catalog_is_noop(db, tmp_path, monkeypatch):
    import app.db as dbmod

    bundle = dbmod.backup_on_launch()
    assert bundle.is_dir()
    backup.verify_backup(bundle)
    monkeypatch.setattr(dbmod._settings, 'db_path', str(tmp_path / 'absent.sqlite'))
    assert dbmod.backup_on_launch() is None


def test_unchanged_wal_reuses_bundle_after_every_source_connection_closes_and_reopens(tmp_path):
    catalog, identity = tmp_path / 'catalog.sqlite', tmp_path / 'identity.sqlite'
    main, authority = source(catalog, wal=True), source(identity, wal=True)
    root = tmp_path / 'backups'
    first = backup.create_backup(catalog, root, identity_path=identity)
    main.close()
    authority.close()
    # Closing the last WAL connection checkpoints and removes its sidecars.
    assert not catalog.with_name(catalog.name + '-wal').exists()
    main, authority = sqlite3.connect(catalog), sqlite3.connect(identity)
    try:
        main.execute('SELECT * FROM decisions').fetchall()
        authority.execute('SELECT * FROM decisions').fetchall()
        assert backup.create_backup(catalog, root, identity_path=identity) == first
        assert list(root.glob('cratemind-*')) == [first]
        main.execute("INSERT INTO decisions VALUES ('new deliberate decision')")
        main.commit()
        changed = backup.create_backup(catalog, root, identity_path=identity)
        assert changed != first
        backup.verify_backup(first)
        backup.verify_backup(changed)
    finally:
        main.close()
        authority.close()


def test_corrupt_old_bundle_is_never_reused_even_if_sources_are_unchanged(tmp_path):
    catalog = tmp_path / 'catalog.sqlite'
    source(catalog).close()
    root = tmp_path / 'backups'
    first = backup.create_backup(catalog, root)
    with (first / 'catalog.sqlite').open('ab') as stream:
        stream.write(b'corruption')
    replacement = backup.create_backup(catalog, root)
    assert replacement != first
    backup.verify_backup(replacement)


def test_low_space_during_wal_reopen_fallback_preserves_verified_previous_bundle(tmp_path, monkeypatch):
    catalog = tmp_path / 'catalog.sqlite'
    connection = source(catalog, wal=True)
    root = tmp_path / 'backups'
    previous = backup.create_backup(catalog, root)
    connection.close()
    monkeypatch.setattr(backup.shutil, 'disk_usage', lambda path: shutil._ntuple_diskusage(1, 1, 0))
    with pytest.raises(OSError, match='space'):
        backup.create_backup(catalog, root)
    backup.verify_backup(previous)
    assert list(root.iterdir()) == [previous]
