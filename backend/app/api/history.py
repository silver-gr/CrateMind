"""Play history: plays recorded on a deck (start, end, seconds heard) in
CrateMind's own play_events table, plus delete and save-as-set. Writes only
play_events, the tracks' play stats, sets/set_tracks and the audit log."""
from __future__ import annotations

from collections import Counter
from datetime import UTC, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import AwareDatetime, BaseModel, Field, StringConstraints
from sqlalchemy import and_, func, or_
from sqlmodel import Session, select

from ..db import get_session
from ..models import DJSet, PlayEvent, SetTrack, Track
from ..services import audit

router = APIRouter(tags=["history"])

PLAY_FIELDS = {"id", "track_id", "set_id", "deck", "played_at", "ended_at", "played_seconds", "context"}
# Stored played_at text can mix ' ' and 'T…Z' forms (adopted rows), so order on
# its julianday, never the raw text.
_PLAYED_JD = func.coalesce(func.julianday(PlayEvent.played_at), 0)


class PlayCreate(BaseModel):
    track_id: int
    deck: Literal["A", "B"]
    started_at: AwareDatetime
    ended_at: AwareDatetime
    played_seconds: float = Field(ge=0, allow_inf_nan=False)


class PlayUpdate(BaseModel):
    track_id: int
    ended_at: AwareDatetime
    played_seconds: float = Field(ge=0, allow_inf_nan=False)


class PlayDelete(BaseModel):
    ids: list[int] = Field(max_length=1000)


class PlaySaveSet(BaseModel):
    play_ids: list[int] = Field(max_length=1000)
    title: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


def _play(event: PlayEvent) -> dict:
    return event.model_dump(mode="json", include=PLAY_FIELDS)


def _clamp_end(ended_at: datetime, played_at: datetime, now: datetime) -> datetime:
    return min(max(ended_at.astimezone(UTC), played_at), now)


@router.get("/history")
def list_history(before_id: int | None = None, limit: int = Query(500, ge=1, le=1000),
                 session: Session = Depends(get_session)):
    stmt = select(PlayEvent, Track).join(Track, Track.id == PlayEvent.track_id)
    if before_id is not None:
        anchor = session.exec(select(_PLAYED_JD).where(PlayEvent.id == before_id)).first()
        if anchor is None:
            raise HTTPException(404, "play not found")
        stmt = stmt.where(or_(_PLAYED_JD < anchor, and_(_PLAYED_JD == anchor, PlayEvent.id < before_id)))
    rows = session.exec(stmt.order_by(_PLAYED_JD.desc(), PlayEvent.id.desc()).limit(limit + 1)).all()
    tracks: dict[int, dict] = {}
    for _event, track in rows[:limit]:
        tracks.setdefault(track.id, track.model_dump(mode="json"))
    from ..services.canonical_library import overlay
    overlay(list(tracks.values()), session)
    plays = [{**_play(event), "track": tracks[track.id]} for event, track in rows[:limit]]
    return {"plays": plays, "has_more": len(rows) > limit}


@router.post("/history/plays")
def create_play(req: PlayCreate, session: Session = Depends(get_session)):
    try:
        # Reserve the writer before reading the play stats this bumps.
        session.connection().exec_driver_sql("BEGIN IMMEDIATE")
        track = session.get(Track, req.track_id)
        if track is None:
            raise HTTPException(404, "track not found")
        now = datetime.now(UTC)
        played_at = min(req.started_at.astimezone(UTC), now)
        event = PlayEvent(track_id=track.id, deck=req.deck, played_at=played_at,
                          ended_at=_clamp_end(req.ended_at, played_at, now),
                          played_seconds=req.played_seconds)
        session.add(event)
        track.play_count = (track.play_count or 0) + 1
        if track.last_played_at is None or track.last_played_at < played_at:
            track.last_played_at = played_at
        session.add(track)
        session.commit()
    except BaseException:
        session.rollback()
        raise
    return _play(event)


@router.post("/history/plays/{play_id}")
def update_play(play_id: int, req: PlayUpdate, session: Session = Depends(get_session)):
    """Extend a recorded play; values only ever grow and counts never change.
    The write lock is taken before the read, so overlapping updates can't move a value back."""
    try:
        session.connection().exec_driver_sql("BEGIN IMMEDIATE")
        event = session.get(PlayEvent, play_id)
        if event is None or event.track_id != req.track_id:
            raise HTTPException(404, "play not found")
        ended_at = _clamp_end(req.ended_at, event.played_at, datetime.now(UTC))
        if event.ended_at is None or event.ended_at < ended_at:
            event.ended_at = ended_at
        if event.played_seconds is None or event.played_seconds < req.played_seconds:
            event.played_seconds = req.played_seconds
        session.add(event)
        session.commit()
    except BaseException:
        session.rollback()
        raise
    return _play(event)


@router.post("/history/delete")
def delete_plays(req: PlayDelete, session: Session = Depends(get_session)):
    ids = list(dict.fromkeys(req.ids))
    try:
        session.connection().exec_driver_sql("BEGIN IMMEDIATE")
        events = session.exec(select(PlayEvent).where(PlayEvent.id.in_(ids))).all() if ids else []
        deleted = [_play(event) for event in events]
        per_track = Counter(event.track_id for event in events)
        for event in events:
            session.delete(event)
        session.flush()
        for track_id, count in per_track.items():
            track = session.get(Track, track_id)
            if track is None:
                continue
            track.play_count = max(0, (track.play_count or 0) - count)
            remaining = session.exec(select(PlayEvent).where(PlayEvent.track_id == track_id)).all()
            track.last_played_at = max((e.played_at for e in remaining if e.played_at is not None), default=None)
            session.add(track)
        if deleted:
            audit.log(session, "history.delete", "play_event", None, before={"deleted": deleted}, commit=False)
        session.commit()
    except BaseException:
        session.rollback()
        raise
    return {"deleted": len(deleted)}


@router.post("/history/save-set")
def save_set(req: PlaySaveSet, session: Session = Depends(get_session)):
    """A new set with each played track once, in the order it was first played."""
    ids = list(dict.fromkeys(req.play_ids))
    track_ids = list(dict.fromkeys(session.exec(
        select(PlayEvent.track_id).join(Track, Track.id == PlayEvent.track_id)
        .where(PlayEvent.id.in_(ids)).order_by(_PLAYED_JD.asc(), PlayEvent.id.asc())
    ).all())) if ids else []
    if not track_ids:
        raise HTTPException(422, "no plays to save")
    try:
        dj_set = DJSet(title=req.title)
        session.add(dj_set)
        session.flush()
        for position, track_id in enumerate(track_ids):
            session.add(SetTrack(set_id=dj_set.id, position=position, track_id=track_id))
        session.commit()
    except BaseException:
        session.rollback()
        raise
    return {"set_id": dj_set.id, "track_count": len(track_ids)}
