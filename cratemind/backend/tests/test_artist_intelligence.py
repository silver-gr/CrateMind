from __future__ import annotations

import json

from app.models import ArtistProfile, Job
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
