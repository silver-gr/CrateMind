"""«Νέα έρευνα για όλους»: research again every artist whose finding another model made, three calls at a time,
with a stop, a breaker and Greek failure reasons. Every provider call is a monkeypatched function."""
from __future__ import annotations

import io
import json
import threading
import time
from datetime import UTC, datetime
from types import SimpleNamespace
from urllib.error import HTTPError, URLError

import pytest
from sqlmodel import select

from app.jobs import worker
from app.models import ArtistProfile, ArtistReview, Job
from app.services import artist_genre_research, artist_intelligence, llm_client

MODEL = "claude-opus-5-5"


def candidate(model=MODEL, genre="Forest"):
    research = {
        "workflow": artist_genre_research.WORKFLOW_VERSION, "status": "classified",
        "sources": [{"url": "https://label.example/artist", "evidence": "Η δισκογραφική γράφει Forest."}],
        "outside_genre": None, "reason": "Εύρημα από τη δισκογραφική.", "reasoning_effort": "high",
        **({"model": model} if model is not None else {}),
    }
    return {
        "scene_cluster": "forest", "primary_subgenre": genre, "secondary_subgenres_json": "[]",
        "confidence_label": "high", "needs_review": True, "notes": research["reason"], "research": research,
        "raw_llm_json": json.dumps({"workflow": research["workflow"], "research": research}),
    }


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    value = SimpleNamespace(llm1_base_url="http://127.0.0.1:9/v1", llm1_api_key="private-test-key-123",
                            llm1_model=MODEL, llm1_model_effort="high")
    monkeypatch.setattr(llm_client, "current_config", lambda: value)
    yield value
    artist_intelligence._stops.clear()


def artist(db, name, *, tracks=2, state=None, model="gpt-6-luna", confirmed=False, error=None):
    row = ArtistProfile(normalized_name=name.lower(), canonical_name=name, track_count=tracks)
    db.add(row); db.commit()
    if state is not None:
        db.add(ArtistReview(
            artist_id=row.id, baseline_json='{"baseline": true}', state=state, error=error,
            candidate_json=json.dumps(candidate(model)) if state in ("ready", "confirmed") else None,
            confirmed_at=datetime.now(UTC) if confirmed else None,
            updated_at=datetime(2026, 11, 1, tzinfo=UTC),
        ))
        db.commit()
    return row


def snapshot(db, artist_id):
    db.expire_all()
    review = db.get(ArtistReview, artist_id)
    return review.model_dump(mode="json") if review else None


def failing(message="LLM request failed (HTTP 400 · invalid_request_error)."):
    def provider(_):
        raise llm_client.LLMClientError(message)
    return provider


def new_job(db):
    job = Job(kind="artist_enrich", status="running")
    db.add(job); db.commit(); db.refresh(job)
    return job


# ------------------------------------------------------------------------------------------------------ selection

def test_selection_skips_the_current_model_and_never_touches_confirmed(db, monkeypatch):
    current = artist(db, "Current", state="ready", model=MODEL)
    other = artist(db, "Other", state="ready", model="gpt-6-luna")
    no_model = artist(db, "NoModel", state="ready", model=None)
    errored = artist(db, "Errored", state="error", error="LLM request failed (HTTP 400).")
    fresh = artist(db, "Fresh")
    stuck = artist(db, "Stuck", state="pending")
    confirmed = artist(db, "Confirmed", state="confirmed", model="gpt-6-luna", confirmed=True)
    legacy_confirmed = artist(db, "LegacyConfirmed", state="confirmed", model="gpt-6-luna")
    single = artist(db, "Single", tracks=1)
    placeholder = artist(db, "Unknown Artist", tracks=40)
    seen = []
    monkeypatch.setattr(artist_genre_research, "research_artist", lambda a: seen.append(a["id"]) or candidate())
    result = artist_intelligence.enrich_artist_profiles(db, again=True)
    assert sorted(seen) == sorted([other.id, no_model.id, errored.id, fresh.id, stuck.id])
    assert result["updated"] == 5 and result["remaining"] == 0 and result["halt"] is None
    assert current.id not in seen and confirmed.id not in seen and legacy_confirmed.id not in seen
    assert single.id not in seen and placeholder.id not in seen
    # A finished run leaves nothing to do: pressing the button again calls nobody.
    seen.clear()
    assert artist_intelligence.enrich_artist_profiles(db, again=True)["processed"] == 0 and seen == []
    db.expire_all()
    assert db.get(ArtistReview, confirmed.id).state == "confirmed"


