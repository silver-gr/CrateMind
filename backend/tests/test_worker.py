"""Job worker — scan vs. post-step (artist rebuild) failure semantics."""
from __future__ import annotations

import os

import pytest
from sqlmodel import select

from app.jobs import worker
from app.models import Job, Track
from tests.conftest import make_wav


def test_scan_reports_done_when_artist_rebuild_fails(db, monkeypatch):
    # The scan committed all rows; a failing artist-profile rebuild is a derived
    # post-step and must not flip the scan itself to "error".
    job = worker.create_job(db, "scan")
    monkeypatch.setattr(
        worker.scanner, "scan",
        lambda *a, **k: {"added": 1, "updated": 0, "unchanged": 0, "missing": 0},
    )

    def boom(_session):
        raise RuntimeError("rebuild kaboom")

    monkeypatch.setattr(worker, "rebuild_artist_profiles", boom)

    worker._run_scan(job.id, None)

    db.expire_all()
    refreshed = db.get(Job, job.id)
    assert refreshed.status == "done"
    assert "rebuild failed" in (refreshed.message or "")


def test_scan_reports_error_when_scan_fails(db, monkeypatch):
    job = worker.create_job(db, "scan")

    def boom(*_a, **_k):
        raise RuntimeError("scan kaboom")

    monkeypatch.setattr(worker.scanner, "scan", boom)

    def rebuild_must_not_run(_session):
        raise AssertionError("rebuild should not run when the scan failed")

    monkeypatch.setattr(worker, "rebuild_artist_profiles", rebuild_must_not_run)

    worker._run_scan(job.id, None)

    db.expire_all()
    refreshed = db.get(Job, job.id)
    assert refreshed.status == "error"
    assert "scan kaboom" in (refreshed.error or "")


@pytest.mark.parametrize("mode", ["full", "delta"])
def test_scan_analyzes_only_new_tracks_and_reports_duplicate_skips(db, tmp_path, monkeypatch, mode):
    lib = tmp_path / "lib"
    monkeypatch.setattr(worker.scanner.ffprobe_reader, "read_stream", lambda *_: {"duration": 300.0})
    make_wav(lib / "Alpha - Moon Garden.wav", freq_seed=1)
    worker.scanner.scan(db, [lib], mode=mode)
    make_wav(lib / "Alpha - Moon Garden (Original Mix).wav", freq_seed=2)
    make_wav(lib / "Beta - Desert.wav", freq_seed=3)
    calls = []

    def analyze(session, **kwargs):
        calls.append(kwargs)
        return {"analyzed": len(kwargs["track_ids"]), "failed": 0}

    monkeypatch.setattr(worker, "_analyze_scan_additions", worker._analyze_scan_tracks)
    monkeypatch.setattr(worker.audio_analysis, "analyze_all", analyze)
    job = worker.create_job(db, "scan")
    worker._run_scan(job.id, [str(lib)], mode)
    db.expire_all()
    added = db.exec(select(Track).where(Track.artist == "Beta")).one()
    assert len(calls) == 1
    assert calls[0]["track_ids"] == [added.id]
    assert calls[0]["local_only"] is True
    assert calls[0]["only_unprocessed"] is True
    assert calls[0]["job"].id == job.id
    refreshed = db.get(Job, job.id)
    assert refreshed.status == "done"
    assert "skipped duplicates 1" in refreshed.message
    assert "analyzed 1, analysis failed 0" in refreshed.message

    repeat = worker.create_job(db, "scan")
    worker._run_scan(repeat.id, [str(lib)], mode)
    assert len(calls) == 1


