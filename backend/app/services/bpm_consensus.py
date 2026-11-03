"""BPM consensus helpers: NumPy only, no DSP stack.

Moved from audio_analysis.py so the desktop API process can recompute the
consensus without importing scipy, librosa or essentia. audio_analysis
re-exports every name.
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from ..models import Track
from .tempo_ranges import TempoRange, fold_into, range_for_method

HALF_TEMPO_THRESHOLD = 109.0


def _corrected_bpm(bpm: float) -> float:
    """Double sub-threshold tempos so half-time detections land in DJ range."""
    if bpm < HALF_TEMPO_THRESHOLD:
        return round(bpm * 2.0, 2)
    return round(bpm, 2)


def bpm_disagreement(
    primary: Optional[float],
    secondary: Optional[float],
    threshold_percent: float,
) -> tuple[Optional[bool], Optional[float]]:
    """Compare BPMs after resolving common half/double-time ambiguity."""
    if primary is None or secondary is None or primary <= 0 or secondary <= 0:
        return None, None
    equivalent = min(
        (secondary / 2.0, secondary, secondary * 2.0),
        key=lambda candidate: abs(candidate - primary),
    )
    difference = abs(equivalent - primary) / primary * 100.0
    rounded = round(difference, 3)
    return rounded > max(0.0, threshold_percent), rounded


def _octave_adjusted(bpm: float, anchor: float) -> float:
    return min((bpm / 2.0, bpm, bpm * 2.0), key=lambda candidate: abs(candidate - anchor))


def bpm_consensus(
    votes: list[tuple[str, Optional[float]]],
    threshold_percent: float,
    window: TempoRange | None = None,
) -> tuple[Optional[float], Optional[str]]:
    """Return unique two-vote-or-better BPM cluster after octave normalization.

    With a window the median folds into it; without one (pre-Phase-B rows) the
    legacy half-tempo doubling applies."""
    valid = [
        (source, float(value))
        for source, value in votes
        if value is not None and np.isfinite(value) and value > 0
    ]
    if len(valid) < 2:
        return None, None

    threshold = max(0.0, threshold_percent)
    clusters: dict[frozenset[str], tuple[float, list[tuple[str, float]]]] = {}
    for _anchor_source, anchor in valid:
        members = []
        for source, value in valid:
            adjusted = _octave_adjusted(value, anchor)
            difference = abs(adjusted - anchor) / anchor * 100.0
            if difference <= threshold:
                members.append((source, adjusted))
        if len(members) < 2:
            continue
        source_set = frozenset(source for source, _value in members)
        spread = float(np.std([value for _source, value in members]))
        current = clusters.get(source_set)
        if current is None or spread < current[0]:
            clusters[source_set] = (spread, members)

    if not clusters:
        return None, None
    largest = max(len(source_set) for source_set in clusters)
    winners = [
        (source_set, cluster)
        for source_set, cluster in clusters.items()
        if len(source_set) == largest
    ]
    if len(winners) != 1:
        return None, None

    source_set, (_spread, members) = winners[0]
    median = float(np.median([value for _source, value in members]))
    if window is None:
        consensus = _corrected_bpm(median)
    else:
        consensus = round(fold_into(median, window.lo, window.hi), 2)
    source_order = [source for source, _value in valid if source in source_set]
    return consensus, "+".join(source_order)


def _refresh_consensus(track: Track, threshold_percent: float) -> None:
    comparison = track.bpm_reccobeats or track.bpm_essentia
    track.bpm_disagreement, track.bpm_disagreement_percent = bpm_disagreement(
        track.bpm_analyzed,
        comparison,
        threshold_percent,
    )

    if (
        track.bpm_consensus_sources
        and track.bpm_consensus_sources.startswith("manual:")
        and track.bpm_consensus is not None
        and np.isfinite(track.bpm_consensus)
        and track.bpm_consensus > 0
    ):
        track.bpm_needs_review = False
        return

    if track.bpm is not None and np.isfinite(track.bpm) and track.bpm > 0:
        track.bpm_consensus = round(float(track.bpm), 2)
        track.bpm_consensus_sources = "metadata"
        track.bpm_needs_review = False
        return

    cyanite_bpm = track.bpm_cyanite_range_adjusted or track.bpm_cyanite
    votes = [
        ("local", track.bpm_analyzed),
        ("essentia", track.bpm_essentia),
        ("reccobeats", track.bpm_reccobeats),
        ("getsongbpm", track.bpm_getsongbpm),
        ("cyanite", cyanite_bpm),
    ]
    track.bpm_consensus, track.bpm_consensus_sources = bpm_consensus(
        votes,
        threshold_percent,
        range_for_method(track.bpm_analyzed_method),
    )
    has_analysis_vote = any(
        value is not None and np.isfinite(value) and value > 0
        for _source, value in votes
    )
    track.bpm_needs_review = has_analysis_vote and track.bpm_consensus is None
