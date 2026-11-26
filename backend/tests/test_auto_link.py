"""auto_link: the plan's rules and guards, apply, undo of one decision and of a batch, and the API (synthetic only)."""
import builtins
import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from app.services import auto_link, canonical_library as canonical, collection_consolidation as consolidation, manual_identity
from app.services.identity_matching import normalized_item
from tests.test_canonical import fixture_db

A, B, C = 'spotify:track:a', 'spotify:track:b', 'spotify:track:c'


def sc(i): return f'soundcloud:tracks:{i}'


def make_db():
    db = fixture_db()
    db.executescript(canonical.SCHEMA)
    consolidation.init(db)
    return db


def add(db, sid, title='Moon Garden', artist='Alpha Beta', dur=300.0, recording=None, state='derived', isrc='', kind='track', **metadata):
    service, recording = sid.split(':')[0], recording or sid
    track = int(sid.split(':')[1]) if service == 'local' else None
    if track:
        metadata = {'absolute_path': f'/music/{track}.mp3', 'file_name': f'{track}.mp3', **metadata}
    norm = normalized_item({'id': sid, 'service': service, 'title': title, 'artist': artist, 'duration_ms': dur and dur * 1000, 'kind': kind})
    norm.update(kind=kind, isrc_key=isrc)
    db.execute('INSERT OR IGNORE INTO recordings VALUES (?,?,?)', (recording, title, 'PROVISIONAL'))
    db.execute('INSERT INTO entities VALUES (?,?,?,?,?,?,?,?,?,?,?)', (sid, service, title, artist, dur and dur * 1000, track, None, recording,
                                                                       'NO_CANDIDATE', json.dumps(metadata), json.dumps(norm)))
    db.execute('INSERT INTO canonical_base_entities VALUES (?,?,?)', (sid, sid, 'NO_CANDIDATE'))
    db.execute("INSERT OR IGNORE INTO canonical_recordings VALUES (?,?,?,'','',?,'{}','{}','then')", (recording, title, artist, state))
    if recording != sid:  # an existing group is held together by a ledger row, as in the real catalog
        db.execute("INSERT INTO identity_acceptances VALUES (?,?,'x',95,'existing','{}','t','deterministic',NULL)", (recording, sid))


def pairs(rows): return [(d['rule'], d['left_id'], d['right_id']) for d in rows]
def groups(db): return dict(db.execute('SELECT id,recording_id FROM entities ORDER BY id').fetchall())
def stops(planned): return {(s['left_id'], s['right_id']): s['reason'] for s in planned['stopped']}


def test_link_needs_the_lengths_within_two_seconds():
    db = make_db()
    add(db, 'local:1'); add(db, A, dur=302.0)
    add(db, 'local:2', title='Sun Temple'); add(db, B, title='Sun Temple', dur=302.1)
    planned = auto_link.plan(db)
    assert pairs(planned['links']) == [('text_exact', 'local:1', A)] and planned['links'][0]['delta'] == 2.0
    assert planned['review'] == [{'local_id': 'local:2', 'remote_id': B, 'reason': 'length_2_5', 'delta': 2.1}]


def test_fold_rules_and_their_guards():
    db = make_db()
    add(db, A, isrc='AAA1'); add(db, sc(1), title='Quite Other Words', artist='Label Nine', dur=301.0, isrc='AAA1')        # same ISRC and length
    add(db, B, title='Sun Temple', isrc='BBB1'); add(db, sc(2), title='Sun Temple', dur=340.0, isrc='BBB1')              # same ISRC, 40 s apart
    add(db, C, title='Red Desert - Zed Remix', isrc='CCC1'); add(db, sc(3), title='Red Desert', isrc='CCC1')             # a remix and its original
    add(db, 'spotify:track:d', title='Blue Lagoon', isrc='DDD1'); add(db, sc(4), title='Blue Lagoon', dur=301.0, isrc='DDD2')  # two ISRCs, same text
    for i, dur in enumerate((300.0, 301.9, 303.8)):                                                                       # a chain is not one group
        add(db, f'spotify:track:chain{i}', title='Long Road', dur=dur)
    add(db, 'spotify:track:e', title='Inner Talk (Chapter One)'); add(db, 'spotify:track:f', title='Inner Talk (Chapter Two)', dur=301.0)
    add(db, 'spotify:track:g', title='Night Owl'); add(db, sc(5), title='Alpha Beta - Night Owl [Free Download]', artist='Some Label')
    planned = auto_link.plan(db)
    assert pairs(planned['folds']) == [
        ('isrc_duration', sc(1), A), ('text_exact', sc(4), 'spotify:track:d'), ('text_exact', 'spotify:track:chain0', 'spotify:track:chain1'),
        ('artist_in_title', sc(5), 'spotify:track:g')]
    assert stops(planned) == {(sc(3), C): 'version_differs', ('spotify:track:chain1', 'spotify:track:chain2'): 'length_differs',
                              ('spotify:track:e', 'spotify:track:f'): 'version_differs'}
    assert not planned['links'] and not planned['review']


