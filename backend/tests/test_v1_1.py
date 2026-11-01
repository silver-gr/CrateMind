"""v1.1 'Memory Crates' — saved searches, count, bridge recommender,
pair-note memory, and set play logging."""
from __future__ import annotations

import pytest

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


@pytest.mark.parametrize("rating,want", [(5, 11), (3, 9), (None, 6), (2, -7), (1, -8)])
def test_pair_note_raw_deltas_boost_for_3_plus_and_penalise_clash(db, rating, want):
    a = _mk(db, "/A.wav", bpm=150, personal_status="approved")
    control = _mk(db, "/control.wav", bpm=150, personal_status="approved")
    cand = _mk(db, "/cand.wav", bpm=150, personal_status="approved")
    db.add(TrackPairNote(from_track_id=a.id, to_track_id=cand.id, rating=rating))
    db.commit()
    ctx = recommender.Context(previous_bpm=150, after_track_id=a.id, exclude_ids={a.id})
    ranked = {r["track_id"]: r for r in recommender.recommend(db, ctx, limit=50)}
    assert round(ranked[cand.id]["score"] - ranked[control.id]["score"], 2) == want
    reasons = ranked[cand.id]["reasons"]
    if want < 0:
        assert "- σημειώθηκε ότι η μετάβαση A→αυτό δεν δούλεψε" in reasons
        assert not any("worked" in r for r in reasons)
    else:
        assert any("noted A→this worked" in r for r in reasons)


def test_pair_note_penalty_is_directional(db):
    a = _mk(db, "/A.wav", bpm=150, personal_status="approved")
    cand = _mk(db, "/cand.wav", bpm=150, personal_status="approved")
    db.add(TrackPairNote(from_track_id=cand.id, to_track_id=a.id, rating=1))  # cand→A, not A→cand
    db.commit()
    ctx = recommender.Context(previous_bpm=150, after_track_id=a.id, exclude_ids={a.id})
    row = next(r for r in recommender.recommend(db, ctx) if r["track_id"] == cand.id)
    assert not any("σημειώθηκε" in r or "noted" in r for r in row["reasons"])


def test_pair_note_penalty_applies_to_both_bridge_legs(db):
    a = _mk(db, "/A.wav", bpm=145, personal_status="approved")
    b = _mk(db, "/B.wav", bpm=150, personal_status="approved")
    cand = _mk(db, "/cand.wav", bpm=148, personal_status="approved")
    ctx = recommender.Context(previous_bpm=145, next_bpm=150, after_track_id=a.id, before_track_id=b.id, exclude_ids={a.id, b.id})
    base = next(r for r in recommender.recommend(db, ctx) if r["track_id"] == cand.id)["score"]
    db.add(TrackPairNote(from_track_id=a.id, to_track_id=cand.id, rating=1))
    db.add(TrackPairNote(from_track_id=cand.id, to_track_id=b.id, rating=2))
    db.commit()
    row = next(r for r in recommender.recommend(db, ctx) if r["track_id"] == cand.id)
    assert round(row["score"] - base, 2) == -15  # -8 and -7
    assert "- σημειώθηκε ότι η μετάβαση A→αυτό δεν δούλεψε" in row["reasons"]
    assert "- σημειώθηκε ότι η μετάβαση αυτό→B δεν δούλεψε" in row["reasons"]


def test_recommender_uses_newest_note_per_pair(db):
    a = _mk(db, "/A.wav", bpm=150, personal_status="approved")
    cand = _mk(db, "/cand.wav", bpm=150, personal_status="approved")
    ctx = recommender.Context(previous_bpm=150, after_track_id=a.id, exclude_ids={a.id})
    db.add(TrackPairNote(from_track_id=a.id, to_track_id=cand.id, rating=5))
    db.add(TrackPairNote(from_track_id=a.id, to_track_id=cand.id, rating=1))  # newer: clash
    db.commit()
    row = next(r for r in recommender.recommend(db, ctx) if r["track_id"] == cand.id)
    assert any("δεν δούλεψε" in r for r in row["reasons"])
    db.add(TrackPairNote(from_track_id=a.id, to_track_id=cand.id, rating=4))  # newest: good again
    db.commit()
    row = next(r for r in recommender.recommend(db, ctx) if r["track_id"] == cand.id)
    assert any("noted A→this worked" in r for r in row["reasons"]) and not any("δεν δούλεψε" in r for r in row["reasons"])


def test_pair_note_post_updates_newest_and_keeps_text_and_type(db):
    from app.api.sets import create_pair_note, list_pair_notes
    from app.schemas import PairNoteCreate
    a = _mk(db, "/A.wav")
    b = _mk(db, "/B.wav")
    old = TrackPairNote(from_track_id=a.id, to_track_id=b.id, rating=5, notes="old", transition_type="cut")
    db.add(old); db.commit()
    new = create_pair_note(PairNoteCreate(from_track_id=a.id, to_track_id=b.id, rating=4, notes="keep me", transition_type="blend"), db)
    # Rating-only call (omitted fields stay omitted): text and type survive, no new row.
    again = create_pair_note(PairNoteCreate.model_validate({"from_track_id": a.id, "to_track_id": b.id, "rating": 1}), db)
    assert again["id"] == new["id"] == old.id  # one canonical record, updated in place
    assert (again["rating"], again["notes"], again["transition_type"]) == (1, "keep me", "blend")
    # An explicit null still clears a field (the Set Builder dialog sends every field).
    cleared = create_pair_note(PairNoteCreate(from_track_id=a.id, to_track_id=b.id, rating=3, notes=None, transition_type=None), db)
    assert (cleared["rating"], cleared["notes"], cleared["transition_type"]) == (3, None, None)
    # The reverse direction is its own pair; first call inserts.
    rev = create_pair_note(PairNoteCreate.model_validate({"from_track_id": b.id, "to_track_id": a.id, "rating": 5}), db)
    assert rev["id"] != old.id and len(list_pair_notes(None, db)) == 2


def test_pair_note_post_updates_only_newest_duplicate(db):
    from app.api.sets import create_pair_note
    from app.schemas import PairNoteCreate
    a = _mk(db, "/A.wav")
    b = _mk(db, "/B.wav")
    first = TrackPairNote(from_track_id=a.id, to_track_id=b.id, rating=5, notes="first")
    second = TrackPairNote(from_track_id=a.id, to_track_id=b.id, rating=4, notes="second")
    db.add(first); db.add(second); db.commit()
    out = create_pair_note(PairNoteCreate.model_validate({"from_track_id": a.id, "to_track_id": b.id, "rating": 1}), db)
    assert out["id"] == second.id and out["notes"] == "second"
    db.refresh(first)
    assert (first.rating, first.notes) == (5, "first")  # older duplicates stay untouched


# ---- set play logging ------------------------------------------------------

def test_log_set_play_bumps_counts(client):
    s = client.post("/api/sets", json={"title": "live"}).json()
    # no tracks yet -> 0 logged, still 200
    r = client.post(f"/api/sets/{s['id']}/log-play", json={"crowd_reaction": 4})
    assert r.status_code == 200
    assert r.json()["tracks_logged"] == 0
