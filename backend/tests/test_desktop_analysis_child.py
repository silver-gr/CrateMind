"""The scan never waits on the analysis pipe alone; spawned children keep a log."""
from __future__ import annotations

import multiprocessing
import os
import pickle
import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]


def _hang(connection, job_id, track_ids):
    time.sleep(120)


def _spawn(target, args, *, pass_sender=True):
    context = multiprocessing.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=target, args=(sender, *args) if pass_sender else args, daemon=True)
    process.start()
    return receiver, sender, process


def test_child_exit_without_message_fails_fast_although_the_sender_leaked():
    from app.jobs import worker
    # The parent keeps its sender open, as the Windows handle duplicate does, so
    # the pipe never reports EOF; only the exit sentinel can end the wait.
    receiver, sender, process = _spawn(os._exit, (3,), pass_sender=False)
    outcome: dict = {}

    def receive():
        try:
            worker._receive_from_child(receiver, process, timeout=60)
        except Exception as exc:  # noqa: BLE001
            outcome["error"] = exc

    # A daemon thread, so a regression to a pipe-only wait fails instead of hanging.
    thread = threading.Thread(target=receive, daemon=True)
    try:
        thread.start()
        thread.join(30)
        assert not thread.is_alive()
        assert isinstance(outcome["error"], RuntimeError)
        assert "exit code 3" in str(outcome["error"])
    finally:
        receiver.close()
        sender.close()
        process.join(5)


def test_message_sent_before_exit_is_still_received():
    from app.desktop_runtime.spawn_probe import send_ok
    from app.jobs import worker
    receiver, sender, process = _spawn(send_ok, ())
    try:
        process.join(30)  # both the pipe and the sentinel are ready: data wins
        assert process.exitcode == 0
        assert worker._receive_from_child(receiver, process, timeout=30) == "ok"
    finally:
        receiver.close()
        sender.close()


def test_receive_times_out_when_a_live_child_sends_nothing():
    from app.jobs import worker
    receiver, sender, process = _spawn(_hang, (1, []))
    try:
        with pytest.raises(TimeoutError):
            worker._receive_from_child(receiver, process, timeout=0.5)
    finally:
        process.terminate()
        process.join(5)
        receiver.close()
        sender.close()


def test_stop_analysis_processes_unblocks_a_waiting_scan(monkeypatch):
    from app.jobs import worker
    monkeypatch.setattr(worker, "_send_scan_analysis", _hang)
    outcome: dict = {}

    def scan():
        try:
            worker._analyze_scan_additions(1, [1])
        except Exception as exc:  # noqa: BLE001
            outcome["error"] = exc

    thread = threading.Thread(target=scan, daemon=True)
    thread.start()
    deadline = time.monotonic() + 30
    while worker._scan_analysis_process is None and time.monotonic() < deadline:
        time.sleep(0.02)
    assert worker._scan_analysis_process is not None
    worker.stop_analysis_processes(10)
    thread.join(15)
    assert not thread.is_alive()
    assert "exit code" in str(outcome["error"])
    assert worker._scan_analysis_process is None


def _echo_track_ids(connection, job_id, ids_path):
    from app.jobs import worker
    connection.send({"result": {"job_id": job_id, "track_ids": worker._read_track_ids(ids_path)}})
    connection.close()


def test_scan_spawn_payload_stays_small_for_a_large_scan(monkeypatch):
    # Windows writes the spawn payload into a ~4 KB pipe inside start(); a large
    # track list there could block start() forever if the child dies first.
    from types import SimpleNamespace
    from app.jobs import worker
    context = multiprocessing.get_context("spawn")
    spawned = []

    def record(*, target, args, daemon):
        spawned.append(args)
        return context.Process(target=target, args=args, daemon=daemon)

    monkeypatch.setattr(worker, "mp", SimpleNamespace(
        get_context=lambda _method: SimpleNamespace(Pipe=context.Pipe, Process=record)))
    monkeypatch.setattr(worker, "_send_scan_analysis", _echo_track_ids)
    track_ids = list(range(100_000, 110_000))
    result = worker._analyze_scan_additions(5, track_ids)
    assert result == {"job_id": 5, "track_ids": track_ids}
    (args,) = spawned
    assert len(pickle.dumps(args[1:])) < 1024
    assert not Path(args[2]).exists()


