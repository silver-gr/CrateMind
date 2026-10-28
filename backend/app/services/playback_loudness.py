"""Read-only full-track loudness measurement for optional playback leveling.

Only the derived JSON cache is written. The source and catalog stay untouched.
One measurement may run at a time; callers retry instead of queueing old selections.
"""
from __future__ import annotations

import json
import math
import os
import subprocess
import tempfile
import threading
from pathlib import Path

from ..config import get_settings
from .library_paths import resolve_source_path
from .media_tools import media_tools

VERSION = 1
TARGET_LUFS = -18
TRUE_PEAK_CEILING = -1
_MEASUREMENT_SLOT = threading.BoundedSemaphore(1)


class MeasurementBusy(Exception):
    """Another selection is already being measured."""


class SourceUnavailable(OSError):
    """The indexed source cannot be read on this device."""


def _result(status: str, integrated: float | None = None, peak: float | None = None) -> dict:
    gain = 0.0
    if status == "ready":
        gain = min(max(-24.0, min(12.0, TARGET_LUFS - integrated)),
                   TRUE_PEAK_CEILING - peak)
    return {"status": status, "gain_db": gain, "integrated_lufs": integrated,
            "true_peak_dbfs": peak, "target_lufs": TARGET_LUFS}


def _signature(path: Path) -> dict:
    stat = path.stat()
    return {"path": str(path.resolve()), "size": stat.st_size, "mtime_ns": stat.st_mtime_ns}


def _parse_measurement(output: bytes) -> dict:
    # FFmpeg writes its loudnorm JSON after normal progress/stream diagnostics.
    text = output.decode("utf-8", errors="replace")
    start, end = text.rfind("{"), text.rfind("}")
    if start < 0 or end < start:
        raise ValueError("missing loudness measurements")
    data = json.loads(text[start:end + 1])
    values = [data["input_i"], data["input_tp"]]
    if any(isinstance(value, bool) for value in values):
        raise ValueError("invalid loudness measurements")
    integrated, peak = map(float, values)
    if integrated == peak == -math.inf:
        return _result("silent")
    if not all(math.isfinite(value) for value in (integrated, peak)):
        raise ValueError("non-finite loudness measurements")
    return _result("ready", integrated, peak)


def _read_cache(cache: Path, signature: dict) -> dict | None:
    try:
        with cache.open() as handle:
            data = json.loads(handle.read(8193))
        if data.get("version") != VERSION or data.get("source") != signature:
            return None
        result = data["result"]
        if result["status"] == "silent":
            expected = _result("silent")
        elif result["status"] == "ready":
            integrated, peak = result["integrated_lufs"], result["true_peak_dbfs"]
            if not all(type(value) in (int, float) and math.isfinite(value)
                       for value in (integrated, peak)):
                return None
            expected = _result("ready", integrated, peak)
        else:
            return None
        # Reject stale/corrupt gain and non-finite JSON, not merely its fingerprint.
        if (result != expected or type(result["gain_db"]) not in (int, float)
                or type(result["target_lufs"]) not in (int, float)):
            return None
        return expected
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError):
        return None


def _write_cache(cache: Path, signature: dict, result: dict) -> None:
    temporary = None
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(mode="w", dir=cache.parent, delete=False) as handle:
            temporary = handle.name
            json.dump({"version": VERSION, "source": signature, "result": result}, handle,
                      allow_nan=False, separators=(",", ":"))
        os.replace(temporary, cache)
    except OSError:
        pass  # Cache availability must not prevent auditioning.
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass


def get_playback_loudness(track_id: int, absolute_path: str) -> dict:
    try:
        path = resolve_source_path(absolute_path).resolve()
        if not path.is_file():
            raise SourceUnavailable()
        signature = _signature(path)
    except OSError as error:
        raise SourceUnavailable() from error

    settings = get_settings()
    cache = settings.db_file.parent / "cache" / "playback-loudness" / f"{track_id}-v{VERSION}.json"
    cached = _read_cache(cache, signature)
    try:
        if cached is not None and _signature(path) == signature:
            return cached
    except OSError as error:
        raise SourceUnavailable() from error
    binary = settings.ffmpeg
    if not binary:
        return _result("unavailable")
    if not _MEASUREMENT_SLOT.acquire(blocking=False):
        raise MeasurementBusy()
    try:
        measured = media_tools.run(binary, [
            "-nostdin", "-hide_banner", "-nostats", "-i", str(path), "-map", "0:a:0",
            "-vn", "-sn", "-dn", "-af", "loudnorm=I=-18:TP=-1:LRA=11:print_format=json",
            "-f", "null", "-",
        ], timeout_s=180)
        if measured.returncode != 0:
            return _result("unavailable")
        result = _parse_measurement(measured.stderr)
        if _signature(path) != signature:
            return _result("unavailable")
        _write_cache(cache, signature, result)
        return result
    except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError,
            subprocess.SubprocessError):
        return _result("unavailable")
    finally:
        _MEASUREMENT_SLOT.release()
