"""Runtime boundaries for the shared web and packaged desktop application."""
from __future__ import annotations

import os
from contextlib import contextmanager
from contextvars import ContextVar
from enum import StrEnum


class RuntimeProfile(StrEnum):
    WEB = "web"
    DESKTOP_CORE = "desktop-core"


_profile: ContextVar[RuntimeProfile | None] = ContextVar("runtime_profile", default=None)


def get_runtime_profile() -> RuntimeProfile:
    return _profile.get() or RuntimeProfile(os.environ.get("CRATEMIND_RUNTIME_PROFILE", "web"))


@contextmanager
def runtime_profile(profile: RuntimeProfile):
    token = _profile.set(RuntimeProfile(profile))
    try:
        yield
    finally:
        _profile.reset(token)


def require_web_processing() -> None:
    if get_runtime_profile() is RuntimeProfile.DESKTOP_CORE:
        raise RuntimeError("Η επεξεργασία BPM/key και παρόχων γίνεται στη web εφαρμογή.")


DEFERRED_ROUTES = (
    ("POST", "/api/analysis/bpm/recompute"),
    ("POST", "/api/analysis/bpm/retry-failures"),
    ("GET", "/api/analysis/bpm/review"),
    ("GET", "/api/analysis/bpm/summary"),
    ("POST", "/api/analysis/bpm/tracks/{track_id}/resolve"),
    ("POST", "/api/scan/analyze"),
    ("POST", "/api/soundcloud/import-batch"),
    ("GET", "/api/soundcloud/review"),
    ("POST", "/api/soundcloud/review/{track_id}/{soundcloud_track_id}/accept"),
    ("POST", "/api/soundcloud/review/{track_id}/{soundcloud_track_id}/reject"),
    ("GET", "/api/soundcloud/summary"),
    ("GET", "/api/identity/calibration"),
)
