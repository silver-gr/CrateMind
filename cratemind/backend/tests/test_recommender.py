"""Recommender scoring behaviour and transparency."""
from __future__ import annotations

from app.models import Track, TrackDJProfile
from app.services import recommender


def _track(db, path, bpm=150, key=None, **profile) -> Track:
    t = Track(absolute_path=path, bpm=bpm, key_text=key, missing=False)
    db.add(t)
    db.commit()
    db.refresh(t)
    if profile:
        db.add(TrackDJProfile(track_id=t.id, **profile))
        db.commit()
    return t


def test_weapon_outranks_unknown(db):
    _track(db, "/weapon.wav", bpm=150, energy=8, personal_status="weapon")
    _track(db, "/plain.wav", bpm=150, energy=8, personal_status="unknown")
    ctx = recommender.Context(target_bpm=150, target_energy=8)
    ranked = recommender.recommend(db, ctx)
    assert ranked[0]["personal_status"] == "weapon"
    assert ranked[0]["score"] > ranked[1]["score"]


def test_retired_excluded(db):
    _track(db, "/retired.wav", personal_status="retired")
    _track(db, "/ok.wav", personal_status="approved")
    ranked = recommender.recommend(db, recommender.Context())
    paths = {r["personal_status"] for r in ranked}
    assert "retired" not in paths


def test_reasons_present(db):
    _track(db, "/a.wav", bpm=150, energy=8, personal_status="approved")
    ctx = recommender.Context(target_bpm=150, target_energy=8)
    ranked = recommender.recommend(db, ctx)
    assert ranked[0]["reasons"]
    assert any("BPM" in r for r in ranked[0]["reasons"])


def test_approved_only_filters(db):
    _track(db, "/a.wav", personal_status="testing")
    _track(db, "/b.wav", personal_status="approved")
    ranked = recommender.recommend(db, recommender.Context(approved_only=True))
    assert all(r["personal_status"] in ("approved", "weapon") for r in ranked)
