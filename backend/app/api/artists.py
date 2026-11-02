"""Artist intelligence foundation endpoints."""
from __future__ import annotations

import json
import threading
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func
from sqlmodel import Session, select

from ..artist_vocab import ALLOWED_ARTIST_GENRES, genre_scene_cluster, normalize_artist_genre
from ..config import get_settings
from ..db import get_session
from ..jobs import worker
from ..models import ArtistProfile, ArtistReview, AuditLog, Job, Track
from ..schemas import ArtistEnrichRequest, ArtistReviewChoice, ArtistStatsResponse, ProfileUpdate
from ..services import artist_genre_research, artist_intelligence, llm_client
from ..services.artist_catalog import rebuild_artist_profiles
from .tracks import _apply_profile

router = APIRouter(prefix="/artists", tags=["artists"])
_mutation_lock = threading.Lock()


def _ensure_idle(session: Session):
    active = session.exec(select(Job).where(Job.kind.in_(["artist_enrich", "artist_compare"]), Job.status.in_(["pending", "running"]))).first()
    if active:
        raise HTTPException(409, f"Artist enrichment job {active.id} is already active.")



def _artist_payload(profile: ArtistProfile, review: ArtistReview | None = None) -> dict:
    item = profile.model_dump(mode="json")
    item["research"] = artist_genre_research.research_info(profile.raw_llm_json)
    item["research_pending"] = artist_intelligence.research_pending(profile, review)
    return item


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
    reviews = {r.artist_id: r for r in session.exec(select(ArtistReview).where(ArtistReview.artist_id.in_([p.id for p in rows]))).all()}
    payload = []
    for row in rows:
        review = reviews.get(row.id)
        item = _artist_payload(row, review)
        if review:
            item["review"] = {"state": review.state, "error": review.error,
                              "current": json.loads(review.baseline_json),
                              "candidate": json.loads(review.candidate_json) if review.candidate_json else None,
                              "confirmed_choice": review.confirmed_choice}
        payload.append(item)
    return payload


@router.get("/stats")
def artist_stats(session: Session = Depends(get_session)) -> ArtistStatsResponse:
    total_artists = session.exec(
        select(func.count()).select_from(ArtistProfile).where(ArtistProfile.track_count >= 2)
    ).one()
    active_artists = session.exec(
        select(func.count()).select_from(ArtistProfile).where(ArtistProfile.track_count >= 2).where(ArtistProfile.track_count > 0)
    ).one()
    profiles = session.exec(select(ArtistProfile).where(ArtistProfile.track_count >= 2)).all()
    reviews = {r.artist_id: r for r in session.exec(select(ArtistReview)).all()}
    unenriched_artists = sum(artist_intelligence.research_pending(p, reviews.get(p.id)) for p in profiles)
    needs_review_artists = session.exec(
        select(func.count()).select_from(ArtistProfile).where(ArtistProfile.track_count >= 2).where(ArtistProfile.needs_review == True)  # noqa: E712
    ).one()
    return ArtistStatsResponse(
        total_artists=int(total_artists),
        active_artists=int(active_artists),
        unenriched_artists=int(unenriched_artists),
        needs_review_artists=int(needs_review_artists),
    )


@router.post("/rebuild")
def rebuild_artists(session: Session = Depends(get_session)):
    with _mutation_lock:
        _ensure_idle(session)
        return rebuild_artist_profiles(session)


@router.post("/enrich")
def enrich_artists(req: ArtistEnrichRequest, session: Session = Depends(get_session)):
    with _mutation_lock:
        _ensure_idle(session)
        if not llm_client.is_configured():
            raise HTTPException(400, "Configure LLM1 before enriching artists.")
        job = worker.create_job(session, "artist_enrich")
        worker.start_artist_enrich(job.id, req.limit, req.force)
        return job


@router.get("/comparison-status")
def comparison_status(session: Session = Depends(get_session)):
    return session.exec(select(Job).where(Job.kind.in_(["artist_compare", "artist_enrich"])).order_by(Job.id.desc())).first()


