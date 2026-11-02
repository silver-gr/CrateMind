"""Six-filter detail colour analysis using NumPy only.

Envelope height is independent of this 512/256-sample colour analysis. Magnitudes
and unwindowed RMS are averaged per channel to preserve inverted stereo audio.
"""
from __future__ import annotations

import numpy as np

from .waveform import RATE

WIN = 512
HOP = 256
PREPAD = 128
_HUES = np.array([.99, 0, .36, .44, .64, .66])
_ANGLES = 2 * np.pi * _HUES
_WINDOW = .54 - .46 * np.cos(2 * np.pi * np.arange(WIN) / WIN)


def _filters() -> np.ndarray:
    knots = ((0, 0, 80, 100), (80, 100, 200, 450), (200, 450, 1500, 1700),
             (1500, 1700, 1700, 3700), (1700, 3700, 5300, 7500), (5300, 7500, 10000, 20000))
    gains = (3, 1.7, 1, 1.2, 1.5, 1.2)
    filters = np.zeros((WIN // 2, 6))
    for band, (hz, gain) in enumerate(zip(knots, gains)):
        # All frequencies are nonnegative: floor(x+.5) is round-nearest-away.
        a, b, c, d = np.minimum(WIN // 2 - 1, np.floor(np.array(hz) * WIN / RATE + .5)).astype(int)
        filters[a:b, band] = gain * np.sqrt(np.arange(1, b - a + 1) / (b - a + 1))
        filters[b:c, band] = gain
        filters[c:d, band] = gain * np.sqrt(1 - np.arange(1, d - c + 1) / (d - c + 1))
    return filters


FILTERS = _filters()


def brightness(rms: np.ndarray) -> np.ndarray:
    with np.errstate(divide='ignore', invalid='ignore'):
        db = 20 * np.log10(rms)
    db = np.where(np.isfinite(db), db, -300)
    return np.clip(np.where(db < -36, .2 * (db + 50) / 14, .2 + .8 * (db + 36) / 27), 0, 1)


def mix_colors(scores: np.ndarray) -> np.ndarray:
    """Circular hue average, weighted by normalized filter score to power 1.5."""
    weights = scores ** 1.5
    x, y = weights @ np.cos(_ANGLES), weights @ np.sin(_ANGLES)
    hue = np.mod(np.arctan2(y, x) / (2 * np.pi), 1)
    saturation = .3 + .7 * np.hypot(x, y) / np.maximum(weights.sum(axis=1), np.finfo(np.float32).tiny)
    sector = hue * 6
    fraction = sector - np.floor(sector)
    one = np.ones_like(hue)
    p, q, t = 1 - saturation, 1 - saturation * fraction, 1 - saturation * (1 - fraction)
    options = np.stack([np.stack(channels, axis=1) for channels in
                        ((one, t, p), (q, one, p), (p, one, t), (p, q, one), (t, p, one), (one, p, q))])
    return options[np.floor(sector).astype(int) % 6, np.arange(len(hue))]


def analyze(frames: np.ndarray) -> np.ndarray:
    """Return RGB [0,1] for (frames, channels, 512) unwindowed PCM blocks."""
    spectrum = np.abs(np.fft.rfft(frames * _WINDOW, axis=-1))[..., :WIN // 2].mean(axis=1)
    # Per-spectrum maximum normalization cancels when the six scores are normalized.
    scores = spectrum @ FILTERS
    scores /= np.maximum(scores.max(axis=1, keepdims=True), np.finfo(np.float32).tiny)
    hue_rgb = mix_colors(scores)
    rms = np.sqrt(np.mean(np.square(frames, dtype=np.float64), axis=-1)).mean(axis=1)
    level = brightness(rms)[:, None]
    return level * hue_rgb + .2 * (1 - level)
