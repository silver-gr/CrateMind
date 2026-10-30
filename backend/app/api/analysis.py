"""BPM consensus summary, review, and manual resolution endpoints."""
from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, not_, or_
from sqlmodel import Session, select

from ..config import get_settings
from ..db import get_session
from ..models import Track
from ..services.audio_analysis import _refresh_consensus

router = APIRouter(prefix="/analysis/bpm", tags=["analysis"])


class BpmResolution(BaseModel):
    source: Literal[
        "auto",
        "metadata",
        "local",
        "essentia",
        "reccobeats",
        "getsongbpm",
        "cyanite",
    ]


def _valid_bpm(value: float | None) -> float | None:
    if value is None or not math.isfinite(value) or value <= 0:
        return None
    return round(float(value), 2)


def _source_value(track: Track, source: str) -> float | None:
    values = {
        "metadata": track.bpm,
        "local": track.bpm_analyzed,
        "essentia": track.bpm_essentia,
        "reccobeats": track.bpm_reccobeats,
        "getsongbpm": track.bpm_getsongbpm,
        "cyanite": track.bpm_cyanite_range_adjusted or track.bpm_cyanite,
    }
    return _valid_bpm(values.get(source))


def _candidate_payload(track: Track) -> list[dict]:
    specs = (
        ("metadata", track.bpm, None),
        ("local", track.bpm_analyzed, track.bpm_analyzed_confidence),
        ("essentia", track.bpm_essentia, track.bpm_essentia_confidence),
        ("reccobeats", track.bpm_reccobeats, None),
        ("getsongbpm", track.bpm_getsongbpm, None),
        (
            "cyanite",
            track.bpm_cyanite_range_adjusted or track.bpm_cyanite,
            None,
        ),
    )
    return [
        {
            "source": source,
            "value": value,
            "confidence": confidence,
            "trusted": source == "metadata",
        }
        for source, raw_value, confidence in specs
        if (value := _valid_bpm(raw_value)) is not None
    ]


def _review_payload(track: Track) -> dict:
    return {
        "id": track.id,
        "artist": track.artist,
        "title": track.title,
        "file_name": track.file_name,
        "bpm": track.bpm,
        "bpm_analyzed": track.bpm_analyzed,
        "bpm_consensus": track.bpm_consensus,
        "bpm_consensus_sources": track.bpm_consensus_sources,
        "consensus": track.bpm_consensus,
        "consensus_source": track.bpm_consensus_sources,
        "disagreement_percent": track.bpm_disagreement_percent,
        "needs_review": track.bpm_needs_review,
        "candidates": _candidate_payload(track),
    }


def _summary_payload(tracks: list[Track]) -> dict:
    manual = [
        track
        for track in tracks
        if (track.bpm_consensus_sources or "").startswith("manual:")
    ]
    actionable = [
        track
        for track in tracks
        if track not in manual
        and (track.bpm_needs_review is True or track.bpm_disagreement is True)
    ]
    return {
        "total": len(tracks),
        "trusted_metadata": sum(_valid_bpm(track.bpm) is not None for track in tracks),
        "local_analyzed": sum(_valid_bpm(track.bpm_analyzed) is not None for track in tracks),
        "reccobeats_analyzed": sum(
            _valid_bpm(track.bpm_reccobeats) is not None for track in tracks
        ),
        "reccobeats_failed": sum(track.reccobeats_error is not None for track in tracks),
        "getsongbpm_matches": sum(
            _valid_bpm(track.bpm_getsongbpm) is not None for track in tracks
        ),
        "getsongbpm_misses": sum(track.getsongbpm_error is not None for track in tracks),
        "provider_disagreements": sum(track.bpm_disagreement is True for track in tracks),
        "consensus": sum(_valid_bpm(track.bpm_consensus) is not None for track in tracks),
        "needs_review": sum(track.bpm_needs_review is True for track in tracks),
        "manual_resolutions": len(manual),
        "actionable_conflicts": len(actionable),
        "bulk_getsongbpm_enabled": get_settings().getsongbpm_bulk_enabled,
    }


def _active_tracks(session: Session) -> list[Track]:
    return list(
        session.exec(
            select(Track).where(Track.missing == False).order_by(Track.id)  # noqa: E712
        ).all()
    )


@router.get("/summary")
def bpm_summary(session: Session = Depends(get_session)):
    return _summary_payload(_active_tracks(session))


@router.get("/review")
def bpm_review(
    scope: Literal["review", "conflicts"] = "conflicts",
    limit: int = Query(40, ge=1, le=100),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
):
    conflict_filter = (
        Track.bpm_needs_review == True  # noqa: E712
        if scope == "review"
        else or_(
            Track.bpm_needs_review == True,  # noqa: E712
            Track.bpm_disagreement == True,  # noqa: E712
        )
    )
    filters = (
        Track.missing == False,  # noqa: E712
        conflict_filter,
        or_(
            Track.bpm_consensus_sources.is_(None),
            not_(Track.bpm_consensus_sources.like("manual:%")),
        ),
    )
    total = session.exec(select(func.count()).select_from(Track).where(*filters)).one()
    rows = list(
        session.exec(
            select(Track)
            .where(*filters)
            .order_by(Track.artist, Track.title, Track.id)
            .limit(limit)
            .offset(offset)
        ).all()
    )
    from ..services.canonical_library import overlay
    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "items": overlay([_review_payload(track) for track in rows], session),
    }


@router.post("/recompute")
def recompute_bpm_consensus(session: Session = Depends(get_session)):
    tracks = _active_tracks(session)
    threshold = get_settings().bpm_disagreement_percent
    for track in tracks:
        _refresh_consensus(track, threshold)
        session.add(track)
    session.commit()
    return _summary_payload(tracks)


@router.post("/retry-failures")
def retry_bpm_failures(session: Session = Depends(get_session)):
    tracks = list(
        session.exec(
            select(Track).where(
                Track.missing == False,  # noqa: E712
                Track.bpm_reccobeats.is_(None),
                Track.reccobeats_error.is_not(None),
            )
        ).all()
    )
    for track in tracks:
        track.reccobeats_error = None
        track.reccobeats_analyzed_at = None
        session.add(track)
    session.commit()
    return {"reccobeats_reset": len(tracks)}


@router.post("/tracks/{track_id}/resolve")
def resolve_bpm(
    track_id: int,
    resolution: BpmResolution,
    session: Session = Depends(get_session),
):
    track = session.get(Track, track_id)
    if track is None or track.missing:
        raise HTTPException(404, "track not found")

    if resolution.source == "auto":
        if (track.bpm_consensus_sources or "").startswith("manual:"):
            track.bpm_consensus = None
            track.bpm_consensus_sources = None
        _refresh_consensus(track, get_settings().bpm_disagreement_percent)
    else:
        value = _source_value(track, resolution.source)
        if value is None:
            raise HTTPException(400, f"{resolution.source} BPM is unavailable")
        track.bpm_consensus = value
        track.bpm_consensus_sources = f"manual:{resolution.source}"
        track.bpm_needs_review = False

    track.analyzed_at = track.analyzed_at or datetime.now(UTC)
    session.add(track)
    session.commit()
    session.refresh(track)
    from ..services.canonical_library import overlay
    return overlay([_review_payload(track)], session)[0]
