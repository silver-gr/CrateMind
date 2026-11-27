"""Duplicate review. Never deletes files — records human decisions only."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from ..db import get_session
from ..jobs import worker
from ..models import DuplicateGroup, DuplicateGroupTrack, Track
from ..schemas import DuplicateResolve
from ..services import audit, relink
from ..services.duplicate_detector import suggest_keeper
from ..services.tempo import effective_bpm
from .scan import _require_idle

router = APIRouter(prefix="/duplicates", tags=["duplicates"])


@router.get("")
def list_duplicates(status: str = "needs_review", session: Session = Depends(get_session)):
    groups = session.exec(
        select(DuplicateGroup).where(DuplicateGroup.status == status)
        .order_by(DuplicateGroup.id.desc())
    ).all()
    out = []
    taste = relink.taste_track_ids(session) if groups else set()
    for g in groups:
        links = session.exec(
            select(DuplicateGroupTrack).where(DuplicateGroupTrack.group_id == g.id)
        ).all()
        members = []
        files = []
        for link in links:
            tr = session.get(Track, link.track_id)
            if tr is None:
                continue
            if not tr.missing:
                files.append({"track_id": tr.id, "extension": tr.extension, "codec": tr.codec, "bitrate": tr.bitrate,
                              "duration": tr.duration, "has_taste": tr.id in taste})
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
        # A suggestion only: nothing is preselected, and no file is ever deleted.
        out.append({"id": g.id, "reason": g.reason, "status": g.status, "tracks": members,
                    "suggested_keep": suggest_keeper(files)})
    from ..services.canonical_library import overlay
    overlay([track for group in out for track in group["tracks"]], session)
    return out


class MovedPair(BaseModel):
    old_id: int
    new_id: int


class MovedMerge(BaseModel):
    pairs: list[MovedPair]


@router.get("/moved")
def list_moved(session: Session = Depends(get_session)):
    """Missing tracks with the user's work on them, each beside the present file that is the same recording."""
    return relink.candidates(session)


@router.post("/moved/merge")
def merge_moved(req: MovedMerge, session: Session = Depends(get_session)):
    """Move the old rows' data to the new rows, for the pairs the user confirmed. Files are never touched."""
    with worker.submission_lock:
        _require_idle(session)
        result = relink.merge(session, [(pair.old_id, pair.new_id) for pair in req.pairs])
    if result["merged"]:
        from ..services.identity_sync import carry_moved_identity_session, replay_mirror_intents, sync_session

        try:
            carry_moved_identity_session(session, result["pairs"])  # while the old observations are still current
            replay_mirror_intents(session)
            sync_session(session, rederive_unchanged=False)
        except Exception as exc:  # the merge itself is committed
            session.rollback()
            raise HTTPException(500, "Η συγχώνευση αποθηκεύτηκε, αλλά ο συγχρονισμός των ταυτοτήτων απέτυχε. "
                                     "Τρέξε μια σάρωση.") from exc
    return {"merged": result["merged"], "skipped": result["skipped"]}


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