def test_analysis_failure_preserves_scan_success_and_added_rows(db, tmp_path, monkeypatch):
    lib = tmp_path / "lib"
    make_wav(lib / "Alpha - Desert.wav")

    def analysis_failure(*_):
        raise RuntimeError("analysis subprocess unavailable")

    def rebuild_failure(_):
        raise RuntimeError("artist rebuild unavailable")

    monkeypatch.setattr(worker, "_analyze_scan_additions", analysis_failure)
    monkeypatch.setattr(worker, "rebuild_artist_profiles", rebuild_failure)
    job = worker.create_job(db, "scan")
    worker._run_scan(job.id, [str(lib)], "delta")

    db.expire_all()
    refreshed = db.get(Job, job.id)
    assert refreshed.status == "done"
    assert "artist rebuild failed" in refreshed.message
    assert refreshed.message.endswith("(new-track analysis failed)")
    assert "analysis subprocess unavailable" not in refreshed.message  # English detail stays in the log
    assert db.exec(select(Track)).one().title == "Desert"


@pytest.mark.parametrize("crash", [False, True])
def test_scan_analysis_runs_in_spawned_process_and_records_file_failure(db, tmp_path, monkeypatch, crash):
    lib = tmp_path / "lib"
    lib.mkdir()
    (lib / "broken.mp3").write_bytes(b"not audio")
    job = worker.create_job(db, "scan")
    context = worker.mp.get_context("spawn")
    created = []

    class SpawnContext:
        def Pipe(self, **kwargs):
            return context.Pipe(**kwargs)

        def Process(self, **kwargs):
            assert kwargs["daemon"] is True
            created.append(kwargs)
            if crash:
                return context.Process(target=os._exit, args=(1,), daemon=True)
            return context.Process(**kwargs)

    monkeypatch.setattr(worker.mp, "get_context", lambda method: SpawnContext())

    worker._run_scan(job.id, [str(lib)], "delta")

    db.expire_all()
    track = db.exec(select(Track)).one()
    refreshed = db.get(Job, job.id)
    assert refreshed.status == "done"
    if crash:
        assert track.analyzed_at is None
        assert "new-track analysis failed" in refreshed.message
    else:
        assert track.analyzed_at is not None
        assert track.analysis_error
        assert "analysis failed 1" in refreshed.message
    assert len(created) == 1


def test_recovery_marks_all_orphans_but_keeps_live_thread_and_starting_job(db, monkeypatch):
    import threading

    from fastapi import HTTPException

    from app.api.scan import _require_idle

    orphan = Job(kind='scan', status='running')
    db.add(orphan)
    db.commit()
    owned = worker.create_job(db, 'fingerprint')
    gate = threading.Event()
    worker._start_thread(lambda job_id: gate.wait(5), (owned.id,))
    starting = worker.create_job(db, 'duplicate_scan')
    try:
        recovered = worker.recover_orphan_jobs(db)
        assert recovered == 1
        db.refresh(orphan)
        db.refresh(owned)
        assert orphan.status == 'error'
        assert owned.status == 'pending'
        assert starting.status == 'pending'
        with pytest.raises(HTTPException) as error:
            _require_idle(db)
        assert error.value.status_code == 409
    finally:
        gate.set()
        for thread in list(worker._active_threads.values()):
            thread.join(5)


def test_recovery_keeps_live_analysis_process_only(db, monkeypatch):
    from types import SimpleNamespace

    owned, orphan = Job(kind='analyze', status='running'), Job(kind='analyze', status='running')
    db.add_all([owned, orphan])
    db.commit()
    monkeypatch.setattr(worker, '_analysis_process', SimpleNamespace(is_alive=lambda: True))
    monkeypatch.setattr(worker, '_analysis_job_id', owned.id)
    assert worker.recover_orphan_jobs(db) == 1
    db.refresh(owned)
    db.refresh(orphan)
    assert owned.status == 'running'
    assert orphan.status == 'error'


def test_thread_start_failure_is_terminal_and_does_not_keep_reservation(db, monkeypatch):
    job = worker.create_job(db, 'scan')

    def fail_start(self):
        raise RuntimeError('thread cannot start')

    monkeypatch.setattr(worker.threading.Thread, 'start', fail_start)
    with pytest.raises(RuntimeError, match='thread cannot start'):
        worker.start_scan(job.id)
    db.refresh(job)
    assert job.status == 'error'
    assert 'thread cannot start' in job.error
    assert job.id not in worker.active_job_ids()


