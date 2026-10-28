import pytest
from sqlalchemy import event
from sqlmodel import select
from fastapi import HTTPException

from app.api.sets import reorder
from app.models import DJSet, SetTrack, Track
from app.schemas import SetReorder


def seed(db):
    db.add_all([Track(id=1, absolute_path='/fixture/a.wav'), Track(id=2, absolute_path='/fixture/b.wav'),
                DJSet(id=1, title='Generated set')])
    db.commit()
    db.add_all([SetTrack(set_id=1, position=0, track_id=1, note='first occurrence'),
                SetTrack(set_id=1, position=1, track_id=2, note='middle'),
                SetTrack(set_id=1, position=2, track_id=1, note='second occurrence')])
    db.commit()


def rows(db):
    db.expire_all()
    return [(link.position, link.track_id, link.note) for link in db.exec(
        select(SetTrack).where(SetTrack.set_id == 1).order_by(SetTrack.position)).all()]


def test_reorder_repeated_tracks_by_occurrence_preserves_notes(db):
    seed(db)
    reorder(1, SetReorder(ordered_track_ids=[1, 1, 2], ordered_positions=[2, 0, 1]), db)
    assert rows(db) == [(0, 1, 'second occurrence'), (1, 1, 'first occurrence'), (2, 2, 'middle')]


def test_old_clients_reorder_all_repeated_occurrences_without_losing_rows(db):
    seed(db)
    reorder(1, SetReorder(ordered_track_ids=[1, 1, 2]), db)
    assert rows(db) == [(0, 1, 'first occurrence'), (1, 1, 'second occurrence'), (2, 2, 'middle')]


@pytest.mark.parametrize('payload', [
    {'ordered_track_ids': [1, 2]}, {'ordered_track_ids': [1, 2, 99]},
    {'ordered_track_ids': [1, 2, 1], 'ordered_positions': [0, 0, 2]},
    {'ordered_track_ids': [1, 2, 1], 'ordered_positions': [0, 2, 1]},
])
def test_stale_or_invalid_reorder_changes_nothing(db, payload):
    seed(db)
    with pytest.raises(HTTPException) as error:
        reorder(1, SetReorder(**payload), db)
    assert error.value.status_code == 409
    assert rows(db) == [(0, 1, 'first occurrence'), (1, 2, 'middle'), (2, 1, 'second occurrence')]


def test_failed_second_pass_rolls_back_entire_reorder(db):
    seed(db)
    engine = db.get_bind()
    updates = 0
    def fail(_conn, _cursor, statement, _params, _context, _many):
        nonlocal updates
        if statement.startswith('UPDATE set_tracks'):
            updates += 1
            if updates == 3:
                raise RuntimeError('injected failure after first final position')
    event.listen(engine, 'before_cursor_execute', fail)
    try:
        with pytest.raises(RuntimeError, match='injected failure'):
            reorder(1, SetReorder(ordered_track_ids=[2, 1, 1]), db)
    finally:
        event.remove(engine, 'before_cursor_execute', fail)
    assert rows(db) == [(0, 1, 'first occurrence'), (1, 2, 'middle'), (2, 1, 'second occurrence')]
