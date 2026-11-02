"""Desktop BPM/key analysis: local only, in a spawned child that never outlives the backend."""
from __future__ import annotations

import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

import app.config as cfg
from app.runtime_profile import RuntimeProfile, runtime_profile

BACKEND = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def fresh_settings():
    yield
    cfg.get_settings.cache_clear()  # after monkeypatch restores the environment


def test_desktop_analyze_route_starts_a_job(db, monkeypatch):
    from app.app_factory import create_app
    from app.jobs import worker
    monkeypatch.setenv("CRATEMIND_FFMPEG_PATH", "/opt/cratemind/ffmpeg")
    cfg.get_settings.cache_clear()
    started = []
    monkeypatch.setattr(worker, "start_analyze",
                        lambda job_id, force=False, limit=None: started.append((job_id, force, limit)) or True)
    with TestClient(create_app(RuntimeProfile.DESKTOP_CORE)) as client:
        response = client.post("/api/scan/analyze", json={"force": True})
        assert response.status_code == 200, response.text
        job = response.json()
        assert job["kind"] == "analyze"
        assert started == [(job["id"], True, None)]
        caps = client.get("/api/capabilities").json()
        assert caps["analysis"] is True and caps["provider_workflows"] is False


def test_desktop_analyze_route_reports_missing_ffmpeg_in_greek(db, monkeypatch):
    from app.app_factory import create_app
    monkeypatch.setattr(cfg.shutil, "which", lambda name: None)
    cfg.get_settings.cache_clear()
    with TestClient(create_app(RuntimeProfile.DESKTOP_CORE)) as client:
        response = client.post("/api/scan/analyze", json={})
        assert response.status_code == 400
        assert response.json()["detail"] == "Δεν βρέθηκε το ffmpeg. Χρειάζεται για την ανάλυση ήχου."



def test_desktop_analyze_route_reports_busy_in_greek(db, monkeypatch):
    from app.app_factory import create_app
    from app.jobs import worker
    monkeypatch.setenv("CRATEMIND_FFMPEG_PATH", "/opt/cratemind/ffmpeg")
    cfg.get_settings.cache_clear()
    monkeypatch.setattr(worker, "start_analyze", lambda job_id, force=False, limit=None: False)
    with TestClient(create_app(RuntimeProfile.DESKTOP_CORE)) as client:
        response = client.post("/api/scan/analyze", json={})
        assert response.status_code == 409
        assert response.json()["detail"] == "Μια ανάλυση BPM/key εκτελείται ήδη."
        active = worker.create_job(db, "scan")  # another job is active
        response = client.post("/api/scan/analyze", json={})
        assert response.status_code == 409
        assert response.json()["detail"] == f"Εκτελείται ήδη άλλη εργασία (#{active.id}). Περίμενε να ολοκληρωθεί."

def test_desktop_scan_analyzes_added_tracks(db, monkeypatch):
    from app.jobs import worker
    from app.models import Job
    monkeypatch.setattr(worker.scanner, "scan", lambda *a, **k: {
        "added": 1, "updated": 0, "missing": 0, "unchanged": 0, "added_track_ids": [42],
    })
    monkeypatch.setattr(worker, "rebuild_artist_profiles", lambda _s: None)
    calls = []

    def analyze(job_id, track_ids):
        calls.append((job_id, track_ids))
        return {"analyzed": 1, "failed": 0}

    monkeypatch.setattr(worker, "_analyze_scan_additions", analyze)
    job = worker.create_job(db, "scan")
    with runtime_profile(RuntimeProfile.DESKTOP_CORE):
        worker._run_scan(job.id, None)
    db.expire_all()
    finished = db.get(Job, job.id)
    assert calls == [(job.id, [42])]
    assert finished.status == "done"
    assert finished.message.endswith(", analyzed 1, analysis failed 0")


def test_desktop_run_analyze_is_local_only(db, monkeypatch):
    from app.jobs import worker
    from app.models import Job
    from app.services import audio_analysis
    received = {}

    def analyze_all(session, **kwargs):
        received.update(kwargs)
        return {"analyzed": 3, "failed": 1}

    monkeypatch.setattr(audio_analysis, "analyze_all", analyze_all)
    job = worker.create_job(db, "analyze")
    with runtime_profile(RuntimeProfile.DESKTOP_CORE):
        worker._run_analyze(job.id, False, None)
    db.expire_all()
    finished = db.get(Job, job.id)
    assert received["local_only"] is True and received["only_unprocessed"] is True
    assert finished.status == "done"
    assert finished.message == "analyzed 3, failed 1"


