"""auto_link + manual_identity: guards across every member pair, human decisions never overridden, undo and
batches in any order, idempotency, unicode and boundary inputs (synthetic catalogs only)."""
import json

import pytest

from app.services import auto_link, manual_identity
from tests.test_auto_link import A, B, C, add, groups, linked_fixture, make_db, pairs, sc, stops

RETIRED = {'asset_lifecycle': {'state': 'retired'}}


def active_auto(db):
    return db.execute("SELECT count(*) FROM identity_acceptances WHERE method LIKE 'auto_v1:%' AND revoked_at IS NULL").fetchone()[0]


def human_link(db, left, right, metadata_from):
    token = manual_identity.comparison(db, left, right)['token']
    return manual_identity.link(db, left, right, token, metadata_from)


def test_plan_only_reads():
    db = linked_fixture()
    add(db, 'local:3', title='Sun Temple'); add(db, C, title='Red Desert')
    before = db.total_changes
    planned = auto_link.plan(db)
    assert planned['links'] and planned['folds']
    assert db.total_changes == before


def test_the_plan_does_not_depend_on_the_order_records_were_added():
    specs = [('local:1', {}), (sc(1), {'dur': 300.4}), (A, {}), ('local:2', {'title': 'Sun Temple'}),
             (B, {'title': 'Sun Temple - Original Mix', 'dur': 301.0}), ('local:3', {'title': 'Sun Temple', 'artist': 'Alpha Beta & Zed'}),
             (C, {'title': 'Red Desert'}), (sc(2), {'title': 'Red Desert', 'dur': 301.5})]
    plans = []
    for order in (specs, specs[::-1]):
        db = make_db()
        for sid, extra in order:
            add(db, sid, **extra)
        plans.append(auto_link.plan(db))
    assert plans[0] == plans[1]


@pytest.mark.parametrize('state', ['human', 'kept_local', 'rejected'])
@pytest.mark.parametrize('side', ['local:1', A])
def test_every_protected_state_on_either_side_stops_the_link(state, side):
    db = make_db()
    add(db, 'local:1'); add(db, A)
    db.execute('UPDATE canonical_recordings SET state=? WHERE recording_id=?', (state, side))
    planned = auto_link.plan(db)
    assert not planned['links'] and stops(planned)['local:1', A] == 'edited_by_hand'


@pytest.mark.parametrize('setup', [
    # a human rejection between another member of the track's recording and the remote record
    lambda db: (add(db, sc(8), title='Other Upload', recording='local:1'),
                db.execute("INSERT INTO canonical_blocks VALUES (?,?,'human_rejection')", (sc(8), A))),
    # between the track and another member of the remote record's recording, stored in the other orientation
    lambda db: (add(db, sc(8), title='Other Upload', recording=A),
                db.execute("INSERT INTO canonical_blocks VALUES (?,?,'human_rejection')", (sc(8), 'local:1'))),
    # a rejection from the older catalog
    lambda db: db.execute("INSERT INTO canonical_blocks VALUES ('local:1',?,'historical_rejection')", (A,)),
    # a rejection that names a member no longer live still counts
    lambda db: (add(db, sc(8), title='Other Upload', recording=A, **RETIRED),
                db.execute("INSERT INTO canonical_blocks VALUES ('local:1',?,'human_rejection')", (sc(8),))),
], ids=['member-of-local', 'member-of-remote', 'historical', 'retired-member'])
def test_a_human_rejection_between_any_two_members_stops_the_link(setup):
    db = make_db()
    add(db, 'local:1'); add(db, A)
    setup(db)
    planned = auto_link.plan(db)
    assert not planned['links'] and stops(planned)['local:1', A] == 'rejected_before'
    auto_link.apply(db, planned, batch='b1')
    assert groups(db)['local:1'] != groups(db)[A]


def test_a_human_rejection_between_members_stops_a_fold_of_two_remote_records():
    db = make_db()
    add(db, A); add(db, B); add(db, sc(8), title='Other Upload', recording=B)
    assert pairs(auto_link.plan(db)['folds']) == [('text_exact', A, B)]
    db.execute("INSERT INTO canonical_blocks VALUES (?,?,'human_rejection')", (A, sc(8)))
    planned = auto_link.plan(db)
    assert not planned['folds'] and stops(planned)[A, B] == 'rejected_before'


def test_a_retired_member_of_another_length_does_not_stop_the_link_but_a_live_one_does():
    db = make_db()
    add(db, 'local:1'); add(db, A); add(db, sc(8), title='Other Upload', dur=400.0, recording=A, **RETIRED)
    assert pairs(auto_link.plan(db)['links']) == [('text_exact', 'local:1', A)]
    db.execute("UPDATE entities SET metadata_json='{}' WHERE id=?", (sc(8),))
    assert stops(auto_link.plan(db))['local:1', A] == 'length_differs'