def test_fold_keeps_the_local_recording_then_the_spotify_one_then_the_most_listed():
    db = make_db()
    add(db, 'local:1'); add(db, sc(1), recording='local:1'); add(db, A)
    add(db, B, title='Sun Temple'); add(db, sc(2), title='Sun Temple')
    add(db, sc(3), title='Red Desert'); add(db, sc(4), title='Red Desert')
    db.execute("INSERT INTO collections VALUES ('c1','Set','soundcloud','source_snapshot',1,'{}')")
    db.execute("INSERT INTO memberships VALUES ('c1',0,?,'t','{}')", (sc(4),))
    assert {d['left_id']: d['target'] for d in auto_link.plan(db)['folds']} == {sc(1): 'local:1', sc(2): B, sc(3): sc(4)}


def test_two_recordings_that_each_hold_a_local_file_are_never_folded():
    db = make_db()
    add(db, 'local:1'); add(db, A, recording='local:1')
    add(db, 'local:2', title='Moon Garden (Night Label)'); add(db, sc(1), recording='local:2')
    planned = auto_link.plan(db)
    assert not planned['folds'] and stops(planned)[sc(1), A] == 'two_local_files'


@pytest.mark.parametrize('setup,reason', [
    (lambda db: db.execute("UPDATE canonical_recordings SET state='human' WHERE recording_id='local:1'"), 'edited_by_hand'),
    (lambda db: db.execute("INSERT INTO canonical_blocks VALUES ('local:1',?,'human_rejection')", (A,)), 'rejected_before'),
    (lambda db: db.execute("INSERT INTO candidates VALUES ('local:1',?,'local:spotify',90,'CONFLICT',?)", (A, json.dumps({'conflicts': ['previously_rejected']}))),
     'rejected_before'),
    (lambda db: db.execute("INSERT INTO identity_acceptances VALUES ('local:1',?,'x',98,'auto_v1:text_exact','{}','t','auto_high_confidence','t2')", (A,)),
     'undone_before'),
    (lambda db: db.execute("UPDATE entities SET normalized_json=json_set(normalized_json,'$.kind','long_form') WHERE id=?", (A,)), 'not_a_single_track'),
    (lambda db: add(db, sc(8), title='Other Upload', dur=None, recording=A), 'length_unknown'),
    (lambda db: add(db, sc(8), title='Other Upload', dur=305.0, recording=A), 'length_differs'),
    (lambda db: add(db, sc(8), title='Moon Garden (Zed Remix)', recording=A), 'version_differs'),
    (lambda db: add(db, 'local:9', title='Other File', recording=A), 'two_local_files'),
    (lambda db: add(db, 'local:9'), 'claimed_twice'),
    (lambda db: add(db, B, title='Old Link', recording='local:1'), 'has_that_service'),
])
def test_each_guard_stops_the_link_and_sends_the_track_to_review(setup, reason):
    db = make_db()
    add(db, 'local:1'); add(db, A)
    assert pairs(auto_link.plan(db)['links']) == [('text_exact', 'local:1', A)]
    setup(db)
    planned = auto_link.plan(db)
    assert not planned['links'] and stops(planned)['local:1', A] == reason
    unlinked = reason != 'has_that_service'  # a track that already has a source record needs no manual look
    assert [r for r in planned['review'] if r['local_id'] == 'local:1'] == (
        [{'local_id': 'local:1', 'remote_id': A, 'reason': 'stopped_by_guard', 'guard': reason, 'delta': 0.0}] if unlinked else [])