def test_web_run_analyze_keeps_providers(db, monkeypatch):
    from app.jobs import worker
    from app.services import audio_analysis
    received = {}

    def analyze_all(session, **kwargs):
        received.update(kwargs)
        raise RuntimeError("stop after recording arguments")

    monkeypatch.setattr(audio_analysis, "analyze_all", analyze_all)
    job = worker.create_job(db, "analyze")
    with runtime_profile(RuntimeProfile.WEB):
        worker._run_analyze(job.id, True, None)
    assert received["local_only"] is False


class FakeProcess:
    def __init__(self, alive: bool):
        self.alive = alive
        self.terminated = 0
        self.joins: list[float | None] = []

    def is_alive(self):
        return self.alive

    def terminate(self):
        self.terminated += 1
        self.alive = False

    def join(self, timeout=None):
        self.joins.append(timeout)


def test_stop_analysis_processes_terminates_tracked_children(monkeypatch):
    from app.jobs import worker
    manual, post_scan = FakeProcess(alive=True), FakeProcess(alive=True)
    monkeypatch.setattr(worker, "_analysis_process", manual)
    monkeypatch.setattr(worker, "_scan_analysis_process", post_scan)
    worker.stop_analysis_processes(2)
    assert manual.terminated == 1 and post_scan.terminated == 1
    assert manual.joins and post_scan.joins
    assert all(0 <= timeout <= 2 for timeout in manual.joins + post_scan.joins)
    worker.stop_analysis_processes(2)  # idempotent: exited children are not terminated again
    assert manual.terminated == 1 and post_scan.terminated == 1



def test_analysis_child_crash_records_greek_error(db):
    from app.jobs import worker
    from app.models import Job
    job = worker.create_job(db, "analyze")
    job.status = "running"
    db.add(job)
    db.commit()
    crashed = FakeProcess(alive=False)
    crashed.exitcode = -11
    worker._monitor_analyze_process(crashed, job.id, worker.get_engine())
    db.expire_all()
    refreshed = db.get(Job, job.id)
    assert refreshed.status == "error"
    assert refreshed.error == "Η ανάλυση BPM/key σταμάτησε πριν ολοκληρωθεί (κωδικός -11). Όσα αποθηκεύτηκαν διατηρούνται· συνέχισε με «BPM + Key · Μόνο νέα»."


def test_stop_analysis_processes_waits_for_the_job_to_release_its_reservation(monkeypatch):
    import threading

    from app.jobs import worker
    from app.services.dataset_access import maintenance_coordinator
    monkeypatch.setattr(worker, "_analysis_process", FakeProcess(alive=True))
    monkeypatch.setattr(worker, "_scan_analysis_process", None)
    reservation = maintenance_coordinator.start_operation("analysis:1")
    threading.Timer(0.2, reservation.close).start()  # the monitor thread finishing the job
    worker.stop_analysis_processes(2)
    assert maintenance_coordinator.active_operations == ()

def test_stop_analysis_processes_without_children(monkeypatch):
    from app.jobs import worker
    monkeypatch.setattr(worker, "_analysis_process", None)
    monkeypatch.setattr(worker, "_scan_analysis_process", None)
    worker.stop_analysis_processes(2)


def test_child_setup_is_a_noop_in_the_main_process(monkeypatch):
    import multiprocessing

    from app.jobs import worker
    assert multiprocessing.parent_process() is None

    def forbidden(*_args):
        raise AssertionError("child setup ran in the main process")

    # Replace the module reference only: pytest itself dup2()s during capture.
    monkeypatch.setattr(worker, "os", SimpleNamespace(dup2=forbidden, nice=forbidden, _exit=forbidden))
    monkeypatch.setattr(worker, "_lower_priority", forbidden)
    monkeypatch.setattr(worker, "_exit_with_parent", forbidden)
    with runtime_profile(RuntimeProfile.DESKTOP_CORE):
        worker._child_setup()


def _run_spawn_probe(tmp_path: Path, body: str, timeout: float = 60) -> subprocess.CompletedProcess:
    (tmp_path / "spawnprobe.py").write_text(textwrap.dedent(body))
    script = textwrap.dedent("""
        import multiprocessing, sys
        import spawnprobe
        if __name__ == "__main__":
            spawnprobe.main(multiprocessing.get_context("spawn"))
    """)
    env = {k: v for k, v in os.environ.items() if not k.startswith("CRATEMIND_")}
    env.update(PYTHONPATH=os.pathsep.join([str(tmp_path), str(BACKEND)]),
               NO_CRATEMIND_ENV_FILE="1", CRATEMIND_RUNTIME_PROFILE="desktop-core",
               CRATEMIND_DB_PATH=str(tmp_path / "catalog.sqlite"),
               CRATEMIND_BACKUP_DIR=str(tmp_path / "backups"),
               CRATEMIND_OUTPUT_DIR=str(tmp_path / "out"))
    return subprocess.run([sys.executable, "-c", script], check=False, env=env, cwd=tmp_path,
                          capture_output=True, text=True, timeout=timeout)


