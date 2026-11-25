"""Whole-track loudness: integrated LUFS and true peak, for the Library column, the `lufs:` search
field and Auto Gain's playback leveling.

ffmpeg's ebur128 filter only reads the source. The result lives in three `tracks` columns
(`loudness_lufs`, `loudness_peak_db`, `loudness_measured_at`), measured once per track: by the
analysis job's loudness phase, or on demand when Auto Gain asks for a track not measured yet. One
on-demand measurement may run at a time; callers retry instead of queueing old selections.
"""
from __future__ import annotations

import logging
import math
import re
import subprocess
import threading
from datetime import UTC, datetime
from pathlib import Path

from sqlalchemy.exc import SQLAlchemyError

from ..config import get_settings
from ..models import Track
from .library_paths import resolve_source_path
from .media_tools import media_tools

logger = logging.getLogger(__name__)

TARGET_LUFS = -18
TRUE_PEAK_CEILING = -1
# Real masters stay under about +6 dBTP; a higher reading is a damaged spot, so the peak rule ignores it.
MAX_TRUSTED_PEAK_DBTP = 6
# Integrated loudness above full scale cannot happen: such a measurement gets no Auto Gain.
MAX_TRUSTED_LUFS = 0
# ebur128's absolute gate: digital silence (or nothing above the gate) reads exactly this.
SILENCE_LUFS = -70.0
TIMEOUT_S = 180
_MEASUREMENT_SLOT = threading.BoundedSemaphore(1)
_INTEGRATED = re.compile(r"^\s*I:\s*(\S+)\s+LUFS", re.MULTILINE)
_PEAK = re.compile(r"^\s*Peak:\s*(\S+)\s+dBFS", re.MULTILINE)


class MeasurementBusy(Exception):
    """Another selection is already being measured."""


class SourceUnavailable(OSError):
    """The indexed source cannot be read on this device."""


def ffmpeg_args(path: str | Path) -> list[str]:
    return ["-nostdin", "-hide_banner", "-nostats", "-i", str(path), "-map", "0:a:0",
            "-vn", "-sn", "-dn", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"]


def parse_measurement(output: bytes) -> tuple[float, float] | None:
    """(integrated LUFS, true peak dBTP) from ebur128's closing summary; None for a silent file.
    Raises ValueError when the summary is missing or not finite."""
    _, found, summary = output.decode("utf-8", errors="replace").rpartition("Summary:")
    integrated, peak = _INTEGRATED.search(summary), _PEAK.search(summary)
    if not found or integrated is None or peak is None:
        raise ValueError("missing loudness summary")
    lufs, true_peak = float(integrated.group(1)), float(peak.group(1))
    if lufs <= SILENCE_LUFS:
        return None
    if not (math.isfinite(lufs) and math.isfinite(true_peak)):
        raise ValueError("non-finite loudness measurements")
    return lufs, true_peak


def measure_file(path: str) -> tuple[float, float] | None:
    """One file, for the analysis pool: ffmpeg runs directly, as `decode_audio` does, not through
    media_tools' two slots. Raises when ffmpeg is missing or fails."""
    ffmpeg = get_settings().ffmpeg
    if not ffmpeg:
        raise RuntimeError("ffmpeg unavailable")
    # stdin=DEVNULL: never hand ffmpeg an inherited stdin (a pipe with a pending read blocks it on Windows).
    proc = subprocess.run([ffmpeg, *ffmpeg_args(path)], stdin=subprocess.DEVNULL, capture_output=True,
                          check=False, timeout=TIMEOUT_S, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg exited {proc.returncode}")
    return parse_measurement(proc.stderr)


def store(track: Track, measured: tuple[float, float] | None) -> None:
    """Set the track's loudness columns; None stores a silent file (measured, no values)."""
    track.loudness_lufs, track.loudness_peak_db = measured if measured is not None else (None, None)
    track.loudness_measured_at = datetime.now(UTC)


def clear(track: Track) -> None:
    """Forget the measurement (the audio changed), so the next analysis measures it again."""
    track.loudness_lufs = track.loudness_peak_db = track.loudness_measured_at = None


def _result(status: str, integrated: float | None = None, peak: float | None = None) -> dict:
    gain = 0.0
    if status == "ready" and integrated > MAX_TRUSTED_LUFS:
        status, integrated, peak = "unavailable", None, None
    if status == "ready":
        gain = TARGET_LUFS - integrated
        if peak <= MAX_TRUSTED_PEAK_DBTP:
            gain = min(gain, TRUE_PEAK_CEILING - peak)
        if integrated <= TARGET_LUFS:
            gain = max(gain, 0.0)  # a quiet track is never turned down, even when its peak asks for it
        gain = max(-24.0, min(12.0, gain))
    return {"status": status, "gain_db": gain, "integrated_lufs": integrated,
            "true_peak_dbfs": peak, "target_lufs": TARGET_LUFS}


def stored_result(track: Track) -> dict | None:
    """Auto Gain's answer from the stored columns; None when the track is not measured yet."""
    if track.loudness_measured_at is None:
        return None
    if track.loudness_lufs is None:
        return _result("silent")
    return _result("ready", track.loudness_lufs, track.loudness_peak_db)


def _signature(path: Path) -> tuple[int, int]:
    stat = path.stat()
    return stat.st_size, stat.st_mtime_ns


def get_playback_loudness(session, track: Track) -> dict:
    """The stored measurement, else one measured now (and stored). Raises SourceUnavailable when
    the file is not on this device and MeasurementBusy while another measurement runs."""
    try:
        path = resolve_source_path(track.absolute_path).resolve()
        if not path.is_file():
            raise SourceUnavailable()
        signature = _signature(path)
    except OSError as error:
        raise SourceUnavailable() from error
    stored = stored_result(track)
    if stored is not None:
        return stored
    binary = get_settings().ffmpeg
    if not binary:
        return _result("unavailable")
    if not _MEASUREMENT_SLOT.acquire(blocking=False):
        raise MeasurementBusy()
    try:
        measured = media_tools.run(binary, ffmpeg_args(path), timeout_s=TIMEOUT_S)
        if measured.returncode != 0:
            return _result("unavailable")
        value = parse_measurement(measured.stderr)
        if _signature(path) != signature:
            return _result("unavailable")  # the file changed while ffmpeg read it
    except (OSError, ValueError, subprocess.SubprocessError):
        return _result("unavailable")
    finally:
        _MEASUREMENT_SLOT.release()
    result = _result("silent") if value is None else _result("ready", *value)
    try:
        store(track, value)
        session.add(track)
        session.commit()
    except SQLAlchemyError as error:
        session.rollback()  # a busy catalog must not stop the audition; the next analysis measures it
        logger.warning("loudness_store_failed track_id=%s error=%s", track.id, error)
    return result
