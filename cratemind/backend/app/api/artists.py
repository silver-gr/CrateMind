"""Artist intelligence foundation endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlmodel import Session, select

from ..db import get_session
from ..jobs import worker
from ..models import ArtistProfile, Track
from ..schemas import ArtistEnrichRequest, ArtistStatsResponse, ProfileUpdate
from ..services.artist_catalog import rebuild_artist_profiles
from .tracks import _apply_profile

router = APIRouter(prefix="/artists", tags=["artists"])


def _artist_payload(profile: ArtistProfile) -> dict:
    return profile.model_dump(mode="json")


@router.get("")
def list_artists(
    q: str | None = None,
    confidence_label: str | None = None,
    needs_review: bool | None = None,
    min_track_count: int = 0,
    limit: int = Query(200, le=5000),
    offset: int = 0,
    session: Session = Depends(get_session),
):
    stmt = select(ArtistProfile)
    if q:
        pattern = f"%{q}%"
        stmt = stmt.where(
            ArtistProfile.canonical_name.ilike(pattern)
            | ArtistProfile.normalized_name.ilike(pattern)
        )
    if confidence_label:
        stmt = stmt.where(ArtistProfile.confidence_label == confidence_label)
    if needs_review is not None:
        stmt = stmt.where(ArtistProfile.needs_review == needs_review)
    if min_track_count > 0:
        stmt = stmt.where(ArtistProfile.track_count >= min_track_count)

    rows = session.exec(
        stmt.order_by(ArtistProfile.track_count.desc(), ArtistProfile.canonical_name)
        .limit(limit)
        .offset(offset)
    ).all()
    return [_artist_payload(row) for row in rows]


@router.get("/stats")
def artist_stats(session: Session = Depends(get_session)) -> ArtistStatsResponse:
    total_artists = session.exec(
        select(func.count()).select_from(ArtistProfile)
    ).one()
    active_artists = session.exec(
        select(func.count()).select_from(ArtistProfile).where(ArtistProfile.track_count > 0)
    ).one()
    unenriched_artists = session.exec(
        select(func.count()).select_from(ArtistProfile).where(ArtistProfile.last_enriched_at.is_(None))
    ).one()
    needs_review_artists = session.exec(
        select(func.count()).select_from(ArtistProfile).where(ArtistProfile.needs_review == True)  # noqa: E712
    ).one()
    return ArtistStatsResponse(
        total_artists=int(total_artists),
        active_artists=int(active_artists),
        unenriched_artists=int(unenriched_artists),
        needs_review_artists=int(needs_review_artists),
    )


@router.post("/rebuild")
def rebuild_artists(session: Session = Depends(get_session)):
    return rebuild_artist_profiles(session)


@router.post("/enrich")
def enrich_artists(req: ArtistEnrichRequest, session: Session = Depends(get_session)):
    job = worker.create_job(session, "artist_enrich")
    worker.start_artist_enrich(job.id, req.limit, req.force)
    return job


@router.post("/tracks/{track_id}/accept-prefill")
def accept_artist_prefill(
    track_id: int,
    update: ProfileUpdate,
    session: Session = Depends(get_session),
):
    track = session.get(Track, track_id)
    if track is None:
        raise HTTPException(404, "track not found")
    profile = _apply_profile(session, track_id, update)
    return profile.model_dump(mode="json")


@router.get("/{artist_id}")
def get_artist(artist_id: int, session: Session = Depends(get_session)):
    profile = session.get(ArtistProfile, artist_id)
    if profile is None:
        raise HTTPException(404, "artist not found")
    return _artist_payload(profile)
