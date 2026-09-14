"""Scan / fingerprint / duplicate-detection job endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..config import get_settings
from ..db import get_session
from ..jobs import worker
from ..models import Job
from ..schemas import AnalyzeRequest, ScanRequest

router = APIRouter(prefix="/scan", tags=["scan"])
ACTIVE_JOB_STATUSES = ("pending", "running")


def _active_job(session: Session) -> Job | None:
    return session.exec(
        select(Job)
        .where(Job.status.in_(ACTIVE_JOB_STATUSES))
        .order_by(Job.id.desc())
    ).first()


def _require_idle(session: Session) -> None:
    active = _active_job(session)
    if active is None:
        return
    if active.kind == "analyze" and worker.active_analyze_job_id() is None:
        active.status = "error"
        active.error = "analysis worker is no longer running"
        session.add(active)
        session.commit()
        return
    raise HTTPException(409, f"{active.kind} job {active.id} is already {active.status}")


@router.post("/start")
def start_scan(req: ScanRequest, session: Session = Depends(get_session)):
    _require_idle(session)
    settings = get_settings()
    roots = req.roots or [str(r) for r in settings.roots]
    if not roots:
        raise HTTPException(400, "No library roots configured. Set CRATEMIND_LIBRARY_ROOTS.")
    job = worker.create_job(session, "scan")
    worker.start_scan(job.id, req.roots)
    return job


@router.post("/fingerprint")
def start_fingerprint(session: Session = Depends(get_session)):
    _require_idle(session)
    if not get_settings().fpcalc:
        raise HTTPException(400, "fpcalc/Chromaprint not found on PATH.")
    job = worker.create_job(session, "fingerprint")
    worker.start_fingerprint(job.id)
    return job


@router.post("/analyze")
def start_analyze(req: AnalyzeRequest, session: Session = Depends(get_session)):
    settings = get_settings()
    if not settings.ffmpeg:
        raise HTTPException(400, "ffmpeg not found on PATH. Required for audio analysis.")
    if (
        settings.getsongbpm_enabled
        and settings.getsongbpm_bulk_enabled
        and not settings.getsongbpm_api_key
    ):
        raise HTTPException(
            400,
            "GetSongBPM is enabled but CRATEMIND_GETSONGBPM_API_KEY is missing.",
        )
    if settings.cyanite_enabled and not settings.cyanite_access_token:
        raise HTTPException(
            400,
            "Cyanite is enabled but CRATEMIND_CYANITE_ACCESS_TOKEN is missing.",
        )
    active = _active_job(session)
    if active is not None:
        running_job_id = worker.active_analyze_job_id()
        if active.kind == "analyze" and running_job_id == active.id:
            return active
        if active.kind == "analyze" and running_job_id is None:
            active.status = "error"
            active.error = "analysis worker is no longer running"
            session.add(active)
            session.commit()
        else:
            raise HTTPException(409, f"{active.kind} job {active.id} is already {active.status}")
    job = worker.create_job(session, "analyze")
    if not worker.start_analyze(job.id, req.force, req.limit):
        job.status = "error"
        job.error = "another analysis worker is already running"
        session.add(job)
        session.commit()
        raise HTTPException(409, job.error)
    return job


@router.post("/duplicates")
def start_duplicate_detection(session: Session = Depends(get_session)):
    _require_idle(session)
    job = worker.create_job(session, "duplicate_scan")
    worker.start_duplicates(job.id)
    return job


@router.get("/status")
def scan_status(job_id: int | None = None, session: Session = Depends(get_session)):
    if job_id is not None:
        job = session.get(Job, job_id)
        if job is None:
            raise HTTPException(404, "job not found")
        return job
    job = session.exec(select(Job).order_by(Job.id.desc())).first()
    return job
