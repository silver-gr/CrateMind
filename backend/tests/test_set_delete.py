import json

import pytest
from fastapi import HTTPException
from sqlmodel import select

from app.api.sets import delete_set
from app.models import AuditLog, DJSet, PlayEvent, SetTrack, SetTransition, Track, TrackDJProfile, TrackPairNote


def transition(set_id, a, b):
    return SetTransition(set_id=set_id, from_track_id=a, to_track_id=b, preset="blend", bars=16,
                         volume_curve="linear", eq_curve="swap", filter_curve="none")


def seed(db):
    db.add_all([
        Track(id=1, absolute_path='/fixture/a.wav'),
        Track(id=2, absolute_path='/fixture/b.wav'),
        TrackDJProfile(track_id=1, energy=7),
        DJSet(id=1, title='Draft'),
        DJSet(id=2, title='Keep'),
    ])
    db.commit()
    db.add_all([
        SetTrack(set_id=1, position=0, track_id=1),
        SetTrack(set_id=1, position=1, track_id=2, note='long blend'),
        SetTrack(set_id=2, position=0, track_id=1),
        SetTrack(set_id=2, position=1, track_id=2),
        transition(1, 1, 2),
        transition(2, 1, 2),
        TrackPairNote(from_track_id=1, to_track_id=2, rating=5),
        PlayEvent(id=10, track_id=1, set_id=1),
        PlayEvent(id=11, track_id=2, set_id=2),
    ])
    db.commit()
    db.rollback()


def test_delete_removes_set_rows_and_transitions_and_keeps_the_rest(db):
    seed(db)

    assert delete_set(1, db) == {'deleted': True, 'set_id': 1, 'track_count': 2}

    db.expire_all()
    assert [s.id for s in db.exec(select(DJSet)).all()] == [2]
    assert {link.set_id for link in db.exec(select(SetTrack)).all()} == {2}
    assert [t.set_id for t in db.exec(select(SetTransition)).all()] == [2]
    assert {t.id for t in db.exec(select(Track)).all()} == {1, 2}
    assert db.get(TrackDJProfile, 1).energy == 7
    assert len(db.exec(select(TrackPairNote)).all()) == 1
    plays = {p.id: p.set_id for p in db.exec(select(PlayEvent)).all()}
    assert plays == {10: None, 11: 2}
    entry = db.exec(select(AuditLog).where(AuditLog.action == 'set.delete')).one()
    assert entry.entity_id == 1
    before = json.loads(entry.before_json)
    assert before['title'] == 'Draft' and before['track_ids'] == [1, 2]
    assert [(r['position'], r['track_id'], r['note']) for r in before['set_tracks']] == [(0, 1, None), (1, 2, 'long blend')]
    assert [(r['from_track_id'], r['to_track_id'], r['preset'], r['bars']) for r in before['set_transitions']] == [
        (1, 2, 'blend', 16)]


def test_delete_unknown_set_is_404_and_changes_nothing(db):
    seed(db)

    with pytest.raises(HTTPException) as error:
        delete_set(99, db)

    assert error.value.status_code == 404
    db.expire_all()
    assert len(db.exec(select(DJSet)).all()) == 2
    assert len(db.exec(select(SetTrack)).all()) == 4
