"""Background job runner — a simple threaded worker over a jobs table.

Deliberately avoids Celery/RQ (overkill for a local single-user tool). Each job
gets its own DB Session on its own thread.
"""
from __future__ import annotations

import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Optional

from sqlmodel import Session

from ..config import get_settings
from ..db import get_engine
from ..models import Job
from ..services import artist_intelligence, audio_analysis, duplicate_detector, fingerprint, scanner
from ..services.artist_catalog import rebuild_artist_profiles


def create_job(session: Session, kind: str) -> Job:
    job = Job(kind=kind, status="pending")
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


def _finish(session: Session, job: Job, status: str, message: str = "", error: str = "") -> None:
    job.status = status
    job.message = message or None
    job.error = error or None
    job.updated_at = datetime.now(UTC)
    session.add(job)
    session.commit()


def _run_scan(job_id: int, roots: Optional[list[str]]) -> None:
    settings = get_settings()
    with Session(get_engine()) as session:
        job = session.get(Job, job_id)
        if job is None:
            return
        job.status = "running"
        session.add(job)
        session.commit()
        try:
            root_paths = [Path(r) for r in roots] if roots else settings.roots
            stats = scanner.scan(session, root_paths, settings.ffprobe, job)
        except Exception as exc:  # noqa: BLE001 - surface scan failure to the job row
            _finish(session, job, "error", error=str(exc))
            return

        # The scan is done and fully committed. Rebuilding artist profiles is a
        # derived post-step; if it fails, the scan itself still succeeded, so
        # report done (with a note) rather than flipping the scan to error.
        msg = (f"added {stats['added']}, updated {stats['updated']}, "
               f"unchanged {stats['unchanged']}, missing {stats['missing']}")
        try:
            rebuild_artist_profiles(session)
        except Exception as exc:  # noqa: BLE001
            session.rollback()  # discard the partial rebuild; scan already committed
            _finish(session, job, "done", f"{msg} (artist rebuild failed: {exc})")
            return
        _finish(session, job, "done", msg)


def _run_fingerprint(job_id: int) -> None:
    settings = get_settings()
    with Session(get_engine()) as session:
        job = session.get(Job, job_id)
        if job is None:
            return
        job.status = "running"
        session.add(job)
        session.commit()
        try:
            n = fingerprint.fingerprint_all(session, settings.fpcalc)
            _finish(session, job, "done", f"fingerprinted {n}")
        except Exception as exc:  # noqa: BLE001
            _finish(session, job, "error", error=str(exc))


def _run_analyze(job_id: int, force: bool, limit: Optional[int]) -> None:
    with Session(get_engine()) as session:
        job = session.get(Job, job_id)
        if job is None:
            return
        job.status = "running"
        session.add(job)
        session.commit()
        try:
            result = audio_analysis.analyze_all(session, force=force, limit=limit, job=job)
            _finish(session, job, "done",
                    f"analyzed {result['analyzed']}, failed {result['failed']}")
        except Exception as exc:  # noqa: BLE001
            _finish(session, job, "error", error=str(exc))


def _run_duplicates(job_id: int) -> None:
    with Session(get_engine()) as session:
        job = session.get(Job, job_id)
        if job is None:
            return
        job.status = "running"
        session.add(job)
        session.commit()
        try:
            result = duplicate_detector.detect(session)
            _finish(session, job, "done", f"groups {result['groups_created']}")
        except Exception as exc:  # noqa: BLE001
            _finish(session, job, "error", error=str(exc))


def _run_artist_enrich(job_id: int, limit: Optional[int]) -> None:
    with Session(get_engine()) as session:
        job = session.get(Job, job_id)
        if job is None:
            return
        job.status = "running"
        session.add(job)
        session.commit()
        try:
            result = artist_intelligence.enrich_artist_profiles(session, limit=limit, job=job)
            _finish(
                session,
                job,
                "done",
                f"enriched {result['updated']}, failed {result['failed']}",
            )
        except Exception as exc:  # noqa: BLE001
            _finish(session, job, "error", error=str(exc))


def start_scan(job_id: int, roots: Optional[list[str]] = None) -> None:
    threading.Thread(target=_run_scan, args=(job_id, roots), daemon=True).start()


def start_fingerprint(job_id: int) -> None:
    threading.Thread(target=_run_fingerprint, args=(job_id,), daemon=True).start()


def start_analyze(job_id: int, force: bool = False, limit: Optional[int] = None) -> None:
    threading.Thread(target=_run_analyze, args=(job_id, force, limit), daemon=True).start()


def start_duplicates(job_id: int) -> None:
    threading.Thread(target=_run_duplicates, args=(job_id,), daemon=True).start()


def start_artist_enrich(job_id: int, limit: Optional[int] = None) -> None:
    threading.Thread(target=_run_artist_enrich, args=(job_id, limit), daemon=True).start()
