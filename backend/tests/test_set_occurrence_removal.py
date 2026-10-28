import pytest
from fastapi import HTTPException
from sqlalchemy import event
from sqlmodel import select

from app.api.sets import remove_track
from app.models import DJSet, SetTrack, Track


def seed(db):
    db.add_all([
        Track(id=1, absolute_path='/fixture/a.wav'),
        Track(id=2, absolute_path='/fixture/b.wav'),
        DJSet(id=1, title='Generated set'),
        DJSet(id=2, title='Other set'),
    ])
    db.commit()
    db.add_all([
        SetTrack(set_id=1, position=0, track_id=1, note='first occurrence'),
        SetTrack(set_id=1, position=3, track_id=2, note='middle'),
        SetTrack(set_id=1, position=7, track_id=1, note='second occurrence'),
        SetTrack(set_id=2, position=0, track_id=1, note='other set'),
    ])
    db.commit()


def rows(db):
    db.expire_all()
    return [(link.set_id, link.position, link.track_id, link.note) for link in db.exec(
        select(SetTrack).order_by(SetTrack.set_id, SetTrack.position)).all()]


@pytest.mark.parametrize('position', [0, 7])
def test_remove_clicked_occurrence_preserves_other_notes_and_positions(db, position):
    seed(db)
    before = rows(db)
    db.rollback()

    assert remove_track(1, 1, db, position=position) == {'removed': True}

    assert rows(db) == [row for row in before if row[:2] != (1, position)]


def test_older_client_removes_only_lowest_position_occurrence(db):
    seed(db)

    remove_track(1, 1, db)

    assert rows(db) == [
        (1, 3, 2, 'middle'),
        (1, 7, 1, 'second occurrence'),
        (2, 0, 1, 'other set'),
    ]


@pytest.mark.parametrize('position', [3, 99])
def test_stale_position_or_different_track_changes_nothing(db, position):
    seed(db)
    before = rows(db)
    db.rollback()

    with pytest.raises(HTTPException) as error:
        remove_track(1, 1, db, position=position)

    assert error.value.status_code == 409
    assert rows(db) == before


@pytest.mark.parametrize('set_id,track_id', [(99, 1), (1, 99)])
def test_missing_set_or_track_returns_not_found_without_changes(db, set_id, track_id):
    seed(db)
    before = rows(db)
    db.rollback()

    with pytest.raises(HTTPException) as error:
        remove_track(set_id, track_id, db)

    assert error.value.status_code == 404
    assert rows(db) == before


def test_failed_delete_rolls_back_occurrence(db):
    seed(db)
    before = rows(db)
    db.rollback()
    engine = db.get_bind()

    def fail(_conn, _cursor, statement, _params, _context, _many):
        if statement.startswith('DELETE FROM set_tracks'):
            raise RuntimeError('injected failure after delete')

    event.listen(engine, 'after_cursor_execute', fail)
    try:
        with pytest.raises(RuntimeError, match='injected failure'):
            remove_track(1, 1, db, position=7)
    finally:
        event.remove(engine, 'after_cursor_execute', fail)

    assert rows(db) == before


def test_delete_route_uses_position_query_parameter(db):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from app.api.sets import router
    from app.db import get_session

    seed(db)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[get_session] = lambda: db

    with TestClient(app) as client:
        response = client.delete('/sets/1/tracks/1?position=7')

    assert response.status_code == 200
    assert response.json() == {'removed': True}
    assert rows(db) == [
        (1, 0, 1, 'first occurrence'),
        (1, 3, 2, 'middle'),
        (2, 0, 1, 'other set'),
    ]