def test_normal_force_and_comparison_runs_ignore_the_again_rule(db, monkeypatch):
    artist(db, "Current", state="ready", model=MODEL)
    calls = []
    monkeypatch.setattr(artist_genre_research, "research_artist", lambda a: calls.append(a["id"]) or candidate())
    assert artist_intelligence.enrich_artist_profiles(db)["processed"] == 0
    assert artist_intelligence.enrich_artist_profiles(db, force=True)["processed"] == 1
    assert artist_intelligence.enrich_artist_profiles(db, comparison=True)["processed"] == 1


def test_again_has_no_cap_of_one_hundred(db, monkeypatch):
    monkeypatch.setattr(artist_intelligence, "MAX_ARTISTS_PER_JOB", 2)
    for i in range(5):
        artist(db, f"Many {i}", state="ready", model="gpt-6-luna")
    monkeypatch.setattr(artist_genre_research, "research_artist", lambda _: candidate())
    result = artist_intelligence.enrich_artist_profiles(db, again=True)
    assert result["processed"] == 5 and result["stopped"] is False


# ------------------------------------------------------------------------------------- untouched-on-failure rule

@pytest.mark.parametrize("message", [
    "LLM request failed (HTTP 400 · invalid_request_error).",
    "Artist research returned an invalid or unsupported finding.",
    llm_client.CONNECTION_REFUSED,
])
def test_a_ready_review_survives_a_failed_research_byte_for_byte(db, monkeypatch, message):
    rows = [artist(db, f"Kept {i}", state="ready", model="gpt-6-luna") for i in range(2)]
    before = [snapshot(db, row.id) for row in rows]
    profiles = [db.get(ArtistProfile, row.id).model_dump(mode="json") for row in rows]
    monkeypatch.setattr(artist_genre_research, "research_artist", failing(message))
    result = artist_intelligence.enrich_artist_profiles(db, again=True)
    assert result["failed"] == 2 and result["updated"] == 0
    assert [snapshot(db, row.id) for row in rows] == before
    assert [db.get(ArtistProfile, row.id).model_dump(mode="json") for row in rows] == profiles


def test_a_valid_new_finding_replaces_the_old_one_and_a_no_finding_artist_keeps_todays_error(db, monkeypatch):
    kept = artist(db, "Replaced", state="ready", model="gpt-6-luna")
    bare = artist(db, "Bare")
    def provider(a):
        if a["id"] == bare.id:
            raise llm_client.LLMClientError("Provider declined the artist research request.")
        return candidate(genre="Darkpsy")
    monkeypatch.setattr(artist_genre_research, "research_artist", provider)
    artist_intelligence.enrich_artist_profiles(db, again=True)
    db.expire_all()
    review = db.get(ArtistReview, kept.id)
    assert review.state == "ready" and review.error is None
    stored = json.loads(review.candidate_json)
    assert stored["primary_subgenre"] == "Darkpsy" and stored["research"]["model"] == MODEL
    assert db.get(ArtistReview, bare.id).state == "error"


def test_nothing_is_written_before_the_answer_arrives(db, monkeypatch):
    # A quit mid-call leaves the review as it was: no «pending» first.
    row = artist(db, "Waiting", state="ready", model="gpt-6-luna")
    before = snapshot(db, row.id)
    during = []
    def provider(a):
        from sqlmodel import Session
        with Session(db.get_bind()) as other:
            during.append(other.get(ArtistReview, a["id"]).model_dump(mode="json"))
        return candidate()
    monkeypatch.setattr(artist_genre_research, "research_artist", provider)
    artist_intelligence.enrich_artist_profiles(db, again=True)
    assert during == [before]


def test_a_confirmation_during_the_call_wins(db, monkeypatch):
    row = artist(db, "Owner", state="ready", model="gpt-6-luna")
    def provider(a):
        from sqlmodel import Session
        with Session(db.get_bind()) as other:
            review = other.get(ArtistReview, a["id"])
            review.state = "confirmed"; review.confirmed_at = datetime.now(UTC)
            other.add(review); other.commit()
        return candidate(genre="Darkpsy")
    monkeypatch.setattr(artist_genre_research, "research_artist", provider)
    result = artist_intelligence.enrich_artist_profiles(db, again=True)
    assert result["updated"] == 0
    db.expire_all()
    assert json.loads(db.get(ArtistReview, row.id).candidate_json)["primary_subgenre"] == "Forest"


# --------------------------------------------------------------------------------------------- three at a time

