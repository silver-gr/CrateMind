"""CrateMind's own beat grid: one steady grid per track, measured from the audio.

NumPy only. Read-only by construction: it takes decoded samples and returns numbers.

Method (validated against raw-audio kick attacks, see docs/BEATGRID_DETECTION.md):
1. Spectral flux in the 150-3000 Hz band. A kick is the strongest pulse there; the full
   band is fooled by off-beat hats and the sub band by bass notes.
2. Tempo from the autocorrelation, then pinned by following its peak out to hundreds of
   beats (a lag of N beats fixes the period N times finer than a lag of one).
3. The envelope folded at that period gives the beat phase (the profile's peak).
4. Windows of 32 beats are matched against that profile: their drift corrects the tempo,
   and the share that stays on the grid is the confidence.
5. The bar line is voted by the strongest arrangement changes, which land on bar starts.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

SAMPLE_RATE = 22050
HOP = 128
N_FFT = 1024
FPS = SAMPLE_RATE / HOP
MAX_SECONDS = 20 * 60            # longer files are mixes or recordings: no single grid
MIN_SECONDS = 30
SOURCE = "cratemind"             # TrackBeatgrid.source for grids detected here
VERSION = 1                      # TrackBeatgrid.source_version: bump when the method changes
MIN_CONFIDENCE = 0.8             # below this the track is not steady enough for one grid

_BLOCK_FRAMES = 1024
_WIN_BEATS = 32
_HOP_BEATS = 16
_RES = 4                         # profile bins per envelope frame
_ONSET_LEAD_S = 0.0045           # the flux peak leads the transient start by ~4.5 ms (measured)
_TIGHT_MS = 12.0
_RHYTHMIC = 1.5                  # a window's profile peak over its mean: it has a pulse
_BAND_EDGES = (0, 60, 120, 250, 500, 1000, 2000, 4000, 11025)
_EARLY_S = 0.03                  # a beat this close before 0:00 still counts as the first
_FRAME0_S = N_FFT / 2 / SAMPLE_RATE   # centre of envelope frame 0


@dataclass(frozen=True)
class GridResult:
    bpm: float
    anchor_s: float                    # a downbeat: the first one at or just before 0:00 onwards
    confidence: float                  # share of the track's 32-beat windows whose pulse sits on this grid (0..1)
    residual_ms: Optional[float]       # median distance of those windows from the grid
    downbeat_confidence: float         # share of the bar-line vote the chosen beat won (0.25 = a coin toss)


def _spectral(audio: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(kick-band flux, log band energies per frame), in blocks so memory stays small.
    Frame i is centred on sample i * HOP + N_FFT / 2 (no padding: no copy of the audio)."""
    window = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(N_FFT) / N_FFT)).astype(np.float32)
    scale = float(window.sum())
    freqs = np.fft.rfftfreq(N_FFT, 1 / SAMPLE_RATE)
    kick = (freqs >= 150) & (freqs < 3000)
    band_masks = [(freqs >= lo) & (freqs < hi) for lo, hi in zip(_BAND_EDGES[:-1], _BAND_EDGES[1:])]
    frames = np.lib.stride_tricks.sliding_window_view(audio.astype(np.float32, copy=False), N_FFT)[::HOP]
    flux = np.empty(len(frames))
    bands = np.empty((len(band_masks), len(frames)))
    previous: Optional[np.ndarray] = None
    for start in range(0, len(frames), _BLOCK_FRAMES):
        mag = np.abs(np.fft.rfft(frames[start:start + _BLOCK_FRAMES] * window, axis=1)) / scale
        for i, mask in enumerate(band_masks):
            bands[i, start:start + len(mag)] = np.log1p(1000.0 * (mag[:, mask] ** 2).sum(axis=1))
        mid = np.log1p(100.0 * mag[:, kick])
        rise = np.diff(mid, axis=0, prepend=(mid[:1] if previous is None else previous[None, :]))
        flux[start:start + len(mag)] = np.maximum(rise, 0).sum(axis=1)
        previous = mid[-1]
    return flux, bands


def _autocorr(env: np.ndarray) -> np.ndarray:
    e = np.maximum(env - np.median(env), 0)
    e = np.minimum(e, np.percentile(e, 99.5))
    size = 1 << int(np.ceil(np.log2(2 * len(e))))
    ac = np.fft.irfft(np.abs(np.fft.rfft(e, size)) ** 2, size)[: len(e)]
    ac = ac / np.arange(len(e), 0, -1)
    return ac / max(float(ac[0]), 1e-12)


def _coarse_period(ac: np.ndarray, lo: float = 70.0, hi: float = 180.0) -> float:
    """Beat period in frames: the tempo whose first 32 beat multiples score best."""
    grid = np.arange(lo, hi + 1e-6, 0.02)
    periods = 60.0 * FPS / grid
    lags = np.arange(len(ac))
    scores = np.zeros(len(grid))
    for multiple in range(1, 33):
        scores += np.interp(periods * multiple, lags, ac) / np.sqrt(multiple)
    return float(periods[int(np.argmax(scores))])


