"""reconciliation/auto_link.py on a synthetic dataset root: dry run on a copy, the apply's refusals, undo and rollback."""
from __future__ import annotations

import csv
import hashlib
import importlib.util
import json
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from app.library_exchange.operations import _pointer
from app.library_exchange.state import atomic_json, initial_state
from app.services.dataset_access import DatasetBusyError, DatasetLease
from app.services.schema_contract import canonical_database_values, load_schema_contract
from tests.test_auto_link import A, B, C, add, sc

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('auto_link_command', ROOT / 'reconciliation/auto_link.py')
cmd = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cmd)
FOLD, LINK, TITLE_ONLY = (sc(1), A), ('local:1', A), ('local:2', B)


def sha(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def values(generation): return canonical_database_values(generation / 'identity.sqlite'), canonical_database_values(generation / 'catalog.sqlite')


@pytest.fixture
def dataset(tmp_path, monkeypatch):
    """A text link with a duplicate remote copy to fold, a title-only link, a SoundCloud link and a track for review."""
    from app.config import get_settings
    root, generation = tmp_path / 'data', tmp_path / 'data/datasets/g1'
    generation.mkdir(parents=True)
    contract = load_schema_contract()['initialization_sql']
    for name in ('catalog', 'identity'):
        with closing(sqlite3.connect(generation / f'{name}.sqlite')) as db:
            for statement in contract[name]: db.execute(statement)
            db.commit()
    with closing(sqlite3.connect(generation / 'identity.sqlite')) as db:
        db.row_factory = sqlite3.Row
        add(db, 'local:1'); add(db, A); add(db, sc(1), dur=300.4)
        add(db, 'local:2', title='Silver River Night', artist='Unknown Artist'); add(db, B, title='Silver River Night', artist='Kilo Lima')
        add(db, 'local:3', title='Sun Temple'); add(db, sc(3), title='Sun Temple')
        add(db, 'local:4', title='Red Desert Storm', artist='Delta Echo'); add(db, C, title='Red Desert Storm', artist='Gamma Ray')
        db.commit()
    with closing(sqlite3.connect(generation / 'catalog.sqlite')) as db:
        for track in (1, 2, 3, 4):
            db.execute('INSERT INTO tracks(id,absolute_path,normalized_path,file_name,extension,play_count,imported_at,last_scanned_at,missing) '
                       "VALUES (?,?,?,?,'.mp3',0,'2026-01-01 00:00:00','2026-01-01 00:00:00',0)", (track, f'/music/{track}.mp3', f'/music/{track}.mp3', f'{track}.mp3'))
        db.commit()
    _pointer(root, 'g1', True)
    atomic_json(generation / 'exchange-state.json', initial_state('lineage-before'))
    for name in ('CRATEMIND_DB_PATH', 'CRATEMIND_IDENTITY_DB_PATH'):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv('CRATEMIND_DATASET_ROOT', str(root))
    get_settings.cache_clear()
    stamps = iter(f'20260101T0000{n:02d}Z' for n in range(60))
    monkeypatch.setattr(cmd.cwl, 'stamp', lambda: next(stamps))
    yield root, generation
    get_settings.cache_clear()


def run(capsys, argv, code=0):
    assert cmd.main(['--json', *argv]) == code
    return json.loads(capsys.readouterr().out)


def rows(path):
    with open(path, newline='', encoding='utf-8-sig') as f:
        return list(csv.DictReader(f))


def answer(path, answers):
    """Fill the «Απόφαση» column as the owner would: {pair: answer}, every other row «ναι». Saved the way a Greek
    spreadsheet saves a CSV, with semicolons."""
    table = rows(path)
    for row in table:
        row[cmd.DECISION] = answers.get((row[cmd.LEFT], row[cmd.RIGHT]), 'ναι')
    with open(path, 'w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=list(table[0]), delimiter=';')
        writer.writeheader()
        writer.writerows(table)


@pytest.fixture
def dry(dataset, tmp_path, capsys):
    from app.services.backup import create_backup
    root, generation = dataset
    bundle = create_backup(generation / 'catalog.sqlite', tmp_path / 'bundles', identity_path=generation / 'identity.sqlite', keep=None, reuse=False)
    report = run(capsys, ['--dry-run', str(bundle), '--work', str(tmp_path / 'work'), '--out', str(tmp_path / 'out')])
    return root, generation, bundle, report, tmp_path / 'out/pairs.csv', tmp_path / 'out/review.csv'


def recordings(generation):
    with closing(sqlite3.connect(generation / 'identity.sqlite')) as db:
        return dict(db.execute('SELECT id,recording_id FROM entities'))


def test_dry_run_touches_only_its_copy_and_the_round_trip_restores_it(dataset, tmp_path, capsys):
    from app.services.backup import create_backup
    root, generation = dataset
    with closing(sqlite3.connect(generation / 'catalog.sqlite')) as db:   # two pending SoundCloud suggestions for track 3
        for sc_id in (3, 99):
            db.execute("INSERT INTO soundcloud_tracks(soundcloud_track_id,title,raw_json,fetched_at) VALUES (?,'Sun Temple','{}','2026-01-01')", (sc_id,))
            db.execute("INSERT INTO soundcloud_match_candidates VALUES (3,?,0.5,'[]','pending','2026-01-01',NULL)", (sc_id,))
        db.commit()
    bundle = create_backup(generation / 'catalog.sqlite', tmp_path / 'bundles', identity_path=generation / 'identity.sqlite', keep=None, reuse=False)
    live = {name: sha(generation / name) for name in ('catalog.sqlite', 'identity.sqlite')}
    sealed = {name: sha(bundle / name) for name in live}
    report = run(capsys, ['--dry-run', str(bundle), '--work', str(tmp_path / 'work'), '--out', str(tmp_path / 'out')])
    assert report['ok'] and all(v == 'ok' for v in report['assertions'].values())
    assert report['written'] == {'folds': 1, 'links': 3, 'folds_per_rule': {'text_exact': 1},
                                 'links_per_rule': {'text_exact': 2, 'title_unknown_artist': 1}, 'links_to_unlinked_tracks': 3}
    assert (report['before']['linked_local_tracks'], report['after']['linked_local_tracks']) == (0, 3)
    assert (report['before']['remote_only'], report['after']['remote_only']) == (5, 1)
    assert report['review_set'] == {'title_only': 1} and report['soundcloud_rows_for_the_catalog'] == 1
    assert report['mirror_after_apply'] == report['mirror_after_undo'] == {'applied': 1, 'cancelled': 0}
    assert all(v['equal'] for v in report['round_trip'].values()) and set(report['round_trip']) == {
        'entities.recording_id', 'canonical_recordings', 'catalog_soundcloud_matches'}
    assert report['second_run_would_add'] == {'folds': 0, 'links': 0} and report['after_undo_would_link_again'] == 0
    assert report['after_undo_new_pairs'] == [] and report['badges_recomputed']['others'] == 0
    # The apply decides every suggestion of the linked track; the undo rejects only the undone pair. Counted, not restored.
    assert report['catalog_candidate_statuses_changed'] == {'pending -> rejected': 2}
    # An unknown local artist is shown as the source's artist once linked; nothing else is renamed.
    assert report['names_changed'] == [{'local_id': 'local:2', 'file_name': '2.mp3', 'before': ['', 'Silver River Night'],
                                        'after': ['Kilo Lima', 'Silver River Night']}]
    assert {name: sha(generation / name) for name in live} == live and {name: sha(bundle / name) for name in sealed} == sealed
    assert not (root / 'backups').exists()
    pairs, review = rows(tmp_path / 'out/pairs.csv'), rows(tmp_path / 'out/review.csv')
    assert [(r[cmd.LEFT], r[cmd.RIGHT]) for r in pairs] == [FOLD, LINK, TITLE_ONLY, ('local:3', sc(3))]
    assert pairs[1] | {} == {'Είδος': 'Σύνδεση με αρχείο', 'Κανόνας': 'Ίδιος καλλιτέχνης και τίτλος', 'Διαφορά διάρκειας (δευτ.)': '0.0',
                             'Α: πηγή': 'Τοπικό αρχείο', 'Α: καλλιτέχνης': 'Alpha Beta', 'Α: τίτλος': 'Moon Garden', 'Α: διάρκεια': '5:00.0',
                             'Α: άλμπουμ': '', 'Α: αρχείο ή χρήστης': '1.mp3', 'Α: ISRC': '', 'Β: πηγή': 'Spotify', 'Β: καλλιτέχνης': 'Alpha Beta',
                             'Β: τίτλος': 'Moon Garden', 'Β: διάρκεια': '5:00.0', 'Β: άλμπουμ': '', 'Β: αρχείο ή χρήστης': '', 'Β: ISRC': '',
                             cmd.LEFT: 'local:1', cmd.RIGHT: A}
    # The review file holds every title-only link and a sample of each fold rule, with the answer left empty.
    assert [(r[cmd.LEFT], r[cmd.RIGHT], r[cmd.DECISION]) for r in review] == [(*TITLE_ONLY, ''), (*FOLD, '')]


def test_dry_run_refuses_a_used_folder_and_any_folder_inside_a_library(dataset, tmp_path, capsys):
    from app.services.backup import create_backup
    root, generation = dataset
    bundle = create_backup(generation / 'catalog.sqlite', tmp_path / 'bundles', identity_path=generation / 'identity.sqlite', keep=None, reuse=False)
    (tmp_path / 'used').mkdir()
    (tmp_path / 'used/file').write_text('x')
    for work in (tmp_path / 'used', root / 'scratch', generation / 'scratch'):
        assert 'error' in run(capsys, ['--dry-run', str(bundle), '--work', str(work), '--out', str(tmp_path / 'out')], code=1)
    assert 'error' in run(capsys, ['--dry-run', str(bundle)], code=1)
    assert not (tmp_path / 'out').exists() and not (root / 'scratch').exists()


@pytest.mark.parametrize('case', ['no_pairs', 'no_review', 'blank_answer', 'title_only_not_read', 'not_a_pair_file'])
def test_apply_refuses_without_a_reviewed_pair_file_and_writes_nothing(dry, capsys, case):
    root, generation, _, _, pairs, review = dry
    pristine = values(generation)
    answer(review, {} if case != 'blank_answer' else {FOLD: ''})
    if case == 'title_only_not_read':
        table = [r for r in cmd.read_csv(review, 'review') if (r[cmd.LEFT], r[cmd.RIGHT]) != TITLE_ONLY]
        with open(review, 'w', newline='', encoding='utf-8-sig') as f:
            writer = csv.DictWriter(f, fieldnames=list(table[0]))
            writer.writeheader()
            writer.writerows(table)
    if case == 'not_a_pair_file':
        pairs.write_text('a,b\n1,2\n')
    argv = {'no_pairs': ['--apply', '--reviewed', str(review)], 'no_review': ['--apply', '--pairs', str(pairs)]}.get(
        case, ['--apply', '--pairs', str(pairs), '--reviewed', str(review)])
    report = run(capsys, argv, code=1)
    assert report['ok'] is False and report['error']
    assert values(generation) == pristine and not (root / 'backups').exists()


def test_apply_refuses_when_the_backup_does_not_verify(dry, capsys, monkeypatch):
    from app.services import backup
    root, generation, _, _, pairs, review = dry
    pristine = values(generation)
    answer(review, {})
    def broken(bundle, **kwargs): raise ValueError('backup hash mismatch')
    monkeypatch.setattr(backup, 'verify_backup', broken)
    report = run(capsys, ['--apply', '--pairs', str(pairs), '--reviewed', str(review)], code=1)
    assert 'backup hash mismatch' in report['error'] and values(generation) == pristine


def test_apply_refuses_while_the_app_holds_the_library(dry, capsys):
    root, generation, _, _, pairs, review = dry
    pristine = values(generation)
    answer(review, {})
    with DatasetLease.acquire(root, 'idle-service'), pytest.raises(DatasetBusyError):
        cmd.main(['--apply', '--pairs', str(pairs), '--reviewed', str(review)])
    assert 'Κλείσε την εφαρμογή' in capsys.readouterr().err and values(generation) == pristine and not (root / 'backups').exists()
    assert run(capsys, []) == {'ok': True, 'mode': 'status', 'batches': []}   # no option: lists the batches, changes nothing
    assert values(generation) == pristine


def test_apply_writes_only_reviewed_pairs_that_still_pass_then_batch_undo_and_rollback(dry, capsys):
    root, generation, _, _, pairs, review = dry
    pristine, before = values(generation), recordings(generation)
    answer(review, {TITLE_ONLY: 'όχι'})                                   # the owner strikes the title-only link
    with closing(sqlite3.connect(generation / 'identity.sqlite')) as db:   # since the dry run: one pair was rejected by hand,
        db.execute("INSERT INTO canonical_blocks VALUES ('local:3',?,'human_rejection')", (sc(3),))
        db.row_factory = sqlite3.Row                                       # and a new exact match arrived
        add(db, 'local:5', title='Blue Lagoon'); add(db, 'spotify:track:new', title='Blue Lagoon')
        db.commit()
    report = run(capsys, ['--apply', '--pairs', str(pairs), '--reviewed', str(review)])
    assert report['ok'] and all(v == 'ok' for v in report['assertions'].values())
    assert report['file'] == {'pairs_allowed': 3, 'struck_in_review': 1, 'rejections_stored': 1}
    assert report['written']['folds'] == 1 and report['written']['links_per_rule'] == {'text_exact': 1}
    assert report['in_file_but_no_longer_passing'] == [['local:3', sc(3)]]
    # The struck pair is stored as a rejection, so it is stopped now and never planned again.
    assert report['passing_but_not_in_file'] == [['local:5', 'spotify:track:new', 'text_exact']]
    assert report['stopped_by_guard'].get('link / rejected_before') == 2   # the struck pair and the one rejected by hand
    after = recordings(generation)
    assert {k: v for k, v in after.items() if before.get(k) != v} == {A: 'local:1', sc(1): 'local:1', 'local:5': 'local:5', 'spotify:track:new': 'spotify:track:new'}
    backup = Path(report['backup']['directory'])
    assert json.loads((backup / 'report.json').read_text())['batch'] == report['batch']
    with closing(sqlite3.connect(generation / 'identity.sqlite')) as db:
        ledger = db.execute("SELECT left_id,right_id,json_extract(evidence_json,'$.batch') FROM identity_acceptances ORDER BY rowid").fetchall()
        assert ledger == [(*FOLD, report['batch']), (*LINK, report['batch'])]
    with closing(sqlite3.connect(generation / 'identity.sqlite')) as db:
        assert db.execute("SELECT reason FROM canonical_blocks WHERE left_id=? AND right_id=?", TITLE_ONLY).fetchone() == ('human_rejection',)
    again = run(capsys, ['--apply', '--pairs', str(pairs), '--reviewed', str(review)])
    assert again['ok'] and again['written']['folds'] == again['written']['links'] == 0
    assert again['file']['rejections_stored'] == 0
    assert [(b['id'], b['link'], b['fold']) for b in run(capsys, [])['batches']] == [(report['batch'], 1, 1)]
    undone = run(capsys, ['--undo-batch', report['batch']])
    assert undone['ok'] and undone['undo'] == {'undone': 2, 'batch': report['batch']}
    assert {k: v for k, v in recordings(generation).items() if k in before} == before
    assert 'error' in run(capsys, ['--undo-batch', 'no-such-batch'], code=1)
    run(capsys, ['--rollback', report['backup']['directory']])
    active = json.loads((root / 'active.json').read_text())['generation']
    restored = values(root / 'datasets' / active)
    assert restored[1] == pristine[1] and recordings(root / 'datasets' / active) == {**before, 'local:5': 'local:5', 'spotify:track:new': 'spotify:track:new'}
