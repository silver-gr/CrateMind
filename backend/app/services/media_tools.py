"""Bounded ownership of native media processes shared by web and desktop."""
from __future__ import annotations

import subprocess
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path


class ToolRunner:
    def __init__(self, concurrency: int = 2, output_limit: int = 16 * 1024**2):
        if not 1 <= concurrency <= 4:
            raise ValueError("media concurrency must be 1–4")
        self._slots = threading.BoundedSemaphore(concurrency)
        self._lock = threading.Lock()
        self._children: set[subprocess.Popen] = set()
        self._stopped = threading.Event()
        self.output_limit = output_limit

    @contextmanager
    def process(self, command: list[str], *, stdout=subprocess.PIPE, stderr=subprocess.PIPE):
        from ..runtime_profile import RuntimeProfile, get_runtime_profile
        if get_runtime_profile() is RuntimeProfile.DESKTOP_CORE:
            executable = Path(command[0])
            if not executable.is_absolute() or not executable.is_file():
                raise FileNotFoundError("Λείπει ενσωματωμένο εργαλείο πολυμέσων.")
        while not self._slots.acquire(timeout=.1):
            if self._stopped.is_set():
                raise OSError("Η εφαρμογή κλείνει.")
        proc = None
        try:
            with self._lock:
                if self._stopped.is_set():
                    raise OSError("Η εφαρμογή κλείνει.")
                # Children inherit the host-owned process group/Windows Job.
                proc = subprocess.Popen(command, stdin=subprocess.DEVNULL,
                                        stdout=stdout, stderr=stderr,
                                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                self._children.add(proc)
            yield proc
        finally:
            if proc is not None:
                self._reap(proc)
                with self._lock:
                    self._children.discard(proc)
                for stream in (proc.stdout, proc.stderr):
                    if stream is not None:
                        stream.close()
            self._slots.release()

    @staticmethod
    def _reap(proc):
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()
        proc.wait()

    def run(self, tool: str, args: list[str], timeout_s: float, cancel_event=None):
        started = time.monotonic()
        # Spool outputs to bound Python memory; enforce disk/output size while running.
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
            with self.process([tool, *args], stdout=output, stderr=errors) as proc:
                while proc.poll() is None:
                    if time.monotonic() - started > timeout_s:
                        raise subprocess.TimeoutExpired([tool, *args], timeout_s)
                    if cancel_event is not None and cancel_event.is_set():
                        raise OSError("Η εργασία ακυρώθηκε.")
                    if max(output.tell(), errors.tell()) > self.output_limit:
                        raise ValueError("Το εργαλείο επέστρεψε υπερβολικά μεγάλο αποτέλεσμα.")
                    time.sleep(.02)
                if max(output.tell(), errors.tell()) > self.output_limit:
                    raise ValueError("Το εργαλείο επέστρεψε υπερβολικά μεγάλο αποτέλεσμα.")
                output.seek(0)
                errors.seek(0)
                return subprocess.CompletedProcess([tool, *args], proc.returncode,
                                                   output.read(), errors.read())

    def stop_all(self):
        self._stopped.set()
        with self._lock:
            children = list(self._children)
        for proc in children:
            self._reap(proc)


media_tools = ToolRunner()