def _parabola(a: float, b: float, c: float) -> float:
    denom = a - 2 * b + c
    return 0.5 * (a - c) / denom if abs(denom) > 1e-12 else 0.0


def _refine_period(ac: np.ndarray, period: float) -> float:
    """Follow the autocorrelation peak at 8, 32, 128, ... beats."""
    n = 8
    while n * period < 0.5 * len(ac):
        half = max(2, int(0.1 * period))
        lo = int(round(n * period)) - half
        seg = ac[lo: lo + 2 * half + 1]
        j = int(np.argmax(seg))
        frac = _parabola(seg[j - 1], seg[j], seg[j + 1]) if 0 < j < len(seg) - 1 else 0.0
        period = (lo + j + frac) / n
        n *= 4
    return period


def _fold(env: np.ndarray, period: float, bins: int) -> np.ndarray:
    """E[j, k]: the envelope at phase j/bins of beat k."""
    n = int((len(env) - 1) / period) - 1
    pos = (np.arange(bins)[:, None] / bins + np.arange(n)[None, :]) * period
    return np.interp(pos, np.arange(len(env)), env)


def _window_shifts(E: np.ndarray, G: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Per window of beats: its centre (beats), its shift against the global profile (bins),
    their correlation, and the bin of its own strongest pulse (-1: no pulse of its own)."""
    bins, n = E.shape
    g = G - G.mean()
    fg = np.conj(np.fft.rfft(g))
    gn = float(np.linalg.norm(g)) + 1e-12
    reach = bins // 8
    idx = np.arange(-reach, reach + 1)
    centres, shifts, corr, own = [], [], [], []
    for n0 in range(0, max(1, n - _WIN_BEATS + 1), _HOP_BEATS):
        raw = E[:, n0:n0 + _WIN_BEATS].sum(axis=1)
        mean = float(raw.mean())
        w = raw - mean
        wn = float(np.linalg.norm(w))
        centres.append(n0 + _WIN_BEATS / 2)
        if wn < 1e-9 or mean <= 0:
            shifts.append(0.0); corr.append(0.0); own.append(-1)
            continue
        seg = (np.fft.irfft(np.fft.rfft(w) * fg, bins) / (wn * gn))[idx % bins]
        j = int(np.argmax(seg))
        frac = _parabola(seg[j - 1], seg[j], seg[j + 1]) if 0 < j < len(seg) - 1 else 0.0
        shifts.append(idx[j] + frac)
        corr.append(float(seg[j]))
        own.append(int(np.argmax(raw)) if float(raw.max()) / mean >= _RHYTHMIC else -1)
    return np.array(centres), np.array(shifts), np.array(corr), np.array(own)


def _robust_slope(x: np.ndarray, y: np.ndarray, w: np.ndarray) -> tuple[float, np.ndarray]:
    """Weighted line fit that drops outliers; returns (slope, residuals)."""
    keep = w > 0
    a = b = 0.0
    for _ in range(4):
        if keep.sum() < 3:
            break
        A = np.vstack([np.ones(keep.sum()), x[keep]]).T * w[keep, None]
        sol, *_ = np.linalg.lstsq(A, y[keep] * w[keep], rcond=None)
        a, b = float(sol[0]), float(sol[1])
        r = y - (a + b * x)
        mad = float(np.median(np.abs(r[keep]))) + 1e-9
        keep = (w > 0) & (np.abs(r) < max(3 * 1.4826 * mad, 1.0))
    return b, y - (a + b * x)


@dataclass(frozen=True)
class _Fit:
    period: float                 # frames
    phase: float                  # frames: the first beat at or after 0
    clarity: float
    confidence: float
    residual_ms: Optional[float]


def _fit(env: np.ndarray, ac: np.ndarray, period: float) -> Optional[_Fit]:
    """Refine `period` and measure how well one steady grid explains the track."""
    period = _refine_period(ac, period)
    for _ in range(3):
        bins = int(round(period * _RES))
        E = _fold(env, period, bins)
        if E.shape[1] < 2 * _WIN_BEATS:
            return None
        G = E.mean(axis=1)
        centres, shifts, corr, own = _window_shifts(E, G)
        weight = np.where(corr > 0.5, corr, 0.0)
        slope, resid = _robust_slope(centres, shifts, weight)
        if abs(slope * E.shape[1]) < 0.5:        # under half a bin of drift over the track
            break
        period += slope * period / bins
    bin_ms = period / bins / FPS * 1000
    tight = (weight > 0) & (np.abs(resid) * bin_ms < _TIGHT_MS)
    j = int(np.argmax(G))
    # Where each window's own strongest pulse sits against the beat. On the beat: for the grid.
    # On a sixteenth (an off-beat part louder than the kick for a while): says nothing.
    # Anywhere else (a timing jump, a tempo change): against. Beatless windows do not count,
    # and under a quarter of the track with a pulse means no grid.
    away = np.abs((own - j + bins / 2) % bins - bins / 2) * bin_ms
    quarter_ms = bins * bin_ms / 4
    on = (own >= 0) & (away < _TIGHT_MS)
    off = (own >= 0) & ~on & (np.abs((away + quarter_ms / 2) % quarter_ms - quarter_ms / 2) >= _TIGHT_MS)
    counted = int(on.sum() + off.sum())
    confidence = float(on.sum() / counted) if counted >= max(3, len(centres) // 4) else 0.0
    frac = _parabola(G[j - 1], G[j], G[(j + 1) % bins])
    return _Fit(
        period=period,
        phase=((j + frac) / bins * period) % period,
        clarity=float(G.max() / (G.mean() + 1e-12)),
        confidence=confidence,
        residual_ms=float(np.median(np.abs(resid[tight])) * bin_ms) if tight.any() else None,
    )


def _fold_octave(period: float, hint_bpm: Optional[float]) -> float:
    """The octave of `period` nearest the hint: the hint decides half/double time, never the tempo."""
    return 60.0 * FPS / fold_bpm(60.0 * FPS / period, hint_bpm)


def _bar_vote(bands: np.ndarray, phase: float, period: float) -> tuple[int, float]:
    """Which beat (mod 4, counted from the beat at `phase`) starts the bar. Arrangement changes
    land on bar lines, so the strongest changes in the per-beat band energies vote."""
    n = int((bands.shape[1] - 1 - phase) / period) - 1
    edges = np.round(phase + np.arange(n + 1) * period).astype(int)
    c = np.concatenate([np.zeros((bands.shape[0], 1)), np.cumsum(bands, axis=1)], axis=1)
    per_beat = (c[:, edges[1:]] - c[:, edges[:-1]]) / np.maximum(1, edges[1:] - edges[:-1])
    cf = np.concatenate([np.zeros((per_beat.shape[0], 1)), np.cumsum(per_beat, axis=1)], axis=1)
    k = np.arange(4, n - 4)
    change = np.abs((cf[:, k + 4] - cf[:, k]) - (cf[:, k] - cf[:, k - 4])).sum(axis=0)   # next bar vs previous bar
    i = np.arange(1, len(change) - 1)
    peak = i[(change[i] > change[i - 1]) & (change[i] >= change[i + 1])]
    votes = np.zeros(4)
    np.add.at(votes, k[peak] % 4, change[peak] ** 2)
    total = float(votes.sum())
    if total <= 0:
        return 0, 0.25
    best = int(np.argmax(votes))
    return best, float(votes[best] / total)


def fold_bpm(bpm: float, reference: Optional[float]) -> float:
    """`bpm` moved by whole octaves to the one nearest `reference` (the track's resolved tempo)."""
    if not reference or reference <= 0 or bpm <= 0:
        return bpm
    return min((bpm * f for f in (0.25, 0.5, 1, 2, 4)), key=lambda b: abs(b - reference))


def detect_grid(audio: np.ndarray, hint_bpm: Optional[float] = None) -> Optional[GridResult]:
    """One steady beat grid for mono float audio at SAMPLE_RATE, or None when there is nothing to fit
    (too short, too long, silent). A low `confidence` means the track is not steady: do not use the grid.

    `hint_bpm` (the track's resolved tempo) only chooses between half and double time."""
    seconds = audio.size / SAMPLE_RATE
    if seconds < MIN_SECONDS or seconds > MAX_SECONDS or not np.isfinite(audio).all():
        return None
    env, bands = _spectral(audio)
    if not np.any(env > 0):
        return None
    ac = _autocorr(env)
    base = _coarse_period(ac)
    best = _fit(env, ac, _fold_octave(base, hint_bpm))
    # A grid at 2/3 or 3/2 of the true tempo lands on a kick only every other beat, so its
    # profile is flatter: switch only for a clearly sharper one.
    for ratio in (2 / 3, 3 / 2):
        other = _fit(env, ac, _fold_octave(base * ratio, hint_bpm))
        if other is not None and (best is None or other.clarity > best.clarity * 1.15):
            best = other
    if best is None:
        return None
    period_s = best.period / FPS
    first = best.phase / FPS + _FRAME0_S + _ONSET_LEAD_S      # beat 0 of the bar vote
    bar, bar_confidence = _bar_vote(bands, best.phase, best.period)
    anchor = first + bar * period_s
    while anchor - 4 * period_s >= -_EARLY_S:                  # the earliest downbeat from 0:00 on
        anchor -= 4 * period_s
    return GridResult(
        bpm=round(float(60.0 / period_s), 4),
        anchor_s=round(float(anchor), 5),
        confidence=round(best.confidence, 3),
        residual_ms=None if best.residual_ms is None else round(best.residual_ms, 2),
        downbeat_confidence=round(bar_confidence, 3),
    )
