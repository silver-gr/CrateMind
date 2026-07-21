from __future__ import annotations

import json

from app.api import tracks
from app.models import ArtistProfile, Job, Track
from app.services import artist_intelligence


def test_enrich_artist_profiles_updates_profiles(db, monkeypatch):
    db.add(ArtistProfile(normalized_name="atyya", canonical_name="ATYYA", track_count=2))
    db.commit()

    monkeypatch.setattr(
        artist_intelligence.llm_client,
        "chat_json",
        lambda _system, _user: {
            "artists": [
                {
                    "normalized_name": "atyya",
                    "canonical_name": "ATYYA",
                    "scene_cluster": "organic bass / glitch-hop",
                    "primary_subgenre": "deep_dubstep",
                    "secondary_subgenres": ["organic bass"],
                    "typical_bpm_min": 70,
                    "typical_bpm_max": 100,
                    "energy_min": 2,
                    "energy_max": 5,
                    "set_role_hints": ["warmup"],
                    "confidence_label": "high",
                    "needs_review": False,
                    "notes": "Good fit",
                }
            ]
        },
    )

    result = artist_intelligence.enrich_artist_profiles(db)
    profile = db.get(ArtistProfile, 1)
    assert result == {"processed": 1, "updated": 1, "failed": 0}
    assert profile is not None
    assert profile.primary_subgenre == "deep_dubstep"
    assert json.loads(profile.secondary_subgenres_json) == ["organic bass"]
    assert profile.last_enriched_at is not None


def test_enrich_artist_profiles_marks_missing_response_as_review(db, monkeypatch):
    db.add(ArtistProfile(normalized_name="atyya", canonical_name="ATYYA", track_count=2))
    db.commit()
    monkeypatch.setattr(artist_intelligence.llm_client, "chat_json", lambda _s, _u: {"artists": []})
    result = artist_intelligence.enrich_artist_profiles(db)
    profile = db.get(ArtistProfile, 1)
    assert result == {"processed": 1, "updated": 0, "failed": 1}
    assert profile is not None
    assert profile.needs_review is True
    assert profile.confidence_label == "unknown"


def test_enrich_artist_profiles_updates_job_progress(db, monkeypatch):
    db.add(ArtistProfile(normalized_name="atyya", canonical_name="ATYYA", track_count=2))
    db.add(Job(kind="artist_enrich"))
    db.commit()
    job = db.get(Job, 1)
    monkeypatch.setattr(
        artist_intelligence.llm_client,
        "chat_json",
        lambda _s, _u: {"artists": [{"normalized_name": "atyya", "canonical_name": "ATYYA"}]},
    )
    artist_intelligence.enrich_artist_profiles(db, job=job)
    refreshed = db.get(Job, 1)
    assert refreshed is not None
    assert refreshed.total == 1
    assert refreshed.processed == 1


# --- LLM-supplied numerics are untrusted and must not 500 (finding #10) ---

def test_normalize_profile_blob_coerces_bad_numerics():
    blob = {
        "canonical_name": "Atyya",
        "typical_bpm_min": "120-124",   # range string -> drop
        "typical_bpm_max": "fast",      # non-numeric -> drop
        "energy_min": "7",              # numeric string -> 7
        "energy_max": None,
    }
    out = artist_intelligence._normalize_profile_blob(blob, "atyya")
    assert out["typical_bpm_min"] is None
    assert out["typical_bpm_max"] is None
    assert out["energy_min"] == 7
    assert out["energy_max"] is None


def test_normalize_profile_blob_keeps_valid_numerics():
    out = artist_intelligence._normalize_profile_blob(
        {"typical_bpm_min": "120", "typical_bpm_max": 128.0, "energy_min": 6, "energy_max": "8"},
        "x",
    )
    assert out["typical_bpm_min"] == 120.0
    assert out["typical_bpm_max"] == 128.0
    assert out["energy_min"] == 6
    assert out["energy_max"] == 8


def test_artist_prefill_payload_survives_legacy_string_bpm():
    # A row enriched before validation may hold a str in a float column;
    # building the prefill payload must not raise (str <= float would 500).
    track = Track(absolute_path="/x.wav", bpm=128.0)
    profile = ArtistProfile(
        normalized_name="x", canonical_name="X",
        typical_bpm_min="120-124", typical_bpm_max="130",  # legacy bad data
    )
    payload = tracks._artist_prefill_payload(track, profile)
    assert payload is not None
    assert payload["bpm_conflict"] is False


# --- a failing batch must not abort the whole job (finding #8) ---

def test_enrich_preserves_partial_progress_on_mid_run_error(db, monkeypatch):
    from types import SimpleNamespace

    db.add(ArtistProfile(normalized_name="good", canonical_name="Good", track_count=5))
    db.add(ArtistProfile(normalized_name="bad", canonical_name="Bad", track_count=1))
    db.commit()

    # batch_size=1 -> "good" and "bad" run as separate batches
    monkeypatch.setattr(
        artist_intelligence, "get_settings",
        lambda: SimpleNamespace(artist_intelligence_batch_size=1),
    )

    calls = {"n": 0}

    def flaky(_system, _user):
        calls["n"] += 1
        if calls["n"] == 1:
            return {"artists": [{"normalized_name": "good", "canonical_name": "Good",
                                 "primary_subgenre": "hitech"}]}
        raise artist_intelligence.llm_client.LLMClientError("network down")

    monkeypatch.setattr(artist_intelligence.llm_client, "chat_json", flaky)

    result = artist_intelligence.enrich_artist_profiles(db)

    assert result == {"processed": 2, "updated": 1, "failed": 1}
    good = db.get(ArtistProfile, 1)
    bad = db.get(ArtistProfile, 2)
    assert good.primary_subgenre == "hitech"        # committed before the error
    assert bad.needs_review is True
    assert "network down" in (bad.notes or "")


def test_enrich_does_not_raise_when_all_batches_fail(db, monkeypatch):
    db.add(ArtistProfile(normalized_name="a", canonical_name="A", track_count=2))
    db.commit()

    def boom(_s, _u):
        raise artist_intelligence.llm_client.LLMClientError("down")

    monkeypatch.setattr(artist_intelligence.llm_client, "chat_json", boom)

    result = artist_intelligence.enrich_artist_profiles(db)  # must not raise
    assert result == {"processed": 1, "updated": 0, "failed": 1}
