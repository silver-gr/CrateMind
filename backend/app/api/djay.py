"""djay beatgrid import (read-only on djay's files) and the stored beatgrid."""
from __future__ import annotations

import json

import numpy as np
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from .. import config
from ..db import get_session
from ..jobs import worker
from ..models import AuditLog, Job, Track, TrackBeatgrid
from ..services import audit, djay_import
from .scan import _require_idle

router = APIRouter(tags=["djay"])


@router.get("/import/djay")
def djay_import_status(session: Session = Depends(get_session)):
    job = session.exec(select(Job).where(Job.kind == "djay_import").order_by(Job.id.desc())).first()
    last = session.exec(select(AuditLog).where(AuditLog.action == "djay_import")
                        .order_by(AuditLog.id.desc())).first()
    library, metadata = djay_import.resolve_sources(config.get_settings())  # looked up per call, never bound at import
    return {
        "sources": {"library": str(library), "metadata": str(metadata)},
        "job": job,
        "report": json.loads(last.after_json) if last and last.after_json else None,
        "report_at": last.created_at if last else None,
        "grids": len(session.exec(select(TrackBeatgrid.id).where(
            TrackBeatgrid.source == djay_import.SOURCE)).all()),
    }


@router.post("/import/djay")
def start_djay_import(session: Session = Depends(get_session)):
    with worker.submission_lock:
        _require_idle(session)
        job = worker.create_job(session, "djay_import")
        worker.start_djay_import(job.id)
        return job


@router.delete("/import/djay")
def remove_djay_beatgrids(session: Session = Depends(get_session)):
    """«Αφαίρεση beatgrid djay»: deletes only the source='djay' rows."""
    with worker.submission_lock:
        _require_idle(session)
        removed = djay_import.remove_djay_beatgrids(session)
        audit.log(session, "djay_import_remove", "djay", None, after={"removed": removed})
        return {"removed": removed}


@router.get("/tracks/{track_id}/beatgrid")
def get_track_beatgrid(track_id: int, session: Session = Depends(get_session)):
    track = session.get(Track, track_id)
    if track is None:
        raise HTTPException(404, "track not found")
    row = session.exec(select(TrackBeatgrid).where(TrackBeatgrid.track_id == track_id)
                       .order_by(TrackBeatgrid.id)).first()
    if row is None or row.edited or row.anchor_s is None:
        raise HTTPException(404, "beatgrid not found")
    return {
        "track_id": track_id, "source": row.source, "source_uuid": row.source_uuid,
        "bpm": row.bpm, "straight": row.straight, "anchor_s": row.anchor_s,
        "first_downbeat_index": row.first_downbeat_index,
        "beats": (np.frombuffer(row.beats, dtype="<f4").astype(float).tolist()
                  if row.beats is not None else None),
        "residual_ms": row.residual_ms, "confidence": row.confidence,
        "key_index": row.key_index, "source_version": row.source_version,
        "imported_at": row.imported_at,
    }
