"""Frozen self-test probes for the spawned analysis child (see bootstrap.self_test).

Targets stay importable and light: a spawn child unpickles them by name, so the
DSP stack is imported only inside the analysis probe.
"""
from __future__ import annotations

import logging
import multiprocessing as mp
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

logger = logging.getLogger(__name__)
TRIVIAL_LIMIT_SECONDS = 60
ANALYSIS_LIMIT_SECONDS = 150
STDIN_REPRO_LIMIT_SECONDS = 20


def analyze_synthetic_clip() -> dict:
    """Estimate BPM/key of a C-major triad plus a decaying click at 140 BPM."""
    import numpy as np
    from ..services import audio_analysis
    rate = audio_analysis.SAMPLE_RATE
    t = np.arange(30 * rate) / rate
    clip = sum(np.sin(2 * np.pi * frequency * t) for frequency in (261.63, 329.63, 392.0)) * 0.15
    click = np.random.default_rng(0).uniform(-0.5, 0.5, int(0.03 * rate)) * np.exp(-np.arange(int(0.03 * rate)) / (0.005 * rate))
    for beat in np.arange(0, 30, 60 / 140):
        start = int(beat * rate)
        clip[start:start + click.size] += click[:clip.size - start]
    clip = clip.astype(np.float32)
    bpm, _raw, _confidence, method = audio_analysis.estimate_bpm(clip)
    key, _key_confidence = audio_analysis.estimate_key(clip)
    if audio_analysis.librosa is None or method != audio_analysis.BPM_METHOD or key is None:
        raise RuntimeError(f"Frozen analysis failed: method={method} key={key}")
    return {"bpm": bpm, "key": key, "method": method}


def send_ok(connection) -> None:
    """Probe 1: the spawn and pipe hand-off alone."""
    try:
        connection.send("ok")
    finally:
        connection.close()


def send_analysis(connection) -> None:
    """Probe 2: the analysis child's path, with DSP on a thread-pool worker like analyze_all."""
    logger.info("spawn_probe stage=target-start")
    try:
        from ..jobs import worker
        worker._child_setup()
        if mp.parent_process() is not None:
            worker._lower_priority()  # as the desktop analysis child does
        logger.info("spawn_probe stage=setup-done")
        with ThreadPoolExecutor(max_workers=1) as executor:
            result = executor.submit(analyze_synthetic_clip).result()
        logger.info("spawn_probe stage=sending")
        connection.send({"result": result})
    except Exception as exc:
        logger.exception("spawn_probe_failed")
        connection.send({"error": f"{type(exc).__name__}: {exc}"})
    finally:
        connection.close()


def _log_tail(log_dir: Path, pid: int | None, lines: int = 80) -> str:
    path = log_dir / f"analysis-child-{pid}.log"
    try:
        return "\n".join(path.read_text(encoding="utf-8", errors="replace").splitlines()[-lines:])
    except OSError as exc:
        return f"(no child log at {path}: {exc})"


def run_probe(name: str, target, limit: float, log_dir: Path) -> dict:
    """Spawn `target(sender)` and wait like the scan does; never raises."""
    from ..jobs.worker import _receive_from_child
    context = mp.get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=target, args=(sender,), daemon=True)
    started = time.monotonic()
    message = error = None
    try:
        process.start()
        sender.close()
        message = _receive_from_child(receiver, process, timeout=limit)
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
    finally:
        receiver.close()
        sender.close()
        if process.pid is not None:
            process.join(5)
            if process.is_alive():
                process.terminate()
                process.join(5)
    if error is None and isinstance(message, dict) and "error" in message:
        error = message["error"]
    record = {"name": name, "ok": error is None, "exit_code": process.exitcode, "pid": process.pid,
              "seconds": round(time.monotonic() - started, 3)}
    if error is None:
        record["result"] = message.get("result") if isinstance(message, dict) else message
    else:
        record["error"] = error
        record["child_log_tail"] = _log_tail(log_dir, process.pid)
    return record


def run_probes(log_dir: Path) -> list[dict]:
    from ..services import audio_analysis
    probes = [run_probe("spawn-pipe", send_ok, TRIVIAL_LIMIT_SECONDS, log_dir),
              run_probe("spawn-analysis", send_analysis, ANALYSIS_LIMIT_SECONDS, log_dir)]
    trivial, analysis = probes
    if trivial["ok"] and trivial.get("result") != "ok":
        trivial.update(ok=False, error=f"unexpected message {trivial.get('result')!r}")
    result = analysis.get("result") or {}
    if analysis["ok"] and (result.get("method") != audio_analysis.BPM_METHOD or result.get("key") is None):
        analysis.update(ok=False, error=f"unexpected analysis {result!r}",
                        child_log_tail=_log_tail(log_dir, analysis["pid"]))
    return probes + run_stdin_block_probes(log_dir)


def run_stdin_block_probes(log_dir: Path) -> list[dict]:
    """Windows: hold a synchronous read on our stdin, as the backend's protocol
    thread does, then spawn without and with std_handles isolation.

    The unisolated child is expected to hang (informational: it records whether
    the deadlock reproduces); the isolated child must succeed.
    """
    if os.name != "nt":
        return []
    import msvcrt

    from .std_handles import (
        STD_INPUT_HANDLE,
        STD_OUTPUT_HANDLE,
        isolate_child_std_handles,
        kernel32,
    )
    library = kernel32()
    previous_input = library.GetStdHandle(STD_INPUT_HANDLE)
    previous_output = library.GetStdHandle(STD_OUTPUT_HANDLE)
    read_fd, write_fd = os.pipe()
    library.SetStdHandle(STD_INPUT_HANDLE, msvcrt.get_osfhandle(read_fd))
    reader = threading.Thread(target=os.read, args=(read_fd, 1), daemon=True, name="stdin-repro")
    reader.start()
    time.sleep(0.5)  # let the synchronous read become pending
    try:
        repro = run_probe("stdin-pending-unisolated", send_ok, STDIN_REPRO_LIMIT_SECONDS, log_dir)
        isolated_ok = isolate_child_std_handles()
        fixed = run_probe("stdin-pending-isolated", send_ok, TRIVIAL_LIMIT_SECONDS, log_dir)
    finally:
        os.write(write_fd, b"x")  # release the pending read before closing the pipe
        reader.join(5)
        os.close(write_fd)
        os.close(read_fd)
        library.SetStdHandle(STD_INPUT_HANDLE, previous_input)
        library.SetStdHandle(STD_OUTPUT_HANDLE, previous_output)
    repro.update(ok=True, reproduced=repro.get("error") is not None,
                 note="informational: True means a child inheriting a stdin pipe with a pending read hangs")
    if fixed["ok"] and fixed.get("result") != "ok":
        fixed.update(ok=False, error=f"unexpected message {fixed.get('result')!r}")
    fixed["isolation_applied"] = isolated_ok
    if not isolated_ok:
        fixed.update(ok=False, error="isolate_child_std_handles() did not change the handles")
    return [repro, fixed]
