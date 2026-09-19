"""Set builder: CRUD, ordered tracks, analysis panel, next-track recommender,
and track-pair transition notes."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..db import get_session
from ..models import (
    DJSet,
    PlayEvent,
    SetTrack,
    Track,
    TrackDJProfile,
    TrackPairNote,
)
from ..schemas import (
    PairNoteCreate,
    PlayLog,
    RecommendQuery,
    SetCreate,
    SetReorder,
    SetTrackAdd,
)
from ..services import recommender
from ..services.recommender import effective_bpm, effective_key

router = APIRouter(tags=["sets"])


def _ordered_tracks(session: Session, set_id: int) -> list[tuple[SetTrack, Track]]:
    links = session.exec(
        select(SetTrack).where(SetTrack.set_id == set_id).order_by(SetTrack.position)
    ).all()
    out = []
    for link in links:
        tr = session.get(Track, link.track_id)
        if tr is not None:
            out.append((link, tr))
    return out


@router.get("/sets")
def list_sets(session: Session = Depends(get_session)):
    return [s.model_dump(mode="json") for s in session.exec(
        select(DJSet).order_by(DJSet.id.desc())).all()]


@router.post("/sets")
def create_set(req: SetCreate, session: Session = Depends(get_session)):
    dj_set = DJSet(**req.model_dump())
    session.add(dj_set)
    session.commit()
    session.refresh(dj_set)
    return dj_set.model_dump(mode="json")


@router.get("/sets/{set_id}")
def get_set(set_id: int, session: Session = Depends(get_session)):
    dj_set = session.get(DJSet, set_id)
    if dj_set is None:
        raise HTTPException(404, "set not found")
    tracks = []
    for link, tr in _ordered_tracks(session, set_id):
        prof = session.get(TrackDJProfile, tr.id)
        tracks.append({
            "position": link.position,
            "note": link.note,
            "track": tr.model_dump(mode="json"),
            "profile": prof.model_dump(mode="json") if prof else None,
        })
    return {"set": dj_set.model_dump(mode="json"), "tracks": tracks}


@router.post("/sets/{set_id}/tracks")
def add_track(set_id: int, req: SetTrackAdd, session: Session = Depends(get_session)):
    if session.get(DJSet, set_id) is None:
        raise HTTPException(404, "set not found")
    if session.get(Track, req.track_id) is None:
        raise HTTPException(404, "track not found")
    existing = _ordered_tracks(session, set_id)
    position = req.position if req.position is not None else (
        existing[-1][0].position + 1 if existing else 0
    )
    session.add(SetTrack(set_id=set_id, position=position, track_id=req.track_id, note=req.note))
    session.commit()
    return {"set_id": set_id, "position": position, "track_id": req.track_id}


@router.patch("/sets/{set_id}/tracks/reorder")
def reorder(set_id: int, req: SetReorder, session: Session = Depends(get_session)):
    if session.get(DJSet, set_id) is None:
        raise HTTPException(404, "set not found")
    existing = {link.track_id: link for link, _ in _ordered_tracks(session, set_id)}
    # rewrite positions in two passes to avoid PK collisions
    for link in existing.values():
        link.position += 100000
        session.add(link)
    session.commit()
    for new_pos, tid in enumerate(req.ordered_track_ids):
        link = existing.get(tid)
        if link is not None:
            link.position = new_pos
            session.add(link)
    session.commit()
    return {"set_id": set_id, "order": req.ordered_track_ids}


@router.delete("/sets/{set_id}/tracks/{track_id}")
def remove_track(set_id: int, track_id: int, session: Session = Depends(get_session)):
    links = session.exec(
        select(SetTrack).where(SetTrack.set_id == set_id, SetTrack.track_id == track_id)
    ).all()
    if not links:
        raise HTTPException(404, "track not in set")
    for link in links:
        session.delete(link)
    session.commit()
    return {"removed": True}


@router.get("/sets/{set_id}/analysis")
def analysis(set_id: int, session: Session = Depends(get_session)):
    if session.get(DJSet, set_id) is None:
        raise HTTPException(404, "set not found")
    rows = _ordered_tracks(session, set_id)
    bpm_curve, energy_curve, darkness_curve = [], [], []
    artists: dict[str, int] = {}
    risky, not_approved, transition_warnings = [], [], []
    total_duration = 0.0
    prev = None

    for link, tr in rows:
        prof = session.get(TrackDJProfile, tr.id)
        total_duration += tr.duration or 0
        bpm_curve.append(effective_bpm(tr))
        energy_curve.append(prof.energy if prof else None)
        darkness_curve.append(prof.darkness if prof else None)
        if tr.artist:
            artists[tr.artist] = artists.get(tr.artist, 0) + 1
        status = prof.personal_status if prof else "unknown"
        if status in ("retired", "avoid") or (prof and (prof.weirdness or 0) >= 8):
            risky.append({"position": link.position, "track_id": tr.id,
                          "label": f"{tr.artist} - {tr.title}"})
        if status not in ("approved", "weapon"):
            not_approved.append({"position": link.position, "track_id": tr.id,
                                 "label": f"{tr.artist} - {tr.title}"})
        if prev is not None:
            ptr, pprof = prev
            pbpm, cbpm = effective_bpm(ptr), effective_bpm(tr)
            if pbpm and cbpm and abs(pbpm - cbpm) > 8:
                transition_warnings.append({
                    "from_position": link.position - 1,
                    "message": f"BPM jump {pbpm:g}->{cbpm:g}",
                })
            if ptr.artist and tr.artist and ptr.artist == tr.artist:
                transition_warnings.append({
                    "from_position": link.position - 1,
                    "message": f"same artist back-to-back: {tr.artist}",
                })
        prev = (tr, prof)

    repeated = {a: c for a, c in artists.items() if c > 1}
    return {
        "track_count": len(rows),
        "total_duration": total_duration,
        "bpm_curve": bpm_curve,
        "energy_curve": energy_curve,
        "darkness_curve": darkness_curve,
        "repeated_artists": repeated,
        "risky_tracks": risky,
        "not_approved": not_approved,
        "transition_warnings": transition_warnings,
    }


@router.post("/sets/{set_id}/recommend-next")
def recommend_next(set_id: int, req: RecommendQuery, session: Session = Depends(get_session)):
    if session.get(DJSet, set_id) is None:
        raise HTTPException(404, "set not found")
    rows = _ordered_tracks(session, set_id)
    in_set = {tr.id for _, tr in rows}

    last_track = None
    if req.after_track_id is not None:
        last_track = session.get(Track, req.after_track_id)
    elif rows:
        last_track = rows[-1][1]

    # bridge target: the track the candidate must lead INTO (Track B)
    next_track = None
    if req.before_track_id is not None:
        next_track = session.get(Track, req.before_track_id)

    recent_cutoff = datetime.now(UTC) - timedelta(days=30)
    recent = session.exec(
        select(PlayEvent.track_id).where(PlayEvent.played_at >= recent_cutoff)
    ).all()
    recent_ids = {r for r in recent}

    ctx = recommender.Context(
        previous_key=effective_key(last_track) if last_track else None,
        previous_bpm=effective_bpm(last_track) if last_track else None,
        next_key=effective_key(next_track) if next_track else None,
        next_bpm=effective_bpm(next_track) if next_track else None,
        after_track_id=last_track.id if last_track else None,
        before_track_id=next_track.id if next_track else None,
        target_bpm=req.target_bpm or (effective_bpm(last_track) if last_track else None),
        target_energy=req.target_energy,
        target_role=req.target_role,
        max_weirdness=req.max_weirdness,
        approved_only=req.approved_only,
        need_bridge=req.need_bridge or next_track is not None,
        exclude_ids=in_set,
        recently_played_ids=recent_ids,
    )
    return recommender.recommend(session, ctx, limit=req.limit)


@router.post("/sets/{set_id}/log-play")
def log_set_play(set_id: int, body: PlayLog, session: Session = Depends(get_session)):
    """Log a play for every track in the set — 'after practice, log what worked'.
    Drives play_count / last_played_at so recency filters reflect real use."""
    if session.get(DJSet, set_id) is None:
        raise HTTPException(404, "set not found")
    rows = _ordered_tracks(session, set_id)
    now = datetime.now(UTC)
    for _link, tr in rows:
        session.add(PlayEvent(
            track_id=tr.id, set_id=set_id, played_at=now,
            context=body.context, crowd_reaction=body.crowd_reaction, notes=body.notes,
        ))
        tr.play_count += 1
        tr.last_played_at = now
        session.add(tr)
    session.commit()
    return {"set_id": set_id, "tracks_logged": len(rows)}


# ---- track pair notes ------------------------------------------------------

@router.get("/pair-notes")
def list_pair_notes(track_id: int | None = None, session: Session = Depends(get_session)):
    stmt = select(TrackPairNote)
    if track_id is not None:
        stmt = stmt.where(
            (TrackPairNote.from_track_id == track_id)
            | (TrackPairNote.to_track_id == track_id)
        )
    return [n.model_dump(mode="json") for n in session.exec(stmt.order_by(TrackPairNote.id.desc())).all()]


@router.post("/pair-notes")
def create_pair_note(req: PairNoteCreate, session: Session = Depends(get_session)):
    note = TrackPairNote(**req.model_dump())
    session.add(note)
    session.commit()
    session.refresh(note)
    return note.model_dump(mode="json")
