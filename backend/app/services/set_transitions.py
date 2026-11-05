"""Set-transition vocabulary and the transparent «Αυτόματο» (Auto) resolver.

Pure functions only: no database access, no audio. The resolver picks a named
preset for an ordered pair of tracks from BPM, key and the DJ profile, and
returns machine reason codes (the frontend maps them to Greek copy).

Desktop API process rule: stdlib + recommender key helpers only (no numpy).
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

from .recommender import key_fit

Preset = Literal["auto", "custom", "fade", "rise", "blend", "wave", "melt", "slam", "dissolve",
                 "surge", "afterglow", "none"]
VolumeCurve = Literal["smooth", "overlap", "fade_fade", "cut_fade", "fade_cut", "center_cut",
                      "linear", "fade_fast"]
EqCurve = Literal["bass_swap_center", "bass_swap_end", "bass_swap_start", "three_band",
                  "bass_cut_quick", "bass_cut_long", "fade_out_start", "bass_fade_out", "none"]
FilterCurve = Literal["lpf_out", "lpf_in", "lpf_in_lpf_out", "lpf_in_hpf_out", "hpf_out", "hpf_in",
                      "hpf_in_hpf_out", "hpf_in_lpf_out", "hpf_half_out", "none"]

LOOP_BEATS = (1, 2, 4, 8, 16)
BARS_MIN, BARS_MAX = 1, 32
MAX_RATE_DEVIATION = 0.16   # the incoming deck's pitch range
CLOSE_RATE_DEVIATION = 0.03

REASON_CODES = ("same_key", "adjacent_key", "relative_key", "key_clash", "key_unknown",
                "bpm_close", "bpm_far", "bpm_out_of_range", "bpm_unknown", "profile_cut",
                "profile_blend")

_FOLD_LO, _FOLD_HI = math.sqrt(0.5), math.sqrt(2.0)


@dataclass(frozen=True)
class PresetSpec:
    volume: str
    eq: str
    filter: str
    bars: int
    loop_beats: int | None = None


# Mirrored in frontend/src/lib/transitions/presets.json (checked by a test).
# "none" is a hard cut: center_cut keeps it distinguishable from "fade" by curves alone.
PRESETS: dict[str, PresetSpec] = {
    "fade": PresetSpec("smooth", "none", "none", 4),
    "rise": PresetSpec("overlap", "bass_swap_end", "lpf_in_hpf_out", 8),
    "blend": PresetSpec("overlap", "three_band", "none", 8),
    "wave": PresetSpec("overlap", "bass_swap_center", "lpf_in_lpf_out", 8),
    "melt": PresetSpec("fade_fade", "bass_swap_center", "hpf_in_hpf_out", 8),
    "slam": PresetSpec("center_cut", "bass_cut_quick", "none", 1),
    "dissolve": PresetSpec("fade_cut", "bass_swap_end", "hpf_half_out", 8),
    "surge": PresetSpec("overlap", "bass_swap_start", "hpf_in", 4, 4),
    "afterglow": PresetSpec("smooth", "bass_swap_center", "none", 8),
    "none": PresetSpec("center_cut", "none", "none", 0),
}


@dataclass(frozen=True)
class ProfileHints:
    transition_role: str | None
    can_cut_into: bool | None
    can_cut_out_of: bool | None


@dataclass(frozen=True)
class PairInput:
    from_bpm: float | None
    to_bpm: float | None
    from_key: str | None
    to_key: str | None
    from_profile: ProfileHints | None
    to_profile: ProfileHints | None


@dataclass(frozen=True)
class Resolved:
    preset: str
    volume_curve: str
    eq_curve: str
    filter_curve: str
    bars: int
    loop_beats: int | None
    tempo_match: bool
    reasons: tuple[str, ...]


def tempo_match_rate(from_bpm: float, to_bpm: float) -> float:
    """The incoming deck's playback rate: from/to folded into [0.7071, 1.4142).

    Same quantity as the frontend's ``tempoMatchRate``; eligibility is
    ``abs(rate - 1) <= MAX_RATE_DEVIATION``.
    """
    if not (from_bpm > 0 and to_bpm > 0) or not math.isfinite(from_bpm / to_bpm):
        raise ValueError("BPM must be positive and finite")
    rate = from_bpm / to_bpm
    while rate < _FOLD_LO:
        rate *= 2
    while rate >= _FOLD_HI:
        rate /= 2
    return rate


def anchor_error(value: float | None, duration: float | None) -> str | None:
    """Why an anchor (seconds into a track) is invalid, or None if it is usable."""
    if value is None:
        return None
    if not math.isfinite(value) or value < 0:
        return "must be a finite time >= 0"
    if duration is not None and math.isfinite(duration) and duration > 0 and value >= duration:
        return "exceeds track duration"
    return None


def materialise(preset: str, reasons: tuple[str, ...] = (), tempo_match: bool = True) -> Resolved:
    """A named preset's spec. ``auto``/``custom`` have no fixed spec."""
    spec = PRESETS.get(preset)
    if spec is None:
        raise ValueError(f"no fixed spec for preset {preset!r}")
    return Resolved(preset, spec.volume, spec.eq, spec.filter, spec.bars, spec.loop_beats,
                    tempo_match, reasons)


def _key_reason(from_key: str | None, to_key: str | None) -> tuple[float, str]:
    score, text = key_fit(from_key, to_key)
    if text is None:
        return score, "key_unknown"
    if score >= 10:
        return score, "same_key"
    if score >= 7:
        return score, "adjacent_key"
    if score >= 6:
        return score, "relative_key"
    return score, "key_clash"


def _roles(*profiles: ProfileHints | None) -> set[str]:
    roles: set[str] = set()
    for p in profiles:
        if p and p.transition_role:
            roles.update(r.strip() for r in p.transition_role.split(",") if r.strip())
    return roles


def resolve_auto(pair: PairInput) -> Resolved:
    """Pick the Auto preset for a pair; ``Resolved.preset`` is the resolved name."""
    key_score, key_reason = _key_reason(pair.from_key, pair.to_key)
    good_key = key_score >= 6

    try:
        rate: float | None = tempo_match_rate(pair.from_bpm or 0.0, pair.to_bpm or 0.0)
    except ValueError:
        rate = None
    if rate is None:
        return materialise("fade", ("bpm_unknown", key_reason), tempo_match=False)

    deviation = abs(rate - 1)
    cut_ok = bool((pair.from_profile and pair.from_profile.can_cut_out_of)
                  or (pair.to_profile and pair.to_profile.can_cut_into))

    def slam(*reasons: str, tempo_match: bool) -> Resolved:
        if cut_ok and "profile_cut" not in reasons:
            reasons = (*reasons, "profile_cut")
        return materialise("slam", reasons, tempo_match=tempo_match)

    if deviation > MAX_RATE_DEVIATION:
        return slam("bpm_out_of_range", key_reason, tempo_match=False)

    bpm_reason = "bpm_close" if deviation <= CLOSE_RATE_DEVIATION else "bpm_far"
    if good_key and bpm_reason == "bpm_close":
        return materialise("blend", (key_reason, bpm_reason))

    roles = _roles(pair.from_profile, pair.to_profile)
    if "safe_blend" in roles:
        return materialise("blend", ("profile_blend", key_reason, bpm_reason))
    if "dramatic_cut" in roles:
        return slam("profile_cut", key_reason, bpm_reason, tempo_match=True)
    if good_key:
        return materialise("afterglow", (key_reason, bpm_reason))
    return materialise("fade", (key_reason, bpm_reason))
