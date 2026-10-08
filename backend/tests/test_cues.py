"""Persistent listening bookmarks, strict request contracts, and catalog safety."""
from datetime import UTC, datetime

import pytest
from sqlalchemy import inspect, text
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app import db as dbmod
from app.models import PlayEvent, Track, TrackCue, TrackDJProfile
from app.services import scanner
from tests.conftest import make_wav


@pytest.fixture
def tracks(client):
    with Session(dbmod.get_engine()) as session:
        rows = [
            Track(absolute_path="/fixture-only/a.wav", extension="wav", duration=60),
            Track(absolute_path="/fixture-only/b.wav", extension="wav", duration=None),
        ]
        session.add_all(rows)
        session.commit()
        return [row.id for row in rows]


def _create(client, track_id, **values):
    response = client.post(
        f"/api/tracks/{track_id}/cues", json={"position_ms": 1234, "kind": "cue", **values},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _utc(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    assert parsed.tzinfo is not None and parsed.utcoffset() == UTC.utcoffset(parsed)
    return parsed


def test_crud_and_explicit_patch_fields(client, tracks):
    track_id = tracks[0]
    url = f"/api/tracks/{track_id}/cues"
    assert client.get(url).json() == []
    cue = _create(client, track_id, kind="entry", label="Είσοδος")
    assert set(cue) == {
        "id", "track_id", "position_ms", "kind", "label", "created_at", "updated_at",
    }
    assert cue["track_id"] == track_id
    assert cue["position_ms"] == 1234
    assert _utc(cue["created_at"]) == _utc(cue["updated_at"])
    item_url = f"{url}/{cue['id']}"
    updated = client.patch(item_url, json={"position_ms": 1334, "kind": "exit"})
    assert updated.status_code == 200
    result = updated.json()
    assert (result["position_ms"], result["kind"], result["label"]) == (1334, "exit", "Είσοδος")
    assert result["created_at"] == cue["created_at"]
    assert _utc(result["updated_at"]) >= _utc(cue["updated_at"])
    assert client.patch(item_url, json={"label": None}).json()["label"] is None
    before = client.get(url).json()[0]
    assert client.patch(item_url, json={}).json() == before
    removed = client.delete(item_url)
    assert removed.status_code == 204 and removed.content == b""
    assert client.get(url).json() == []
    assert client.delete(item_url).status_code == 404


def test_ordering_and_multiple_independent_entry_exit_cues(client, tracks):
    track_id = tracks[0]
    entries = [
        _create(client, track_id, position_ms=position, kind=kind)
        for position, kind in [(9999, "exit"), (0, "entry"), (234, "entry"),
                               (234, "exit"), (0, "exit"), (234, "cue")]
    ]
    assert all(item["label"] is None for item in entries)
    response = client.get(f"/api/tracks/{track_id}/cues")
    assert response.status_code == 200
    assert response.json() == sorted(entries, key=lambda item: (item["position_ms"], item["id"]))


INVALID_FIELDS = [
    {"position_ms": -1}, {"position_ms": 1.1}, {"position_ms": 1.0},
    {"position_ms": True}, {"position_ms": False}, {"position_ms": None},
    {"position_ms": "1000"}, {"position_ms": 2**63},
    {"kind": "loop"}, {"kind": "Entry"}, {"kind": None},
    {"label": "x" * 121}, {"label": 123},
    {"id": 99}, {"track_id": 99}, {"created_at": "2020-01-01T00:00:00Z"},
    {"updated_at": "2020-01-01T00:00:00Z"}, {"unknown": True},
]


@pytest.mark.parametrize("values", INVALID_FIELDS)
@pytest.mark.parametrize("method", ["post", "patch"])
def test_invalid_writes_are_422_and_leave_saved_cues_unchanged(client, tracks, values, method):
    track_id = tracks[0]
    cue = _create(client, track_id)
    url = f"/api/tracks/{track_id}/cues"
    if method == "post":
        response = client.post(url, json={"position_ms": 0, "kind": "entry", **values})
    else:
        response = client.patch(f"{url}/{cue['id']}", json=values)
    assert response.status_code == 422, response.text
    assert client.get(url).json() == [cue]


@pytest.mark.parametrize("body", [{}, {"kind": "cue"}, {"position_ms": 0}, None, []])
def test_post_requires_kind_and_position(client, tracks, body):
    assert client.post(f"/api/tracks/{tracks[0]}/cues", json=body).status_code == 422


def test_label_length_boundary_and_empty_label(client, tracks):
    cue = _create(client, tracks[0], label="α" * 120)
    assert cue["label"] == "α" * 120
    response = client.patch(f"/api/tracks/{tracks[0]}/cues/{cue['id']}", json={"label": ""})
    assert response.status_code == 200 and response.json()["label"] == ""


def test_duration_limit_and_100ms_metadata_rounding_tolerance(client, tracks):
    track_id = tracks[0]
    for position in (0, 60000, 60100):
        _create(client, track_id, position_ms=position)
    url = f"/api/tracks/{track_id}/cues"
    assert client.post(url, json={"position_ms": 60101, "kind": "cue"}).status_code == 422
    cue = _create(client, track_id)
    item_url = f"{url}/{cue['id']}"
    assert client.patch(item_url, json={"position_ms": 60101}).status_code == 422
    response = client.patch(item_url, json={"position_ms": 60100})
    assert response.status_code == 200 and response.json()["position_ms"] == 60100


@pytest.mark.parametrize("duration", [None, 0, -1, float("inf"), float("-inf"), float("nan")])
def test_unknown_or_nonfinite_duration_is_not_invented(client, tracks, duration):
    track_id = tracks[1]
    with Session(dbmod.get_engine()) as session:
        track = session.get(Track, track_id)
        track.duration = duration
        session.add(track)
        session.commit()
    cue = _create(client, track_id, position_ms=3_600_999)
    response = client.patch(
        f"/api/tracks/{track_id}/cues/{cue['id']}", json={"position_ms": 3_601_099},
    )
    assert response.status_code == 200 and response.json()["position_ms"] == 3_601_099


def test_fractional_duration_boundary(client, tracks):
    with Session(dbmod.get_engine()) as session:
        track = session.get(Track, tracks[0])
        track.duration = 1.2345
        session.add(track)
        session.commit()
    _create(client, tracks[0], position_ms=1334)
    response = client.post(
        f"/api/tracks/{tracks[0]}/cues", json={"position_ms": 1335, "kind": "cue"},
    )
    assert response.status_code == 422


def test_missing_resources_and_cross_track_isolation(client, tracks):
    cue = _create(client, tracks[0])
    unknown = 999999
    for track_id in [tracks[1], unknown]:
        item_url = f"/api/tracks/{track_id}/cues/{cue['id']}"
        assert client.patch(item_url, json={"label": "wrong track"}).status_code == 404
        assert client.delete(item_url).status_code == 404
    assert client.get(f"/api/tracks/{unknown}/cues").status_code == 404
    assert client.post(
        f"/api/tracks/{unknown}/cues", json={"position_ms": 0, "kind": "cue"},
    ).status_code == 404
    assert client.patch(
        f"/api/tracks/{tracks[0]}/cues/{unknown}", json={"label": "missing cue"},
    ).status_code == 404
    assert client.delete(f"/api/tracks/{tracks[0]}/cues/{unknown}").status_code == 404
    assert client.get(f"/api/tracks/{tracks[0]}/cues").json() == [cue]
    assert client.get(f"/api/tracks/{tracks[1]}/cues").json() == []


def test_missing_audio_still_has_cues_and_crud_does_not_log_plays(client, tracks):
    cue = _create(client, tracks[0])
    with Session(dbmod.get_engine()) as session:
        track = session.get(Track, tracks[0])
        track.missing = True
        session.add(track)
        session.commit()
    assert client.get(f"/api/tracks/{tracks[0]}/audio").status_code == 410
    assert client.get(f"/api/tracks/{tracks[0]}/cues").json() == [cue]
    assert client.patch(
        f"/api/tracks/{tracks[0]}/cues/{cue['id']}", json={"label": "saved"},
    ).status_code == 200
    assert client.delete(f"/api/tracks/{tracks[0]}/cues/{cue['id']}").status_code == 204
    with Session(dbmod.get_engine()) as session:
        track = session.get(Track, tracks[0])
        assert track.play_count == 0 and track.last_played_at is None
        assert session.exec(select(PlayEvent)).all() == []


def test_persistence_in_fresh_session_and_connection(client, tracks):
    cue = _create(client, tracks[0], position_ms=4321, kind="exit", label="Μετά το break")
    dbmod.get_engine().dispose()  # subsequent sessions must reopen the on-disk catalog
    with Session(dbmod.get_engine()) as session:
        persisted = session.get(TrackCue, cue["id"])
        assert persisted is not None
        assert (persisted.track_id, persisted.position_ms, persisted.kind, persisted.label) == (
            tracks[0], 4321, "exit", "Μετά το break",
        )
    assert client.get(f"/api/tracks/{tracks[0]}/cues").json() == [cue]


@pytest.mark.parametrize("delete_with_sql", [False, True])
def test_track_deletion_cascades_without_orphan_cues(db, delete_with_sql):
    track = Track(absolute_path="/fixture-only/delete.wav")
    db.add(track)
    db.commit()
    db.refresh(track)
    track_id = track.id
    db.add(TrackCue(track_id=track_id, position_ms=0, kind="entry"))
    db.commit()
    if delete_with_sql:
        db.exec(text("DELETE FROM tracks WHERE id = :id"), params={"id": track_id})
    else:
        db.delete(track)
    db.commit()
    with Session(db.get_bind()) as session:
        assert session.get(Track, track_id) is None
        assert session.exec(select(TrackCue)).all() == []


def test_database_rejects_orphan_cue(db):
    db.add(TrackCue(track_id=999999, position_ms=0, kind="cue"))
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_repeat_init_preserves_populated_pre_cue_catalog(db):
    engine = db.get_bind()
    TrackCue.__table__.drop(engine)  # reproduce the populated pre-feature schema
    track = Track(absolute_path="/fixture-only/old.wav", artist="Artist", title="Old", play_count=7)
    db.add(track)
    db.commit()
    db.refresh(track)
    track_id = track.id
    db.add(TrackDJProfile(track_id=track_id, notes="Existing human work", energy=9))
    db.commit()
    dbmod.reindex_track(db, track_id)
    assert "track_cues" not in inspect(engine).get_table_names()

    dbmod.init_db()
    dbmod.init_db()
    with Session(engine) as session:
        assert session.exec(select(Track)).one().id == track_id
        assert session.get(Track, track_id).play_count == 7
        profile = session.get(TrackDJProfile, track_id)
        assert profile.notes == "Existing human work" and profile.energy == 9
        assert session.exec(text("SELECT rowid FROM track_search")).all() == [(track_id,)]
        session.add(TrackCue(track_id=track_id, position_ms=123, kind="cue"))
        session.commit()
    dbmod.init_db()
    with Session(engine) as session:
        assert session.exec(select(TrackCue)).one().position_ms == 123


@pytest.mark.parametrize("mode", ["full", "delta"])
def test_cues_survive_unchanged_changed_missing_and_restored_scans(db, tmp_path, mode):
    lib = tmp_path / "lib"
    audio = make_wav(lib / "cue-track.wav", freq_seed=1)
    make_wav(lib / "other.wav", freq_seed=2)
    scanner.scan(db, [lib], mode=mode)
    track = db.exec(select(Track).where(Track.absolute_path == str(audio))).one()
    track_id = track.id
    cue = TrackCue(track_id=track_id, position_ms=234, kind="entry", label="Keep")
    db.add(cue)
    db.commit()
    db.refresh(cue)
    before = cue.model_dump()

    scanner.scan(db, [lib], mode=mode)
    audio.write_bytes(audio.read_bytes() + b"\x00\x00")  # fixture audio only
    scanner.scan(db, [lib], mode=mode)
    audio.unlink()
    scanner.scan(db, [lib], mode=mode)
    assert db.get(Track, track_id).missing
    assert db.get(TrackCue, cue.id).model_dump() == before
    make_wav(audio, freq_seed=1)
    scanner.scan(db, [lib], mode=mode)
    db.expire_all()
    assert not db.get(Track, track_id).missing
    assert db.get(TrackCue, cue.id).model_dump() == before
