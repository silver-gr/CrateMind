"""Per-track downbeat override (CrateMind-owned; hermetic fixtures only)."""
from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlmodel import Session, select

from app.models import Track, TrackBeatgrid, TrackDownbeat


@pytest.fixture
def track_id(client):
    from app.db import get_engine

    with Session(get_engine(), expire_on_commit=False) as session:
        track = Track(absolute_path="/x/a.mp3", file_name="a.mp3", duration=100.0)
        session.add(track)
        session.commit()
        return track.id


def test_downbeat_round_trip_and_validation(client, track_id):
    url = f"/api/tracks/{track_id}/downbeat"
    assert client.get(url).json() == {"downbeat_s": None}
    assert client.post(url, json={"downbeat_s": 12.5}).json() == {"downbeat_s": 12.5}
    assert client.post(url, json={"downbeat_s": 20.25}).status_code == 200  # upsert
    assert client.get(url).json() == {"downbeat_s": 20.25}
    for bad in (-0.1, 100.5):
        assert client.post(url, json={"downbeat_s": bad}).status_code == 422
    assert client.post(url, content='{"downbeat_s": NaN}',
                       headers={"content-type": "application/json"}).status_code == 422
    assert client.get(url).json() == {"downbeat_s": 20.25}
    assert client.delete(url).status_code == 204
    assert client.delete(url).status_code == 204
    assert client.get(url).json() == {"downbeat_s": None}
    for call in (client.get, client.delete):
        assert call("/api/tracks/9999/downbeat").status_code == 404
    assert client.post("/api/tracks/9999/downbeat", json={"downbeat_s": 1}).status_code == 404


def test_downbeat_cascades_and_survives_djay_removal(client, track_id):
    from app.db import get_engine
    from app.services import djay_import

    assert client.post(f"/api/tracks/{track_id}/downbeat", json={"downbeat_s": 3.0}).status_code == 200
    with Session(get_engine()) as session:
        session.add(TrackBeatgrid(track_id=track_id, source="djay", source_uuid="x", bpm=120.0))
        session.commit()
        djay_import.remove_djay_beatgrids(session)
        assert len(session.exec(select(TrackDownbeat)).all()) == 1
        session.exec(text("DELETE FROM tracks WHERE id = :i").bindparams(i=track_id))
        session.commit()
        assert session.exec(select(TrackDownbeat)).all() == []