def test_a_retired_second_copy_of_the_file_does_not_claim_the_remote_record():
    db = make_db()
    add(db, 'local:1'); add(db, 'local:9', **RETIRED); add(db, A)
    assert pairs(auto_link.plan(db)['links']) == [('text_exact', 'local:1', A)]


def test_a_pair_the_owner_linked_and_then_undid_is_never_linked_automatically():
    db = make_db()
    add(db, 'local:1'); add(db, A)
    human_link(db, 'local:1', A, 'local:1')
    assert groups(db)['local:1'] == groups(db)[A]
    manual_identity.undo(db, 'local:1', A)
    assert groups(db) == {'local:1': 'local:1', A: A}
    planned = auto_link.plan(db)
    assert not planned['links'] and stops(planned)['local:1', A] == 'undone_before'
    with pytest.raises(ValueError, match='never linked automatically again'):
        manual_identity.link_automatic(db, 'local:1', A, {}, method='auto_v1:text_exact', mode='auto_high_confidence',
                                       target='local:1', confidence=98.6)


def test_an_automatic_undo_never_undoes_a_human_link():
    db = make_db()
    add(db, 'local:1'); add(db, A)
    human_link(db, 'local:1', A, 'local:1')
    with pytest.raises(ValueError, match='αυτόματες'):
        auto_link.undo(db, A, 'local:1')
    assert db.execute("SELECT revoked_at FROM identity_acceptances WHERE left_id='local:1' AND right_id=?", (A,)).fetchone()[0] is None
    assert groups(db)['local:1'] == groups(db)[A]


def test_a_human_link_made_after_the_batch_survives_its_batch_undo():
    db = make_db()
    add(db, 'local:1'); add(db, A)
    add(db, sc(5), artist='Some Label')                                          # title only: never automatic
    auto_link.apply(db, auto_link.plan(db), batch='b1')
    assert groups(db)[A] == 'local:1'
    human_link(db, 'local:1', sc(5), 'local:1')                                 # the owner adds the label upload by hand
    assert auto_link.undo_batch(db, 'b1') == {'undone': 1, 'batch': 'b1'}
    found = groups(db)
    assert found['local:1'] == found[sc(5)] and found[A] != found['local:1']
    assert db.execute("SELECT revoked_at FROM identity_acceptances WHERE right_id=?", (sc(5),)).fetchone()[0] is None


def test_undo_of_a_later_batch_leaves_the_earlier_batch_in_place():
    db = make_db()
    add(db, 'local:1'); add(db, A)
    auto_link.apply(db, auto_link.plan(db), batch='b1')
    add(db, 'local:2', title='Sun Temple'); add(db, B, title='Sun Temple')
    second = auto_link.plan(db)
    assert pairs(second['links']) == [('text_exact', 'local:2', B)]          # b1's pair is not decided again
    auto_link.apply(db, second, batch='b2')
    assert [(b['id'], b['link']) for b in auto_link.decisions(db)['batches']] in ([('b2', 1), ('b1', 1)], [('b1', 1), ('b2', 1)])
    assert auto_link.decisions(db, batch='b1')['total'] == 1
    assert auto_link.undo_batch(db, 'b2') == {'undone': 1, 'batch': 'b2'}
    found = groups(db)
    assert found[A] == 'local:1' and found[B] == B
    assert [b['id'] for b in auto_link.decisions(db)['batches']] == ['b1']


def test_applying_the_same_plan_twice_writes_each_decision_once():
    db = linked_fixture()
    planned = auto_link.plan(db)
    auto_link.apply(db, planned, batch='b1')
    rows = [tuple(r) for r in db.execute('SELECT * FROM identity_acceptances ORDER BY rowid')]
    links = db.execute("SELECT count(*) FROM canonical_events WHERE action='automatic_identity_link'").fetchone()[0]
    before = groups(db)
    auto_link.apply(db, planned, batch='b1')
    assert [tuple(r) for r in db.execute('SELECT * FROM identity_acceptances ORDER BY rowid')] == rows
    assert db.execute("SELECT count(*) FROM canonical_events WHERE action='automatic_identity_link'").fetchone()[0] == links
    assert groups(db) == before


def test_a_stale_plan_cannot_relink_what_its_batch_undo_split():
    db = linked_fixture()
    planned = auto_link.plan(db)
    auto_link.apply(db, planned, batch='b1')
    auto_link.undo_batch(db, 'b1')
    split = groups(db)
    with pytest.raises(ValueError, match='never linked automatically again'):
        auto_link.apply(db, planned, batch='b2')
    assert groups(db) == split and active_auto(db) == 0


