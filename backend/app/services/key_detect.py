"""Musical key from the whole track (librosa CQT; NumPy for the rest).

The constant-Q magnitude (36 bins per octave from C1, seven octaves, tuning-corrected) is averaged
over 2-second blocks, log-compressed against the track's loudest block and summed into 84 semitones
(the octaves stay apart), each block scaled to its strongest semitone, and averaged over the track.
Each of the 24 keys is scored by rotating that profile to the key's tonic and weighting it with
WEIGHTS_MAJOR or WEIGHTS_MINOR; a softmax over the scores gives the key and its confidence. The
weights were trained on tracks whose key two or three DJ apps agree on. Method, measurements and
limits: docs/KEY_DETECTION.md; re-measure with the harness in .omc/research/key-eval before changing
anything here, and give any change a new METHOD so the analysis re-keys tracks keyed by the old one.
"""
from __future__ import annotations

from typing import Optional

import numpy as np

try:  # librosa is a hard dependency, but stay defensive so import never crashes
    import librosa
except Exception:  # pragma: no cover
    librosa = None

METHOD = "cqt-octave-trained-v2"
SAMPLE_RATE = 22050
HOP_LENGTH = 512
BINS_PER_OCTAVE = 36
OCTAVES = 7
BLOCK_FRAMES = 86            # 86 hops of 512 at 22050 Hz: 2.0 s
LOG_GAIN = 1000.0
MIN_SECONDS = 10
MAX_SECONDS = 20 * 60        # the first 20 minutes decide the key of anything longer

PITCHES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
# Rows: octaves from C1 up. Columns: semitones above the key's tonic. Trained 2026-11-18 on 3,377
# tracks (93 major) with fit_trained.py in .omc/research/key-eval (L2 3e-6, majors up-weighted).
WEIGHTS_MAJOR = np.array([
    [  16.898,   -8.000,   -1.824,   -5.897,    7.927,   -3.721,   -6.534,    9.921,   -3.762,    1.676,   -7.104,    1.251],
    [  17.300,  -11.176,   -8.807,    2.268,    1.354,    0.656,  -15.867,   17.040,   -7.994,  -10.600,   -5.612,   13.221],
    [  30.822,  -12.055,    5.039,  -19.067,   19.897,  -19.626,   -4.996,   18.320,   -1.990,   12.370,  -16.243,  -11.158],
    [  28.814,  -25.478,    5.297,  -24.917,   21.480,    3.898,  -22.563,   30.429,  -12.754,   -4.563,    2.623,    1.588],
    [  35.795,  -15.118,    2.440,  -27.053,   14.216,    4.576,   -9.241,   17.815,   -7.679,   12.535,  -21.953,  -12.987],
    [   7.686,   -1.301,    8.409,   -6.846,    3.867,   -2.777,   -0.309,   -5.149,   -9.070,   16.436,   -7.110,   -4.408],
    [  -0.901,   16.932,   11.377,   -0.573,   -1.112,    1.835,   -7.649,   -0.107,    2.588,    5.434,   -7.704,  -10.671],
])
WEIGHTS_MINOR = np.array([
    [  14.964,   -8.202,   -0.627,    2.476,   -5.538,   -1.459,   -1.841,    8.792,   -4.831,   -5.940,    1.225,    0.152],
    [  21.224,   -3.365,   -4.300,    2.500,   -6.809,    0.512,   -0.986,    9.234,   -4.675,   -4.337,    1.033,   -1.813],
    [  26.486,   -9.375,   -7.667,   11.248,   -6.169,   -9.474,   -4.233,   18.851,   -1.753,   -6.748,   -5.970,   -6.508],
    [  31.759,  -16.844,    0.694,    9.739,   -3.768,   -6.562,  -10.762,   29.075,  -15.422,  -10.144,    2.231,  -13.850],
    [  25.052,  -10.861,   -2.457,   17.318,  -14.725,   -3.827,   -8.837,   18.198,    2.214,  -12.444,    6.945,   -9.922],
    [  10.995,  -16.484,    8.355,    3.465,   -7.515,    8.996,   -6.417,    8.218,   -3.857,   -4.515,    7.789,   -8.459],
    [   2.037,   -4.123,   -1.977,   -2.256,    7.799,    4.216,   -7.755,   -4.939,   -3.532,    1.835,    3.634,   -4.386],
])
MINOR_OFFSET = -1.2219


def pitch_profile(audio: np.ndarray) -> np.ndarray:
    """The track's profile over 84 semitones (C1 first), as described in the module docstring."""
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
    # A semitone is its centre bin and the bin on either side (the first semitone has no bin below it).
    shifted = np.vstack([np.zeros((1, compressed.shape[1]), compressed.dtype), compressed])[: compressed.shape[0]]
    semitones = shifted.reshape(OCTAVES * 12, BINS_PER_OCTAVE // 12, -1).sum(axis=1)
    semitones /= semitones.max(axis=0, keepdims=True) + 1e-9
    return semitones.mean(axis=1)


def key_of_profile(profile: np.ndarray) -> tuple[str, float]:
    """The most likely of the 24 keys for an 84-semitone profile, and its probability."""
    centred = np.asarray(profile, dtype=np.float64) - float(np.mean(profile))
    norm = float(np.linalg.norm(centred))
    if norm <= 1e-12:
        raise RuntimeError("flat profile")
    octaves = (centred / norm).reshape(OCTAVES, 12)
    scores = np.empty(24)
    for tonic in range(12):
        rotated = np.roll(octaves, -tonic, axis=1)
        scores[tonic] = float((WEIGHTS_MAJOR * rotated).sum())
        scores[12 + tonic] = float((WEIGHTS_MINOR * rotated).sum()) + MINOR_OFFSET
    likelihood = np.exp(scores - scores.max())
    likelihood /= likelihood.sum()
    best = int(np.argmax(scores))
    return f"{PITCHES[best % 12]} {'minor' if best >= 12 else 'major'}", round(float(likelihood[best]), 4)


def estimate_key(audio: np.ndarray) -> tuple[Optional[str], Optional[float]]:
    """The key of a decoded track (mono float32 at SAMPLE_RATE), e.g. ("A minor", 0.93)."""
    return key_of_profile(pitch_profile(audio))
