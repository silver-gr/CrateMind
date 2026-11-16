"""Recommender: exclusions, continuous tempo, bridge midpoint, absolute match, the set-less route."""
from __future__ import annotations

from sqlmodel import Session

import app.db as dbmod
from app.models import DuplicateGroup, DuplicateGroupTrack, Track, TrackDJProfile
from app.services import recommender


def _track(db, path, bpm=150.0, key=None, artist=None, **profile) -> Track:
    t = Track(absolute_path=path, bpm=bpm, key_text=key, artist=artist,
              artist_normalized=artist.casefold() if artist else None, missing=False)
    db.add(t)
    db.commit()
    db.refresh(t)
    if profile:
        db.add(TrackDJProfile(track_id=t.id, **profile))
        db.commit()
    return t


def _group(db, status="needs_review", **roles) -> None:
    group = DuplicateGroup(status=status)
    db.add(group)
    db.commit()
    db.refresh(group)
    for track_id, role in roles.items():
        db.add(DuplicateGroupTrack(group_id=group.id, track_id=int(track_id[1:]), role=role))
    db.commit()


def _ids(rows):
    return [r["track_id"] for r in rows]


def test_a_b_and_their_open_duplicates_are_never_suggested(db):
    a = _track(db, "/a.wav", key="8A")
    a_copy = _track(db, "/a-copy.wav", key="8A")
    a_edit = _track(db, "/a-edit.wav", key="8A")
    b = _track(db, "/b.wav", key="8A")
    other = _track(db, "/other.wav", key="8A")
    _group(db, **{f"t{a.id}": None, f"t{a_copy.id}": None, f"t{a_edit.id}": "different_edit"})
    ctx = recommender.build_context(db, a, b, recent_days=None)
    ids = _ids(recommender.recommend(db, ctx))
    assert a.id not in ids and b.id not in ids and a_copy.id not in ids
    assert a_edit.id in ids and other.id in ids  # a different edit is its own track


def test_ignored_duplicate_groups_hide_nothing(db):
    a = _track(db, "/a.wav")
    twin = _track(db, "/twin.wav")
    _group(db, status="ignored", **{f"t{a.id}": "master", f"t{twin.id}": "duplicate"})
    ctx = recommender.build_context(db, a, recent_days=None)
    assert twin.id in _ids(recommender.recommend(db, ctx))


def test_duplicate_candidates_collapse_to_the_best_copy(db):
    a = _track(db, "/a.wav")
    x1 = _track(db, "/x1.wav", bpm=150)
    x2 = _track(db, "/x2.wav", bpm=158)
    _group(db, **{f"t{x1.id}": "master", f"t{x2.id}": "duplicate"})
    ids = _ids(recommender.recommend(db, recommender.build_context(db, a, recent_days=None)))
    assert x1.id in ids and x2.id not in ids


def test_tempo_fit_is_continuous_and_relative():
    close, _ = recommender.bpm_fit(151.0, 150.0)
    near, _ = recommender.bpm_fit(153.0, 150.0)
    assert close > near > 0
    assert recommender.bpm_fit(156.0, 150.0)[1].startswith("BPM reachable")  # exactly 4%
    s, r = recommender.bpm_fit(170.0, 150.0)
    assert s < 0 and r.startswith("BPM far")
    assert recommender.bpm_fit(150.0, 0.0) == (0.0, None)


def test_bridge_prefers_the_a_b_midpoint(db):
    a = _track(db, "/a.wav", bpm=140)
    b = _track(db, "/b.wav", bpm=148)
    mid = _track(db, "/mid.wav", bpm=144)
    at_a = _track(db, "/at-a.wav", bpm=140)
    rows = recommender.recommend(db, recommender.build_context(db, a, b, recent_days=None))
    assert _ids(rows).index(mid.id) < _ids(rows).index(at_a.id)
    assert any("BPM between A and B" in r for r in rows[0]["reasons"])


def test_match_is_absolute_bounded_and_null_without_a_reference(db):
    a = _track(db, "/a.wav", bpm=150, key="8A")
    perfect = _track(db, "/p.wav", bpm=150, key="8A")
    clash = _track(db, "/c.wav", bpm=180, key="3B")
    rows = {r["track_id"]: r for r in recommender.recommend(db, recommender.build_context(db, a, recent_days=None))}
    assert rows[perfect.id]["match"] == 100
    assert 0 <= rows[clash.id]["match"] < 20
    assert rows[perfect.id]["bpm_delta_pct"] == 0.0
    bare = _track(db, "/bare.wav", bpm=None)
    rows = recommender.recommend(db, recommender.build_context(db, bare, recent_days=None))
    assert all(r["match"] is None for r in rows)


def test_status_and_freshness_add_no_reason_lines(db):
    a = _track(db, "/a.wav")
    _track(db, "/w.wav", personal_status="weapon")
    rows = recommender.recommend(db, recommender.build_context(db, a, recent_days=None))
    assert not any(r.lstrip("+- ") in {"weapon", "approved", "testing", "fresh (never played)"}
                   for row in rows for r in row["reasons"])


def _client_track(**kw) -> int:
    with Session(dbmod.get_engine()) as s:
        t = Track(missing=False, **kw)
        s.add(t)
        s.commit()
        s.refresh(t)
        return t.id


def test_recommend_route_needs_no_set_and_caps_at_96(client):
    a = _client_track(absolute_path="/a.wav", bpm=150)
    for i in range(3):
        _client_track(absolute_path=f"/c{i}.wav", bpm=150 + i)
    rows = client.post("/api/recommend", json={"after_track_id": a, "limit": 96}).json()
    assert len(rows) == 3 and a not in _ids(rows)
    assert {"match", "style", "bpm_delta_pct"} <= rows[0].keys()
    assert client.post("/api/recommend", json={"limit": 12}).status_code == 422
    assert client.post("/api/recommend", json={"after_track_id": 999999}).status_code == 404
    assert client.post("/api/recommend", json={"after_track_id": a, "limit": 97}).status_code == 422
    assert client.get("/api/sets").status_code == 200 and not any(
        s["title"] == "Flow scratch" for s in client.get("/api/sets").json())
