from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest
from sqlmodel import Session, select

from app.api import tracks
from app.models import ArtistProfile, ArtistReview, Job, Track
from app.services import artist_genre_research, artist_intelligence


def candidate(status="classified", genre="Hi-Tech"):
    research = {
        "workflow": artist_genre_research.WORKFLOW_VERSION, "status": status,
        "sources": [{"url": "https://example.org/artist", "evidence": "The label identifies hi-tech."}],
        "outside_genre": "glitch-hop" if status == "outside_list" else None,
        "reason": "Εύρημα από τη δισκογραφική.", "model": "gpt-6-luna", "reasoning_effort": "max",
    }
    return {
        "scene_cluster": "hi-tech" if status == "classified" else "unknown / mixed",
        "primary_subgenre": genre if status == "classified" else None,
        "secondary_subgenres_json": "[]", "confidence_label": "high",
        "needs_review": True, "notes": research["reason"], "research": research,
        "raw_llm_json": json.dumps({"workflow": research["workflow"], "research": research}),
    }


def profile(db, name="Artist", **values):
    row = ArtistProfile(normalized_name=name.lower(), canonical_name=name, track_count=2, **values)
    db.add(row); db.commit()
    return row


@pytest.mark.parametrize("comparison", [False, True])
def test_research_stages_genres_without_overwriting_active_metadata(db, monkeypatch, comparison):
    row = profile(db, primary_subgenre="Forest", typical_bpm_min=148, energy_max=9,
                  notes="Original", raw_llm_json='{"legacy":true}')
    original = row.model_dump(mode="json")
    monkeypatch.setattr(artist_genre_research, "research_artist", lambda _: candidate())
    assert artist_intelligence.enrich_artist_profiles(db, comparison=comparison) == {"processed": 1, "updated": 1, "failed": 0}
    db.refresh(row)
    assert row.primary_subgenre == "Forest" and row.typical_bpm_min == 148 and row.energy_max == 9
    assert row.notes == "Original" and row.raw_llm_json == '{"legacy":true}'
    assert row.last_enriched_at is None and row.needs_review
    review = db.get(ArtistReview, row.id)
    assert review.state == "ready" and review.confirmed_at is None
    assert json.loads(review.baseline_json) == original
    assert json.loads(review.candidate_json)["primary_subgenre"] == "Hi-Tech"


def test_legacy_enrichment_and_ready_findings_are_researched_once(db, monkeypatch):
    row = profile(db, last_enriched_at=datetime.now(UTC), primary_subgenre="Legacy")
    old = ArtistReview(artist_id=row.id, baseline_json='{"original":true}',
                       state="ready", candidate_json='{"primary_subgenre":"Old guess"}')
    db.add(old); db.commit()
    calls = []
    monkeypatch.setattr(artist_genre_research, "research_artist", lambda artist: calls.append(artist) or candidate())
    assert artist_intelligence.enrich_artist_profiles(db)["processed"] == 1
    assert artist_intelligence.enrich_artist_profiles(db)["processed"] == 0
    assert artist_intelligence.enrich_artist_profiles(db, force=True)["processed"] == 1
    assert artist_intelligence.enrich_artist_profiles(db, comparison=True)["processed"] == 1
    db.refresh(old)
    assert old.baseline_json == '{"original":true}' and len(calls) == 3


@pytest.mark.parametrize("mode", [{}, {"force": True}, {"comparison": True}])
def test_confirmed_and_placeholder_artists_never_reach_provider(db, monkeypatch, mode):
    for name, count in [("Unknown Artist", 50), ("various artists", 8), ("solo", 1)]:
        db.add(ArtistProfile(normalized_name=name.lower(), canonical_name=name, track_count=count))
    protected = profile(db, "Protected")
    legacy_protected = profile(db, "LegacyProtected")
    db.add(ArtistReview(artist_id=protected.id, baseline_json="{}", state="confirmed", confirmed_at=datetime.now(UTC)))
    db.add(ArtistReview(artist_id=legacy_protected.id, baseline_json="{}", state="confirmed"))
    db.commit()
    def forbidden(_): raise AssertionError("Provider called for protected artist")
    monkeypatch.setattr(artist_genre_research, "research_artist", forbidden)
    assert artist_intelligence.enrich_artist_profiles(db, **mode) == {"processed": 0, "updated": 0, "failed": 0}