def test_a_machine_block_is_overridden_and_a_second_service_is_added():
    db = make_db()
    add(db, 'local:1'); add(db, sc(1), recording='local:1'); add(db, A, isrc='ZZZ9')
    db.execute("INSERT INTO canonical_blocks VALUES ('local:1',?,'contradictory_isrc'),(?,?,'component_artist_conflict')", (A, sc(1), A))
    planned = auto_link.plan(db)
    # The stored blocks do not count: the Spotify copy folds into the track's recording through its SoundCloud record.
    assert pairs(planned['folds']) == [('text_exact', sc(1), A)] and planned['folds'][0]['target'] == 'local:1' and not planned['links']


def test_folds_run_before_links_so_two_copies_are_one_candidate():
    db = make_db()
    add(db, 'local:1'); add(db, A); add(db, sc(1), dur=300.5)
    add(db, 'local:2', title='Sun Temple'); add(db, B, title='Sun Temple')
    add(db, 'local:3', title='Sun Temple', artist='Alpha Beta & Zed', dur=300.2)
    planned = auto_link.plan(db)
    assert pairs(planned['folds']) == [('text_exact', sc(1), A)]
    assert pairs(planned['links']) == [('text_exact', 'local:1', A)]   # the closest length of the one recording
    # local:2 and local:3 both claim the one Spotify record: neither is linked, both go to review.
    assert {r['local_id']: (r['reason'], r.get('guard')) for r in planned['review']} == {
        'local:2': ('stopped_by_guard', 'claimed_twice'), 'local:3': ('stopped_by_guard', 'claimed_twice')}


def test_review_set_reasons():
    db = make_db()
    add(db, 'local:1'); add(db, A); add(db, B, dur=301.0, artist='Alpha Beta & Zed')                 # two different recordings qualify
    db.execute("INSERT INTO canonical_blocks VALUES (?,?,'human_rejection')", (A, B))
    add(db, 'local:2', title='Silver River Night', artist='Delta Echo'); add(db, C, title='Silver River Night', artist='Kilo Lima')
    add(db, 'local:3', title='Jokers Smile Again', artist='Gamma Ray'); add(db, sc(3), title='Jokers Smiles Again', artist='Gamma Ray', dur=301.0)
    add(db, 'local:4', title='Parallel Dimension', artist='Nobody Known'); add(db, sc(4), title='Parallel Dimensions', artist='Someone Else')
    planned = auto_link.plan(db)
    assert not planned['links']
    assert {r['local_id']: r['reason'] for r in planned['review']} == {
        'local:1': 'several_candidates', 'local:2': 'title_only', 'local:3': 'similar_title'}  # local:4 has no artist evidence


def test_title_only_rules_link_and_are_listed_first():
    db = make_db()
    add(db, 'local:1'); add(db, A)
    add(db, 'local:2', title='Silver River Night', artist='Unknown Artist'); add(db, B, title='Silver River Night', artist='Kilo Lima')
    add(db, 'local:3', title='Red Desert Storm', artist='Delta Echo', album='Kilo Lima Collected'); add(db, C, title='Red Desert Storm', artist='Kilo Lima')
    planned = auto_link.plan(db)
    assert pairs(planned['links']) == [('text_exact', 'local:1', A), ('title_unknown_artist', 'local:2', B), ('title_supported', 'local:3', C)]
    auto_link.apply(db, planned, batch='b1')
    listed = auto_link.decisions(db)
    assert [(r['rule'], r['left_file_name'], r['right_artist'], r['right_title']) for r in listed['items']][2] == ('text_exact', '1.mp3', 'Alpha Beta', 'Moon Garden')
    assert {r['rule'] for r in listed['items'][:2]} == {'title_unknown_artist', 'title_supported'}
    assert listed['total'] == 3 and listed['rules'] == {'link': {'text_exact': 1, 'title_unknown_artist': 1, 'title_supported': 1}, 'fold': {}}
    assert [(b['id'], b['link'], b['fold']) for b in listed['batches']] == [('b1', 3, 0)]
    assert auto_link.decisions(db, rule='title_supported')['total'] == 1 and auto_link.decisions(db, kind='fold')['items'] == []


def linked_fixture():
    """One local file, its SoundCloud and Spotify copies, and a second local with a Spotify record."""
    db = make_db()
    add(db, 'local:1'); add(db, sc(1), dur=300.4); add(db, A)
    add(db, 'local:2', title='Sun Temple'); add(db, B, title='Sun Temple - Original Mix', dur=301.0)
    return db


