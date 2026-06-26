"""Tag CRUD and track<->tag assignment."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..db import get_session, reindex_track
from ..models import Tag, Track, TrackTag
from ..schemas import TagAssign, TagCreate

router = APIRouter(tags=["tags"])


def _get_or_create_tag(session: Session, name: str, category: str | None = None) -> Tag:
    tag = session.exec(select(Tag).where(Tag.name == name)).first()
    if tag is None:
        tag = Tag(name=name, category=category)
        session.add(tag)
        session.commit()
        session.refresh(tag)
    return tag


@router.get("/tags")
def list_tags(session: Session = Depends(get_session)):
    return [t.model_dump(mode="json") for t in session.exec(select(Tag).order_by(Tag.name)).all()]


@router.post("/tags")
def create_tag(req: TagCreate, session: Session = Depends(get_session)):
    return _get_or_create_tag(session, req.name, req.category).model_dump(mode="json")


@router.post("/tracks/{track_id}/tags")
def assign_tag(track_id: int, req: TagAssign, session: Session = Depends(get_session)):
    if session.get(Track, track_id) is None:
        raise HTTPException(404, "track not found")
    if req.tag_id is not None:
        tag = session.get(Tag, req.tag_id)
        if tag is None:
            raise HTTPException(404, "tag not found")
    elif req.name:
        tag = _get_or_create_tag(session, req.name)
    else:
        raise HTTPException(400, "provide tag_id or name")
    if session.get(TrackTag, (track_id, tag.id)) is None:
        session.add(TrackTag(track_id=track_id, tag_id=tag.id))
        session.commit()
    reindex_track(session, track_id)
    return {"track_id": track_id, "tag_id": tag.id, "name": tag.name}


@router.delete("/tracks/{track_id}/tags/{tag_id}")
def remove_tag(track_id: int, tag_id: int, session: Session = Depends(get_session)):
    link = session.get(TrackTag, (track_id, tag_id))
    if link is None:
        raise HTTPException(404, "assignment not found")
    session.delete(link)
    session.commit()
    reindex_track(session, track_id)
    return {"removed": True}
