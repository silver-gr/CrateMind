"""Musical key from the whole track (librosa CQT; NumPy for the rest).

The constant-Q magnitude (36 bins per octave from C1, seven octaves, tuning-corrected) is averaged
over 2-second blocks, log-compressed against the track's loudest block, folded into 12 pitch
classes, normalised per block and averaged over the track. That profile is correlated with 24 key
templates. The templates (PROFILE_MAJOR / PROFILE_MINOR) were learned from tracks whose key three
DJ apps agree on. Method, measurements and limits: docs/KEY_DETECTION.md; re-measure with the
harness in .omc/research/key-eval before changing anything here.
"""
from __future__ import annotations

from typing import Optional

import numpy as np

try:  # librosa is a hard dependency, but stay defensive so import never crashes
    import librosa
except Exception:  # pragma: no cover
    librosa = None

METHOD = "cqt-log-profile-v1"
SAMPLE_RATE = 22050
HOP_LENGTH = 512
BINS_PER_OCTAVE = 36
OCTAVES = 7
BLOCK_FRAMES = 86            # 86 hops of 512 at 22050 Hz: 2.0 s
LOG_GAIN = 1000.0
# Added to the minor keys' correlations: most electronic music is in minor (99% of the reference
# library, 87% of GiantSteps). Larger values cost major-key tracks (docs/KEY_DETECTION.md).
MINOR_BIAS = 0.02
MIN_SECONDS = 10
MAX_SECONDS = 20 * 60        # the first 20 minutes decide the key of anything longer

PITCHES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
# Mean folded profile of the reference tracks, tonic first (index 0 = the key's tonic).
# Learned 2026-11-18 from 3,377 tracks (93 major) with fit_profiles.py in .omc/research/key-eval.
PROFILE_MAJOR = np.array([0.09759, 0.08141, 0.08405, 0.07816, 0.08552, 0.08071, 0.07813, 0.08991, 0.07865, 0.08191, 0.07983, 0.08412])
PROFILE_MINOR = np.array([0.09202, 0.08174, 0.08297, 0.08331, 0.08136, 0.08132, 0.08025, 0.08789, 0.08151, 0.08064, 0.08380, 0.08319])


def _templates() -> np.ndarray:
    """24 x 12: the major keys on C..B, then the minor keys on C..B, each centred and unit length,
    so a dot product with a centred, unit-length profile is the Pearson correlation."""
    rows = [np.roll(PROFILE_MAJOR, i) for i in range(12)] + [np.roll(PROFILE_MINOR, i) for i in range(12)]
    t = np.array(rows, dtype=np.float64)
    t -= t.mean(axis=1, keepdims=True)
    return t / np.linalg.norm(t, axis=1, keepdims=True)


def pitch_profile(audio: np.ndarray) -> np.ndarray:
    """The track's 12-bin pitch-class profile (C first), as described in the module docstring."""
    if librosa is None:
        raise RuntimeError("librosa not available")
    if audio.size < SAMPLE_RATE * MIN_SECONDS:
        raise RuntimeError("audio too short for key analysis")
    audio = np.asarray(audio[: SAMPLE_RATE * MAX_SECONDS], dtype=np.float32)
    tuning = float(librosa.estimate_tuning(y=audio, sr=SAMPLE_RATE, bins_per_octave=BINS_PER_OCTAVE))
    cqt = np.abs(librosa.cqt(audio, sr=SAMPLE_RATE, hop_length=HOP_LENGTH, n_bins=OCTAVES * BINS_PER_OCTAVE,
                             bins_per_octave=BINS_PER_OCTAVE, tuning=tuning))
    blocks = cqt.shape[1] // BLOCK_FRAMES
    if blocks == 0:
        pooled = cqt.mean(axis=1, keepdims=True)
    else:
        pooled = cqt[:, : blocks * BLOCK_FRAMES].reshape(cqt.shape[0], blocks, BLOCK_FRAMES).mean(axis=2)
    peak = float(pooled.max())
    if peak <= 1e-12:
        raise RuntimeError("silent audio")
    compressed = np.log1p(LOG_GAIN * pooled / peak)
    fold = librosa.filters.cq_to_chroma(OCTAVES * BINS_PER_OCTAVE, bins_per_octave=BINS_PER_OCTAVE)
    chroma = fold @ compressed
    chroma /= chroma.max(axis=0, keepdims=True) + 1e-9
    return chroma.mean(axis=1)


def key_of_profile(profile: np.ndarray) -> tuple[str, float]:
    """Best of the 24 keys for a pitch-class profile, and (its correlation + 1) / 2 as the confidence."""
    centred = profile - profile.mean()
    norm = float(np.linalg.norm(centred))
    if norm <= 1e-12:
        raise RuntimeError("flat chroma")
    correlation = _templates() @ (centred / norm)
    best = int(np.argmax(correlation + np.r_[np.zeros(12), np.full(12, MINOR_BIAS)]))
    name = f"{PITCHES[best % 12]} {'minor' if best >= 12 else 'major'}"
    return name, round(max(0.0, min(1.0, (float(correlation[best]) + 1.0) / 2.0)), 4)


def estimate_key(audio: np.ndarray) -> tuple[Optional[str], Optional[float]]:
    """The key of a decoded track (mono float32 at SAMPLE_RATE), e.g. ("A minor", 0.93)."""
    return key_of_profile(pitch_profile(audio))
