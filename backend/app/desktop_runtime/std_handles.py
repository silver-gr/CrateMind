"""Keep spawned children off the desktop protocol pipes (Windows).

On Windows a console child created without explicit standard handles, which
is how multiprocessing's spawn creates it, receives duplicates of the
parent's standard handles. The desktop backend's stdin is the framed protocol
pipe, and a thread always has a synchronous read pending on it. Windows
serialises I/O on a synchronous file object, so the child blocks the first
time its startup touches stdin and never runs.

Point the process standard input at NUL and standard output at stderr.
SetStdHandle does not change the C runtime descriptors 0 and 1 that the
backend's protocol uses; it only changes what new children inherit.
"""
from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

STD_INPUT_HANDLE = -10 & 0xFFFFFFFF
STD_OUTPUT_HANDLE = -11 & 0xFFFFFFFF
STD_ERROR_HANDLE = -12 & 0xFFFFFFFF
_null_fd: int | None = None


def kernel32():
    import ctypes
    from ctypes import wintypes
    library = ctypes.WinDLL("kernel32", use_last_error=True)
    library.GetStdHandle.argtypes = (wintypes.DWORD,)
    library.GetStdHandle.restype = wintypes.HANDLE
    library.SetStdHandle.argtypes = (wintypes.DWORD, wintypes.HANDLE)
    library.SetStdHandle.restype = wintypes.BOOL
    return library


def isolate_child_std_handles() -> bool:
    """Windows only: give future children NUL stdin and stderr as stdout.

    Returns True when both handles changed. Best effort: never raises.
    """
    global _null_fd
    if os.name != "nt":
        return False
    try:
        import ctypes
        import msvcrt
        library = kernel32()
        if _null_fd is None:
            _null_fd = os.open(os.devnull, os.O_RDWR)  # open for the process lifetime
        null = msvcrt.get_osfhandle(_null_fd)
        error = library.GetStdHandle(STD_ERROR_HANDLE)
        if not error or error == ctypes.c_void_p(-1).value:
            error = null
        changed = bool(library.SetStdHandle(STD_INPUT_HANDLE, null))
        changed = bool(library.SetStdHandle(STD_OUTPUT_HANDLE, error)) and changed
        if not changed:
            logger.warning("child_std_handles_unchanged error=%s", ctypes.get_last_error())
        return changed
    except Exception:  # startup must continue without the isolation
        logger.exception("child_std_handles_failed")
        return False
