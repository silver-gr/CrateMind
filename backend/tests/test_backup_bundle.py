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
    assert [p for p in root.iterdir() if p.name != '.backup.lock'] == [previous]
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
    assert [p for p in root.iterdir() if p.name != '.backup.lock'] == [previous]
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
    assert [p for p in root.iterdir() if p.name != '.backup.lock'] == [previous]


# ---- launch backup: verification depths, locking, pruning, cadence ----------

from datetime import UTC, datetime, timedelta

from app.services import schema_contract


def _bundles(root):
    return sorted(root.glob('cratemind-*'))


def test_shallow_verify_never_hashes_or_integrity_checks(tmp_path, monkeypatch):
    catalog = tmp_path / 'catalog.sqlite'
    source(catalog).close()
    bundle = backup.create_backup(catalog, tmp_path / 'b')
    calls = []
    monkeypatch.setattr(backup, '_sha256', lambda p: calls.append(p))
    monkeypatch.setattr(backup, '_integrity', lambda p: calls.append(p))
    backup.verify_backup(bundle, deep=False)
    assert calls == []
    (bundle / 'catalog.sqlite-wal').write_bytes(b'')
    with pytest.raises(ValueError, match='sidecar'):
        backup.verify_backup(bundle, deep=False)


def test_same_size_corruption_caught_by_deep_but_not_shallow(tmp_path):
    catalog = tmp_path / 'catalog.sqlite'
    source(catalog, 'x' * 500).close()
    bundle = backup.create_backup(catalog, tmp_path / 'b')
    target = bundle / 'catalog.sqlite'
    data = bytearray(target.read_bytes())
    data[-10] ^= 0xFF
    target.write_bytes(bytes(data))
    backup.verify_backup(bundle, deep=False)
    for call in (backup.verify_backup, lambda b: backup.restore_backup(b, tmp_path / 'r')):
        with pytest.raises(ValueError, match='checksum'):
            call(bundle)


def test_corrupt_bundle_not_returned_via_equality_fallback(tmp_path):
    catalog = tmp_path / 'catalog.sqlite'
    connection = source(catalog, wal=True)
    root = tmp_path / 'b'
    first = backup.create_backup(catalog, root)
    connection.close()  # checkpoint changes the stat signature, not the content
    target = first / 'catalog.sqlite'
    data = bytearray(target.read_bytes())
    data[-10] ^= 0xFF
    target.write_bytes(bytes(data))
    replacement = backup.create_backup(catalog, root)
    assert replacement != first
    backup.verify_backup(replacement)


def test_new_snapshot_is_deep_checked_once_then_shallow(tmp_path, monkeypatch):
    catalog = tmp_path / 'catalog.sqlite'
    source(catalog).close()
    hashed = []
    original = backup._sha256
    monkeypatch.setattr(backup, '_sha256', lambda p: hashed.append(p) or original(p))
    backup.create_backup(catalog, tmp_path / 'b')
    assert len(hashed) == 1


def test_pending_dirs_removed_under_lock_and_live_writer_dir_survives(tmp_path):
    catalog = tmp_path / 'catalog.sqlite'
    source(catalog).close()
    root = tmp_path / 'b'
    orphan = root / '.cratemind-pending-orphan'
    orphan.mkdir(parents=True)
    (orphan / 'x').write_text('x')
    with backup.backup_root_lock(root):
        live = root / '.cratemind-pending-live'
        live.mkdir()
        # A second writer cannot enter (and thus cannot clean) while the lock is held.
        import threading
        done = threading.Event()
        worker = threading.Thread(target=lambda: (backup.create_backup(catalog, root), done.set()))
        worker.start()
        assert not done.wait(0.5)
        assert live.exists()
        for item in list(root.glob('.cratemind-pending-live')):
            item.rmdir()
    worker.join(30)
    assert done.is_set()
    assert not orphan.exists()


def test_reuse_path_still_cleans_and_prunes(tmp_path):
    catalog = tmp_path / 'catalog.sqlite'
    connection = source(catalog)
    root = tmp_path / 'b'
    for index in range(4):
        connection.execute('INSERT INTO decisions VALUES (?)', (str(index),))
        connection.commit()
        backup.create_backup(catalog, root, keep=None)
    assert len(_bundles(root)) == 4
    (root / '.cratemind-pending-old').mkdir()
    newest = _bundles(root)[-1]
    assert backup.create_backup(catalog, root, keep=3) == newest
    assert len(_bundles(root)) == 3
    assert not (root / '.cratemind-pending-old').exists()
    assert len(_bundles(root)) == 3 and backup.create_backup(catalog, root, keep=None) == newest
    connection.close()


def test_prune_keep_symlink_and_protected_budget(tmp_path):
    catalog = tmp_path / 'catalog.sqlite'
    connection = source(catalog)
    root = tmp_path / 'b'
    for index in range(4):
        connection.execute('INSERT INTO decisions VALUES (?)', (str(index),))
        connection.commit()
        backup.create_backup(catalog, root, keep=None)
    bundles = _bundles(root)
    outside = tmp_path / 'outside'
    shutil.copytree(bundles[0], outside)
    link = root / 'cratemind-00000000T000000000000Z'
    link.symlink_to(outside, target_is_directory=True)
    backup._prune(root, 3)
    assert link.is_symlink() and outside.exists()
    assert [b for b in _bundles(root) if not b.is_symlink()] == bundles[1:]
    # Protected oldest bundle survives and counts within keep (2 total).
    backup._prune(root, 2, protected=bundles[1])
    assert [b for b in _bundles(root) if not b.is_symlink()] == [bundles[1], bundles[3]]
    connection.close()


