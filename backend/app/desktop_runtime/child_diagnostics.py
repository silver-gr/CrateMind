"""Best-effort log file for a spawned analysis child of the frozen desktop backend.

A Windows spawn child's stdout/stderr are otherwise lost, so a child that dies or
stalls leaves no trace. `install()` runs before `multiprocessing.freeze_support()`
hands control to the child: it sends fds 1/2 (and the Windows std handles) to
<dir>/analysis-child-<pid>.log, writes a header, enables faulthandler and makes
crashes exit instead of waiting on an error dialog. Stdlib only, and nothing here
may raise into the child.
"""
from __future__ import annotations

import faulthandler
import logging
import os
import sys
import threading
import time
import traceback
from pathlib import Path

LOG_PREFIX = "analysis-child-"
KEEP_LOGS = 5
HANG_DUMP_SECONDS = 60
# Only these values are written; never other environment values.
ENV_KEYS = ("CRATEMIND_RUNTIME_PROFILE", "CRATEMIND_DATASET_ROOT", "CRATEMIND_FFMPEG_PATH")
_STD_HANDLES = {"stdin": -10, "stdout": -11, "stderr": -12}
# SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX
_ERROR_MODE = 0x8003

_stream = None  # kept open for faulthandler and the excepthooks


def _write(text: str) -> None:
    try:
        _stream.write(text.rstrip("\n") + "\n")
        _stream.flush()
    except Exception:
        pass


def _attempt(label: str, function, *args):
    try:
        return function(*args)
    except Exception as exc:
        _write(f"{label} failed: {type(exc).__name__}: {exc}")
        return None


def prune(directory: Path, current: Path, keep: int = KEEP_LOGS) -> None:
    """Keep the current log and the newest `keep - 1` others."""
    def modified(path: Path) -> float:
        try:
            return path.stat().st_mtime
        except OSError:
            return 0.0

    others = sorted((path for path in directory.glob(LOG_PREFIX + "*.log") if path != current),
                    key=modified, reverse=True)
    for stale in others[max(0, keep - 1):]:
        try:
            stale.unlink()
        except OSError:  # another child may still hold it open (Windows)
            pass


def _kernel32():
    import ctypes
    from ctypes import wintypes
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.GetStdHandle.argtypes = (wintypes.DWORD,)
    kernel32.GetStdHandle.restype = wintypes.HANDLE
    kernel32.SetStdHandle.argtypes = (wintypes.DWORD, wintypes.HANDLE)
    kernel32.SetStdHandle.restype = wintypes.BOOL
    kernel32.GetFileType.argtypes = (wintypes.HANDLE,)
    kernel32.GetFileType.restype = wintypes.DWORD
    kernel32.SetErrorMode.argtypes = (wintypes.UINT,)
    kernel32.SetErrorMode.restype = wintypes.UINT
    return kernel32


def _std_handles() -> dict:
    kernel32 = _kernel32()
    types = {0: "unknown", 1: "disk", 2: "char", 3: "pipe"}
    handles = {}
    for name, number in _STD_HANDLES.items():
        handle = kernel32.GetStdHandle(number & 0xFFFFFFFF)
        kind = types.get(kernel32.GetFileType(handle), "other") if handle else "none"
        handles[name] = {"handle": hex(handle) if handle else None, "type": kind}
    return handles


def _fd_validity() -> dict:
    valid = {}
    for fd in (0, 1, 2):
        try:
            os.fstat(fd)
            valid[fd] = True
        except OSError:
            valid[fd] = False
    return valid


def _redirect(fileno: int) -> None:
    os.dup2(fileno, 1)
    os.dup2(fileno, 2)
    if os.name == "nt":
        import msvcrt
        kernel32 = _kernel32()
        for name, fd in (("stdout", 1), ("stderr", 2)):
            if not kernel32.SetStdHandle(_STD_HANDLES[name] & 0xFFFFFFFF, msvcrt.get_osfhandle(fd)):
                _write(f"SetStdHandle({name}) failed: {_kernel32_error()}")


def _kernel32_error() -> int:
    import ctypes
    return ctypes.get_last_error()


def _python_streams() -> None:
    sys.stdout = open(1, "w", buffering=1, encoding="utf-8", errors="backslashreplace", closefd=False)
    sys.stderr = open(2, "w", buffering=1, encoding="utf-8", errors="backslashreplace", closefd=False)


def _error_mode() -> str:
    kernel32 = _kernel32()
    previous = kernel32.SetErrorMode(_ERROR_MODE)
    kernel32.SetErrorMode(previous | _ERROR_MODE)
    return f"{previous:#x} -> {previous | _ERROR_MODE:#x}"


def _logging(path: Path) -> None:
    handler = logging.FileHandler(path, encoding="utf-8")
    handler.setLevel(logging.INFO)
    handler.setFormatter(logging.Formatter(
        "%(asctime)s %(levelname)s [%(threadName)s] %(name)s: %(message)s"))
    logging.getLogger().addHandler(handler)
    # Application stage markers are INFO; third-party loggers keep the root level.
    logging.getLogger("app").setLevel(logging.INFO)


def _excepthook(kind, value, tb) -> None:
    _write("uncaught exception:\n" + "".join(traceback.format_exception(kind, value, tb)))


def _thread_excepthook(args) -> None:
    if args.exc_type is SystemExit:
        return
    name = args.thread.name if args.thread is not None else "?"
    _write(f"uncaught exception in thread {name}:\n"
           + "".join(traceback.format_exception(args.exc_type, args.exc_value, args.exc_traceback)))


def _hooks() -> None:
    sys.excepthook = _excepthook
    threading.excepthook = _thread_excepthook


def install(log_dir: str | os.PathLike | None = None) -> Path | None:
    """Send this child's output to its own log. Returns the log path, or None."""
    global _stream
    try:
        directory = Path(log_dir if log_dir is not None else os.environ["CRATEMIND_CHILD_LOG_DIR"])
        path = directory / f"{LOG_PREFIX}{os.getpid()}.log"
        _stream = open(path, "a", buffering=1, encoding="utf-8", errors="backslashreplace")
    except Exception:
        return None
    _attempt("prune", prune, directory, path)
    fds_before = _attempt("fd check", _fd_validity)
    handles_before = _attempt("std handles", _std_handles) if os.name == "nt" else None
    _attempt("redirect", _redirect, _stream.fileno())
    _attempt("python streams", _python_streams)
    header = {
        "started": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "pid": os.getpid(),
        "ppid": os.getppid(),
        "argv": sys.argv,
        "executable": sys.executable,
        "base_executable": getattr(sys, "_base_executable", None),
        "frozen": bool(getattr(sys, "frozen", False)),
        "cwd": _attempt("cwd", os.getcwd),
        "env": {key: os.environ.get(key) for key in ENV_KEYS},
        "fds_valid_before_redirect": fds_before,
    }
    if os.name == "nt":
        header["std_handles_before_redirect"] = handles_before
        header["error_mode"] = _attempt("SetErrorMode", _error_mode)
    _write(f"=== analysis child {header}")
    _attempt("faulthandler", faulthandler.enable, _stream, True)
    try:
        faulthandler.dump_traceback_later(HANG_DUMP_SECONDS, repeat=True, file=_stream)
    except Exception as exc:
        _write(f"dump_traceback_later failed: {type(exc).__name__}: {exc}")
    _attempt("logging", _logging, path)
    _attempt("excepthooks", _hooks)
    return path
