"""Stage source-backed artist genre findings for explicit human confirmation."""
from __future__ import annotations

import json
import threading
from collections import Counter, deque
from collections.abc import Iterable
from concurrent.futures import FIRST_COMPLETED, Future, wait
from dataclasses import dataclass
from datetime import UTC, datetime
from time import monotonic

from sqlalchemy import or_, update
from sqlmodel import Session, select

from ..artist_vocab import artist_substyle
from ..models import ArtistProfile, ArtistReview, Job, Track, TrackName
from . import artist_genre_research, llm_client, names_switch
from .sql_ids import ids_in

PLACEHOLDER_ARTISTS = {
    "unknown artist", "unknown", "various artists", "va", "misc", "downloaded by mediahuman",
    # The same credits as act keys («Καθαρά ονόματα» on: "act:" + names_store.act_key(name)).
    "act:unknownartist", "act:unknown", "act:variousartists", "act:va", "act:misc", "act:downloadedbymediahuman",
}
# Bounds on one research job (each artist is a paid web-search call). urlopen's timeout bounds
# one socket read only, so a call gets its own wall clock; a job stops cleanly at whichever
# bound comes first and keeps what it already staged. A later run continues with the rest.
# The job clock fits a whole «research again» run: about 460 artists at about 40 s a call, three at a time,
# is about 1 h 45 min, so 3 h leaves room for calls up to about 70 s.
ARTIST_CALL_DEADLINE_S = 5 * 60
JOB_DEADLINE_S = 3 * 60 * 60
MAX_ARTISTS_PER_JOB = 100
CALL_TIMEOUT_ERROR = "Η έρευνα ξεπέρασε το χρονικό όριο· δεν αποθηκεύτηκε εύρημα."
# Provider calls a «research again» run keeps out at once (network only; the database stays on the job's thread).
RESEARCH_AGAIN_WIDTH = 3
# The breaker: a run stops by itself when its first calls all fail, or this many in a row fail for the same reason.
BREAKER_FIRST_CALLS = 3
BREAKER_SAME_IN_ROW = 5

# «Καθαρά ονόματα» refuses to turn while research runs: the job would keep spending on the other key set.
SWITCH_WAIT_TEXT = "Περίμενε να τελειώσει η έρευνα καλλιτεχνών ή διάκοψέ τη, και ξαναδοκίμασε."
RESEARCH_KINDS = ("artist_enrich", "artist_compare")

_stops: set[int] = set()
_stops_lock = threading.Lock()


def request_stop(job_id: int) -> None:
    """Ask the artist research job `job_id` to start no new call; calls already out finish and are kept."""
    with _stops_lock:
        _stops.add(job_id)


def stop_requested(job_id: int | None) -> bool:
    with _stops_lock:
        return job_id in _stops


def clear_stop(job_id: int) -> None:
    with _stops_lock:
        _stops.discard(job_id)


def research_running(session: Session) -> Job | None:
    """The artist research job that is waiting or running, if any."""
    return session.exec(select(Job).where(Job.kind.in_(RESEARCH_KINDS), Job.status.in_(["pending", "running"]))).first()


def confirmed_substyles(session: Session, normalized_names: Iterable[str] | None = None) -> dict[str, str]:
    """The genre of each artist the user confirmed in «Καλλιτέχνες», as a track substyle, keyed by normalized
    name. A track with no substyle of its own shows this one; unconfirmed estimates and placeholder credits
    («Unknown Artist») never count."""
    stmt = (select(ArtistProfile.normalized_name, ArtistProfile.primary_subgenre)
            .join(ArtistReview, ArtistReview.artist_id == ArtistProfile.id)
            .where(or_(ArtistReview.state == "confirmed", ArtistReview.confirmed_at.is_not(None))))
    if normalized_names is not None:
        stmt = stmt.where(ids_in(ArtistProfile.normalized_name, normalized_names))
    found = {}
    for name, genre in session.exec(stmt).all():
        substyle = artist_substyle(genre)
        if substyle and name not in PLACEHOLDER_ARTISTS:
            found[name] = substyle
    return found


def candidate_research(review: ArtistReview | None) -> dict | None:
    if review is None or not review.candidate_json:
        return None
    try:
        candidate = json.loads(review.candidate_json)
    except (TypeError, ValueError):
        return None
    if not isinstance(candidate, dict):
        return None
    return artist_genre_research.research_info(candidate.get("raw_llm_json"))


def research_pending(profile: ArtistProfile, review: ArtistReview | None) -> bool:
    """Legacy estimates remain eligible; a current ready finding avoids repeat spending."""
    if profile.track_count < 2 or profile.normalized_name in PLACEHOLDER_ARTISTS:
        return False
    if review is not None and (review.confirmed_at is not None or review.state == "confirmed"):
        return False
    return not (review is not None and review.state == "ready" and candidate_research(review))