def test_apply_marks_every_decision_and_a_second_run_changes_nothing():
    db = linked_fixture()
    canonical_before = [tuple(r) for r in db.execute('SELECT recording_id,title,artist,version,release,state FROM canonical_recordings ORDER BY 1')]
    planned = auto_link.plan(db)
    assert pairs(planned['folds']) == [('text_exact', sc(1), A)] and planned['folds'][0]['target'] == A
    assert pairs(planned['links']) == [('text_exact', 'local:1', A), ('text_clean', 'local:2', B)]
    assert auto_link.apply(db, planned, batch='b1') == 'b1'
    assert groups(db) == {'local:1': 'local:1', sc(1): 'local:1', A: 'local:1', 'local:2': 'local:2', B: 'local:2'}
    rows = [dict(r) for r in db.execute("SELECT * FROM identity_acceptances WHERE method LIKE 'auto_v1:%' ORDER BY rowid")]
    assert [(r['left_id'], r['right_id'], r['match_source'], r['confidence'], r['method'], r['acceptance_mode'], r['revoked_at']) for r in rows] == [
        (sc(1), A, 'automatic_fold', 98.5, 'auto_v1:text_exact', 'auto_high_confidence', None),
        ('local:1', A, 'automatic_link', 98.6, 'auto_v1:text_exact', 'auto_high_confidence', None),
        ('local:2', B, 'automatic_link', 98.6, 'auto_v1:text_clean', 'auto_high_confidence', None)]
    assert json.loads(rows[2]['evidence_json']) == {'policy': 'auto_v1', 'batch': 'b1', 'kind': 'link', 'rule': 'text_clean',
                                                    'delta_seconds': 1.0, 'matched': 'field~field'}
    # Names stay put: every canonical row keeps its title, artist and state; the joined rows stay as aliases.
    assert [tuple(r) for r in db.execute('SELECT recording_id,title,artist,version,release,state FROM canonical_recordings ORDER BY 1')] == canonical_before
    actions = [r[0] for r in db.execute('SELECT action FROM canonical_events ORDER BY id')]
    assert actions == ['automatic_identity_link'] * 3 + [auto_link.REVIEW_EVENT]  # no SoundCloud mirror: the links go to Spotify records
    assert {r[0] for r in db.execute("SELECT status FROM entities")} == {'ACCEPTED'}
    again = auto_link.plan(db)
    assert not again['folds'] and not again['links']
    with pytest.raises(ValueError, match='never revoked here'):
        canonical.revoke(db, 'local:1', A)


def test_undo_of_one_decision_and_of_a_batch_restores_the_groups_exactly():
    db = linked_fixture()
    before = groups(db)
    auto_link.apply(db, auto_link.plan(db), batch='b1')
    assert auto_link.undo(db, A, sc(1)) == {'still_connected': False}   # either order of the pair; the fold only
    assert groups(db) == {'local:1': 'local:1', A: 'local:1', sc(1): sc(1), 'local:2': 'local:2', B: 'local:2'}
    assert auto_link.undo(db, sc(1), A) == {'already_undone': True}
    assert auto_link.undo_batch(db, 'b1') == {'undone': 2, 'batch': 'b1'}
    assert groups(db) == before
    assert db.execute("SELECT count(*) FROM identity_acceptances WHERE method LIKE 'auto_v1:%' AND revoked_at IS NULL").fetchone()[0] == 0
    # The badges are recomputed from the suggestions, not restored; nothing stays marked as linked.
    assert 'ACCEPTED' not in {r[0] for r in db.execute("SELECT status FROM entities")}
    # An undone pair is never linked again, by a later run or by a direct call.
    again = auto_link.plan(db)
    assert not again['folds'] and not again['links'] and set(stops(again).values()) == {'undone_before'}
    with pytest.raises(ValueError, match='never linked automatically again'):
        manual_identity.link_automatic(db, 'local:1', A, {}, method='auto_v1:text_exact', mode='auto_high_confidence', target='local:1', confidence=98.6)
    with pytest.raises(ValueError, match='παρτίδα'):
        auto_link.undo_batch(db, 'b1')
    with pytest.raises(ValueError, match='αυτόματες'):
        auto_link.undo(db, 'local:1', 'local:2')


