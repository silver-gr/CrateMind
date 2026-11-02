"""Background job runner — a simple threaded worker over a jobs table.

Deliberately avoids Celery/RQ (overkill for a local single-user tool). Regular
jobs use threads; CPU-heavy audio analysis uses a spawned process.
"""
from __future__ import annotations

import logging
import os
from contextvars import copy_context
import multiprocessing as mp
import multiprocessing.connection as mp_connection
import threading
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Optional

from sqlalchemy.engine import Engine
from sqlmodel import Session, select

from ..config import get_settings
from ..db import get_engine
from ..runtime_profile import RuntimeProfile, get_runtime_profile
from ..services.dataset_access import maintenance_coordinator
from ..models import Job
from ..services import artist_intelligence, duplicate_detector, fingerprint, scanner
from ..services.artist_catalog import rebuild_artist_profiles

logger = logging.getLogger(__name__)
_ANALYSIS_LOCK = threading.Lock()
_analysis_process: mp.Process | None = None
_analysis_job_id: int | None = None
_analysis_engine: Engine | None = None
_analysis_reservation = None
_scan_analysis_process: mp.Process | None = None

# A dispatch lock closes the idle-check -> create -> start race. Ownership is
# local to the API process; uvicorn reload terminates that process and its
# daemon workers. No persisted heartbeat or daemon queue is required.
submission_lock = threading.RLock()
_active_threads: dict[tuple[str, int], threading.Thread] = {}
_starting_jobs: dict[tuple[str, int], float] = {}
_START_GRACE_SECONDS = 30


def _job_key(job_id: int) -> tuple[str, int]:
    return str(get_engine().url), job_id


def create_job(session: Session, kind: str) -> Job:
    with submission_lock:
        job = Job(kind=kind, status="pending")
        session.add(job)
        session.commit()
        session.refresh(job)
        _starting_jobs[_job_key(job.id)] = time.monotonic()
        return job


def active_job_ids() -> set[int]:
    with submission_lock:
        database = str(get_engine().url)
        owned = {job_id for (source, job_id), thread in _active_threads.items()
                 if source == database and thread.is_alive()}
        now = time.monotonic()
        for key, started in list(_starting_jobs.items()):
            if now - started > _START_GRACE_SECONDS:
                _starting_jobs.pop(key, None)
            elif key[0] == database:
                owned.add(key[1])
        analysis = active_analyze_job_id()
        if analysis is not None:
            owned.add(analysis)
        return owned


def recover_orphan_jobs(session: Session) -> int:
    """Make interrupted jobs terminal without invalidating owned live work."""
    with submission_lock:
        owned = active_job_ids()
        jobs = session.exec(select(Job).where(Job.status.in_(("pending", "running")))).all()
        recovered = 0
        for job in jobs:
            if job.id in owned:
                continue
            job.status = "error"
            job.error = "Η εργασία διακόπηκε. Δοκίμασε ξανά· όσα αποθηκεύτηκαν διατηρούνται."
            job.updated_at = datetime.now(UTC)
            session.add(job)
            recovered += 1
        if recovered:
            session.commit()
        return recovered


def _worker_failed(job_id: int, error: str, *, engine: Engine) -> None:
    with Session(engine) as session:
        job = session.get(Job, job_id)
        if job is not None and job.status in {"pending", "running"}:
            _finish(session, job, "error", error=error)


def _start_thread(target, args: tuple) -> None:
    job_id = args[0]
    engine = get_engine()
    key = str(engine.url), job_id

    reservation = maintenance_coordinator.start_operation(f"job:{job_id}")
    context = copy_context()

    def run():
        try:
            target(*args)
        except Exception as exc:
            logger.exception("background_job_failed job_id=%s", job_id)
            _worker_failed(job_id, str(exc), engine=engine)
        finally:
            # Unexpected returns must also be terminal. Unregister only after
            # recording completion so a concurrent idle check sees owned work.
            try:
                _worker_failed(job_id, "Η εργασία σταμάτησε πριν ολοκληρωθεί. Δοκίμασε ξανά.", engine=engine)
            finally:
                with submission_lock:
                    _active_threads.pop(key, None)

    def run_reserved():
        with reservation:
            run()

    with submission_lock:
        _starting_jobs.pop(key, None)
        try:
            thread = threading.Thread(target=lambda: context.run(run_reserved), daemon=True)
            _active_threads[key] = thread
            thread.start()
        except Exception as exc:
            reservation.close()
            _active_threads.pop(key, None)
            _worker_failed(job_id, str(exc), engine=engine)
            raise


