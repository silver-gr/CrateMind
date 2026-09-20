"""Background job runner — a simple threaded worker over a jobs table.

Deliberately avoids Celery/RQ (overkill for a local single-user tool). Regular
jobs use threads; CPU-heavy audio analysis uses a spawned process.
"""
from __future__ import annotations

import logging
import multiprocessing as mp
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

logger = logging.getLogger(__name__)
_ANALYSIS_LOCK = threading.Lock()
_analysis_process: mp.Process | None = None
_analysis_job_id: int | None = None


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


def _run_scan(job_id: int, roots: Optional[list[str]], mode: str = "full") -> None:
    settings = get_settings()
    with Session(get_engine()) as session:
        job = session.get(Job, job_id)
        if job is None:
            return
        job.status = "running"
        job.message = "checking file changes" if mode == "delta" else "scanning library"
        session.add(job)
        session.commit()
        try:
            root_paths = [Path(r) for r in roots] if roots else settings.roots
            stats = scanner.scan(session, root_paths, settings.ffprobe, job, mode=mode)
        except Exception as exc:  # noqa: BLE001 - surface scan failure to the job row
            _finish(session, job, "error", error=str(exc))
            return

        # The scan is done and fully committed. Rebuilding artist profiles is a
        # derived post-step; if it fails, the scan itself still succeeded, so
        # report done (with a note) rather than flipping the scan to error.
        msg = (f"added {stats['added']}, updated {stats['updated']}, "
               f"unchanged {stats['unchanged']}, missing {stats['missing']}")
        if stats.get("warnings"):
            msg += "; " + "; ".join(stats["warnings"])
        try:
            if mode == "full" or stats["added"] or stats["updated"] or stats["missing"]:
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
            logger.exception("fingerprint_job_failed job_id=%s", job_id)
            session.rollback()
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
            result = audio_analysis.analyze_all(session, force=force, limit=limit, job=job, only_unprocessed=not force)
            _finish(
                session,
                job,
                "done",
                (
                    f"analyzed {result['analyzed']}, failed {result['failed']}, "
                    f"essentia {result['validated']}, "
                    f"validation failed {result['validation_failed']}, "
                    f"disagreements {result['disagreements']}, "
                    f"reccobeats {result['reccobeats_analyzed']}, "
                    f"reccobeats failed {result['reccobeats_failed']}, "
                    f"getsongbpm {result['getsongbpm_matched']}, "
                    f"getsongbpm failed {result['getsongbpm_failed']}, "
                    f"consensus {result['consensus']}, "
                    f"review {result['needs_review']}, "
                    f"cyanite submitted {result['cyanite_submitted']}, "
                    f"cyanite finished {result['cyanite_finished']}, "
                    f"cyanite failed {result['cyanite_failed']}, "
                    f"cyanite skipped {result['cyanite_skipped']}"
                ),
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("analysis_job_failed job_id=%s", job_id)
            session.rollback()
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


def _run_artist_enrich(job_id: int, limit: Optional[int], force: bool = False) -> None:
    with Session(get_engine()) as session:
        job = session.get(Job, job_id)
        if job is None:
            return
        job.status = "running"
        session.add(job)
        session.commit()
        try:
            result = artist_intelligence.enrich_artist_profiles(
                session, limit=limit, force=force, job=job
            )
            _finish(
                session,
                job,
                "done",
                f"enriched {result['updated']}, failed {result['failed']}",
            )
        except Exception as exc:  # noqa: BLE001
            _finish(session, job, "error", error=str(exc))


def start_scan(job_id: int, roots: Optional[list[str]] = None, mode: str = "full") -> None:
    threading.Thread(target=_run_scan, args=(job_id, roots, mode), daemon=True).start()


def start_fingerprint(job_id: int) -> None:
    threading.Thread(target=_run_fingerprint, args=(job_id,), daemon=True).start()


def active_analyze_job_id() -> int | None:
    with _ANALYSIS_LOCK:
        if _analysis_process is not None and _analysis_process.is_alive():
            return _analysis_job_id
        return None


def _monitor_analyze_process(process: mp.Process, job_id: int) -> None:
    global _analysis_process, _analysis_job_id

    process.join()
    exit_code = process.exitcode
    with _ANALYSIS_LOCK:
        if _analysis_process is process:
            _analysis_process = None
            _analysis_job_id = None
    if exit_code == 0:
        return

    logger.error("analysis_worker_exited job_id=%s exit_code=%s", job_id, exit_code)
    with Session(get_engine()) as session:
        job = session.get(Job, job_id)
        if job is None or job.status not in {"pending", "running"}:
            return
        job.status = "error"
        job.error = f"analysis worker exited with code {exit_code}"
        job.updated_at = datetime.now(UTC)
        session.add(job)
        session.commit()


def start_analyze(job_id: int, force: bool = False, limit: Optional[int] = None) -> bool:
    global _analysis_process, _analysis_job_id

    with _ANALYSIS_LOCK:
        if _analysis_process is not None and _analysis_process.is_alive():
            return False
        process = mp.get_context("spawn").Process(
            target=_run_analyze,
            args=(job_id, force, limit),
            daemon=True,
        )
        process.start()
        _analysis_process = process
        _analysis_job_id = job_id

    threading.Thread(
        target=_monitor_analyze_process,
        args=(process, job_id),
        daemon=True,
    ).start()
    return True


def start_duplicates(job_id: int) -> None:
    threading.Thread(target=_run_duplicates, args=(job_id,), daemon=True).start()


def start_artist_enrich(job_id: int, limit: Optional[int] = None, force: bool = False) -> None:
    threading.Thread(target=_run_artist_enrich, args=(job_id, limit, force), daemon=True).start()