def test_scan_reports_a_dead_analysis_child_with_the_greek_mapped_marker(db, monkeypatch):
    from app.jobs import worker
    from app.models import Job
    from app.runtime_profile import RuntimeProfile, runtime_profile
    monkeypatch.setattr(worker.scanner, "scan", lambda *a, **k: {
        "added": 1, "updated": 0, "missing": 0, "unchanged": 0, "added_track_ids": [7],
    })
    monkeypatch.setattr(worker, "rebuild_artist_profiles", lambda _s: None)

    def dead_child(job_id, track_ids):
        raise RuntimeError("analysis process exited (exit code 3) before returning results")

    monkeypatch.setattr(worker, "_analyze_scan_additions", dead_child)
    job = worker.create_job(db, "scan")
    with runtime_profile(RuntimeProfile.DESKTOP_CORE):
        worker._run_scan(job.id, None)
    db.expire_all()
    finished = db.get(Job, job.id)
    assert finished.status == "done"
    assert finished.message.endswith(" (new-track analysis failed)")


def _install_script(log_dir: Path) -> subprocess.CompletedProcess:
    script = textwrap.dedent("""
        import logging, os, sys, threading
        from app.desktop_runtime import child_diagnostics
        path = child_diagnostics.install(sys.argv[1])
        logging.getLogger("app.jobs.worker").info("stage-marker-xyz")
        logging.getLogger("thirdparty").info("third-party-info")
        print("stdout-line")
        os.write(2, b"native-stderr\\n")
        thread = threading.Thread(target=lambda: 1 / 0, name="probe-thread")
        thread.start(); thread.join()
        print("installed" if path else "not-installed")
    """)
    env = {k: v for k, v in os.environ.items() if not k.startswith("CRATEMIND_")}
    env.update(PYTHONPATH=str(BACKEND), NO_CRATEMIND_ENV_FILE="1",
               CRATEMIND_RUNTIME_PROFILE="desktop-core", CRATEMIND_LLM1_API_KEY="secret-value-xyz")
    return subprocess.run([sys.executable, "-c", script, str(log_dir)], env=env, cwd=log_dir.parent,
                          capture_output=True, text=True, timeout=60)


def test_child_diagnostics_install_writes_a_pruned_log(tmp_path):
    logs = tmp_path / "logs"
    logs.mkdir()
    old_names = {f"analysis-child-{1000 + index}.log" for index in range(6)}
    for index in range(6):
        old = logs / f"analysis-child-{1000 + index}.log"
        old.write_text("old\n")
        os.utime(old, (1_000_000 + index, 1_000_000 + index))
    (logs / "unrelated.log").write_text("keep\n")
    result = _install_script(logs)
    assert result.returncode == 0, result.stderr
    # Everything went to the log, nothing to the inherited streams.
    assert result.stdout == "" and result.stderr == ""
    remaining = sorted(path.name for path in logs.glob("analysis-child-*.log"))
    assert len(remaining) == 5
    assert {f"analysis-child-{1000 + index}.log" for index in (2, 3, 4, 5)} < set(remaining)
    assert (logs / "unrelated.log").exists()
    current = next(logs / name for name in remaining if name not in old_names)
    text = current.read_text(encoding="utf-8")
    assert "=== analysis child" in text and f"'pid': {current.stem.rsplit('-', 1)[1]}" in text
    assert "'CRATEMIND_RUNTIME_PROFILE': 'desktop-core'" in text
    assert "secret-value-xyz" not in text
    assert "[MainThread] app.jobs.worker: stage-marker-xyz" in text
    assert "third-party-info" not in text
    assert "stdout-line" in text and "native-stderr" in text and "installed" in text
    assert "uncaught exception in thread probe-thread" in text and "ZeroDivisionError" in text


def test_child_diagnostics_install_is_best_effort_without_a_directory(tmp_path):
    result = _install_script(tmp_path / "missing")
    assert result.returncode == 0, result.stderr
    assert "not-installed" in result.stdout
    assert not (tmp_path / "missing").exists()


def test_child_diagnostics_sets_the_error_mode_without_a_log(tmp_path, monkeypatch):
    from app.desktop_runtime import child_diagnostics
    calls = []
    monkeypatch.setattr(child_diagnostics, "_error_mode", lambda: calls.append("set"))
    assert child_diagnostics.install(tmp_path / "missing") is None
    assert calls == ["set"]