def test_three_calls_at_a_time_finish_out_of_order_with_truthful_progress(db, monkeypatch):
    rows = [artist(db, f"Window {i}", state="ready", model="gpt-6-luna") for i in range(5)]
    ids = [row.id for row in rows]  # plain ids: provider threads never touch the test's ORM objects
    job = new_job(db)
    gates = {i: threading.Event() for i in ids}
    lock = threading.Lock()
    running, peak, order = [0], [0], []

    def provider(a):
        with lock:
            running[0] += 1
            peak[0] = max(peak[0], running[0])
        gates[a["id"]].wait(5)
        with lock:
            running[0] -= 1
            order.append(a["id"])
        return candidate(genre="Hi-Tech" if a["id"] == ids[2] else "Forest")

    monkeypatch.setattr(artist_genre_research, "research_artist", provider)
    out = {}
    worker_thread = threading.Thread(
        target=lambda: out.update(artist_intelligence.enrich_artist_profiles(db, job=job, again=True)))
    worker_thread.start()
    deadline = time.monotonic() + 5
    while running[0] < 3 and time.monotonic() < deadline:
        time.sleep(0.01)
    from sqlmodel import Session
    with Session(db.get_bind()) as other:
        message = other.get(Job, job.id).message
    # The page reads «Έρευνα είδους: <names> (<next>/<total>)» with next == processed + 1.
    assert message == "Έρευνα είδους: Window 0 · Window 1 · Window 2 (1/5)"
    # The third call answers first, then the rest in reverse.
    for i in [2, 1, 0, 4, 3]:
        time.sleep(0.15)
        gates[ids[i]].set()
    worker_thread.join(10)
    assert not worker_thread.is_alive()
    assert peak[0] == 3
    assert order[0] == ids[2]
    assert out["processed"] == out["updated"] == 5 and out["failed"] == 0
    assert job.processed == job.total == 5
    from sqlmodel import Session
    with Session(db.get_bind()) as check:
        genres = {r.artist_id: json.loads(r.candidate_json)["primary_subgenre"]
                  for r in check.exec(select(ArtistReview)).all()}
    assert genres[ids[2]] == "Hi-Tech" and all(genres[i] == "Forest" for i in ids if i != ids[2])


# ------------------------------------------------------------------------------------------------------ stop

def test_stop_lets_calls_out_finish_and_a_second_run_continues(db, monkeypatch):
    rows = [artist(db, f"Stop {i}", state="ready", model="gpt-6-luna") for i in range(6)]
    job = new_job(db)
    seen = []
    first_three = threading.Barrier(3, timeout=5)
    # Plain ids: the provider runs on its own thread and must never touch the test's ORM objects.
    first_id, job_id = rows[0].id, job.id

    def provider(a):
        seen.append(a["id"])
        if len(seen) <= 3:
            first_three.wait()  # all three calls are out before the stop
            if a["id"] == first_id:
                artist_intelligence.request_stop(job_id)
        return candidate()

    monkeypatch.setattr(artist_genre_research, "research_artist", provider)
    result = artist_intelligence.enrich_artist_profiles(db, job=job, again=True)
    assert result["halt"] == "stop" and result["processed"] == result["updated"] == 3
    assert result["remaining"] == 3
    message = worker.artist_research_message(result)
    assert "Η έρευνα διακόπηκε μετά από 3 καλλιτέχνες" in message and "δεν ερευνήθηκαν 3" in message
    artist_intelligence.clear_stop(job.id)
    seen.clear()
    second = artist_intelligence.enrich_artist_profiles(db, again=True)
    assert second["processed"] == 3 and sorted(seen) == sorted(r.id for r in rows[3:])


def test_stop_route_stops_only_a_running_artist_job(client, db):
    assert client.post("/api/artists/enrich/999/stop").status_code == 404
    done = Job(kind="artist_enrich", status="done")
    other = Job(kind="analyze", status="running")
    running = Job(kind="artist_enrich", status="running")
    db.add(done); db.add(other); db.add(running); db.commit()
    assert client.post(f"/api/artists/enrich/{done.id}/stop").status_code == 409
    assert client.post(f"/api/artists/enrich/{other.id}/stop").status_code == 409
    assert not artist_intelligence.stop_requested(running.id)
    answer = client.post(f"/api/artists/enrich/{running.id}/stop")
    assert answer.status_code == 200 and answer.json()["id"] == running.id
    assert artist_intelligence.stop_requested(running.id)