def test_confirmation_while_searching_wins_over_in_flight_result(db, monkeypatch):
    row = profile(db, primary_subgenre="Forest")
    artist_id = row.id
    def while_searching(_):
        with Session(db.get_bind()) as other:
            review = other.get(ArtistReview, artist_id)
            review.state = "confirmed"; review.confirmed_at = datetime.now(UTC); review.confirmed_choice = "current"
            other.add(review); other.commit()
        return candidate()
    monkeypatch.setattr(artist_genre_research, "research_artist", while_searching)
    assert artist_intelligence.enrich_artist_profiles(db) == {"processed": 1, "updated": 0, "failed": 0}
    db.expire_all()
    assert db.get(ArtistProfile, artist_id).primary_subgenre == "Forest"
    review = db.get(ArtistReview, artist_id)
    assert review.state == "confirmed" and review.candidate_json is None


def test_failure_preserves_partial_findings_and_retries_only_failed_artist(db, monkeypatch):
    good = profile(db, "Good", primary_subgenre="Forest", notes="Keep")
    bad = profile(db, "Bad", primary_subgenre="Old", notes="Keep too")
    def flaky(artist):
        if artist["id"] == bad.id: raise artist_intelligence.llm_client.LLMClientError("Search unavailable")
        return candidate()
    monkeypatch.setattr(artist_genre_research, "research_artist", flaky)
    result = artist_intelligence.enrich_artist_profiles(db)
    assert result == {"processed": 2, "updated": 1, "failed": 1}
    db.expire_all()
    assert db.get(ArtistReview, good.id).state == "ready"
    failed = db.get(ArtistReview, bad.id)
    assert failed.state == "error" and "Search unavailable" in failed.error
    assert db.get(ArtistProfile, good.id).notes == "Keep"
    assert db.get(ArtistProfile, bad.id).primary_subgenre == "Old"
    monkeypatch.setattr(artist_genre_research, "research_artist", lambda _: candidate())
    assert artist_intelligence.enrich_artist_profiles(db)["processed"] == 1


@pytest.mark.parametrize("status", ["outside_list", "unresolved"])
def test_outside_or_unknown_result_is_a_review_finding_not_a_forced_genre(db, monkeypatch, status):
    row = profile(db, primary_subgenre="Old")
    monkeypatch.setattr(artist_genre_research, "research_artist", lambda _: candidate(status))
    assert artist_intelligence.enrich_artist_profiles(db)["updated"] == 1
    db.expire_all()
    assert db.get(ArtistProfile, row.id).primary_subgenre == "Old"
    value = json.loads(db.get(ArtistReview, row.id).candidate_json)
    assert value["primary_subgenre"] is None and value["research"]["status"] == status


def test_job_progress_and_local_examples_are_scoped_without_paths_or_biography(db, monkeypatch):
    row = profile(db, notes="Old invented biography")
    for i in range(4):
        db.add(Track(absolute_path=f"/private/{i}.mp3", title=f"Track {i}", artist="Artist",
                     artist_normalized="artist", album="Release", label="Label"))
    db.add(Job(kind="artist_enrich")); db.commit()
    job = db.exec(select(Job)).one()
    captured = []
    monkeypatch.setattr(artist_genre_research, "research_artist", lambda value: captured.append(value) or candidate())
    artist_intelligence.enrich_artist_profiles(db, job=job)
    assert len(captured[0]["library_examples"]) == 3
    assert "/private" not in json.dumps(captured) and "Old invented" not in json.dumps(captured)
    db.refresh(job)
    assert job.total == job.processed == 1 and row.canonical_name in job.message


def test_profile_ids_and_limit_bound_live_work(db, monkeypatch):
    first = profile(db, "First")
    second = profile(db, "Second")
    seen = []
    monkeypatch.setattr(artist_genre_research, "research_artist", lambda a: seen.append(a["id"]) or candidate())
    assert artist_intelligence.enrich_artist_profiles(db, profile_ids=[second.id], limit=1)["processed"] == 1
    assert seen == [second.id]
    assert db.get(ArtistReview, first.id) is None


def test_artist_prefill_payload_survives_legacy_string_bpm():
    track = Track(absolute_path="/x.wav", bpm=128.0)
    artist = ArtistProfile(normalized_name="x", canonical_name="X",
                           typical_bpm_min="120-124", typical_bpm_max="130")
    assert tracks._artist_prefill_payload(track, artist)["bpm_conflict"] is False
