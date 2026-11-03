"""Scan / fingerprint / duplicate-detection job endpoints."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..config import get_settings
from ..db import get_session
from ..jobs import worker
from ..models import Job, Track
from ..schemas import AnalyzeRequest, ScanRequest
from ..services.bulk_edit import _scope_ids
from ..services.sql_ids import ids_in

router = APIRouter(prefix="/scan", tags=["scan"])
ACTIVE_JOB_STATUSES = ("pending", "running")


def _active_job(session: Session) -> Job | None:
    worker.recover_orphan_jobs(session)
    return session.exec(
        select(Job)
        .where(Job.status.in_(ACTIVE_JOB_STATUSES))
        .order_by(Job.id.desc())
    ).first()


def _require_idle(session: Session) -> None:
    active = _active_job(session)
    if active is None:
        return
    raise HTTPException(409, f"Εκτελείται ήδη άλλη εργασία (#{active.id}). Περίμενε να ολοκληρωθεί.")


@router.post("/start")
def start_scan(req: ScanRequest, session: Session = Depends(get_session)):
    with worker.submission_lock:
        _require_idle(session)
        settings = get_settings()
        roots = req.roots or [str(r) for r in settings.roots]
        if not roots:
            raise HTTPException(400, "No library roots configured. Set CRATEMIND_LIBRARY_ROOTS.")
        job = worker.create_job(session, "scan")
        worker.start_scan(job.id, req.roots, mode=req.mode,
                          tempo_range=req.tempo_range, root_ranges=req.root_ranges)
        return job


@router.post("/fingerprint")
def start_fingerprint(session: Session = Depends(get_session)):
    with worker.submission_lock:
        _require_idle(session)
        if not get_settings().fpcalc:
            raise HTTPException(400, "fpcalc/Chromaprint not found on PATH.")
        job = worker.create_job(session, "fingerprint")
        worker.start_fingerprint(job.id)
        return job


def _analysis_scope(session: Session, req: AnalyzeRequest) -> list[int]:
    """The scoped track ids, without missing tracks (search compile; no DSP)."""
    ids = _scope_ids(session, req)
    return list(session.exec(
        select(Track.id).where(ids_in(Track.id, ids), Track.missing == False).order_by(Track.id)  # noqa: E712
    ).all())


def _launch_analyze(session: Session, plan: dict, force: bool, limit: int | None) -> Job:
    job = worker.create_job(session, "analyze")
    plan_path = worker.write_analysis_plan(plan)
    try:
        started = worker.start_analyze(job.id, force, limit, plan_path)
    except Exception:
        Path(plan_path).unlink(missing_ok=True)
        raise
    if not started:
        Path(plan_path).unlink(missing_ok=True)
        job.status = "error"
        job.error = "Μια ανάλυση BPM/key εκτελείται ήδη."
        session.add(job)
        session.commit()
        raise HTTPException(409, job.error)
    return job


def _start_scoped_analyze(req: AnalyzeRequest, session: Session):
    # Scoped jobs never call providers, so their credentials are not checked.
    ids = _analysis_scope(session, req)
    if req.dry_run:
        return {"matched": len(ids)}
    if not get_settings().ffmpeg:
        raise HTTPException(400, "Δεν βρέθηκε το ffmpeg. Χρειάζεται για την ανάλυση ήχου.")
    if not ids:
        raise HTTPException(400, "Δεν βρέθηκαν tracks για ανάλυση")
    _require_idle(session)
    plan = {"tempo_range": req.tempo_range, "root_ranges": {}, "track_ids": ids, "scoped": True}
    return _launch_analyze(session, plan, False, None)


@router.post("/analyze")
def start_analyze(req: AnalyzeRequest, session: Session = Depends(get_session)):
    with worker.submission_lock:
        if req.scoped:
            return _start_scoped_analyze(req, session)
        settings = get_settings()
        if not settings.ffmpeg:
            raise HTTPException(400, "Δεν βρέθηκε το ffmpeg. Χρειάζεται για την ανάλυση ήχου.")
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
            raise HTTPException(409, f"Εκτελείται ήδη άλλη εργασία (#{active.id}). Περίμενε να ολοκληρωθεί.")
        plan = {"tempo_range": req.tempo_range, "root_ranges": req.root_ranges,
                "track_ids": None, "scoped": False}
        return _launch_analyze(session, plan, req.force, req.limit)


@router.post("/duplicates")
def start_duplicate_detection(session: Session = Depends(get_session)):
    with worker.submission_lock:
        _require_idle(session)
        job = worker.create_job(session, "duplicate_scan")
        worker.start_duplicates(job.id)
        return job


@router.get("/status")
def scan_status(job_id: int | None = None, session: Session = Depends(get_session)):
    worker.recover_orphan_jobs(session)
    if job_id is not None:
        job = session.get(Job, job_id)
        if job is None:
            raise HTTPException(404, "job not found")
        return job
    active = _active_job(session)
    return active or session.exec(select(Job).order_by(Job.id.desc())).first()