def _finish(session: Session, job: Job, status: str, message: str = "", error: str = "") -> None:
    job.status = status
    job.message = message or None
    job.error = error or None
    job.updated_at = datetime.now(UTC)
    session.add(job)
    session.commit()


def _lower_priority() -> None:
    """Best effort: keep deck playback ahead of DSP; ffmpeg children inherit it."""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.SetPriorityClass.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        kernel32.SetPriorityClass.restype = wintypes.BOOL
        below_normal_priority_class = 0x00004000
        if not kernel32.SetPriorityClass(kernel32.GetCurrentProcess(), below_normal_priority_class):
            logger.warning("analysis_priority_unchanged error=%s", ctypes.get_last_error())
        return
    try:
        os.nice(10)
    except OSError as exc:
        logger.warning("analysis_priority_unchanged error=%s", exc)


def _exit_with_parent(parent) -> None:
    parent.join()
    # The parent owns the dataset lease; never keep writing after it is gone.
    os._exit(1)


def _child_setup() -> None:
    """Prepare a spawned analysis child. A no-op in the API process itself."""
    parent = mp.parent_process()
    if parent is None:
        return
    # POSIX spawn children inherit fd 1, the desktop backend's framed stdout
    # protocol pipe; send any stray child output to stderr instead.
    try:
        os.dup2(2, 1)
    except OSError as exc:  # an invalid fd 2 (Windows) must not kill the child
        logger.warning("analysis_child_stdout_unchanged error=%s", exc)
    threading.Thread(target=_exit_with_parent, args=(parent,), daemon=True,
                     name="analysis-parent").start()
    if get_runtime_profile() is RuntimeProfile.DESKTOP_CORE:
        _lower_priority()


def _analyze_scan_tracks(job_id: int, track_ids: list[int]) -> dict:
    """Run local detection in a spawned process, with its own database session."""
    from ..services import audio_analysis
    logger.info("scan_analysis_child stage=audio-import-done job_id=%s", job_id)
    with Session(get_engine()) as session:
        job = session.get(Job, job_id)
        logger.info("scan_analysis_child stage=engine-ready job_id=%s", job_id)
        result = audio_analysis.analyze_all(
            session, track_ids=track_ids, local_only=True, only_unprocessed=True, job=job,
        )
    logger.info("scan_analysis_child stage=analysis-done job_id=%s", job_id)
    return result


def _send_scan_analysis(connection, job_id: int, track_ids: list[int]) -> None:
    logger.info("scan_analysis_child stage=target-start job_id=%s tracks=%s", job_id, len(track_ids))
    _child_setup()
    logger.info("scan_analysis_child stage=setup-done job_id=%s", job_id)
    try:
        result = _analyze_scan_tracks(job_id, track_ids)
        logger.info("scan_analysis_child stage=sending job_id=%s", job_id)
        connection.send({"result": result})
    except Exception as exc:
        logger.exception("scan_analysis_process_failed job_id=%s", job_id)
        connection.send({"error": str(exc)})
    finally:
        connection.close()


def _child_exited(process) -> RuntimeError:
    process.join(timeout=1)
    logger.error("scan_analysis_child_exited pid=%s exit_code=%s", process.pid, process.exitcode)
    return RuntimeError(f"analysis process exited (exit code {process.exitcode}) before returning results")


def _recv_from_child(receiver, process):
    try:
        return receiver.recv()
    except (EOFError, OSError) as exc:  # Windows reports a broken pipe as OSError
        raise _child_exited(process) from exc


def _receive_from_child(receiver, process, timeout: float | None = None):
    """Return the child's one message, or fail once the child has exited.

    Never block on the pipe alone: on Windows, pickling the sender for a spawned
    child duplicates its write handle into this process until the child
    unpickles it, so a child that dies or stalls before then never yields EOF.
    """
    deadline = None if timeout is None else time.monotonic() + timeout
    while True:
        wait_for = 5.0
        if deadline is not None:
            wait_for = min(wait_for, deadline - time.monotonic())
            if wait_for <= 0:
                raise TimeoutError(f"analysis process {process.pid} sent nothing within {timeout} s")
        ready = mp_connection.wait([receiver, process.sentinel], timeout=wait_for)
        if receiver in ready:
            return _recv_from_child(receiver, process)
        if process.sentinel in ready:
            try:
                pending = receiver.poll()  # the message may have raced the exit
            except (EOFError, OSError):
                pending = False
            if pending:
                return _recv_from_child(receiver, process)
            raise _child_exited(process)


