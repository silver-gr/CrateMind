"""SoundCloud snapshot import and match-review endpoints."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlmodel import Session

from ..db import get_session
from ..schemas import SoundCloudImportBatch
from ..services import soundcloud

router = APIRouter(prefix="/soundcloud", tags=["soundcloud"])


@router.post("/import-batch")
def import_batch(
    request: SoundCloudImportBatch,
    session: Session = Depends(get_session),
) -> dict[str, int | bool]:
    return soundcloud.import_batch(
        session,
        run_id=request.run_id,
        items=request.items,
        complete=request.complete,
    )


@router.get("/summary")
def get_summary(session: Session = Depends(get_session)) -> dict[str, int | str | None]:
    return soundcloud.summary(session)


@router.get("/review")
def get_review_queue(
    limit: int = Query(100, ge=1, le=250),
    offset: int = Query(0, ge=0),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    return soundcloud.review_queue(session, limit=limit, offset=offset)


@router.post("/review/{track_id}/{soundcloud_track_id}/accept")
def accept_review(
    track_id: int,
    soundcloud_track_id: int,
    session: Session = Depends(get_session),
) -> dict[str, int | str]:
    try:
        return soundcloud.accept_candidate(
            session, track_id=track_id, soundcloud_track_id=soundcloud_track_id
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/review/{track_id}/{soundcloud_track_id}/reject")
def reject_review(
    track_id: int,
    soundcloud_track_id: int,
    session: Session = Depends(get_session),
) -> dict[str, int | str]:
    try:
        return soundcloud.reject_candidate(
            session, track_id=track_id, soundcloud_track_id=soundcloud_track_id
        )
    except LookupError as exc:
        raise HTTPException(404, str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