def test_identity_sync_failure_is_visible_and_catalog_rows_remain_saved(db, tmp_path, monkeypatch):
    from app.services import identity_sync

    lib = tmp_path / 'lib'
    make_wav(lib / 'Alpha - Moon.wav')
    monkeypatch.setattr(identity_sync, 'sync_session', lambda *a, **k: (_ for _ in ()).throw(RuntimeError('identity offline')))
    job = worker.create_job(db, 'scan')
    worker._run_scan(job.id, [str(lib)], 'delta')
    db.expire_all()
    assert db.exec(select(Track)).one().title == 'Moon'
    assert db.get(Job, job.id).status == 'error'
    assert 'identity offline' in db.get(Job, job.id).error


def test_newer_orphan_does_not_hide_older_owned_pending_job(db):
    from fastapi import HTTPException

    from app.api.scan import _require_idle

    owned = worker.create_job(db, 'fingerprint')
    orphan = Job(kind='scan', status='running')
    db.add(orphan)
    db.commit()
    with pytest.raises(HTTPException) as error:
        _require_idle(db)
    assert error.value.status_code == 409
    assert str(owned.id) in error.value.detail
    db.refresh(orphan)
    assert orphan.status == 'error'


@pytest.mark.parametrize('kind', ['thread', 'process'])
def test_worker_construction_failure_is_terminal(db, monkeypatch, kind):
    job = worker.create_job(db, 'analyze' if kind == 'process' else 'scan')

    def fail(*args, **kwargs):
        raise RuntimeError('worker construction failed')

    if kind == 'thread':
        monkeypatch.setattr(worker.threading, 'Thread', fail)
        start = worker.start_scan
    else:
        monkeypatch.setattr(worker.mp, 'get_context', fail)
        start = worker.start_analyze
    with pytest.raises(RuntimeError, match='worker construction failed'):
        start(job.id)
    db.refresh(job)
    assert job.status == 'error'
    assert job.id not in worker.active_job_ids()


def test_status_prefers_persisted_active_job_over_newer_terminal_history(db):
    from app.api.scan import scan_status

    owned = worker.create_job(db, 'scan')
    terminal = Job(kind='fingerprint', status='done')
    db.add(terminal)
    db.commit()
    assert scan_status(session=db).id == owned.id
    assert scan_status(job_id=terminal.id, session=db).id == terminal.id


def test_expired_dispatch_reservation_becomes_recoverable(db, monkeypatch):
    now = worker.time.monotonic()
    monkeypatch.setattr(worker.time, 'monotonic', lambda: now)
    job = worker.create_job(db, 'scan')
    monkeypatch.setattr(worker.time, 'monotonic', lambda: now + worker._START_GRACE_SECONDS + 1)
    assert worker.recover_orphan_jobs(db) == 1
    db.refresh(job)
    assert job.status == 'error'


def test_startup_recovers_orphans_after_backup(db, monkeypatch):
    import asyncio

    from app import app_factory as main
    from app.main import app
    import app.db as database

    job = Job(kind='scan', status='running')
    db.add(job)
    db.commit()
    events = []
    monkeypatch.setattr(database, 'init_db', lambda: events.append('init'))
    monkeypatch.setattr(database, 'backup_on_launch', lambda: events.append('backup'))

    async def startup():
        async with main.lifespan(app):
            events.append('serving')
            db.expire_all()
            assert db.get(Job, job.id).status == 'error'

    asyncio.run(startup())
    assert events == ['init', 'backup', 'serving']


