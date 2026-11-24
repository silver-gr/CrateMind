"""Stage source-backed artist genre findings for explicit human confirmation."""
from __future__ import annotations

import json
import threading
from concurrent.futures import Future
from datetime import UTC, datetime
from time import monotonic

from collections.abc import Iterable

from sqlalchemy import or_, update
from sqlmodel import Session, select

from ..artist_vocab import artist_substyle
from ..models import ArtistProfile, ArtistReview, Job, Track
from . import artist_genre_research, llm_client
from .sql_ids import ids_in

PLACEHOLDER_ARTISTS = {
    "unknown artist", "unknown", "various artists", "va", "misc", "downloaded by mediahuman",
}
# Bounds on one research job (each artist is a paid web-search call). urlopen's timeout bounds
# one socket read only, so a call gets its own wall clock; a job stops cleanly at whichever
# bound comes first and keeps what it already staged. A later run continues with the rest.
ARTIST_CALL_DEADLINE_S = 5 * 60
JOB_DEADLINE_S = 3 * 60 * 60
MAX_ARTISTS_PER_JOB = 100
CALL_TIMEOUT_ERROR = "Η έρευνα ξεπέρασε το χρονικό όριο· δεν αποθηκεύτηκε εύρημα."


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


def _research_within(payload: dict, seconds: float) -> dict:
    """Run one provider call against a wall clock. A call past it is abandoned (its daemon
    thread ends at its own socket timeout and its result is dropped)."""
    future: Future = Future()

    def run():
        try:
            future.set_result(artist_genre_research.research_artist(payload))
        except BaseException as exc:  # noqa: BLE001 - re-raised in the job thread
            future.set_exception(exc)

    threading.Thread(target=run, name="artist-research", daemon=True).start()
    try:
        return future.result(timeout=max(0.0, seconds))
    except TimeoutError:
        raise llm_client.LLMClientError(CALL_TIMEOUT_ERROR) from None


def enrich_artist_profiles(
    session: Session,
    *,
    limit: int | None = None,
    profile_ids: list[int] | None = None,
    force: bool = False,
    job: Job | None = None,
    comparison: bool = False,
) -> dict[str, int]:
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
    artist_ids = [
        p.id for p in profiles
        if force or comparison or research_pending(p, reviews.get(p.id))
    ]
    if limit is not None:
        artist_ids = artist_ids[:limit]
    selected = len(artist_ids)
    if not (force or comparison):  # those runs redo the same artists every time: a cap would never reach the rest
        artist_ids = artist_ids[:MAX_ARTISTS_PER_JOB]
    deadline = monotonic() + JOB_DEADLINE_S
    if job is not None:
        job.total = len(artist_ids)
        job.processed = 0
        job.message = "Προετοιμασία έρευνας ειδών…"
        session.add(job)
        session.commit()

    processed = updated = failed = started = 0
    for artist_id in artist_ids:
        if monotonic() >= deadline:
            break
        started += 1
        session.expire_all()
        profile = session.get(ArtistProfile, artist_id)
        review = session.get(ArtistReview, artist_id)
        if profile is None or (review is not None and (review.confirmed_at is not None or review.state == "confirmed")):
            continue
        if review is None:
            review = ArtistReview(
                artist_id=artist_id,
                baseline_json=json.dumps(profile.model_dump(mode="json"), ensure_ascii=False),
            )
            session.add(review)
            session.flush()
        if not _set_review(session, artist_id, state="pending", error=None, updated_at=datetime.now(UTC)):
            session.rollback()
            continue
        examples = session.exec(
            select(Track).where(
                Track.artist_normalized == profile.normalized_name, Track.missing == False,
            ).order_by(Track.id).limit(3)
        ).all()
        payload = {
            "id": artist_id,
            "canonical_name": profile.canonical_name,
            "normalized_name": profile.normalized_name,
            "library_examples": [
                {"title": t.title, "artist_credit": t.artist, "genre": t.genre,
                 "album": t.album, "label": t.label}
                for t in examples
            ],
        }
        if job is not None:
            job.message = f"Έρευνα είδους: {profile.canonical_name} ({processed + 1}/{len(artist_ids)})"
            session.add(job)
        # End the read transaction before waiting for the network; confirmations
        # from another session will be visible after the provider returns.
        session.commit()
        candidate = None
        error = None
        try:
            candidate = _research_within(payload, min(ARTIST_CALL_DEADLINE_S, deadline - monotonic()))
        except llm_client.LLMClientError as exc:
            error = str(exc)
        processed += 1
        values = {"updated_at": datetime.now(UTC)}
        if error is not None:
            values.update(state="error", error=error)
        else:
            values.update(
                state="ready", error=None,
                candidate_json=json.dumps(candidate, ensure_ascii=False, default=str),
            )
        if _set_review(session, artist_id, **values):
            if error is not None:
                failed += 1
            else:
                updated += 1
            session.execute(
                update(ArtistProfile).where(ArtistProfile.id == artist_id)
                .values(needs_review=True).execution_options(synchronize_session=False)
            )
        if job is not None:
            job.processed = processed
            session.add(job)
        session.commit()
    remaining = selected - started
    return {"processed": processed, "updated": updated, "failed": failed,
            "stopped": remaining > 0, "remaining": remaining}