@router.post("/compare")
def compare_artists(session: Session = Depends(get_session)):
    with _mutation_lock:
        _ensure_idle(session)
        if not llm_client.is_configured():
            raise HTTPException(400, "Configure LLM1 before enriching artists.")
        profiles = session.exec(select(ArtistProfile).where(ArtistProfile.track_count >= 2)).all()
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        folder = get_settings().output_path / "artist-comparisons"
        folder.mkdir(parents=True, exist_ok=True)
        snapshot = folder / f"profiles-{stamp}.json"
        snapshot.write_text(json.dumps([_artist_payload(p) for p in profiles], ensure_ascii=False, indent=2))
        for profile in profiles:
            review = session.get(ArtistReview, profile.id)
            if review is not None:
                continue  # retain pending/ready findings and human confirmations
            placeholder = profile.normalized_name in {"unknown artist", "unknown", "various artists", "va", "misc", "downloaded by mediahuman"}
            session.add(ArtistReview(artist_id=profile.id, baseline_json=json.dumps(_artist_payload(profile), ensure_ascii=False),
                                    state="skipped" if placeholder else "pending",
                                    error="Placeholder artist credit; manual correction needed." if placeholder else None))
        session.commit()
        job = worker.create_job(session, "artist_compare")
        worker.start_artist_enrich(job.id, None, False, True)
        return {"job": job, "snapshot": str(snapshot)}


@router.post("/{artist_id}/review")
def choose_artist_finding(artist_id: int, req: ArtistReviewChoice, session: Session = Depends(get_session)):
    with _mutation_lock:
        profile = session.get(ArtistProfile, artist_id)
        review = session.get(ArtistReview, artist_id)
        if profile is None or review is None:
            raise HTTPException(404, "Artist comparison not found.")
        before = profile.model_dump(mode="json")
        if req.choice == "candidate":
            if not review.candidate_json:
                raise HTTPException(409, "New finding is not ready.")
            candidate = json.loads(review.candidate_json)
            research = artist_genre_research.research_info(candidate.get("raw_llm_json"))
            if research is not None:
                if (review.state != "ready" or research.get("status") != "classified"
                        or candidate.get("primary_subgenre") not in ALLOWED_ARTIST_GENRES
                        or not research.get("sources")):
                    raise HTTPException(409, "Το εύρημα δεν έχει επιβεβαιωμένο είδος. Επίλεξε χειροκίνητα.")
                fields = artist_genre_research.GENRE_PROFILE_FIELDS
            else:
                fields = ("scene_cluster", "primary_subgenre", "secondary_subgenres_json", "typical_bpm_min", "typical_bpm_max",
                          "energy_min", "energy_max", "set_role_hints_json", "confidence_label", "notes", "raw_llm_json")
            for key in fields:
                if key in candidate:
                    setattr(profile, key, candidate[key])
            profile.last_enriched_at = datetime.now(UTC)
        elif req.choice == "manual":
            if not req.subgenre or not req.subgenre.strip():
                raise HTTPException(422, "Enter a substyle.")
            profile.primary_subgenre = req.subgenre.strip()
            if review.candidate_json:
                candidate = json.loads(review.candidate_json)
                research = artist_genre_research.research_info(candidate.get("raw_llm_json"))
                if research is not None:
                    raw = json.loads(candidate["raw_llm_json"])
                    raw["research"] = {**research, "manual_genre": profile.primary_subgenre}
                    profile.raw_llm_json = json.dumps(raw, ensure_ascii=False)
                    profile.notes = f"Χειροκίνητα επιβεβαιωμένο είδος: {profile.primary_subgenre}. Αρχική έρευνα: {research.get('reason', '')}"
                    profile.scene_cluster = genre_scene_cluster(normalize_artist_genre(profile.primary_subgenre))
                    profile.secondary_subgenres_json = "[]"
                    profile.confidence_label = "unknown"
        profile.needs_review = False
        profile.updated_at = datetime.now(UTC)
        review.confirmed_choice = req.choice
        review.confirmed_at = datetime.now(UTC)
        review.state = "confirmed"
        review.error = None
        review.updated_at = datetime.now(UTC)
        session.add(profile); session.add(review)
        session.add(AuditLog(action="artist_genre_confirmation", entity_type="artist_profile", entity_id=profile.id,
                             before_json=json.dumps(before, ensure_ascii=False),
                             after_json=json.dumps(profile.model_dump(mode="json"), ensure_ascii=False)))
        session.commit()
        session.refresh(profile)
        session.refresh(review)
        return _artist_payload(profile, review)


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
    return _artist_payload(profile, session.get(ArtistReview, artist_id))