@pytest.mark.parametrize('replacement_has_jobs', [False, True])
def test_thread_finalizer_keeps_the_engine_it_owned_at_start(db, tmp_path, monkeypatch, replacement_has_jobs):
    import threading

    from sqlmodel import Session, create_engine

    owned_engine = db.get_bind()
    replacement = create_engine(f"sqlite:///{tmp_path / 'replacement.sqlite'}")
    job = worker.create_job(db, 'scan')
    if replacement_has_jobs:
        Job.__table__.create(replacement)
        with Session(replacement) as session:
            session.add(Job(id=job.id, kind='scan', status='running'))
            session.commit()
    entered, release = threading.Event(), threading.Event()
    errors = []
    monkeypatch.setattr(threading, 'excepthook', lambda event: errors.append(event.exc_value))

    def target(job_id):
        with Session(owned_engine) as session:
            worker._finish(session, session.get(Job, job_id), 'done')
        entered.set()
        release.wait(5)

    worker._start_thread(target, (job.id,))
    thread = worker._active_threads[(str(owned_engine.url), job.id)]
    try:
        assert entered.wait(5)
        monkeypatch.setattr(worker, 'get_engine', lambda: replacement)
        release.set()
        thread.join(5)
        assert not thread.is_alive()
        assert errors == []
        db.expire_all()
        assert db.get(Job, job.id).status == 'done'
        if replacement_has_jobs:
            with Session(replacement) as session:
                assert session.get(Job, job.id).status == 'running'
    finally:
        release.set()
        thread.join(5)
        replacement.dispose()


@pytest.mark.parametrize('replacement_has_jobs', [False, True])
def test_analysis_monitor_keeps_its_original_catalog_engine(db, tmp_path, monkeypatch, replacement_has_jobs):
    import threading
    from types import SimpleNamespace

    from sqlmodel import Session, create_engine

    replacement = create_engine(f"sqlite:///{tmp_path / 'replacement.sqlite'}")
    job = worker.create_job(db, 'analyze')
    if replacement_has_jobs:
        Job.__table__.create(replacement)
        with Session(replacement) as session:
            session.add(Job(id=job.id, kind='analyze', status='running'))
            session.commit()
    entered, release = threading.Event(), threading.Event()
    errors, monitors = [], []
    real_thread = threading.Thread
    monkeypatch.setattr(threading, 'excepthook', lambda event: errors.append(event.exc_value))

    class Process:
        exitcode = 0
        alive = False

        def start(self):
            self.alive = True

        def is_alive(self):
            return self.alive

        def join(self):
            entered.set()
            release.wait(5)
            self.alive = False

    def thread(*args, **kwargs):
        current = real_thread(*args, **kwargs)
        monitors.append(current)
        return current

    monkeypatch.setattr(worker.mp, 'get_context', lambda method: SimpleNamespace(Process=lambda **kwargs: Process()))
    monkeypatch.setattr(worker.threading, 'Thread', thread)
    try:
        assert worker.start_analyze(job.id)
        assert entered.wait(5)
        assert worker.active_analyze_job_id() == job.id
        job.status = 'done'
        db.add(job)
        db.commit()
        monkeypatch.setattr(worker, 'get_engine', lambda: replacement)
        assert worker.active_analyze_job_id() is None
        release.set()
        monitors[0].join(5)
        assert not monitors[0].is_alive()
        assert errors == []
        assert db.get(Job, job.id).status == 'done'
        if replacement_has_jobs:
            with Session(replacement) as session:
                assert session.get(Job, job.id).status == 'running'
    finally:
        release.set()
        for monitor in monitors:
            monitor.join(5)
        replacement.dispose()


def test_unchanged_delta_does_not_rebuild_artists_or_launch_analysis(db,tmp_path,monkeypatch):
    root = tmp_path/'lib'
    make_wav(root/'Artist - Song.wav')
    worker.scanner.scan(db,[root],mode='delta')
    def forbidden(*args,**kwargs):
        raise AssertionError('unchanged delta post-processing must not run')
    monkeypatch.setattr(worker,'rebuild_artist_profiles',forbidden)
    monkeypatch.setattr(worker,'_analyze_scan_additions',forbidden)
    job = worker.create_job(db,'scan')
    worker._run_scan(job.id,[str(root)],'delta')
    db.expire_all()
    assert db.get(Job,job.id).status == 'done'
    assert 'unchanged 1' in db.get(Job,job.id).message
    assert 'failed' not in db.get(Job,job.id).message