def _analyze_scan_additions(job_id: int, track_ids: list[int]) -> dict:
    global _scan_analysis_process

    context = mp.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(
        target=_send_scan_analysis, args=(sender, job_id, track_ids), daemon=True,
    )
    try:
        with _ANALYSIS_LOCK:
            process.start()
            _scan_analysis_process = process
        sender.close()
        # stop_analysis_processes() terminates the child, which fires its sentinel.
        response = _receive_from_child(receiver, process)
        if "error" in response:
            raise RuntimeError(response["error"])
        return response["result"]
    finally:
        receiver.close()
        sender.close()
        if process.pid is not None:
            process.join(timeout=1)
            if process.is_alive():
                process.terminate()
            process.join()
        with _ANALYSIS_LOCK:
            if _scan_analysis_process is process:
                _scan_analysis_process = None


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
            session.rollback()
            _finish(session, job, "error", error=str(exc))
            return

        # The scan is done and fully committed. Rebuilding artist profiles is a
        # derived post-step; if it fails, the scan itself still succeeded, so
        # report done (with a note) rather than flipping the scan to error.
        msg = (f"added {stats['added']}, updated {stats['updated']}, "
               f"unchanged {stats['unchanged']}, missing {stats['missing']}, "
               f"skipped duplicates {stats.get('skipped_duplicates', 0)}")
        if stats.get("warnings"):
            msg += "; " + "; ".join(stats["warnings"])
        try:
            if mode == "full" or stats["added"] or stats["updated"] or stats["missing"]:
                rebuild_artist_profiles(session)
        except Exception as exc:  # noqa: BLE001
            session.rollback()  # discard the partial rebuild; scan already committed
            msg += f" (artist rebuild failed: {exc})"

        added_ids = stats.get("added_track_ids", [])
        if added_ids:
            try:
                job.message = f"analyzing {len(added_ids)} new tracks"
                job.total = len(added_ids)
                job.processed = 0
                session.add(job)
                session.commit()
                # Keep the scan active through detection so other jobs cannot
                # overlap it. DSP stays outside the API server process.
                result = _analyze_scan_additions(job_id, added_ids)
                msg += f", analyzed {result['analyzed']}, analysis failed {result['failed']}"
            except Exception:  # imported tracks remain committed
                session.rollback()
                # The detail stays in the log; the job message is shown in the UI.
                logger.exception("scan_analysis_failed job_id=%s", job_id)
                msg += " (new-track analysis failed)"
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
    logger.info("analysis_child stage=target-start job_id=%s", job_id)
    _child_setup()
    from ..services import audio_analysis
    logger.info("analysis_child stage=audio-import-done job_id=%s", job_id)
    # Desktop never contacts providers; its environment disables them too.
    local_only = get_runtime_profile() is RuntimeProfile.DESKTOP_CORE
    with Session(get_engine()) as session:
        job = session.get(Job, job_id)
        if job is None:
            return
        job.status = "running"
        session.add(job)
        session.commit()
        try:
            result = audio_analysis.analyze_all(session, force=force, limit=limit, job=job,
                                                only_unprocessed=not force, local_only=local_only)
            if local_only:
                _finish(session, job, "done", f"analyzed {result['analyzed']}, failed {result['failed']}")
                return
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


def _run_artist_enrich(job_id: int, limit: Optional[int], force: bool = False, comparison: bool = False) -> None:
    with Session(get_engine()) as session:
        job = session.get(Job, job_id)
        if job is None:
            return
        job.status = "running"
        session.add(job)
        session.commit()
        try:
            result = artist_intelligence.enrich_artist_profiles(
                session, limit=limit, force=force, job=job, comparison=comparison
            )
            _finish(
                session,
                job,
                "error" if result["failed"] else "done",
                f"Ευρήματα έτοιμα για έλεγχο: {result['updated']} · αποτυχίες: {result['failed']}",
                error=f"Η έρευνα ολοκληρώθηκε με {result['failed']} αποτυχίες και {result['updated']} αποθηκευμένα ευρήματα." if result["failed"] else None,
            )
        except Exception as exc:  # noqa: BLE001
            _finish(session, job, "error", error=str(exc))


def _run_djay_import(job_id: int) -> None:
    from ..services import audit, djay_import
    with Session(get_engine()) as session:
        job = session.get(Job, job_id)
        if job is None:
            return
        job.status = "running"
        session.add(job)
        session.commit()
        try:
            report = djay_import.run_import(session, job)
            audit.log(session, "djay_import", "djay", None, after=report)
            _finish(session, job, "done",
                    f"matched {report['matched']}, added {report['added']}, "
                    f"updated {report['updated']}, unchanged {report['unchanged']}")
        except djay_import.DjayImportError as exc:
            session.rollback()
            _finish(session, job, "error", error=str(exc))
        except Exception as exc:  # noqa: BLE001
            logger.exception("djay_import_failed job_id=%s", job_id)
            session.rollback()
            _finish(session, job, "error", error=str(exc))