def test_worker_clears_the_stop_and_writes_a_greek_end(db, monkeypatch):
    artist(db, "Only", state="ready", model="gpt-6-luna")
    job = new_job(db)
    artist_intelligence.request_stop(job.id)
    monkeypatch.setattr(worker, "get_engine", lambda: db.get_bind())
    monkeypatch.setattr(artist_genre_research, "research_artist", lambda _: pytest.fail("no call after a stop"))
    worker._run_artist_enrich(job.id, None, again=True)
    db.expire_all()
    finished = db.get(Job, job.id)
    assert finished.status == "done"
    assert finished.message == ("Ευρήματα έτοιμα για έλεγχο: 0 · αποτυχίες: 0 · Η έρευνα διακόπηκε μετά από 0 "
                                "καλλιτέχνες· δεν ερευνήθηκαν 1 καλλιτέχνες.")
    assert not artist_intelligence.stop_requested(job.id)


# --------------------------------------------------------------------------------------------------- breaker

def test_breaker_stops_when_the_first_calls_all_fail(db, monkeypatch):
    rows = [artist(db, f"Broken {i}", state="ready", model="gpt-6-luna") for i in range(17)]
    before = {row.id: snapshot(db, row.id) for row in rows}
    calls = []
    def provider(a):
        calls.append(a["id"])
        raise llm_client.LLMClientError("LLM request failed (HTTP 400 · invalid_request_error).")
    monkeypatch.setattr(artist_genre_research, "research_artist", provider)
    for mode in ({"again": True}, {"force": True}):
        calls.clear()
        result = artist_intelligence.enrich_artist_profiles(db, **mode)
        # Three at a time can have up to two more calls out when the third answer trips it; they finish.
        started = len(calls)
        assert result["halt"] == "breaker" and 3 <= started <= (5 if mode.get("again") else 3)
        assert result["failed"] == started and result["remaining"] == 17 - started
        assert result["reason"] == "Ο πάροχος απέρριψε το αίτημα (HTTP 400 · invalid_request_error)"
        message = worker.artist_research_message(result)
        assert message == (f"Ευρήματα έτοιμα για έλεγχο: 0 · αποτυχίες: {started} (συχνότερος λόγος: Ο πάροχος "
                           "απέρριψε το αίτημα (HTTP 400 · invalid_request_error)) · Η έρευνα σταμάτησε μόνη της: "
                           f"οι πρώτες 3 κλήσεις απέτυχαν· δεν ερευνήθηκαν {17 - started} καλλιτέχνες.")
        if mode.get("again"):
            assert {row.id: snapshot(db, row.id) for row in rows} == before


def test_breaker_stops_after_five_same_failures_in_a_row(db, monkeypatch):
    rows = [artist(db, f"Streak {i}") for i in range(12)]
    order = {row.id: i for i, row in enumerate(rows)}
    def provider(a):
        if order[a["id"]] == 0:
            return candidate()
        raise llm_client.LLMClientError(llm_client.CONNECTION_REFUSED)
    monkeypatch.setattr(artist_genre_research, "research_artist", provider)
    result = artist_intelligence.enrich_artist_profiles(db)  # one call at a time: a fixed order
    assert result["halt"] == "breaker" and result["updated"] == 1 and result["failed"] == 5
    assert result["breaker"] == "5 κλήσεις στη σειρά απέτυχαν για τον ίδιο λόγο"
    assert result["reason"].startswith("Δεν έγινε σύνδεση με τον πάροχο")


def test_different_failures_do_not_trip_the_streak(db, monkeypatch):
    rows = [artist(db, f"Mixed {i}") for i in range(8)]
    order = {row.id: i for i, row in enumerate(rows)}
    reasons = ["Artist research returned an invalid or unsupported finding.", llm_client.TIMED_OUT]
    def provider(a):
        if order[a["id"]] == 0:
            return candidate()
        raise llm_client.LLMClientError(reasons[order[a["id"]] % 2])
    monkeypatch.setattr(artist_genre_research, "research_artist", provider)
    result = artist_intelligence.enrich_artist_profiles(db)
    assert result["halt"] is None and result["failed"] == 7 and result["processed"] == 8


# -------------------------------------------------------------------------------------------- failure reasons

class _Body(io.BytesIO):
    pass


def http_error(status, body):
    return HTTPError("http://127.0.0.1:9/v1/responses", status, "Bad", {}, _Body(json.dumps(body).encode()))