def test_spawned_child_keeps_stdout_protocol_clean(tmp_path):
    result = _run_spawn_probe(tmp_path, """
        import sys

        def child():
            from app.jobs.worker import _child_setup
            _child_setup()
            print("child-output", flush=True)

        def main(context):
            process = context.Process(target=child)
            process.start()
            process.join(60)
            sys.exit(process.exitcode)
    """)
    assert result.returncode == 0, result.stderr
    assert "child-output" not in result.stdout
    assert "child-output" in result.stderr


@pytest.mark.skipif(os.name == "nt", reason="signal 0 liveness probe is POSIX only")
def test_spawned_child_exits_when_parent_dies(tmp_path):
    marker = tmp_path / "child.pid"
    result = _run_spawn_probe(tmp_path, f"""
        import os, time
        from pathlib import Path

        def child():
            from app.jobs.worker import _child_setup
            _child_setup()
            Path({str(marker)!r}).write_text(str(os.getpid()))
            time.sleep(60)

        def main(context):
            process = context.Process(target=child)
            process.start()
            deadline = time.monotonic() + 30
            while not Path({str(marker)!r}).exists() and time.monotonic() < deadline:
                time.sleep(.05)
            os._exit(0)  # the parent dies without stopping its child
    """)
    assert result.returncode == 0, result.stderr
    pid = int(marker.read_text())
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return
        time.sleep(.1)
    os.kill(pid, 9)
    pytest.fail("analysis child outlived its parent")


def test_decode_audio_uses_configured_ffmpeg(monkeypatch):
    from app.services import audio_analysis
    monkeypatch.setenv("CRATEMIND_FFMPEG_PATH", "/opt/cratemind/ffmpeg")
    cfg.get_settings.cache_clear()
    calls = []

    def run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        return subprocess.CompletedProcess(cmd, 0, np.ones(4, dtype=np.float32).tobytes(), b"")

    monkeypatch.setattr(audio_analysis.subprocess, "run", run)
    audio = audio_analysis.decode_audio("/music/track.flac")
    assert audio.size == 4
    cmd, kwargs = calls[0]
    assert cmd[0] == "/opt/cratemind/ffmpeg"
    assert kwargs["creationflags"] == getattr(subprocess, "CREATE_NO_WINDOW", 0)
    assert kwargs["stdin"] is subprocess.DEVNULL


def test_child_std_handles_isolation_is_a_no_op_off_windows(monkeypatch):
    from app.desktop_runtime import std_handles
    monkeypatch.setattr(std_handles.os, "name", "posix")
    assert std_handles.isolate_child_std_handles() is False
    assert std_handles._null_fd is None


def test_stdin_block_probes_only_run_on_windows(tmp_path, monkeypatch):
    from app.desktop_runtime import spawn_probe
    monkeypatch.setattr(spawn_probe.os, "name", "posix")
    assert spawn_probe.run_stdin_block_probes(tmp_path) == []


def test_desktop_main_isolates_child_std_handles_after_reading_init(monkeypatch):
    from app.desktop_runtime import bootstrap, std_handles
    order = []
    monkeypatch.setattr(bootstrap, "load_desktop_init", lambda _stream: order.append("init") or {"launch_id": "x"})
    monkeypatch.setattr(std_handles, "isolate_child_std_handles", lambda: order.append("isolate") or True)
    monkeypatch.setattr(bootstrap, "run_server", lambda _init, _protocol: order.append("serve") or 0)
    assert bootstrap.main([]) == 0
    assert order == ["init", "isolate", "serve"]


def test_decode_audio_without_ffmpeg_raises_greek_error(monkeypatch):
    from app.services import audio_analysis
    monkeypatch.setattr(cfg.shutil, "which", lambda name: None)
    cfg.get_settings.cache_clear()

    def run(*_args, **_kwargs):
        raise AssertionError("ran a bare ffmpeg")

    monkeypatch.setattr(audio_analysis.subprocess, "run", run)
    with pytest.raises(RuntimeError, match="Δεν βρέθηκε το ffmpeg"):
        audio_analysis.decode_audio("/music/track.flac")
