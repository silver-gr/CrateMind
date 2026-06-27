"""Track listing, detail, and DJ-profile editing."""
from __future__ import annotations

from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import StreamingResponse
from sqlmodel import Session, select

from ..db import get_session, reindex_track
from ..models import PlayEvent, Tag, Track, TrackDJProfile, TrackTag
from ..schemas import BatchProfileUpdate, PlayLog, ProfileUpdate
from ..services import audit, search, streaming

router = APIRouter(prefix="/tracks", tags=["tracks"])


def _track_payload(session: Session, track: Track) -> dict:
    prof = session.get(TrackDJProfile, track.id)
    tag_rows = session.exec(
        select(Tag).join(TrackTag, TrackTag.tag_id == Tag.id).where(
            TrackTag.track_id == track.id
        )
    ).all()
    return {
        "track": track.model_dump(mode="json"),
        "profile": prof.model_dump(mode="json") if prof else None,
        "tags": [t.model_dump(mode="json") for t in tag_rows],
    }


def _list_payload(session: Session, tracks: list[Track]) -> list[dict]:
    """Serialize a track list, merging in a small DJ-profile summary per row.

    One bulk lookup (no N+1). Profiles are created lazily, so most untagged
    tracks have NO profile row → the summary keys are emitted as null. Purely
    additive and read-only; it never writes or mutates anything.
    """
    ids = [t.id for t in tracks]
    prof_map: dict[int, TrackDJProfile] = {}
    if ids:  # guard against an empty IN ()
        rows = session.exec(
            select(TrackDJProfile).where(TrackDJProfile.track_id.in_(ids))
        ).all()
        prof_map = {p.track_id: p for p in rows}
    out: list[dict] = []
    for t in tracks:
        row = t.model_dump(mode="json")
        p = prof_map.get(t.id)
        row["personal_status"] = p.personal_status if p else None
        row["energy"] = p.energy if p else None
        row["darkness"] = p.darkness if p else None
        row["set_role"] = p.set_role if p else None
        out.append(row)
    return out


@router.get("")
def list_tracks(
    q: str | None = None,
    limit: int = Query(200, le=2000),
    offset: int = 0,
    session: Session = Depends(get_session),
):
    if q:
        tracks = search.search(session, q, limit=limit, offset=offset)
    else:
        tracks = list(session.exec(
            select(Track).order_by(Track.artist, Track.title).limit(limit).offset(offset)
        ).all())
    return _list_payload(session, tracks)


@router.get("/search")
def search_tracks(
    q: str = "",
    limit: int = Query(200, le=2000),
    offset: int = 0,
    session: Session = Depends(get_session),
):
    tracks = search.search(session, q, limit=limit, offset=offset)
    return _list_payload(session, tracks)


@router.get("/count")
def count_tracks(q: str = "", session: Session = Depends(get_session)):
    return {"count": search.count(session, q)}


@router.get("/{track_id}")
def get_track(track_id: int, session: Session = Depends(get_session)):
    track = session.get(Track, track_id)
    if track is None:
        raise HTTPException(404, "track not found")
    return _track_payload(session, track)


@router.get("/{track_id}/audio")
def stream_audio(track_id: int, request: Request, session: Session = Depends(get_session)):
    """Stream an indexed track's audio for in-app audition.

    Security: the file is resolved from the DB by integer id only — the client
    never supplies a path, so arbitrary-file access is impossible. Read-only;
    never mutates the file. Supports HTTP Range so the browser can seek.
    """
    track = session.get(Track, track_id)
    if track is None:
        raise HTTPException(404, "track not found")

    content_type = streaming.content_type_for(track.extension)
    if content_type is None:
        raise HTTPException(415, f"unsupported audio format for in-browser audition: .{track.extension}")

    path = Path(track.absolute_path)
    if not path.is_file():
        raise HTTPException(410, "audio file no longer present on disk")
    size = path.stat().st_size

    rng = streaming.parse_range(request.headers.get("range"), size)
    base_headers = {"Accept-Ranges": "bytes"}

    if rng == "invalid":
        return Response(
            status_code=416,
            headers={"Content-Range": f"bytes */{size}", "Accept-Ranges": "bytes"},
        )

    if rng is None:
        return StreamingResponse(
            streaming.iter_file_range(path, 0, max(size - 1, 0)),
            media_type=content_type,
            headers={**base_headers, "Content-Length": str(size)},
        )

    start, end = rng
    return StreamingResponse(
        streaming.iter_file_range(path, start, end),
        status_code=206,
        media_type=content_type,
        headers={
            **base_headers,
            "Content-Range": f"bytes {start}-{end}/{size}",
            "Content-Length": str(end - start + 1),
        },
    )


def _apply_profile(session: Session, track_id: int, update: ProfileUpdate) -> TrackDJProfile:
    prof = session.get(TrackDJProfile, track_id)
    before = prof.model_dump(mode="json") if prof else None
    if prof is None:
        prof = TrackDJProfile(track_id=track_id)
    data = update.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(prof, k, v)
    prof.updated_at = datetime.utcnow()
    session.add(prof)
    session.commit()
    reindex_track(session, track_id)  # notes feed FTS
    audit.log(session, "profile_update", "track", track_id, before, prof.model_dump(mode="json"))
    return prof


@router.patch("/{track_id}/profile")
def update_profile(track_id: int, update: ProfileUpdate, session: Session = Depends(get_session)):
    if session.get(Track, track_id) is None:
        raise HTTPException(404, "track not found")
    prof = _apply_profile(session, track_id, update)
    return prof.model_dump(mode="json")


@router.post("/{track_id}/play")
def log_play(track_id: int, req: PlayLog, session: Session = Depends(get_session)):
    """Record a play: drives play_count / last_played_at, which feed the
    not_recent / played_recently / never_played search tokens."""
    track = session.get(Track, track_id)
    if track is None:
        raise HTTPException(404, "track not found")
    now = datetime.utcnow()
    session.add(PlayEvent(
        track_id=track_id, set_id=req.set_id, played_at=now,
        context=req.context, crowd_reaction=req.crowd_reaction, notes=req.notes,
    ))
    track.play_count += 1
    track.last_played_at = now
    session.add(track)
    session.commit()
    return {"track_id": track_id, "play_count": track.play_count,
            "last_played_at": now.isoformat()}


@router.post("/batch-profile")
def batch_profile(req: BatchProfileUpdate, session: Session = Depends(get_session)):
    updated = 0
    for tid in req.track_ids:
        if session.get(Track, tid) is None:
            continue
        _apply_profile(session, tid, req.profile)
        updated += 1
    return {"updated": updated}