def test_http_failure_carries_the_provider_code_never_its_message_or_the_key(configured, monkeypatch):
    key = configured.llm1_api_key
    body = {"error": {"message": f"schema refused for {key}", "type": "invalid_request_error"}}
    monkeypatch.setattr(llm_client, "_urlopen", lambda *a, **k: (_ for _ in ()).throw(http_error(400, body)))
    with pytest.raises(llm_client.LLMClientError) as raised:
        llm_client.research_json("s", "u", {})
    assert str(raised.value) == "LLM request failed (HTTP 400 · invalid_request_error)."
    assert key not in str(raised.value) and "schema refused" not in str(raised.value)
    assert (artist_genre_research.failure_text(str(raised.value))
            == "Ο πάροχος απέρριψε το αίτημα (HTTP 400 · invalid_request_error)")


@pytest.mark.parametrize("code", ["private-test-key-123", "test-key", "Bearer private-test-key-123", "x" * 60])
def test_a_code_that_overlaps_the_key_or_is_not_a_code_is_dropped(configured, monkeypatch, code):
    body = {"error": {"code": code, "message": "nope"}}
    monkeypatch.setattr(llm_client, "_urlopen", lambda *a, **k: (_ for _ in ()).throw(http_error(401, body)))
    with pytest.raises(llm_client.LLMClientError) as raised:
        llm_client.research_json("s", "u", {})
    assert str(raised.value) == "LLM request failed (HTTP 401)."
    assert configured.llm1_api_key not in str(raised.value)


def test_connection_refused_is_told_apart_from_an_http_status(monkeypatch):
    monkeypatch.setattr(llm_client, "_urlopen",
                        lambda *a, **k: (_ for _ in ()).throw(URLError(ConnectionRefusedError(61, "refused"))))
    with pytest.raises(llm_client.LLMClientError) as raised:
        llm_client.research_json("s", "u", {})
    assert str(raised.value) == llm_client.CONNECTION_REFUSED
    assert artist_genre_research.failure_text(str(raised.value)).startswith("Δεν έγινε σύνδεση με τον πάροχο")
    monkeypatch.setattr(llm_client, "_urlopen", lambda *a, **k: (_ for _ in ()).throw(URLError(TimeoutError())))
    with pytest.raises(llm_client.LLMClientError) as raised:
        llm_client.research_json("s", "u", {})
    assert str(raised.value) == llm_client.TIMED_OUT


@pytest.mark.parametrize("error, greek", [
    ("LLM request failed (HTTP 401 · invalid_api_key).", "Ο πάροχος απέρριψε το κλειδί API (HTTP 401 · invalid_api_key)"),
    ("LLM request failed (HTTP 429).", "Ο πάροχος αρνήθηκε προσωρινά το αίτημα (HTTP 429): όριο χρήσης ή χρέωσης"),
    ("LLM request failed (HTTP 502).", "Σφάλμα στον πάροχο (HTTP 502)"),
    ("Artist research returned an invalid or unsupported finding.", "Η απάντηση δεν πέρασε τον έλεγχο πηγών"),
    ("Malformed research output item.", "Ο πάροχος έστειλε απάντηση σε μορφή που δεν αναγνωρίζεται"),
    (artist_intelligence.CALL_TIMEOUT_ERROR, "Η έρευνα ξεπέρασε το χρονικό όριο· δεν αποθηκεύτηκε εύρημα"),
    ("Something nobody expected", "Άγνωστο σφάλμα στην έρευνα"),
    (None, "Άγνωστο σφάλμα στην έρευνα"),
])
def test_failure_text_is_greek(error, greek):
    assert artist_genre_research.failure_text(error) == greek


def test_the_review_list_shows_the_error_in_greek(client, db):
    artist(db, "Refused", state="error", error="LLM request failed (HTTP 400 · invalid_request_error).")
    rows = client.get("/api/artists").json()
    assert rows[0]["review"]["error"] == "Ο πάροχος απέρριψε το αίτημα (HTTP 400 · invalid_request_error)"


# ------------------------------------------------------------------------------------------------------ routes

def test_stats_count_what_the_button_would_research_and_name_the_model(client, db):
    artist(db, "Current", state="ready", model=MODEL)
    artist(db, "Other", state="ready", model="gpt-6-luna")
    artist(db, "Errored", state="error")
    artist(db, "Confirmed", state="confirmed", confirmed=True)
    body = client.get("/api/artists/stats").json()
    assert body["research_again_artists"] == 2 and body["research_model"] == MODEL


def test_enrich_route_starts_the_again_mode(client, monkeypatch):
    seen = []
    monkeypatch.setattr("app.api.artists.worker.start_artist_enrich", lambda *a: seen.append(a))
    job = client.post("/api/artists/enrich", json={"again": True}).json()
    assert seen == [(job["id"], None, False, False, True)]
    assert client.post("/api/artists/enrich", json={"again": True, "force": True}).status_code == 422
