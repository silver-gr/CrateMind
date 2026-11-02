"""Stage source-backed artist genre findings for explicit human confirmation."""
from __future__ import annotations

import json
from datetime import UTC, datetime

from sqlalchemy import update
from sqlmodel import Session, select

from ..models import ArtistProfile, ArtistReview, Job, Track
from . import artist_genre_research, llm_client

PLACEHOLDER_ARTISTS = {
    "unknown artist", "unknown", "various artists", "va", "misc", "downloaded by mediahuman",
}


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
    if job is not None:
        job.total = len(artist_ids)
        job.processed = 0
        job.message = "Προετοιμασία έρευνας ειδών…"
        session.add(job)
        session.commit()

    processed = updated = failed = 0
    for artist_id in artist_ids:
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
            candidate = artist_genre_research.research_artist(payload)
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
    return {"processed": processed, "updated": updated, "failed": failed}
