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


def test_effective_prefers_tag_over_analyzed(db):
    t = Track(absolute_path="/e.wav", bpm=150, key_text="Am",
              bpm_analyzed=120, key_analyzed="C major", missing=False)
    assert recommender.effective_bpm(t) == 150
    assert recommender.effective_key(t) == "Am"


def test_effective_falls_back_to_analyzed(db):
    t = Track(absolute_path="/f.wav", bpm=None, key_text=None,
              bpm_analyzed=128, key_analyzed="A minor", missing=False)
    assert recommender.effective_bpm(t) == 128
    assert recommender.effective_key(t) == "A minor"


def test_analyzed_bpm_used_in_ranking(db):
    t = Track(absolute_path="/g.wav", bpm=None, bpm_analyzed=150, missing=False)
    db.add(t)
    db.commit()
    ranked = recommender.recommend(db, recommender.Context(target_bpm=150))
    row = next(r for r in ranked if r["track_id"] == t.id)
    assert row["bpm"] == 150
    assert row["bpm_is_analyzed"] is True
    assert any("BPM" in r for r in row["reasons"])


def test_tempo_fit_folds_half_and_double_tempo():
    same, _ = recommender.bpm_fit(138.0, 138.0)
    half, reason = recommender.bpm_fit(276.0, 138.0)
    assert half == same - recommender.HALF_DOUBLE_PENALTY
    assert reason == "BPM close at half tempo: 138->276"
    double, reason = recommender.bpm_fit(70.0, 138.0)
    assert double > 0 and reason == "BPM near at double tempo: 138->70"
    # a 3:4 jump is not a tempo match: scored as before
    assert recommender.bpm_fit(200.0, 146.0) == (-4.0, "BPM far: 146->200")
    assert recommender.fold_bpm(200.0, 146.0) == 200.0


def test_double_tempo_track_is_suggested_after_its_half(db):
    a = _track(db, "/a138.wav", bpm=138)
    double = _track(db, "/c276.wav", bpm=276)
    other = _track(db, "/c160.wav", bpm=160)
    rows = {r["track_id"]: r for r in recommender.recommend(db, recommender.build_context(db, a))}
    assert rows[double.id]["score"] > rows[other.id]["score"]
    assert rows[double.id]["bpm_delta_pct"] == 0.0
    assert rows[double.id]["match"] == 70  # the half-tempo penalty shows in the match too
    assert rows[double.id]["reasons"] == ["+ BPM close at half tempo: 138->276"]


def test_bridge_midpoint_folds_a_double_tempo_b(db):
    a = _track(db, "/a138.wav", bpm=138)
    b = _track(db, "/b280.wav", bpm=280)
    between = _track(db, "/c139.wav", bpm=139)
    row = next(r for r in recommender.recommend(db, recommender.build_context(db, a, b)) if r["track_id"] == between.id)
    assert row["reasons"] == ["+ BPM between A and B: 138->139->280"]


def _own_key(db, path, key, confidence, **extra) -> Track:
    t = Track(absolute_path=path, bpm=150, key_analyzed=key, key_analyzed_confidence=confidence,
              key_analyzed_method="cqt-octave-trained-v2", missing=False, **extra)
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


def test_key_weight_follows_the_resolved_key_order(db):
    assert recommender.key_weight(_track(db, "/tag.wav", key="8A")) == 1.0
    assert recommender.key_weight(_own_key(db, "/sure.wav", "8A", 0.9)) == 1.0
    assert recommender.key_weight(_own_key(db, "/djay.wav", "8A", 0.4, key_djay="9A")) == 1.0
    assert recommender.key_weight(_own_key(db, "/unsure.wav", "8A", 0.4)) == 0.4


def test_uncertain_key_counts_less_and_says_so(db):
    a = _track(db, "/a.wav", key="8A")
    sure = _own_key(db, "/sure.wav", "8A", 0.9)
    unsure = _own_key(db, "/unsure.wav", "8A", 0.4)
    sure_clash = _own_key(db, "/sure-clash.wav", "2B", 0.9)
    unsure_clash = _own_key(db, "/unsure-clash.wav", "2B", 0.4)
    rows = {r["track_id"]: r for r in recommender.recommend(db, recommender.build_context(db, a))}
    assert rows[sure.id]["reasons"][1] == "+ key match 8a"
    assert rows[unsure.id]["reasons"][1] == "+ key match 8a (uncertain key)"
    assert rows[unsure_clash.id]["reasons"][1] == "- key clash 8a->2b (uncertain key)"
    # a match helps less and a clash hurts less, in the score and in the match percentage
    assert rows[sure.id]["score"] - rows[unsure.id]["score"] == 6.0
    assert round(rows[unsure_clash.id]["score"] - rows[sure_clash.id]["score"], 2) == 1.8
    assert (rows[sure_clash.id]["match"], rows[unsure_clash.id]["match"]) == (50, 71)


def test_an_uncertain_key_on_track_a_counts_less_too(db):
    a = _own_key(db, "/a.wav", "8A", 0.5)
    cand = _track(db, "/c.wav", key="8A")
    ctx = recommender.build_context(db, a)
    assert ctx.previous_key_weight == 0.5
    row = next(r for r in recommender.recommend(db, ctx) if r["track_id"] == cand.id)
    assert "+ key match 8a (uncertain key)" in row["reasons"]
