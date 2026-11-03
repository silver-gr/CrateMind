"""R10 obvious SoundCloud links: selection, link_automatic/undo, consolidation re-stamp and the command (synthetic only)."""
import json
import sqlite3
from contextlib import closing

import pytest

from app.services import canonical_library as canonical, collection_consolidation as consolidation, manual_identity as m
from app.services.identity_matching import normalized_item, score_candidate
from tests.test_canonical import fixture_db
from tests.test_clean_working_library import canonical as canonical_row, cwl, dataset, entity, run, values  # noqa: F401 (fixture)

A = ('cleanup_policy_high_confidence', 'auto_high_confidence')


def make_db():
    db = fixture_db()
    db.executescript(canonical.SCHEMA)
    consolidation.init(db)
    return db


def add(db, sid, title='Moon Garden', artist='Alpha Beta', recording=None, state='derived', metadata=None):
    service, recording = sid.split(':')[0], recording or sid
    norm = normalized_item({'id': sid, 'service': service, 'title': title, 'artist': artist, 'duration_ms': 300000, 'kind': 'track'})
    db.execute('INSERT OR IGNORE INTO recordings VALUES (?,?,?)', (recording, title, 'PROVISIONAL'))
    db.execute('INSERT INTO entities VALUES (?,?,?,?,?,?,?,?,?,?,?)', (sid, service, title, artist, 300000,
               int(sid.split(':')[1]) if service == 'local' else None, None, recording, 'NO_CANDIDATE', json.dumps(metadata or {}), json.dumps(norm)))
    db.execute('INSERT INTO canonical_base_entities VALUES (?,?,?)', (sid, recording, 'NO_CANDIDATE'))
    db.execute("INSERT OR IGNORE INTO canonical_recordings VALUES (?,?,?,'','',?,'{}','{}','then')", (recording, title, artist, state))


def pair(db, left, right, cls=None, **evidence):
    na, nb = (json.loads(db.execute('SELECT normalized_json FROM entities WHERE id=?', (x,)).fetchone()[0]) for x in (left, right))
    result = score_candidate(na, nb)
    db.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)', (left, right, 'local:soundcloud', result['score'], cls or result['class'],
                                                               json.dumps({**result['evidence'], **evidence})))


def sc(i): return f'soundcloud:tracks:{i}'


def test_selection_tiers_and_every_exclusion():
    db = make_db()
    for i in (1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 13):
        add(db, f'local:{i}', metadata={'asset_lifecycle': {'state': 'retired'}} if i == 5 else None,
            state='human' if i == 8 else 'derived')
    for i in (1, 2, 5, 7, 8, 10, 11, 12):
        add(db, sc(i))
    add(db, sc(6), recording='local:6')                                    # already one recording
    add(db, sc(9)); add(db, 'local:90', title='Other', recording=sc(9))    # the SoundCloud recording has a current local
    add(db, sc(100), title='Other', recording='local:10')                  # the local recording already has SoundCloud
    for i in (1, 5, 6, 7, 8, 9, 10, 11, 12):
        pair(db, f'local:{i}', sc(i))
    pair(db, 'local:2', sc(2), conflicts=['version_mismatch'])            # HIGH_CONFIDENCE but not policy-eligible: no tier
    pair(db, 'local:13', sc(12))                                           # two locals claim one upload
    db.execute("INSERT INTO identity_acceptances VALUES ('local:7',?,'x',90,'manual_identity_confirmation','{}','t','human','t2')", (sc(7),))
    db.execute("INSERT INTO canonical_blocks VALUES ('local:11',?,'human_rejection')", (sc(11),))
    # Tier B: a downloaded file x a liked upload, same title and length, only the artist disagrees; any class.
    add(db, 'local:3'); add(db, sc(3), artist='Qxz Wvk'); add(db, 'local:4'); add(db, sc(4), artist='Qxz Wvk')
    pair(db, 'local:3', sc(3)); pair(db, 'local:4', sc(4))
    db.execute("INSERT INTO collections VALUES ('sc:likes','Likes','soundcloud','likes',1,'{}')")
    db.execute("INSERT INTO memberships VALUES ('sc:likes',0,?,'t','{}')", (sc(3),))  # sc 4 is not liked
    evidence = json.loads(db.execute('SELECT evidence_json FROM candidates WHERE left_id=?', ('local:3',)).fetchone()[0])
    assert evidence['conflicts'] == ['artist_conflict'] and m.comparison(db, 'local:3', sc(3))['hard_blocks']
    selected, tiers, excluded = cwl.obvious_links(db, downloads={3, 4})
    assert [p[:3] for p in selected] == [('A', 'local:1', sc(1)), ('B', 'local:3', sc(3))]
    assert tiers == {'A': 10, 'B': 1}
    assert excluded == {'A': {'local_not_current': 1, 'already_one_recording': 1, 'existing_acceptance': 1, 'protected_recording': 1,
                              'soundcloud_recording_has_local': 1, 'local_recording_has_soundcloud': 1, 'hard_block': 1,
                              'not_one_to_one': 2}}
    # The download is what makes tier B: without it the artist conflict leaves no tier.
    assert [p[:3] for p in cwl.obvious_links(db, downloads=set())[0]] == [('A', 'local:1', sc(1))]