def start_scan(job_id: int, roots: Optional[list[str]] = None, mode: str = "full") -> None:
    _start_thread(_run_scan, (job_id, roots, mode))


def start_fingerprint(job_id: int) -> None:
    _start_thread(_run_fingerprint, (job_id,))


def active_analyze_job_id() -> int | None:
    with _ANALYSIS_LOCK:
        if (_analysis_process is not None and _analysis_process.is_alive()
                and (_analysis_engine is None or str(_analysis_engine.url) == str(get_engine().url))):
            return _analysis_job_id
        return None


def _monitor_analyze_process(process: mp.Process, job_id: int, engine: Engine, reservation=None) -> None:
    global _analysis_process, _analysis_job_id, _analysis_engine

    process.join()
    exit_code = process.exitcode
    with _ANALYSIS_LOCK:
        if _analysis_process is process:
            _analysis_process = None
            _analysis_job_id = None
            _analysis_engine = None
    if exit_code:
        logger.error("analysis_worker_exited job_id=%s exit_code=%s", job_id, exit_code)
    try:
        _worker_failed(job_id, f"Η ανάλυση BPM/key σταμάτησε πριν ολοκληρωθεί (κωδικός {exit_code}). Όσα αποθηκεύτηκαν διατηρούνται· συνέχισε με «BPM + Key · Μόνο νέα».", engine=engine)
    finally:
        if reservation is not None:
            reservation.close()


def start_analyze(job_id: int, force: bool = False, limit: Optional[int] = None) -> bool:
    global _analysis_process, _analysis_job_id, _analysis_engine, _analysis_reservation

    engine = get_engine()
    key = str(engine.url), job_id
    with submission_lock:
        with _ANALYSIS_LOCK:
            if _analysis_process is not None and _analysis_process.is_alive():
                _starting_jobs.pop(key, None)
                return False
            reservation = maintenance_coordinator.start_operation(f"analysis:{job_id}")
            try:
                process = mp.get_context("spawn").Process(
                    target=_run_analyze,
                    args=(job_id, force, limit),
                    daemon=True,
                )
                process.start()
            except Exception as exc:
                reservation.close()
                _starting_jobs.pop(key, None)
                _worker_failed(job_id, str(exc), engine=engine)
                raise
            _analysis_process = process
            _analysis_job_id = job_id
            _analysis_engine = engine
            _analysis_reservation = reservation
        _starting_jobs.pop(key, None)

        # Process ownership remains visible even if a monitor cannot start;
        # later status/idle checks reconcile a process that has exited.
        try:
            threading.Thread(
                target=_monitor_analyze_process, args=(process, job_id, engine, reservation), daemon=True,
            ).start()
        except RuntimeError:
            logger.exception("analysis_monitor_start_failed job_id=%s", job_id)
            # No unmonitored writer may escape maintenance accounting.
            process.terminate()
            process.join()
            _monitor_analyze_process(process, job_id, engine, reservation)
            return False
        return True


def stop_analysis_processes(timeout: float) -> None:
    """Terminate both analysis children, waiting up to `timeout` seconds in
    total, so none outlives the dataset lease. Idempotent."""
    with _ANALYSIS_LOCK:
        processes = [process for process in (_analysis_process, _scan_analysis_process)
                     if process is not None]
    deadline = time.monotonic() + timeout
    for process in processes:
        if process.is_alive():
            process.terminate()
    for process in processes:
        process.join(max(0.0, deadline - time.monotonic()))
    # The monitor/scan thread records the end of the job and only then closes
    # its reservation; let it, so shutdown can release the lease cleanly.
    while processes and maintenance_coordinator.active_operations and time.monotonic() < deadline:
        time.sleep(0.02)


def start_djay_import(job_id: int) -> None:
    _start_thread(_run_djay_import, (job_id,))


def start_duplicates(job_id: int) -> None:
    _start_thread(_run_duplicates, (job_id,))


def start_artist_enrich(job_id: int, limit: Optional[int] = None, force: bool = False, comparison: bool = False) -> None:
    _start_thread(_run_artist_enrich, (job_id, limit, force, comparison))


def __getattr__(name: str):
    # Preserve the web test/extension hook without eagerly importing DSP.
    if name == "audio_analysis":
        from ..services import audio_analysis
        return audio_analysis
    raise AttributeError(name)
