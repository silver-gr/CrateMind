"""Duplicate review. Never deletes files — records human decisions only."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..db import get_session
from ..models import DuplicateGroup, DuplicateGroupTrack, Track
from ..schemas import DuplicateResolve
from ..services import audit
from ..services.tempo import effective_bpm

router = APIRouter(prefix="/duplicates", tags=["duplicates"])


@router.get("")
def list_duplicates(status: str = "needs_review", session: Session = Depends(get_session)):
    groups = session.exec(
        select(DuplicateGroup).where(DuplicateGroup.status == status)
        .order_by(DuplicateGroup.id.desc())
    ).all()
    out = []
    for g in groups:
        links = session.exec(
            select(DuplicateGroupTrack).where(DuplicateGroupTrack.group_id == g.id)
        ).all()
        members = []
        for link in links:
            tr = session.get(Track, link.track_id)
            if tr is None:
                continue
            members.append({
                "track_id": tr.id,
                "role": link.role,
                "artist": tr.artist,
                "title": tr.title,
                "duration": tr.duration,
                "bpm": effective_bpm(tr),
                "extension": tr.extension,
                "absolute_path": tr.absolute_path,
            })
        out.append({"id": g.id, "reason": g.reason, "status": g.status, "tracks": members})
    from ..services.canonical_library import overlay
    overlay([track for group in out for track in group["tracks"]], session)
    return out


@router.post("/{group_id}/resolve")
def resolve(group_id: int, req: DuplicateResolve, session: Session = Depends(get_session)):
    group = session.get(DuplicateGroup, group_id)
    if group is None:
        raise HTTPException(404, "group not found")
    links = session.exec(
        select(DuplicateGroupTrack).where(DuplicateGroupTrack.group_id == group_id)
    ).all()
    for link in links:
        if req.master_track_id is not None and link.track_id == req.master_track_id:
            link.role = "master"
        elif link.track_id in req.roles:
            link.role = req.roles[link.track_id]
        session.add(link)
    group.status = req.status
    session.add(group)
    session.commit()
    audit.log(session, "duplicate_resolve", "duplicate_group", group_id,
              after={"status": req.status, "master": req.master_track_id})
    return {"id": group_id, "status": group.status}