def test_child_diagnostics_dumps_stacks_only_after_a_stall(tmp_path):
    script = textwrap.dedent("""
        import sys, time
        from app.desktop_runtime import child_diagnostics
        child_diagnostics.HANG_DUMP_SECONDS = 0.5
        child_diagnostics.install(sys.argv[1])
        for _ in range(8):  # steady progress: no dump
            child_diagnostics.progress()
            time.sleep(0.15)
        print("progress-done")
        time.sleep(0.8)  # a stall: one dump
        print("stall-done")
    """)
    env = {k: v for k, v in os.environ.items() if not k.startswith("CRATEMIND_")}
    env.update(PYTHONPATH=str(BACKEND), NO_CRATEMIND_ENV_FILE="1")
    result = subprocess.run([sys.executable, "-c", script, str(tmp_path)], env=env, cwd=tmp_path,
                            capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    (log,) = tmp_path.glob("analysis-child-*.log")
    text = log.read_text(encoding="utf-8")
    before, after = text.split("progress-done")
    assert "Timeout (" not in before
    assert after.count("Timeout (") == 1 and "stall-done" in after


def test_child_diagnostics_log_stops_growing_past_the_size_cap(tmp_path):
    script = textwrap.dedent("""
        import logging, sys, time
        from app.desktop_runtime import child_diagnostics
        child_diagnostics.HANG_DUMP_SECONDS = 0.3
        child_diagnostics.MAX_LOG_BYTES = 8192
        child_diagnostics.install(sys.argv[1])
        time.sleep(1.0)  # one long stall: one dump, not one per 0.3 s
        print("stall-done")
        print("x" * 9000)  # past the cap
        child_diagnostics.progress()
        logging.getLogger("app.jobs.worker").info("marker-after-cap")
        time.sleep(0.6)  # no dump once capped
        print("capped-done")
    """)
    env = {k: v for k, v in os.environ.items() if not k.startswith("CRATEMIND_")}
    env.update(PYTHONPATH=str(BACKEND), NO_CRATEMIND_ENV_FILE="1")
    result = subprocess.run([sys.executable, "-c", script, str(tmp_path)], env=env, cwd=tmp_path,
                            capture_output=True, text=True, timeout=60, check=False)
    assert result.returncode == 0, result.stderr
    (log,) = tmp_path.glob("analysis-child-*.log")
    before, after = log.read_text(encoding="utf-8").split("stall-done")
    assert before.count("Timeout (") == 1
    assert "log reached 8192 bytes" in after and "capped-done" in after
    assert "marker-after-cap" not in after and "Timeout (" not in after


def test_spawn_probe_targets_run_in_process():
    from app.desktop_runtime import spawn_probe
    from app.services import audio_analysis
    receiver, sender = multiprocessing.Pipe(duplex=False)
    spawn_probe.send_ok(sender)
    assert receiver.recv() == "ok"
    receiver, sender = multiprocessing.Pipe(duplex=False)
    spawn_probe.send_analysis(sender)
    result = receiver.recv()["result"]
    assert result["method"] == audio_analysis.BPM_METHOD and result["key"] is not None


def test_run_probe_reports_success_and_a_dead_child(tmp_path):
    from app.desktop_runtime import spawn_probe
    ok = spawn_probe.run_probe("spawn-pipe", spawn_probe.send_ok, 60, tmp_path)
    assert ok["ok"] and ok["result"] == "ok" and ok["exit_code"] == 0
    dead = spawn_probe.run_probe("dead", os._exit, 60, tmp_path)  # os._exit(<connection>) raises in the child
    assert not dead["ok"] and dead["exit_code"] == 1
    assert "exit code 1" in dead["error"] and "no child log" in dead["child_log_tail"]


def test_desktop_environment_sets_the_child_log_dir(tmp_path):
    import app.config as cfg
    from app.desktop_runtime.config import configure_environment, resolve_desktop_paths
    assert "CRATEMIND_CHILD_LOG_DIR" not in os.environ  # the web runtime never sets it
    (tmp_path / "resources").mkdir()
    init = {"paths": {"app_data": str(tmp_path / "app-data"), "resources": str(tmp_path / "resources")},
            "tools": {}}
    saved = dict(os.environ)
    try:
        paths = resolve_desktop_paths(init)
        configure_environment(init, paths)
        assert os.environ["CRATEMIND_CHILD_LOG_DIR"] == str(paths.app_data / "logs")
        assert (paths.app_data / "logs").is_dir()
    finally:
        os.environ.clear()
        os.environ.update(saved)
        cfg.get_settings.cache_clear()