def test_undo_of_one_fold_in_a_chain_keeps_the_other_pair_together():
    db = make_db()
    for sid, dur in ((A, 300.0), (B, 300.5), (C, 301.0)):
        add(db, sid, dur=dur)
    planned = auto_link.plan(db)
    assert pairs(planned['folds']) == [('text_exact', A, B), ('text_exact', B, C)]
    auto_link.apply(db, planned, batch='b1')
    assert auto_link.undo(db, B, A) == {'still_connected': False}
    found = groups(db)
    assert found[B] == found[C] and found[A] != found[B]
    assert active_auto(db) == 1
    again = auto_link.plan(db)
    assert not again['folds'] and set(stops(again).values()) == {'undone_before'}


def test_greek_names_with_accents_and_case_link_as_the_same_text():
    db = make_db()
    add(db, 'local:1', title='Πρώτη Φορά', artist='Ξύλινα Σπαθιά')
    add(db, A, title='ΠΡΩΤΗ ΦΟΡΑ', artist='ξυλινα σπαθια')
    add(db, 'local:2', title='Ηλιοβασίλεμα', artist='Ζωή')                  # another song, same length
    planned = auto_link.plan(db)
    assert pairs(planned['links']) == [('text_exact', 'local:1', A)]


@pytest.mark.parametrize('title', ['🔥🔥', '★ ★', '', '()'])
def test_remote_records_with_no_title_text_never_fold(title):
    db = make_db()
    add(db, sc(1), title=title); add(db, sc(2), title=title, dur=300.5)
    assert auto_link.plan(db)['folds'] == []


@pytest.mark.parametrize('dur,folds', [(302.0, True), (302.001, False), (298.0, True), (297.999, False)])
def test_two_remote_records_fold_only_within_two_seconds(dur, folds):
    db = make_db()
    add(db, A); add(db, sc(1), dur=dur)
    assert bool(auto_link.plan(db)['folds']) is folds


def test_an_empty_catalog_plans_nothing_and_applies_only_its_review_set():
    db = make_db()
    planned = auto_link.plan(db)
    assert planned == {'folds': [], 'links': [], 'review': [], 'stopped': [], 'outside': []}
    assert auto_link.apply(db, planned, batch='b0') == 'b0'
    assert [r[0] for r in db.execute('SELECT action FROM canonical_events')] == [auto_link.REVIEW_EVENT]
    assert auto_link.review(db) == {'items': []}
    assert auto_link.decisions(db)['total'] == 0 and auto_link.decisions(db)['batches'] == []
    assert auto_link.headline(db) == {'local_tracks': 0, 'linked_local_tracks': 0, 'remote_records': 0,
                                      'remote_recordings': 0, 'remote_only': 0}
    with pytest.raises(ValueError, match='παρτίδα'):
        auto_link.undo_batch(db, 'b0')


def test_link_automatic_refuses_unknown_records_and_writes_nothing():
    db = linked_fixture()
    with pytest.raises(ValueError, match='Unknown source identity'):
        manual_identity.link_automatic(db, 'local:1', 'spotify:track:nope', {}, method='auto_v1:text_exact',
                                       mode='auto_high_confidence', target='local:1', confidence=98.6)
    assert db.execute('SELECT count(*) FROM identity_acceptances').fetchone()[0] == 0


def test_link_automatic_on_an_active_pair_returns_without_writing():
    db = linked_fixture()
    auto_link.apply(db, auto_link.plan(db), batch='b1')
    changes = db.total_changes
    again = manual_identity.link_automatic(db, A, 'local:1', {}, method='auto_v1:text_exact', mode='auto_high_confidence',
                                           target='local:1', confidence=98.6)
    assert again == {'recording_id': 'local:1', 'already_accepted': True}
    assert db.total_changes == changes


def test_the_review_set_keeps_the_last_catch_up_only():
    db = make_db()
    add(db, 'local:2', title='Silver River Night', artist='Delta Echo'); add(db, C, title='Silver River Night', artist='Kilo Lima')
    auto_link.apply(db, auto_link.plan(db), batch='b1')
    assert [r['local_id'] for r in auto_link.review(db)['items']] == ['local:2']
    db.execute("UPDATE entities SET title='Something Else', normalized_json=? WHERE id=?",
               (json.dumps({'kind': 'track', 'isrc_key': ''}), 'local:2'))
    planned = auto_link.plan(db)
    assert planned['review'] == []
    auto_link.apply(db, planned, batch='b2')
    assert auto_link.review(db) == {'items': []}