def linked_fixture():
    db = make_db()
    add(db, 'local:1', title='Local Title', artist='Local Artist', metadata={'absolute_path': '/music/a.mp3'})
    add(db, sc(1), title='Local Title', artist='Local Artist')
    add(db, 'spotify:track:t', title='Local Title', artist='Local Artist', recording=sc(1))
    db.execute("INSERT INTO identity_acceptances VALUES ('spotify:track:t',?,'x',95,'promoted','{}','t','auto_high_confidence',NULL)", (sc(1),))
    pair(db, 'local:1', sc(1))
    return db


def test_link_automatic_and_undo_round_trip():
    db = linked_fixture()
    canonical_before = [tuple(r) for r in db.execute('SELECT recording_id,title,artist,state FROM canonical_recordings ORDER BY 1')]
    score = db.execute('SELECT score FROM candidates').fetchone()[0]
    with pytest.raises(ValueError, match='Unknown automatic'):
        m.link_automatic(db, 'local:1', sc(1), {}, method='manual_identity_confirmation', mode='human')
    result = m.link_automatic(db, 'local:1', sc(1), {'x': 1, 'tier': 'A'}, method=A[0], mode=A[1])
    assert result == {'recording_id': 'local:1', 'already_accepted': False}
    assert [(r[0], r[1]) for r in db.execute('SELECT id,status FROM entities WHERE recording_id=? ORDER BY id', ('local:1',))] == [
        ('local:1', 'ACCEPTED'), (sc(1), 'ACCEPTED'), ('spotify:track:t', 'ACCEPTED')]
    acceptance = dict(db.execute("SELECT * FROM identity_acceptances WHERE left_id='local:1'").fetchone())
    assert {k: acceptance[k] for k in ('left_id', 'right_id', 'match_source', 'confidence', 'method', 'acceptance_mode', 'revoked_at')} == {
        'left_id': 'local:1', 'right_id': sc(1), 'match_source': 'cleanup_obvious_link', 'confidence': score, 'method': A[0],
        'acceptance_mode': A[1], 'revoked_at': None}
    assert json.loads(acceptance['evidence_json']) == {'x': 1, 'tier': 'A'}
    # Both canonical rows stay (the old one as an alias); the target's display metadata is unchanged.
    assert [tuple(r) for r in db.execute('SELECT recording_id,title,artist,state FROM canonical_recordings ORDER BY 1')] == canonical_before
    events = [(r[0], r[1], json.loads(r[2] or 'null'), json.loads(r[3])) for r in db.execute(
        'SELECT recording_id,action,before_json,after_json FROM canonical_events ORDER BY id')]
    assert events[0] == ('local:1', 'automatic_identity_link', {'groups': {'local:1': ['local:1'], sc(1): [sc(1), 'spotify:track:t']},
                                                                'metadata_from': 'local:1'},
                         {'left_id': 'local:1', 'right_id': sc(1), 'recording_id': 'local:1', 'method': A[0]})
    assert events[1][1] == 'legacy_soundcloud_mirror_intent' and events[1][3]['operation'] == 'accept'
    assert events[1][3]['method'] == A[0]
    assert (events[1][3]['track_id'], events[1][3]['soundcloud_track_id'], events[1][3]['absolute_path']) == (1, 1, '/music/a.mp3')
    # Idempotent: an active acceptance means nothing more is written.
    assert m.link_automatic(db, 'local:1', sc(1), {}, method=A[0], mode=A[1])['already_accepted']
    assert db.execute('SELECT COUNT(*) FROM canonical_events').fetchone()[0] == 2
    assert m.undo(db, 'local:1', sc(1)) == {'still_connected': False}
    assert dict(db.execute('SELECT id,recording_id FROM entities').fetchall()) == {
        'local:1': 'local:1', sc(1): sc(1), 'spotify:track:t': sc(1)}
    assert db.execute("SELECT revoked_at FROM identity_acceptances WHERE left_id='local:1'").fetchone()[0] is not None
    actions = [r[0] for r in db.execute('SELECT action FROM canonical_events ORDER BY id')]
    assert actions[2:] == ['undo_human_identity', 'legacy_soundcloud_mirror_intent']
    assert json.loads(db.execute('SELECT after_json FROM canonical_events ORDER BY id DESC').fetchone()[0])['operation'] == 'remove'
    assert m.undo(db, 'local:1', sc(1)) == {'already_undone': True}
    db.execute("UPDATE identity_acceptances SET method='legacy_confirmed_manual_review',revoked_at=NULL WHERE left_id='local:1'")
    with pytest.raises(ValueError, match='only undoes'):
        m.undo(db, 'local:1', sc(1))