def test_records_of_an_undone_cluster_are_not_folded_through_another_pair():
    db = make_db()
    for sid, dur in ((A, 300.0), (B, 300.5), (C, 301.0)):
        add(db, sid, dur=dur)
    planned = auto_link.plan(db)
    assert len(planned['folds']) == 2
    auto_link.apply(db, planned, batch='b1')
    assert len(set(groups(db).values())) == 1
    auto_link.undo_batch(db, 'b1')
    assert groups(db) == {A: A, B: B, C: C} and not auto_link.plan(db)['folds']


def test_an_undone_batch_is_not_rejoined_through_an_older_group():
    db = make_db()
    add(db, A, isrc='AAA1'); add(db, sc(1), title='Quite Other Words', artist='Label Nine', recording=A)   # one recording before the batch
    add(db, B); add(db, sc(2), title='Quite Other Words', artist='Label Nine')                            # a second copy of each
    planned = auto_link.plan(db)
    assert pairs(planned['folds']) == [('text_exact', A, B), ('text_exact', sc(1), sc(2))]
    auto_link.apply(db, planned, batch='b1')
    auto_link.undo_batch(db, 'b1')
    assert groups(db) == {A: A, sc(1): A, B: B, sc(2): sc(2)}
    db.execute("UPDATE entities SET normalized_json=json_set(normalized_json,'$.isrc_key','AAA1') WHERE id IN (?,?)", (B, sc(2)))
    again = auto_link.plan(db)   # the two copies share an ISRC, but the batch had them in one recording
    assert not again['folds'] and stops(again)[sc(2), B] == 'undone_before'


def test_link_automatic_needs_a_target_and_a_confidence_for_a_rule():
    db = linked_fixture()
    with pytest.raises(ValueError, match='target'):
        manual_identity.link_automatic(db, sc(1), A, {}, method='auto_v1:text_exact', mode='auto_high_confidence', target='local:1', confidence=98.5)
    with pytest.raises(ValueError, match='target'):
        manual_identity.link_automatic(db, sc(1), A, {}, method='auto_v1:text_exact', mode='auto_high_confidence', target=A)
    with pytest.raises(ValueError, match='Unknown automatic'):
        manual_identity.link_automatic(db, sc(1), A, {}, method='auto_v1:anything', mode='auto_high_confidence', target=A, confidence=98.5)
    assert db.execute('SELECT count(*) FROM identity_acceptances').fetchone()[0] == 0


def test_a_pair_outside_the_reviewed_file_is_never_written():
    db = linked_fixture()
    planned = auto_link.plan(db, allowed={('local:2', B), ('local:1', sc(1)), ('local:9', A)})
    # Without the fold the track has two candidate recordings, so its link is not made either.
    assert not planned['folds'] and pairs(planned['links']) == [('text_clean', 'local:2', B)]
    assert pairs(planned['outside']) == [('text_exact', sc(1), A)]
    assert [(r['local_id'], r['reason']) for r in planned['review']] == [('local:1', 'several_candidates')]


def test_a_hand_edited_recording_is_untouched():
    db = linked_fixture()
    db.execute("UPDATE canonical_recordings SET title='My Title',state='human' WHERE recording_id=?", (B,))
    row = tuple(db.execute('SELECT * FROM canonical_recordings WHERE recording_id=?', (B,)).fetchone())
    planned = auto_link.plan(db)
    assert ('local:2', B) not in {(d['left_id'], d['right_id']) for d in planned['links']}
    auto_link.apply(db, planned, batch='b1')
    assert tuple(db.execute('SELECT * FROM canonical_recordings WHERE recording_id=?', (B,)).fetchone()) == row
    assert groups(db)[B] == B