def research_again_pending(profile: ArtistProfile, review: ArtistReview | None, model: str) -> bool:
    """«Νέα έρευνα για όλους»: an artist the normal run would consider (two tracks or more, a real name, not confirmed)
    whose stored finding was not made by `model`: another or no model, no ready finding, or an error."""
    if profile.track_count < 2 or profile.normalized_name in PLACEHOLDER_ARTISTS:
        return False
    if review is None:
        return True
    if review.confirmed_at is not None or review.state == "confirmed":
        return False
    research = candidate_research(review) if review.state == "ready" else None
    return not (research is not None and research.get("model") == model)


def _set_review(session: Session, artist_id: int, **values) -> bool:
    # A confirmation made while a web request runs must win, including between
    # a cached SELECT and this write. Never update a confirmed row conditionally.
    result = session.execute(
        update(ArtistReview)
        .where(ArtistReview.artist_id == artist_id, ArtistReview.confirmed_at.is_(None), ArtistReview.state != "confirmed")
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    return result.rowcount == 1


def _start_research(payload: dict) -> Future:
    """Start one provider call on its own daemon thread. A call past its wall clock is abandoned (the thread
    ends at its own socket timeout and its result is dropped). The thread never touches the database."""
    future: Future = Future()

    def run():
        try:
            future.set_result(artist_genre_research.research_artist(payload))
        except BaseException as exc:  # noqa: BLE001 - re-raised in the job thread
            future.set_exception(exc)

    threading.Thread(target=run, name="artist-research", daemon=True).start()
    return future


@dataclass
class _Call:
    artist_id: int
    name: str
    keep_old: bool  # a ready finding stays exactly as it is unless the new one arrives valid
    until: float


def _prepare(session: Session, artist_id: int, again: bool, model: str) -> tuple[dict, str, bool] | None:
    session.expire_all()
    profile = session.get(ArtistProfile, artist_id)
    review = session.get(ArtistReview, artist_id)
    if profile is None or (review is not None and (review.confirmed_at is not None or review.state == "confirmed")):
        return None
    if again:
        # Nothing is written before the answer: a failed call, a stop or a quit leaves the review as it was.
        if not research_again_pending(profile, review, model):
            return None
        # Any ready review, with a research envelope or an older estimate without one.
        keep_old = review is not None and review.state == "ready"
    else:
        keep_old = False
        if review is None:
            session.add(_new_review(profile))
            session.flush()
        if not _set_review(session, artist_id, state="pending", error=None, updated_at=datetime.now(UTC)):
            session.rollback()
            return None
    examples = session.exec(
        select(Track).where(
            Track.artist_normalized == profile.normalized_name, Track.missing == False,
        ).order_by(Track.id).limit(3)
    ).all()
    # With «Καθαρά ονόματα» on, the examples carry the shown (clean) names and the key goes without "act:".
    shown = {}
    if names_switch.is_on(session):
        shown = {row.track_id: row for row in session.exec(
            select(TrackName).where(TrackName.track_id.in_([t.id for t in examples]))).all() if row.artist}
    payload = {
        "id": artist_id,
        "canonical_name": profile.canonical_name,
        "normalized_name": profile.normalized_name.removeprefix("act:"),
        "library_examples": [
            {"title": shown[t.id].title if t.id in shown else t.title,
             "artist_credit": shown[t.id].artist if t.id in shown else t.artist, "genre": t.genre,
             "album": t.album, "label": t.label}
            for t in examples
        ],
    }
    return payload, profile.canonical_name, keep_old


def _new_review(profile: ArtistProfile) -> ArtistReview:
    return ArtistReview(
        artist_id=profile.id,
        baseline_json=json.dumps(profile.model_dump(mode="json"), ensure_ascii=False),
    )


def _store(session: Session, call: _Call, candidate: dict | None, error: str | None) -> str | None:
    """Write one answer; "updated", "failed", or None when the owner confirmed the artist meanwhile."""
    if error is not None and call.keep_old:
        return "failed"  # the ready finding stays byte for byte; only this run counts the failure
    session.expire_all()
    if session.get(ArtistReview, call.artist_id) is None:
        profile = session.get(ArtistProfile, call.artist_id)
        if profile is None:
            return None
        session.add(_new_review(profile))
        session.flush()
    values = {"updated_at": datetime.now(UTC)}
    if error is not None:
        values.update(state="error", error=error)
    else:
        values.update(state="ready", error=None,
                      candidate_json=json.dumps(candidate, ensure_ascii=False, default=str))
    if not _set_review(session, call.artist_id, **values):
        session.rollback()
        return None
    session.execute(
        update(ArtistProfile).where(ArtistProfile.id == call.artist_id)
        .values(needs_review=True).execution_options(synchronize_session=False)
    )
    return "failed" if error is not None else "updated"


def enrich_artist_profiles(
    session: Session,
    *,
    limit: int | None = None,
    profile_ids: list[int] | None = None,
    force: bool = False,
    job: Job | None = None,
    comparison: bool = False,
    again: bool = False,
) -> dict:
    confirmed = select(ArtistReview.artist_id).where(
        ArtistReview.confirmed_at.is_not(None) | (ArtistReview.state == "confirmed")
    )
    stmt = select(ArtistProfile).where(
        ArtistProfile.track_count >= 2,
        ArtistProfile.normalized_name.notin_(PLACEHOLDER_ARTISTS),
        ArtistProfile.id.notin_(confirmed),
    )
    if profile_ids is not None:
        stmt = stmt.where(ArtistProfile.id.in_(profile_ids))
    profiles = session.exec(stmt.order_by(ArtistProfile.track_count.desc(), ArtistProfile.id)).all()
    reviews = {
        r.artist_id: r for r in session.exec(
            select(ArtistReview).where(ArtistReview.artist_id.in_([p.id for p in profiles]))
            .execution_options(populate_existing=True)
        ).all()
    }
    model = llm_client.current_config().llm1_model if again else ""
    artist_ids = [
        p.id for p in profiles
        if (research_again_pending(p, reviews.get(p.id), model) if again
            else force or comparison or research_pending(p, reviews.get(p.id)))
    ]
    if limit is not None:
        artist_ids = artist_ids[:limit]
    selected = len(artist_ids)
    if not (force or comparison or again):  # those runs redo the same artists every time: a cap would never reach the rest
        artist_ids = artist_ids[:MAX_ARTISTS_PER_JOB]
    total = len(artist_ids)
    width = RESEARCH_AGAIN_WIDTH if again else 1
    deadline = monotonic() + JOB_DEADLINE_S
    job_id = job.id if job is not None else None
    if job is not None:
        job.total = total
        job.processed = 0
        job.message = "Προετοιμασία έρευνας ειδών…"
        session.add(job)
        session.commit()

    queue = deque(artist_ids)
    inflight: dict[Future, _Call] = {}
    processed = updated = failed = started = answered = 0
    reasons: Counter[str] = Counter()
    streak_reason, streak = None, 0
    first_failures = 0
    halt: str | None = None
    breaker: str | None = None

    def progress():
        if job is not None and inflight:
            names = " · ".join(call.name for call in inflight.values())
            job.message = f"Έρευνα είδους: {names} ({processed + 1}/{total})"
        if job is not None:
            job.processed = processed
            session.add(job)

    while True:
        while len(inflight) < width and queue and halt is None:
            if stop_requested(job_id):
                halt = "stop"
            elif monotonic() >= deadline:
                halt = "limit"
            if halt is not None:
                break
            artist_id = queue.popleft()
            started += 1
            prepared = _prepare(session, artist_id, again, model)
            if prepared is None:
                processed += 1  # confirmed or no longer due meanwhile: counted, so a finished run reads 100%
                progress()
                session.commit()
                continue
            payload, name, keep_old = prepared
            until = min(monotonic() + ARTIST_CALL_DEADLINE_S, deadline)
            inflight[_start_research(payload)] = _Call(artist_id, name, keep_old, until)
            progress()
            # End the read transaction before waiting for the network; confirmations
            # from another session will be visible after the provider returns.
            session.commit()
        if not inflight:
            break
        soonest = min(call.until for call in inflight.values())
        done, _ = wait(list(inflight), timeout=max(0.0, soonest - monotonic()), return_when=FIRST_COMPLETED)
        now = monotonic()
        finished = [f for f in inflight if f in done or now >= inflight[f].until]
        for future in finished:
            call = inflight.pop(future)
            candidate = error = None
            if future in done:
                try:
                    candidate = future.result()
                except llm_client.LLMClientError as exc:
                    error = str(exc)
            else:
                error = CALL_TIMEOUT_ERROR
            processed += 1
            outcome = _store(session, call, candidate, error)
            if outcome == "updated":
                updated += 1
            elif outcome == "failed":
                failed += 1
            if outcome is not None:
                answered += 1
                if outcome == "failed":
                    reason = artist_genre_research.failure_text(error)
                    reasons[reason] += 1
                    if error == artist_genre_research.INVALID_FINDING:
                        streak_reason, streak = None, 0  # about this artist, not the provider
                    else:
                        streak = streak + 1 if reason == streak_reason else 1
                        streak_reason = reason
                    if answered <= BREAKER_FIRST_CALLS:
                        first_failures += 1
                else:
                    streak_reason, streak = None, 0
                if halt is None and answered == BREAKER_FIRST_CALLS and first_failures == BREAKER_FIRST_CALLS:
                    halt, breaker = "breaker", f"οι πρώτες {BREAKER_FIRST_CALLS} κλήσεις απέτυχαν"
                elif halt is None and streak >= BREAKER_SAME_IN_ROW:
                    halt, breaker = "breaker", f"{BREAKER_SAME_IN_ROW} κλήσεις στη σειρά απέτυχαν για τον ίδιο λόγο"
            progress()
            session.commit()
    if halt is None and started < selected:
        halt = "limit"  # the per-job cap
    remaining = selected - started
    # `halt` says why work was left over: "stop" (the owner), "breaker" (failures), "limit" (job clock or cap).
    return {"processed": processed, "updated": updated, "failed": failed,
            "stopped": remaining > 0, "remaining": remaining, "halt": halt if remaining > 0 else None,
            "reason": reasons.most_common(1)[0][0] if reasons else None,
            "breaker": breaker if remaining > 0 else None}
