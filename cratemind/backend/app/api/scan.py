"""Scan / fingerprint / duplicate-detection job endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..config import get_settings
from ..db import get_session
from ..jobs import worker
from ..models import Job
from ..schemas import ScanRequest

router = APIRouter(prefix="/scan", tags=["scan"])


@router.post("/start")
def start_scan(req: ScanRequest, session: Session = Depends(get_session)):
    settings = get_settings()
    roots = req.roots or [str(r) for r in settings.roots]
    if not roots:
        raise HTTPException(400, "No library roots configured. Set CRATEMIND_LIBRARY_ROOTS.")
    job = worker.create_job(session, "scan")
    worker.start_scan(job.id, req.roots)
    return job


@router.post("/fingerprint")
def start_fingerprint(session: Session = Depends(get_session)):
    if not get_settings().fpcalc:
        raise HTTPException(400, "fpcalc/Chromaprint not found on PATH.")
    job = worker.create_job(session, "fingerprint")
    worker.start_fingerprint(job.id)
    return job


@router.post("/duplicates")
def start_duplicate_detection(session: Session = Depends(get_session)):
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
