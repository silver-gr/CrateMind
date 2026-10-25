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


def _resolve(
    metadata: float | None,
    analyzed: float | None,
    consensus: float | None,
    consensus_sources: str | None,
) -> tuple[float | None, str | None]:
    manual = bool(consensus_sources and consensus_sources.startswith("manual:"))
    consensus_value = positive_bpm(consensus)
    if manual and consensus_value is not None:
        return consensus_value, consensus_sources
    metadata_value = positive_bpm(metadata)
    if metadata_value is not None:
        return metadata_value, "metadata"
    if consensus_value is not None:
        return consensus_value, consensus_sources or "consensus"
    analyzed_value = positive_bpm(analyzed)
    return (analyzed_value, "local") if analyzed_value is not None else (None, None)


def effective_bpm_values(
    metadata: float | None,
    analyzed: float | None,
    consensus: float | None,
    consensus_sources: str | None,
) -> float | None:
    """Scalar entry point shared by SQLite filters and object consumers."""
    return _resolve(metadata, analyzed, consensus, consensus_sources)[0]


def effective_bpm(track: Track) -> float | None:
    return effective_bpm_values(
        track.bpm, track.bpm_analyzed, track.bpm_consensus, track.bpm_consensus_sources,
    )


def bpm_source(track: Track) -> str | None:
    return _resolve(
        track.bpm, track.bpm_analyzed, track.bpm_consensus, track.bpm_consensus_sources,
    )[1]
