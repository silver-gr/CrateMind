"""CrateMind's own beat grid, measured from the audio: one steady grid, or a few steady sections.

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
6. When that grid leaves the start or the end of the track unexplained (a timing jump, another
   tempo), the unexplained part is fitted the same way as its own section, and the result is a
   beat list instead of one steady grid.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np

SAMPLE_RATE = 22050
HOP = 128
N_FFT = 1024
FPS = SAMPLE_RATE / HOP
MAX_SECONDS = 20 * 60            # longer files are mixes or recordings: no single grid
MIN_SECONDS = 30
SOURCE = "cratemind"             # TrackBeatgrid.source for grids detected here
VERSION = 2                      # TrackBeatgrid.source_version: bump when the method changes
LISTS_SINCE = 2                  # from this version on a track with sections gets a beat list
MIN_CONFIDENCE = 0.8             # below this the grid does not explain enough of the track

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
_SECTION_BEATS = 68              # an unexplained start or end at least this long is fitted on its own (_fit needs 64)
_SECTION_ON = 3                  # on-windows a section needs
_MAX_SECTIONS = 8
_TEMPO_REACH = 0.25              # a section's tempo is searched this far around the track's main tempo
_OTHER_MIN = 0.5                 # autocorrelation a bar away that counts as a clear beat
_OTHER_RATIO = 0.7               # ... and how far below it the grid's own tempo must sit to be "another tempo"
_ACCENT_RATIO = 0.2              # the single beat this strong next to a peak 3 or 5 beats away: an accent, not a tempo


@dataclass(frozen=True)
class GridResult:
    bpm: float
    anchor_s: float                    # a downbeat: the first one at or just before 0:00 onwards
    confidence: float                  # share of the track's 32-beat windows whose pulse sits on this grid (0..1)
    residual_ms: Optional[float]       # median distance of those windows from the grid
    downbeat_confidence: float         # share of the bar-line vote the chosen beat won (0.25 = a coin toss)
    # A track with sections (a timing jump, a tempo change): every beat time in seconds, and which
    # one is the first downbeat. None: one steady grid (anchor_s + n * 60 / bpm).
    beats: Optional[np.ndarray] = field(default=None, compare=False)
    first_downbeat_index: int = 0


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


def _other_tempo(window: np.ndarray, period: float) -> bool:
    """The window has a clear beat, but not at `period` (frames): its autocorrelation one bar away
    peaks somewhere else within the tempo reach."""
    bar = 4 * period
    if len(window) < 2.5 * bar:
        return False
    ac = _autocorr(window)

    def at(lag: float) -> float:
        return float(ac[int(round(lag)) - 1: int(round(lag)) + 2].max())

    lo = int(bar * (1 - _TEMPO_REACH))
    peak = lo + int(np.argmax(ac[lo: int(bar * (1 + _TEMPO_REACH)) + 1]))
    anywhere = float(ac[peak])
    if anywhere < _OTHER_MIN or at(bar) >= _OTHER_RATIO * anywhere:
        return False
    # An accent every 3 or 5 beats of this tempo peaks there too, but then the single beat is in the
    # autocorrelation as well; a section at 4/3 or 4/5 of the tempo leaves nothing one beat away.
    on_a_beat = abs(peak - round(peak / period) * period) <= 1.5
    return not (on_a_beat and at(period) >= _ACCENT_RATIO * anywhere)


def _votes(own: np.ndarray, j: int, bins: int, bin_ms: float, env: np.ndarray, frame_of) -> np.ndarray:
    """Per window: +1 its own strongest pulse sits on the beat (bin j): for the grid. -1 the pulse is
    somewhere that is not a sixteenth (a timing jump), or the window's beat runs at another tempo:
    against. 0 says nothing: the pulse is on a sixteenth (an off-beat part louder than the kick for a
    while), the window has no beat (intro, breakdown), or its pulse is on the beat while something at
    another tempo is stronger. `frame_of(k)`: the envelope frame where beat k of the fold starts."""
    votes = np.zeros(len(own), dtype=int)
    quarter = bins / 4
    for i, pulse in enumerate(own):
        away = abs((pulse - j + bins / 2) % bins - bins / 2)
        if pulse >= 0 and away * bin_ms >= _TIGHT_MS and abs((away + quarter / 2) % quarter - quarter / 2) * bin_ms >= _TIGHT_MS:
            votes[i] = -1
            continue
        on = pulse >= 0 and away * bin_ms < _TIGHT_MS
        f0, f1 = int(frame_of(i * _HOP_BEATS)), int(frame_of(i * _HOP_BEATS + _WIN_BEATS))
        other = _other_tempo(env[max(f0, 0):f1], (f1 - f0) / _WIN_BEATS)
        votes[i] = (0 if other else 1) if on else (-1 if other else 0)
    return votes


def _confidence(votes: np.ndarray) -> float:
    """Share of the voting windows that are for the grid. Under a quarter of the track voting: no grid."""
    counted = int((votes != 0).sum())
    return float((votes == 1).sum() / counted) if counted >= max(3, len(votes) // 4) else 0.0


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
    confidence = _confidence(_votes(own, j, bins, bin_ms, env, lambda k: k * period))
    frac = _parabola(G[j - 1], G[j], G[(j + 1) % bins])
    return _Fit(
        period=period,
        phase=((j + frac) / bins * period) % period,
        clarity=float(G.max() / (G.mean() + 1e-12)),
        confidence=confidence,
        residual_ms=float(np.median(np.abs(resid[tight])) * bin_ms) if tight.any() else None,
    )


@dataclass(frozen=True)
class _Section:
    """A stretch of the track that one steady grid explains. Frames, from the start of the track."""
    a: float                      # centre of its first on-window
    b: float                      # centre of its last on-window
    period: float
    phase: float                  # one beat position
    n_on: int


def _grid_votes(env: np.ndarray, period: float, phase: float) -> tuple[np.ndarray, np.ndarray]:
    """Window centres (beats) and votes for the steady grid (period, phase) over `env`."""
    bins = int(round(period * _RES))
    E = _fold(env, period, bins)
    if E.shape[1] < 1:
        return np.empty(0), np.empty(0, dtype=int)
    j = int(round((phase % period) / period * bins)) % bins
    centres, _, _, own = _window_shifts(E, E.mean(axis=1))
    return centres, _votes(own, j, bins, period / bins / FPS * 1000, env, lambda k: k * period)


def _core(votes: np.ndarray) -> Optional[tuple[int, int, int]]:
    """The longest run of on-windows as (first, last, count). Two off-windows with no on between end a run."""
    best: Optional[tuple[int, int, int]] = None
    first = last = count = offs = 0
    for i, vote in enumerate(votes):
        if vote == 1:
            if count and offs >= 2:
                if best is None or count > best[2]:
                    best = (first, last, count)
                count = 0
            if not count:
                first = i
            last, count, offs = i, count + 1, 0
        elif vote == -1:
            offs += 1
    if count and (best is None or count > best[2]):
        best = (first, last, count)
    return best


def _sections(env: np.ndarray, lo: int, hi: int, fit: Optional[_Fit], main_bpm: Optional[float],
              budget: list[int]) -> list[_Section]:
    """The steady sections of env[lo:hi] in time order: the grid that explains most of it, then the same
    for what it leaves unexplained before and after. `fit`: the grid already fitted (the whole track)."""
    seg = env[lo:hi]
    if fit is None:
        if budget[0] <= 0:
            return []
        ac = _autocorr(seg)
        fit = _fit(seg, ac, _coarse_period(ac, main_bpm * (1 - _TEMPO_REACH), main_bpm * (1 + _TEMPO_REACH)))
        if fit is None:
            return []
    period, phase = fit.period, fit.phase
    for refit in (True, False):
        centres, votes = _grid_votes(seg, period, phase)
        core = _core(votes)
        if core is None:
            return []
        a, b = centres[core[0]] * period, centres[core[1]] * period
        if not refit or (a < _SECTION_BEATS * period and len(seg) - b < _SECTION_BEATS * period):
            break
        # Another section pulls a whole-range fit towards itself: measure this one on its own.
        s0, s1 = max(0, int(a - 16 * period)), min(len(seg), int(b + 16 * period))
        again = _fit(seg[s0:s1], _autocorr(seg[s0:s1]), period)
        if again is None:
            break
        period, phase = again.period, s0 + again.phase
    if main_bpm is not None and core[2] < _SECTION_ON:
        return []
    budget[0] -= 1
    main = main_bpm or 60.0 * FPS / period
    out: list[_Section] = []
    if a >= _SECTION_BEATS * period:
        out += _sections(env, lo, lo + int(a), None, main, budget)
    out.append(_Section(lo + a, lo + b, period, lo + phase, core[2]))
    if len(seg) - b >= _SECTION_BEATS * period:
        out += _sections(env, lo + int(b), hi, None, main, budget)
    return out


_TIGHT_FRAMES = _TIGHT_MS / 1000 * FPS


def _same_tempo(p: _Section, q: _Section) -> bool:
    """Over the shorter section the two grids drift apart by less than the tolerance."""
    short = p if p.b - p.a <= q.b - q.a else q
    beats = max((short.b - short.a) / short.period, _WIN_BEATS)
    return abs(p.period - q.period) * beats <= _TIGHT_FRAMES


def _same_grid(p: _Section, q: _Section, sixteenths: bool) -> bool:
    """One grid continues through both sections. With `sixteenths`, a whole number of sixteenths apart
    counts too: that is an off-beat part louder than the kick, not a timing jump."""
    if not _same_tempo(p, q):
        return False
    long, short = (p, q) if p.b - p.a >= q.b - q.a else (q, p)
    mid = (short.a + short.b) / 2
    beat = short.phase + round((mid - short.phase) / short.period) * short.period
    apart = (beat - long.phase + long.period / 2) % long.period - long.period / 2
    if sixteenths:
        quarter = long.period / 4
        apart = (apart + quarter / 2) % quarter - quarter / 2
    return abs(apart) <= _TIGHT_FRAMES


def _merge(sections: list[_Section]) -> list[_Section]:
    """Join neighbours that are one grid. A section between two that are exactly one grid, at their
    tempo, is dropped: time did not move across it, so it was another part, not another grid."""
    out = list(sections)

    def join(i: int, k: int) -> None:
        p, q = out[i], out[k]
        keep = p if p.n_on >= q.n_on else q
        out[i:k + 1] = [_Section(p.a, q.b, keep.period, keep.phase, p.n_on + q.n_on)]

    changed = True
    while changed:
        changed = False
        for i in range(len(out) - 1):
            if _same_grid(out[i], out[i + 1], sixteenths=True):
                join(i, i + 1)
                changed = True
                break
        else:
            for i in range(len(out) - 2):
                if _same_grid(out[i], out[i + 2], sixteenths=False) and _same_tempo(out[i], out[i + 1]):
                    join(i, i + 2)
                    changed = True
                    break
    return out


def _list_frames(env: np.ndarray, sections: list[_Section]) -> np.ndarray:
    """Beat positions (frames) through the sections. Between two sections the grid switches where the
    envelope stops landing on the first one's beats and starts landing on the second's."""
    frames = np.arange(len(env))
    times = np.empty(0)
    for i, sec in enumerate(sections):
        start = -2 * sec.period
        if i:
            prev = sections[i - 1]
            ta = prev.phase + np.arange(np.ceil((prev.b - prev.phase) / prev.period) - 16,
                                        np.floor((sec.a - prev.phase) / prev.period) + 17) * prev.period
            ta = ta[(ta >= 0) & (ta < len(env) - 1)]
            tb = np.clip(sec.phase + np.round((ta - sec.phase) / sec.period) * sec.period, 0, len(env) - 1)
            gain = np.concatenate([[0.0], np.cumsum(np.interp(ta, frames, env) - np.interp(tb, frames, env))])
            k = int(np.argmax(gain))                      # the first section keeps ta[:k]
            switch = ta[k] if k < len(ta) else ta[-1] + prev.period
            times = times[times < switch - 0.25 * prev.period]
            start = (times[-1] if len(times) else switch) + 0.5 * sec.period
        end = len(env) if i == len(sections) - 1 else sections[i + 1].a + 17 * sec.period
        times = np.concatenate([times, sec.phase + np.arange(
            np.ceil((start - sec.phase) / sec.period), np.floor((end - sec.phase) / sec.period) + 1) * sec.period])
    return times


def _list_result(env: np.ndarray, bands: np.ndarray, sections: list[_Section], seconds: float) -> Optional[GridResult]:
    """The beat list for a track with more than one section, scored by the same window vote."""
    frames = _list_frames(env, sections)
    seconds_of = frames / FPS + _FRAME0_S + _ONSET_LEAD_S
    frames = frames[(seconds_of >= -_EARLY_S) & (seconds_of <= seconds) & (frames < len(env) - 1)]
    if len(frames) < 2 * _WIN_BEATS:
        return None
    inside = np.maximum(frames, 0.0)
    gaps = np.diff(inside)
    beat = float(np.median(gaps))
    bins = int(round(beat * _RES))
    E = np.interp(inside[:-1][None, :] + (np.arange(bins)[:, None] / bins) * gaps[None, :], np.arange(len(env)), env)
    _, _, _, own = _window_shifts(E, E.mean(axis=1))
    votes = _votes(own, 0, bins, beat / bins / FPS * 1000, env, lambda k: inside[min(k, len(inside) - 1)])
    bar, bar_confidence = _bar_vote(bands, np.round(inside).astype(int))
    longest = max(sections, key=lambda sec: sec.b - sec.a)
    beats = np.round(frames / FPS + _FRAME0_S + _ONSET_LEAD_S, 5)
    return GridResult(
        bpm=round(float(60.0 * FPS / longest.period), 4),
        anchor_s=float(beats[bar]),
        confidence=round(_confidence(votes), 3),
        residual_ms=None,
        downbeat_confidence=round(bar_confidence, 3),
        beats=beats,
        first_downbeat_index=bar,
    )


def _fold_octave(period: float, hint_bpm: Optional[float]) -> float:
    """The octave of `period` nearest the hint: the hint decides half/double time, never the tempo."""
    return 60.0 * FPS / fold_bpm(60.0 * FPS / period, hint_bpm)


def _bar_vote(bands: np.ndarray, edges: np.ndarray) -> tuple[int, float]:
    """Which beat (mod 4, counted from the first) starts the bar. `edges`: the frame where each beat
    starts. Arrangement changes land on bar lines, so the strongest changes in the per-beat band
    energies vote."""
    n = len(edges) - 1
    if n < 12:
        return 0, 0.25
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
    """The beat grid for mono float audio at SAMPLE_RATE, or None when there is nothing to fit (too
    short, too long, silent): one steady grid, or a beat list (`beats`) for a track with a timing jump
    or a tempo change. A low `confidence` means the grid does not explain the track: do not use it.

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
    sections = _merge(_sections(env, 0, len(env), best, None, [_MAX_SECTIONS]))
    if len(sections) > 1:
        return _list_result(env, bands, sections, seconds)
    period_s = best.period / FPS
    first = best.phase / FPS + _FRAME0_S + _ONSET_LEAD_S      # beat 0 of the bar vote
    n_beats = int((bands.shape[1] - 1 - best.phase) / best.period) - 1
    bar, bar_confidence = _bar_vote(bands, np.round(best.phase + np.arange(n_beats + 1) * best.period).astype(int))
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
