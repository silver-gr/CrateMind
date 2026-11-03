"""Tempo windows for BPM analysis: a pure registry, no DSP.

The DJ windows run the multi-lag scorer on their own grid; the therapy window
runs the wide estimator. The window's method string is stored on the track
(Track.bpm_analyzed_method), so the consensus can fold into the same window
later. The desktop API process may import this module.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal, Mapping

TempoRangeKey = Literal["psy", "mixed", "slow", "therapy"]
DjRangeKey = Literal["psy", "mixed", "slow"]


@dataclass(frozen=True)
class TempoRange:
    key: str
    lo: float
    hi: float
    estimator: Literal["multilag", "wide"]
    method: str                    # stored in Track.bpm_analyzed_method
    fallback_method: str | None    # multilag windows only


def _multilag(key: str, lo: int, hi: int) -> TempoRange:
    return TempoRange(
        key=key,
        lo=float(lo),
        hi=float(hi),
        estimator="multilag",
        method=f"librosa-onset-multilag-v2@{lo}-{hi}",
        fallback_method=f"ffmpeg+onset-autocorr-v1@{lo}-{hi}",
    )


TEMPO_RANGES: dict[str, TempoRange] = {
    "psy": _multilag("psy", 133, 286),
    "mixed": _multilag("mixed", 118, 250),
    "slow": _multilag("slow", 70, 125),
    "therapy": TempoRange(
        key="therapy",
        lo=40.0,
        hi=240.0,
        estimator="wide",
        method="librosa-onset-wide-v1@40-240",
        fallback_method=None,
    ),
}
DEFAULT_TEMPO_RANGE = "psy"

_BY_METHOD: dict[str, TempoRange] = {}
for _window in TEMPO_RANGES.values():
    _BY_METHOD[_window.method] = _window
    if _window.fallback_method:
        _BY_METHOD[_window.fallback_method] = _window


def get_range(key: str) -> TempoRange:
    try:
        return TEMPO_RANGES[key]
    except KeyError:
        raise ValueError("unknown tempo range") from None


def range_for_method(method: str | None) -> TempoRange | None:
    """The window a stored method string came from; None for pre-Phase-B rows."""
    if not method:
        return None
    return _BY_METHOD.get(method)


def fold_into(bpm: float, lo: float, hi: float) -> float:
    """Move bpm by octaves (x2**k, |k| <= 4) into [lo, hi], preferring the
    smallest shift. If no octave fits, return the closest in log distance."""
    candidates = sorted(range(-4, 5), key=abs)
    for k in candidates:
        value = bpm * 2.0**k
        if lo <= value <= hi:
            return value

    def distance(value: float) -> float:
        if value < lo:
            return math.log(lo / value)
        return math.log(value / hi)

    return min((bpm * 2.0**k for k in candidates), key=distance)


def _norm(path: str) -> str:
    return path.replace("\\", "/").casefold()


def resolve_track_range(path: str, default: str, root_ranges: Mapping[str, str]) -> str:
    """The window for one track: the longest matching music-folder root wins.

    `path` is the connected path (str(resolve_source_path(track.absolute_path)));
    `root_ranges` keys are the connected root strings Settings lists. Separators
    and case fold, and a root only matches whole folder names. The therapy
    default ignores the per-folder windows.
    """
    if default == "therapy":
        return default
    target = _norm(path)
    best_len = -1
    best = default
    for root, key in root_ranges.items():
        prefix = _norm(root)
        if not prefix.endswith("/"):
            prefix += "/"
        if target.startswith(prefix) and len(prefix) > best_len:
            best_len = len(prefix)
            best = key
    return best