def test_restamp_rewrites_only_hashes_that_matched_before():
    db = linked_fixture()
    db.execute("INSERT INTO collections VALUES ('c1','Likes','soundcloud','likes',1,'{}'),('c2','Set','soundcloud','playlist',1,'{}'),"
               "('c3','Other','soundcloud','playlist',1,'{}')")
    db.execute("INSERT INTO memberships VALUES ('c1',0,?,'t','{}'),('c2',0,?,'t','{}'),('c3',0,'spotify:track:none','t','{}')", (sc(1), sc(1)))
    fp = lambda cid: consolidation.fingerprint(db, cid)
    for did, baseline, result in (('d1', {'ids': ['c1'], 'hashes': {'c1': fp('c1')}}, {'representative_hashes': {'c3': fp('c3')}}),
                                  ('d2', {'ids': ['c2'], 'hashes': {'c2': 'stale'}}, {}),
                                  ('review:x', {'ids': ['c1', 'c2'], 'hashes': {'c1': fp('c1'), 'c2': fp('c2')}}, {})):
        db.execute("INSERT INTO collection_consolidations VALUES (?,'b','automatic','exact','active',?,?,'t')", (did, json.dumps(baseline), json.dumps(result)))
    matched = cwl.matching_hashes(db)
    assert matched == {('d1', 'baseline', 'c1'), ('d1', 'representative', 'c3'), ('review:x', 'baseline', 'c1'), ('review:x', 'baseline', 'c2')}
    before = cwl.digest(db, 'SELECT * FROM collection_consolidations ORDER BY rowid')
    d2 = db.execute("SELECT * FROM collection_consolidations WHERE id='d2'").fetchone()
    m.link_automatic(db, 'local:1', sc(1), {}, method=A[0], mode=A[1])
    assert cwl.matching_hashes(db) == {('d1', 'representative', 'c3')}
    rewrites = cwl.restamp(db, matched)
    assert set(rewrites) == {('d1', 'baseline', 'c1'), ('review:x', 'baseline', 'c1'), ('review:x', 'baseline', 'c2')}
    assert cwl.matching_hashes(db) == matched and tuple(db.execute("SELECT * FROM collection_consolidations WHERE id='d2'").fetchone()) == tuple(d2)
    assert [r[0] for r in db.execute('SELECT id FROM collection_consolidations ORDER BY rowid')] == ['d1', 'd2', 'review:x']
    reverted = cwl.consolidation_rows(db, {k: old for k, (old, _) in rewrites.items()})
    assert cwl.digest_rows(tuple(r.values()) for r in reverted) == before
    assert cwl.restamp(db, matched) == {}