def test_collection_hashes_follow_the_recordings_and_come_back_on_undo():
    db = linked_fixture()
    db.execute("INSERT INTO collections VALUES ('c1','Likes','soundcloud','likes',1,'{}'),('c2','Set','soundcloud','source_snapshot',1,'{}')")
    db.execute("INSERT INTO memberships VALUES ('c1',0,?,'t','{}'),('c2',0,?,'t','{}')", (sc(1), sc(1)))
    fp = lambda cid: consolidation.fingerprint(db, cid)
    db.execute("INSERT INTO collection_consolidations VALUES ('d1','b','automatic','exact','active',?,?,'t')",
               (json.dumps({'ids': ['c1', 'c2'], 'hashes': {'c1': fp('c1'), 'c2': 'stale'}}), json.dumps({'representative_hashes': {'c1': fp('c1')}})))
    stored = lambda: tuple(db.execute("SELECT baseline_json,result_json FROM collection_consolidations WHERE id='d1'").fetchone())
    before = stored()
    auto_link.apply(db, auto_link.plan(db), batch='b1')
    baseline, result = (json.loads(x) for x in stored())
    assert stored() != before and baseline['hashes'] == {'c1': fp('c1'), 'c2': 'stale'} and result['representative_hashes'] == {'c1': fp('c1')}
    auto_link.undo_batch(db, 'b1')
    assert stored() == before


def test_review_set_drops_what_was_decided_since():
    db = make_db()
    add(db, 'local:1'); add(db, A); add(db, B, dur=301.0, artist='Alpha Beta & Zed')
    db.execute("INSERT INTO canonical_blocks VALUES (?,?,'human_rejection')", (A, B))
    add(db, 'local:2', title='Silver River Night', artist='Delta Echo'); add(db, C, title='Silver River Night', artist='Kilo Lima')
    assert auto_link.review(db) == {'items': []}
    planned = auto_link.plan(db)
    auto_link.apply(db, planned, batch='b1')
    assert [(r['local_id'], r['reason']) for r in auto_link.review(db)['items']] == [('local:1', 'several_candidates'), ('local:2', 'title_only')]
    db.execute("INSERT INTO canonical_blocks VALUES ('local:2',?,'human_rejection')", (C,))          # the owner rejected the pair
    db.execute("UPDATE entities SET recording_id='local:1' WHERE id=?", (B,))                         # the owner linked the track
    assert auto_link.review(db) == {'items': []}


def test_an_automatically_linked_track_keeps_its_name_after_a_retag():
    from app.services.identity_sync import sync_local_rows
    db = linked_fixture()
    row = lambda track, title: {'id': track, 'title': title, 'artist': 'Alpha Beta', 'duration': 300, 'file_name': f'{track}.mp3',
                                'absolute_path': f'/music/{track}.mp3', 'missing': 0}
    auto_link.apply(db, auto_link.plan(db, allowed={(sc(1), A), ('local:1', A)}), batch='b1')
    sync_local_rows(db, [row(1, 'Retagged One'), row(2, 'Retagged Two')])
    names = dict(db.execute("SELECT recording_id,title FROM canonical_recordings WHERE recording_id IN ('local:1','local:2')").fetchall())
    assert names == {'local:1': 'Moon Garden', 'local:2': 'Retagged Two'}   # the unlinked track still follows its file


def test_headline_counts_linked_tracks_and_remote_only_recordings():
    db = linked_fixture()
    add(db, 'spotify:episode:e', title='Talk')
    add(db, sc(9), title='', artist='')                                               # an id with no title is not a known song
    assert auto_link.headline(db) == {'local_tracks': 2, 'linked_local_tracks': 0, 'remote_records': 4, 'remote_recordings': 4, 'remote_only': 4}
    auto_link.apply(db, auto_link.plan(db), batch='b1')
    assert auto_link.headline(db) == {'local_tracks': 2, 'linked_local_tracks': 2, 'remote_records': 4, 'remote_recordings': 3, 'remote_only': 1}


def test_no_file_is_opened(monkeypatch):
    from app.services import provider_resolution
    db = linked_fixture()
    auto_link.plan(db)  # imports settle before the trap
    def trap(*args, **kwargs): raise AssertionError('a file was opened')
    with monkeypatch.context() as patch:
        patch.setattr(builtins, 'open', trap)
        patch.setattr(provider_resolution, 'file_evidence', trap)
        auto_link.apply(db, auto_link.plan(db), batch='b1')
        auto_link.decisions(db), auto_link.review(db), auto_link.headline(db)
        auto_link.undo(db, 'local:2', B)
        auto_link.undo_batch(db, 'b1')


