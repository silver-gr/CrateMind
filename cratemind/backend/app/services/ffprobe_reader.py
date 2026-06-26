"""Read audio stream info via ffprobe. Degrades gracefully when ffprobe is
absent or fails on a file."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any


def read_stream(path: Path, ffprobe: str | None) -> dict[str, Any]:
    """Return duration/codec/bitrate/sample_rate/channels/container.

    Returns {} if ffprobe is unavailable or the probe fails — callers must not
    depend on stream info being present.
    """
    if not ffprobe:
        return {}
    cmd = [
        ffprobe, "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", str(path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=30)
    except (subprocess.TimeoutExpired, OSError):
        return {}
    if proc.returncode != 0 or not proc.stdout:
        return {}
    try:
        data = json.loads(proc.stdout)
    except (json.JSONDecodeError, ValueError):
        return {}

    fmt = data.get("format", {}) or {}
    streams = data.get("streams", []) or []
    audio = next((s for s in streams if s.get("codec_type") == "audio"), {})

    out: dict[str, Any] = {}

    def as_float(v: Any) -> float | None:
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    def as_int(v: Any) -> int | None:
        try:
            return int(float(v))
        except (TypeError, ValueError):
            return None

    out["duration"] = as_float(fmt.get("duration")) or as_float(audio.get("duration"))
    out["bitrate"] = as_int(fmt.get("bit_rate")) or as_int(audio.get("bit_rate"))
    out["sample_rate"] = as_int(audio.get("sample_rate"))
    out["channels"] = as_int(audio.get("channels"))
    out["codec"] = audio.get("codec_name")
    out["container"] = (fmt.get("format_name") or "").split(",")[0] or None
    return {k: v for k, v in out.items() if v is not None}
