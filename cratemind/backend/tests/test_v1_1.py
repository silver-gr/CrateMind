"""v1.1 'Memory Crates' — saved searches, count, bridge recommender,
pair-note memory, and set play logging."""
from __future__ import annotations

from app.db import reindex_track
from app.models import Track, TrackDJProfile, TrackPairNote
from app.services import recommender, search


def _mk(db, path, bpm=150, key=None, **profile) -> Track:
    t = Track(absolute_path=path, bpm=bpm, key_text=key, missing=False)
    db.add(t)
    db.commit()
    db.refresh(t)
    if profile:
        db.add(TrackDJProfile(track_id=t.id, **profile))
        db.commit()
    reindex_track(db, t.id)
    return t


# ---- saved searches (API) --------------------------------------------------

def test_saved_search_crud_and_count(client):
    # seed two approved tracks via the API-backed DB
    client.post("/api/sets", json={"title": "warmup"})  # touch app
    # create a crate
    r = client.post("/api/searches", json={
        "name": "Forgotten Approved", "query": "status:approved not_recent:90",
    })
    assert r.status_code == 200
    sid = r.json()["id"]
    assert r.json()["count"] == 0  # nothing tagged yet

    listed = client.get("/api/searches").json()
    assert any(s["name"] == "Forgotten Approved" for s in listed)

    client.patch(f"/api/searches/{sid}", json={"pinned": True})
    assert client.get("/api/searches").json()[0]["pinned"] is True

    assert client.delete(f"/api/searches/{sid}").json()["deleted"] is True
    assert client.get("/api/searches").json() == []


def test_track_count_endpoint(client):
    assert client.get("/api/tracks/count", params={"q": "status:approved"}).json()["count"] == 0


# ---- count (service) -------------------------------------------------------

def test_search_count_matches_results(db):
    _mk(db, "/a.wav", personal_status="approved")
    _mk(db, "/b.wav", personal_status="approved")
    _mk(db, "/c.wav", personal_status="testing")
    assert search.count(db, "status:approved") == 2
    assert len(search.search(db, "status:approved")) == 2
    assert search.count(db, "zzznomatch") == 0


# ---- bridge recommender ----------------------------------------------------

def test_bridge_prefers_candidate_fitting_both_neighbors(db):
    a = _mk(db, "/A.wav", bpm=140, key="8A", personal_status="approved")
    b = _mk(db, "/B.wav", bpm=150, key="9A", personal_status="approved")
    # good bridge: sits between A(140) and B(150) on bpm and key
    good = _mk(db, "/good.wav", bpm=145, key="8A", personal_status="approved")
    # bad: fits A but lands far from B
    _mk(db, "/bad.wav", bpm=141, key="2B", personal_status="approved")

    ctx = recommender.Context(
        previous_bpm=a.bpm, previous_key=a.key_text,
        next_bpm=b.bpm, next_key=b.key_text,
        after_track_id=a.id, before_track_id=b.id,
        exclude_ids={a.id, b.id},
    )
    ranked = recommender.recommend(db, ctx)
    assert ranked[0]["track_id"] == good.id
    assert any("into B" in r for r in ranked[0]["reasons"])


def test_pair_note_memory_boosts_and_explains(db):
    a = _mk(db, "/A.wav", bpm=150, personal_status="approved")
    cand = _mk(db, "/cand.wav", bpm=150, personal_status="approved")
    db.add(TrackPairNote(from_track_id=a.id, to_track_id=cand.id,
                         rating=5, transition_type="breakdown swap"))
    db.commit()

    ctx = recommender.Context(previous_bpm=150, after_track_id=a.id, exclude_ids={a.id})
    ranked = recommender.recommend(db, ctx)
    top = next(r for r in ranked if r["track_id"] == cand.id)
    assert any("noted A→this worked" in r for r in top["reasons"])


# ---- set play logging ------------------------------------------------------

def test_log_set_play_bumps_counts(client):
    s = client.post("/api/sets", json={"title": "live"}).json()
    # no tracks yet -> 0 logged, still 200
    r = client.post(f"/api/sets/{s['id']}/log-play", json={"crowd_reaction": 4})
    assert r.status_code == 200
    assert r.json()["tracks_logged"] == 0