def add_r10_material(generation):
    """A tier A pair with a leftover suggestion, a tier B download pair and a consolidation hash over a linked upload."""
    from app.services.collection_consolidation import fingerprint
    with closing(sqlite3.connect(generation / 'identity.sqlite')) as db:
        db.row_factory = sqlite3.Row
        for sid, title, artist, track in (('local:20', 'Lunar Tide', 'Nova Crew', 20), ('local:22', 'Glass River', 'Nova Crew', 22),
                                          (sc(20), 'Lunar Tide', 'Nova Crew', None), (sc(21), 'Lunar Tide (Other Mix)', 'Someone Else', None),
                                          (sc(22), 'Glass River', 'Qxz Wvk', None)):
            entity(db, sid, sid.split(':')[0], title, artist, local_id=track, status='NO_CANDIDATE',
                   metadata={'absolute_path': f'/nowhere/{track}.mp3'} if track else {})
            canonical_row(db, sid, title, artist)
        for left, right in (('local:20', sc(20)), ('local:20', sc(21)), ('local:22', sc(22))):
            na, nb = (json.loads(db.execute('SELECT normalized_json FROM entities WHERE id=?', (x,)).fetchone()[0]) for x in (left, right))
            r = score_candidate(na, nb)
            db.execute('INSERT INTO candidates VALUES (?,?,?,?,?,?)', (left, right, 'local:soundcloud', r['score'],
                                                                       'AMBIGUOUS' if right == sc(21) else r['class'], json.dumps(r['evidence'])))
        db.execute("INSERT INTO memberships VALUES ('sc:likes',1,?,'then','{}')", (sc(22),))
        db.execute("INSERT INTO collections VALUES ('sc:set2','Set 2','soundcloud','source_snapshot',1,'{}')")
        db.execute("INSERT INTO memberships VALUES ('sc:set2',0,?,'then','{}')", (sc(20),))
        db.execute("INSERT INTO collection_consolidations VALUES ('d2','b','automatic','exact','active',?,'{}','then')",
                   (json.dumps({'kind': 'exact', 'ids': ['sc:set2'], 'hashes': {'sc:set2': fingerprint(db, 'sc:set2')}}),))
        db.commit()
    with closing(sqlite3.connect(generation / 'catalog.sqlite')) as db:
        for track, album in ((20, 'Rumble'), (22, 'likes of dj panoramixxx (2024)')):
            db.execute('INSERT INTO tracks(id,absolute_path,normalized_path,file_name,extension,album,play_count,imported_at,last_scanned_at,missing) '
                       "VALUES (?,?,?,?,'.mp3',?,0,'then','then',0)", (track, f'/nowhere/{track}.mp3', f'/nowhere/{track}.mp3', f'{track}.mp3', album))
        db.commit()


def test_command_links_restamps_settles_and_reruns_clean(dataset, capsys):
    root, generation, argv = dataset
    add_r10_material(generation)
    pristine = values(generation)
    preview = run(capsys, argv)
    assert preview['ok'] and values(generation) == pristine
    assert (preview['rules']['R10']['tier_a'], preview['rules']['R10']['tier_b']) == (1, 1)
    assert preview['rules']['R10']['consolidation_hashes']['restamped'] == 1 and preview['rules']['R11']['changed'] >= 1
    report = run(capsys, argv + ['--apply'])
    assert report['ok'] and all(v == 'ok' for v in report['assertions'].values())
    assert [p[:3] for p in report['rules']['R10']['pairs']] == [['A', 'local:20', sc(20)], ['B', 'local:22', sc(22)]]
    with closing(sqlite3.connect(generation / 'identity.sqlite')) as db:
        db.row_factory = sqlite3.Row
        recording = dict(db.execute('SELECT id,recording_id FROM entities WHERE id IN (?,?,?,?)', ('local:20', sc(20), 'local:22', sc(22))).fetchall())
        assert recording == {'local:20': 'local:20', sc(20): 'local:20', 'local:22': 'local:22', sc(22): 'local:22'}
        modes = dict(db.execute("SELECT method,acceptance_mode FROM identity_acceptances WHERE match_source='cleanup_obvious_link'").fetchall())
        assert modes == {'cleanup_policy_high_confidence': 'auto_high_confidence', 'cleanup_download_provenance': 'deterministic'}
        assert not db.execute('SELECT 1 FROM candidates WHERE left_id=? AND right_id=?', ('local:20', sc(21))).fetchone()  # settled
        from app.services.collection_consolidation import fingerprint
        stored = json.loads(db.execute("SELECT baseline_json FROM collection_consolidations WHERE id='d2'").fetchone()[0])
        assert stored['hashes']['sc:set2'] == fingerprint(db, 'sc:set2')
        assert json.loads(db.execute("SELECT value FROM metadata WHERE key='candidate_shortlist'").fetchone()[0])['rule_version'] == 'er3-settled-v1'
    again = run(capsys, argv + ['--apply'])
    assert again['ok'] and all(rule['changed'] == 0 for rule in again['rules'].values())
    assert again['rules']['R10']['consolidation_hashes']['restamped'] == 0
    run(capsys, ['--json', '--rollback', report['backup']['directory']])
    active = json.loads((root / 'active.json').read_text())['generation']
    assert values(root / 'datasets' / active) == pristine