def test_prune_oserror_is_reported_not_raised(tmp_path, monkeypatch, capsys):
    catalog = tmp_path / 'catalog.sqlite'
    connection = source(catalog)
    root = tmp_path / 'b'
    for index in range(2):
        connection.execute('INSERT INTO decisions VALUES (?)', (str(index),))
        connection.commit()
        backup.create_backup(catalog, root, keep=None)
    bundles = _bundles(root)

    def deny(*args, **kwargs):
        raise PermissionError('denied')

    monkeypatch.setattr(backup.shutil, 'rmtree', deny)
    with backup.backup_root_lock(root):
        backup.reclaim_backups(root, 1, bundles[-1])
    assert 'CrateMind backup prune failed: denied' in capsys.readouterr().err
    assert all(bundle.exists() for bundle in bundles)
    connection.close()


def test_export_json_protects_companion(db, tmp_path):
    dest = tmp_path / 'e.json'
    backup.export_json(db, dest)
    first = json.loads(dest.read_text())['application_backup']['directory']
    assert (dest.parent / first).is_dir()
    backup.export_json(db, dest)
    assert (dest.parent / json.loads(dest.read_text())['application_backup']['directory']).is_dir()


# ---- schema_pending + launch cadence ---------------------------------------

@pytest.fixture
def launch(db, tmp_path):
    import app.db as dbmod
    dbmod._settings.__dict__['backup_dir'] = str(tmp_path / 'bk')
    return dbmod


def _backup_phase_cause(dbmod):
    dbmod.launch_phase.clear()
    bundle = dbmod.backup_on_launch()
    return bundle, dbmod.launch_phase['backup']


def test_schema_pending_false_for_initialized_true_for_missing_objects(db, tmp_path):
    import app.db as dbmod
    catalog = dbmod._settings.db_file
    assert dbmod.schema_pending(catalog, None) is False
    for statement in ('DROP INDEX ix_tracks_artist_normalized',
                      'ALTER TABLE tracks DROP COLUMN created_time'):
        copy = tmp_path / f'c{abs(hash(statement))}.sqlite'
        shutil.copyfile(catalog, copy)
        with sqlite3.connect(copy) as connection:
            connection.execute(statement)
        assert dbmod.schema_pending(copy, None) is True


def test_schema_pending_true_for_missing_trigger_and_unreadable(db, tmp_path, monkeypatch):
    import app.db as dbmod
    contract = schema_contract.load_schema_contract()
    monkeypatch.setattr(schema_contract, 'load_schema_contract', lambda: {
        **contract, 'normalized_catalog_schema': {
            **contract['normalized_catalog_schema'],
            'objects': {'trigger:needed': 'create trigger needed'}}})
    assert dbmod.schema_pending(dbmod._settings.db_file, None) is True
    assert dbmod.schema_pending(tmp_path / 'absent.sqlite', None) is True


def test_launch_skips_when_all_conditions_hold(launch):
    first, reason = _backup_phase_cause(launch)
    assert reason.startswith('new:')
    again, reason = _backup_phase_cause(launch)
    assert again == first and reason == 'reused'
    assert len(_bundles(first.parent)) == 1


def _rewrite_manifest(bundle, **changes):
    path = bundle / 'manifest.json'
    manifest = json.loads(path.read_text())
    manifest.update(changes)
    path.write_text(json.dumps(manifest))


@pytest.mark.parametrize('cause,change', [
    ('stale', lambda b: {'created_at': (datetime.now(UTC) - timedelta(hours=25)).isoformat()}),
    ('future', lambda b: {'created_at': (datetime.now(UTC) + timedelta(hours=1)).isoformat()}),
    ('revision', lambda b: {'migration_revision': 0}),
    ('identity', lambda b: {'identity_installed': True}),
    ('token', lambda b: {'source_signatures': {'catalog': {'source_token': 'other', 'files': []}}}),
])
def test_each_failing_skip_condition_forces_new_deep_verified_bundle(launch, cause, change):
    first, _ = _backup_phase_cause(launch)
    _rewrite_manifest(first, **change(first))
    second, reason = _backup_phase_cause(launch)
    assert reason == f'new:{cause}'
    assert second != first
    backup.verify_backup(second)


def test_pending_schema_forces_new_bundle_before_init_db(launch, monkeypatch):
    first, _ = _backup_phase_cause(launch)
    monkeypatch.setattr(launch, 'schema_pending', lambda *a: True)
    second, reason = _backup_phase_cause(launch)
    assert reason == 'new:schema_pending' and second != first
    backup.verify_backup(second)


def test_default_keep_is_three_and_launch_reclaims_old_bundles(launch, monkeypatch):
    from app.config import Settings
    assert Settings.model_fields['backup_keep'].default == 3
    monkeypatch.setattr(launch._settings, 'backup_keep', 3)
    root = launch._settings.backup_path
    first, _ = _backup_phase_cause(launch)
    for index in range(3):  # older bundles from earlier days
        old = first.parent / f'cratemind-2020010{index}T000000000000Z'
        shutil.copytree(first, old)
    (first.parent / '.cratemind-pending-orphan').mkdir()
    again, reason = _backup_phase_cause(launch)
    assert again == first and reason == 'reused'
    assert len(_bundles(first.parent)) == 3 and first in _bundles(first.parent)
    assert not (first.parent / '.cratemind-pending-orphan').exists()
