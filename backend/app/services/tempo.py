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
    artist: str | None = None,
    title: str | None = None,
) -> float | None:
    """Scalar entry point shared by SQLite filters and object consumers."""
    if positive_bpm(metadata) is None and (artist or title):
        metadata, _ = metadata_bpm_hint(artist, title, analyzed)
    return _resolve(metadata, analyzed, consensus, consensus_sources)[0]


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


def effective_bpm(track: Track) -> float | None:
    hint, _ = metadata_bpm_hint(track.artist, track.title, track.bpm_analyzed)
    return effective_bpm_values(
        track.bpm if positive_bpm(track.bpm) is not None else hint,
        track.bpm_analyzed, track.bpm_consensus, track.bpm_consensus_sources,
    )


def bpm_source(track: Track) -> str | None:
    hint, basis = metadata_bpm_hint(track.artist, track.title, track.bpm_analyzed)
    _, source = _resolve(
        track.bpm if positive_bpm(track.bpm) is not None else hint,
        track.bpm_analyzed, track.bpm_consensus, track.bpm_consensus_sources,
    )
    return "metadata:" + basis if source == "metadata" and positive_bpm(track.bpm) is None and basis else source
