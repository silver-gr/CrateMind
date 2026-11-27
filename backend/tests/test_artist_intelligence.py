from __future__ import annotations

import json
import threading
from datetime import UTC, datetime

import pytest
from sqlmodel import Session, select

from app.models import ArtistProfile, ArtistReview, Job, Track
from app.jobs import worker
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


def core(result):
    """The counts every run reports (the halt, reason and breaker fields are tested in test_artist_research_again)."""
    return {key: result[key] for key in ("processed", "updated", "failed", "stopped", "remaining")}


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
    assert core(artist_intelligence.enrich_artist_profiles(db, comparison=comparison)) == {"processed": 1, "updated": 1, "failed": 0, "stopped": False, "remaining": 0}
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
    assert core(artist_intelligence.enrich_artist_profiles(db, **mode)) == {"processed": 0, "updated": 0, "failed": 0, "stopped": False, "remaining": 0}


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
    assert core(artist_intelligence.enrich_artist_profiles(db)) == {"processed": 1, "updated": 0, "failed": 0, "stopped": False, "remaining": 0}
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
    assert core(result) == {"processed": 2, "updated": 1, "failed": 1, "stopped": False, "remaining": 0}
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


def test_artist_cap_stops_cleanly_and_keeps_findings(db, monkeypatch):
    rows = [profile(db, f"Capped {i}") for i in range(3)]
    db.add(Job(kind="artist_enrich")); db.commit()
    job = db.exec(select(Job)).one()
    monkeypatch.setattr(artist_intelligence, "MAX_ARTISTS_PER_JOB", 2)
    monkeypatch.setattr(artist_genre_research, "research_artist", lambda _: candidate())
    result = artist_intelligence.enrich_artist_profiles(db, job=job)
    assert core(result) == {"processed": 2, "updated": 2, "failed": 0, "stopped": True, "remaining": 1}
    db.refresh(job)
    assert job.total == job.processed == 2
    db.expire_all()
    assert sum(db.get(ArtistReview, r.id) is not None for r in rows) == 2
    # The next run picks up the artist that was left over.
    assert artist_intelligence.enrich_artist_profiles(db)["processed"] == 1


def test_job_deadline_stops_before_next_artist(db, monkeypatch):
    for i in range(3):
        profile(db, f"Timed {i}")
    clock = [0.0]
    monkeypatch.setattr(artist_intelligence, "monotonic", lambda: clock[0])
    monkeypatch.setattr(artist_intelligence, "JOB_DEADLINE_S", 100)
    def slow(_):
        clock[0] += 60
        return candidate()
    monkeypatch.setattr(artist_genre_research, "research_artist", slow)
    result = artist_intelligence.enrich_artist_profiles(db)
    assert core(result) == {"processed": 2, "updated": 2, "failed": 0, "stopped": True, "remaining": 1}
    db.expire_all()
    assert [r.state for r in db.exec(select(ArtistReview)).all()] == ["ready", "ready"]


def test_call_deadline_abandons_a_stalled_call_and_moves_on(db, monkeypatch):
    stalled = profile(db, "Stalled")
    stalled.track_count = 5; db.add(stalled); db.commit()
    fine = profile(db, "Fine")
    release = threading.Event()
    def provider(artist):
        if artist["id"] == stalled.id:
            release.wait(5)
        return candidate()
    monkeypatch.setattr(artist_intelligence, "ARTIST_CALL_DEADLINE_S", 0.05)
    monkeypatch.setattr(artist_genre_research, "research_artist", provider)
    try:
        result = artist_intelligence.enrich_artist_profiles(db)
    finally:
        release.set()
    assert core(result) == {"processed": 2, "updated": 1, "failed": 1, "stopped": False, "remaining": 0}
    db.expire_all()
    review = db.get(ArtistReview, stalled.id)
    assert review.state == "error" and review.error == artist_intelligence.CALL_TIMEOUT_ERROR
    assert review.candidate_json is None
    assert db.get(ArtistReview, fine.id).state == "ready"


def test_worker_message_says_the_job_stopped_at_the_limit(db, monkeypatch):
    for i in range(3):
        profile(db, f"Worker {i}")
    db.add(Job(kind="artist_enrich")); db.commit()
    job_id = db.exec(select(Job)).one().id
    monkeypatch.setattr(artist_intelligence, "MAX_ARTISTS_PER_JOB", 2)
    monkeypatch.setattr(artist_genre_research, "research_artist", lambda _: candidate())
    monkeypatch.setattr(worker, "get_engine", lambda: db.get_bind())
    worker._run_artist_enrich(job_id, None)
    db.expire_all()
    job = db.get(Job, job_id)
    assert job.status == "done" and job.error is None
    assert job.message == ("Ευρήματα έτοιμα για έλεγχο: 2 · αποτυχίες: 0 · Η έρευνα σταμάτησε στο όριο "
                           "της εργασίας· δεν ερευνήθηκαν 1 καλλιτέχνες.")
