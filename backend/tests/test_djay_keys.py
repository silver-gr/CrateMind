"""djay's key index becomes a key name, and tracks.key_djay follows the djay rows."""
from __future__ import annotations

import pytest
from sqlmodel import select

from app.models import Track, TrackBeatgrid
from app.services.djay_import import djay_key, remove_djay_beatgrids, sync_djay_keys
from app.services.musical_key import to_camelot


@pytest.mark.parametrize(("index", "expected"), [
    (0, "C major"), (1, "A minor"), (2, "C# major"), (3, "A# minor"),
    (13, "D# minor"), (21, "G minor"), (22, "B major"), (23, "G# minor"),
    (None, None), (-1, None), (24, None),
])
def test_djay_key_index(index, expected):
    assert djay_key(index) == expected


def test_each_index_pair_is_a_relative_major_and_minor():
    names = [djay_key(index) for index in range(24)]
    assert len(set(names)) == 24
    for i in range(12):
        major, minor = to_camelot(names[2 * i]), to_camelot(names[2 * i + 1])
        assert major[:-1] == minor[:-1] and (major[-1], minor[-1]) == ("B", "A")


def _grid(track_id: int, key_index: int | None, source: str = "djay") -> TrackBeatgrid:
    return TrackBeatgrid(track_id=track_id, source=source, source_uuid=f"{source}-{track_id}", key_index=key_index)


def test_sync_follows_djay_rows_only(db):
    a, b, c = Track(absolute_path="/a.mp3"), Track(absolute_path="/b.mp3"), Track(absolute_path="/c.mp3", key_djay="E minor")
    db.add_all([a, b, c])
    db.commit()
    db.add_all([_grid(a.id, 1), _grid(b.id, 5, source="cratemind")])
    db.commit()
    sync_djay_keys(db.connection())
    db.commit()
    db.expire_all()
    keys = {t.absolute_path: t.key_djay for t in db.exec(select(Track)).all()}
    assert keys == {"/a.mp3": "A minor", "/b.mp3": None, "/c.mp3": None}

    assert remove_djay_beatgrids(db) == 1
    db.expire_all()
    assert db.get(Track, a.id).key_djay is None
