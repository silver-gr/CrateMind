"""Resolve usable tempo without changing the separate source observations."""
from __future__ import annotations

import math
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..models import Track


def positive_bpm(value: float | None) -> float | None:
    """Zero, negative and non-finite observations mean BPM is unavailable."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) and value > 0 else None


_OCTAVES = (0.25, 0.5, 1, 2, 4)
SAME_TEMPO = 0.03  # a grid this close to the value it replaces is the same tempo (the deck's rule too)


def grid_tempo(
    bpm: float | None, anchor_s: float | None, confidence: float | None, straight: bool, method: str | None,
) -> float | None:
    """The value for `Track.bpm_grid`, from a track's own (CrateMind) beatgrid row: its tempo when that
    grid can stand in for the BPM. It must be confident and steady (a beat list's tempo was never
    measured against a reference), and the track must not be on the wide (Therapy) estimator, whose
    local value is protected from every other source. Every writer of the column uses this rule."""
    from .beatgrid_detect import MIN_CONFIDENCE
    from .tempo_ranges import range_for_method

    value = positive_bpm(bpm)
    if value is None or anchor_s is None or not straight or (confidence or 0) < MIN_CONFIDENCE:
        return None
    window = range_for_method(method)
    if window is not None and window.estimator == "wide":
        return None
    return round(value, 2)


def _resolve(
    metadata: float | None,
    analyzed: float | None,
    consensus: float | None,
    consensus_sources: str | None,
    grid: float | None = None,
) -> tuple[float | None, str | None]:
    """Manual, then CrateMind's own grid tempo, then file tag or title hint, consensus, local analysis.

    The grid replaces the value it agrees with (within SAME_TEMPO after moving by whole octaves, so
    that value keeps deciding the octave). Where they disagree, a tag stays (it never disagreed in
    the measurements, and it is the way back from a wrong grid), while a machine estimate gives way:
    those disagreements are its own 4/3 and 3/2 errors (docs/BEATGRID_DETECTION.md)."""
    manual = bool(consensus_sources and consensus_sources.startswith("manual:"))
    consensus_value = positive_bpm(consensus)
    if manual and consensus_value is not None:
        return consensus_value, consensus_sources
    metadata_value = positive_bpm(metadata)
    analyzed_value = positive_bpm(analyzed)
    if metadata_value is not None:
        prior: tuple[float | None, str | None] = (metadata_value, "metadata")
    elif consensus_value is not None:
        prior = (consensus_value, consensus_sources or "consensus")
    else:
        prior = (analyzed_value, "local") if analyzed_value is not None else (None, None)
    grid_value = positive_bpm(grid)
    if grid_value is None:
        return prior
    if prior[0] is None:
        return grid_value, "grid"
    folded = min((grid_value * factor for factor in _OCTAVES), key=lambda value: abs(value - prior[0]))
    if abs(folded - prior[0]) / prior[0] <= SAME_TEMPO:
        return round(folded, 2), "grid"
    return prior if metadata_value is not None else (grid_value, "grid")


def effective_bpm_values(
    metadata: float | None,
    analyzed: float | None,
    consensus: float | None,
    consensus_sources: str | None,
    artist: str | None = None,
    title: str | None = None,
    grid: float | None = None,
) -> float | None:
    """Scalar entry point shared by SQLite filters and object consumers."""
    if positive_bpm(metadata) is None and (artist or title):
        metadata, _ = metadata_bpm_hint(artist, title, analyzed)
    return _resolve(metadata, analyzed, consensus, consensus_sources, grid)[0]


def metadata_bpm_hint(artist: str | None, title: str | None, analyzed: float | None = None) -> tuple[float | None, str | None]:
    """Recover explicit misplaced tempo; never normalize it to analyzed half-time."""
    from .metadata_reader import display_title_hints
    _, hint = display_title_hints(title)
    if hint is not None:
        return hint, "title_annotation"
    # Numeric artist tags are weak evidence unless audio corroborates the tempo
    # or a metrical octave. This avoids treating every numbered act as BPM.
    if artist and artist.strip().isdigit():
        value = float(artist.strip())
        measured = positive_bpm(analyzed)
        if 60 <= value <= 400 and measured and any(
            abs(measured * factor - value) / value <= .03 for factor in (.5, 1, 2, 4)
        ):
            return value, "numeric_artist"
    return None, None


def effective_bpm(track: Track, include_grid: bool = True) -> float | None:
    """`include_grid=False`: the tempo without CrateMind's own grid (the detector's octave hint)."""
    hint, _ = metadata_bpm_hint(track.artist, track.title, track.bpm_analyzed)
    return effective_bpm_values(
        track.bpm if positive_bpm(track.bpm) is not None else hint,
        track.bpm_analyzed, track.bpm_consensus, track.bpm_consensus_sources,
        grid=track.bpm_grid if include_grid else None,
    )


def bpm_source(track: Track) -> str | None:
    hint, basis = metadata_bpm_hint(track.artist, track.title, track.bpm_analyzed)
    _, source = _resolve(
        track.bpm if positive_bpm(track.bpm) is not None else hint,
        track.bpm_analyzed, track.bpm_consensus, track.bpm_consensus_sources, track.bpm_grid,
    )
    return "metadata:" + basis if source == "metadata" and positive_bpm(track.bpm) is None and basis else source