def test_soundcloud_mirror_rows_follow_apply_and_batch_undo(db, tmp_path):
    from app.models import Track, TrackSoundCloudMatch
    from app.services.identity_sync import replay_mirror_intents
    from sqlmodel import select
    source = make_db()
    add(source, 'local:1', absolute_path='/library/1.mp3'); add(source, sc(1))
    source.commit()
    path = tmp_path / 'identity.sqlite'
    with sqlite3.connect(path) as destination:
        source.backup(destination)
    db.add(Track(id=1, title='Moon Garden', artist='Alpha Beta', duration=300, absolute_path='/library/1.mp3', file_name='1.mp3'))
    db.commit()
    matches = lambda: [(m.track_id, m.soundcloud_track_id, m.method) for m in db.exec(select(TrackSoundCloudMatch)).all()]
    before = matches()
    with canonical.connect(path) as authority:
        auto_link.apply(authority, auto_link.plan(authority), batch='b1')
    assert replay_mirror_intents(db, path) == {'applied': 1, 'cancelled': 0}
    assert matches() == [(1, 1, 'auto_v1:text_exact')]
    with canonical.connect(path) as authority:
        auto_link.undo_batch(authority, 'b1')
    assert replay_mirror_intents(db, path) == {'applied': 1, 'cancelled': 0}
    db.expire_all()
    assert matches() == before == []


@pytest.fixture
def desktop(db, tmp_path, monkeypatch):
    from app.app_factory import create_app
    from app.runtime_profile import RuntimeProfile
    source = linked_fixture()
    auto_link.apply(source, auto_link.plan(source), batch='b1')
    source.execute("INSERT INTO identity_acceptances VALUES ('local:2','local:1','x',100,'manual_identity_confirmation','{}','t','human',NULL)")
    source.commit()
    path = tmp_path / 'identity.sqlite'
    with sqlite3.connect(path) as destination:
        source.backup(destination)
    monkeypatch.setenv('CRATEMIND_IDENTITY_DB_PATH', str(path))
    with TestClient(create_app(RuntimeProfile.DESKTOP_CORE)) as client:
        yield client, path


def stored_groups(path):
    with sqlite3.connect(path) as db:
        return dict(db.execute('SELECT id,recording_id FROM entities'))


def test_desktop_lists_automatic_links_and_folds(desktop):
    client, _ = desktop
    links = client.get('/api/identity/automatic-links').json()
    assert links['total'] == 2 and links['rules'] == {'link': {'text_exact': 1, 'text_clean': 1}, 'fold': {'text_exact': 1}}
    assert [(r['left_id'], r['left_file_name'], r['right_service'], r['right_title'], r['rule'], r['batch']) for r in links['items']] == [
        ('local:2', '2.mp3', 'spotify', 'Sun Temple - Original Mix', 'text_clean', 'b1'), ('local:1', '1.mp3', 'spotify', 'Moon Garden', 'text_exact', 'b1')]
    folds = client.get('/api/identity/automatic-links', params={'kind': 'fold', 'rule': 'text_exact'}).json()
    assert [(r['left_id'], r['right_id'], r['delta_seconds']) for r in folds['items']] == [(sc(1), A, 0.4)]
    assert client.get('/api/identity/automatic-links/review').json() == {'items': []}


def test_desktop_may_undo_an_automatic_fold_between_two_remote_records(desktop):
    client, path = desktop
    pair = {'left_id': sc(1), 'right_id': A}
    # The general undo keeps its desktop guard; only the automatic-links route takes a pair of remote records.
    assert client.post('/api/identity/undo-identity', json=pair).json()['code'] == 'web_workflow_required'
    response = client.post('/api/identity/automatic-links/undo', json=pair)
    assert response.status_code == 200 and response.json() == {'still_connected': False}
    assert stored_groups(path)[sc(1)] == sc(1) and stored_groups(path)[A] == 'local:1'
    refused = client.post('/api/identity/automatic-links/undo', json={'left_id': 'local:2', 'right_id': 'local:1'})
    assert refused.status_code == 400 and 'αυτόματες' in refused.json()['detail']


def test_desktop_may_undo_one_link_but_not_a_whole_batch(desktop):
    client, path = desktop
    assert client.post('/api/identity/automatic-links/undo', json={'left_id': 'local:2', 'right_id': B}).status_code == 200
    assert stored_groups(path)[B] == B
    # A whole batch is undone only by the command (app closed, verified backup), never from the app.
    assert client.post('/api/identity/automatic-links/undo-batch', json={'batch_id': 'b1'}).status_code in (404, 405)
    assert client.get('/api/identity/automatic-links').json()['total'] == 1
