"""A track's sections and phrase lines, measured from the low end along CrateMind's own beat grid.

NumPy only. Read-only by construction: it takes the band energies the grid detector computes and the
grid's beat times, and returns numbers.

Method (measured on real tracks, see docs/TRACK_STRUCTURE.md):
1. The low end (0-120 Hz) per beat splits into two classes, loud and quiet (Otsu threshold). The band
   below 60 Hz alone is not enough: a bass playing a higher note leaves it.
2. A loud beat is bass only when the low end also moves inside the beat, as a kick and a bass line
   make it move. A drone does not.
3. Runs shorter than two bars are merged into their neighbours: a short dropout is no section.
4. The beat where the bass comes in is an anchor. Phrase lines are counted from it, every 8 bars, up
   to the next anchor; before the first anchor they are counted backwards from it.
5. A bass stop shorter than three bars between two bass runs is a fill: it is no section, but the
   bass coming back after it is an anchor (a drop) when the bass played six bars up to it or came in
   just before it after a break; in a groove of short stops it is not. A stop after a weaker run (a
   build-up) stays a section, so the drop after it starts one. The lead-in and the closing are never fills.
6. After such a stop the kick-bass counts even without its sub, while the mid-bass (120-250 Hz) plays
   as it does under the full kick-bass and the sub returns soon.
7. With the grid's bar line known, an anchor one beat off it moves onto it (only for counting; the
   sections stay where they were measured). Two beats off stays.

The beats are the track's real beats: a grid in the wrong tempo octave is folded first (`fold_beats`),
so 32 beats are 8 real bars. A global phrase grid does not hold (the phrase shifts inside tracks), and
bass-outs are too irregular to anchor anything, so neither is used.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from .beatgrid_detect import FPS, _FRAME0_S, _ONSET_LEAD_S
from .tempo import SAME_TEMPO, positive_bpm

VERSION = 3                      # TrackStructure.version: bump when the method changes
PHRASE_BEATS = 32                # 8 bars
MIN_QUALITY = 0.7                # below this the low end does not split into loud and quiet (one bell curve gives 0.64)
_MIN_BEATS = 64
_MIN_RUN = 8                     # beats: a shorter run is not a section
_FILL = 3                        # beats: a shorter bass stop is a flicker, not a fill
_PAUSE = 12                      # beats: a shorter bass stop between two bass runs is a fill, not a break
_MIN_CLASS = 0.05                # each class holds at least this share of the beats
_LATE_LINE = 8                   # a phrase line this close before the next anchor gives way to it
_STEP = 0.5                      # the bass comes in when it rises this share of the loud/quiet gap within a bar
_SLICES = 8                      # a beat is cut into this many slices to see the low end move inside it
_MOVES = 0.3                     # the low end moves when it swings this share of its usual swing on the track's loud beats
_WEAKER = 0.7                    # a bass run that moves under this share of the next one is a build-up, not the same bass
_MID_WEIGHT = 0.1                # the mid-bass counts only in a track where it swings this share of the sub's swing
_MID_LEVEL = 0.5                 # ... and only this close under its level on the bass beats (log energy)
_BACK = 32                       # beats: after a drop without its sub, the full bass returns within this
_PLAYED = 24                     # beats of bass up to a fill for the bass after it to restart the count (measured, see _restarts)


@dataclass(frozen=True)
class Section:
    start_s: float
    beats: int
    bass: bool
    level: float                 # mean energy of all bands, 0..1 relative to the track's loudest section


@dataclass(frozen=True)
class Fill:
    start_s: float
    beats: int


@dataclass(frozen=True)
class Structure:
    quality: float               # share of the low-end variance the loud/quiet split explains (0..1)
    sections: tuple[Section, ...]
    anchors: tuple[float, ...]   # seconds: where the bass comes in (the start, when it plays from the first beat)
    phrases: tuple[float, ...]   # seconds: every phrase line, anchors included
    fills: tuple[Fill, ...] = ()  # bass stops under three bars inside a bass section
    bpm: Optional[float] = None  # the tempo of the beats it was measured along (set by the caller)


def tempo_factor(grid_bpm: Optional[float], bpm: Optional[float]) -> float:
    """2 when `bpm` (the track's resolved BPM) is about double the grid's tempo, 0.5 when about half,
    else 1: the deck's octave fold (frontend/src/lib/beatGrid.ts), limited to one octave."""
    grid, value = positive_bpm(grid_bpm), positive_bpm(bpm)
    if grid is None or value is None:
        return 1.0
    factor = min((0.5, 1.0, 2.0), key=lambda f: abs(grid * f - value))
    return factor if abs(grid * factor - value) / value <= SAME_TEMPO else 1.0


def fold_beats(times: np.ndarray, downbeat: int, factor: float) -> tuple[np.ndarray, int]:
    """The grid's beats moved into the real tempo octave, and the new index of its downbeat. Factor
    0.5: every second beat, starting on the bar line. Factor 2: a beat between every two."""
    times = np.asarray(times, dtype=float)
    if factor == 0.5:
        return times[downbeat % 2::2], downbeat // 2
    if factor == 2.0 and len(times) > 1:
        out = np.empty(2 * len(times) - 1)
        out[0::2] = times
        out[1::2] = (times[:-1] + times[1:]) / 2
        return out, 2 * downbeat
    return times, downbeat


def _split(x: np.ndarray) -> tuple[float, float]:
    """(threshold, share of the variance between the two classes) of the best two-class split."""
    xs = np.sort(x)
    n = len(xs)
    total = float(xs.var())
    if total <= 0:
        return float(xs[0]), 0.0
    c = np.cumsum(xs)
    i = np.arange(1, n)                                      # classes xs[:i] and xs[i:]
    between = i * (n - i) * (c[i - 1] / i - (c[-1] - c[i - 1]) / (n - i)) ** 2 / n ** 2
    edge = max(1, int(n * _MIN_CLASS))
    between[:edge - 1] = 0
    between[n - edge:] = 0
    k = int(np.argmax(between)) + 1
    return float((xs[k - 1] + xs[k]) / 2), float(between[k - 1] / total)


def _merge_short(on: np.ndarray, shortest: int = _MIN_RUN) -> np.ndarray:
    """`on` with every run shorter than `shortest` beats flipped into its neighbours, shortest first.
    A short lead-in without bass stays: flipped, it would move the first bass-in to the first beat."""
    on = on.copy()
    while True:
        bounds = np.concatenate([[0], np.flatnonzero(np.diff(on)) + 1, [len(on)]])
        runs = np.diff(bounds).astype(float)
        if not on[0]:
            runs[0] = np.inf
        if len(runs) < 2 or runs.min() >= shortest:
            return on
        i = int(np.argmin(runs))
        on[bounds[i]:bounds[i + 1]] = 1 - on[bounds[i]]


def _runs(on: np.ndarray) -> list[tuple[int, int]]:
    """(start, end) of every run of equal values in `on`."""
    bounds = np.concatenate([[0], np.flatnonzero(np.diff(on)) + 1, [len(on)]])
    return [(int(a), int(b)) for a, b in zip(bounds[:-1], bounds[1:])]


def _moving(swing: np.ndarray, usual: float) -> np.ndarray:
    """Where the band moves inside the beat: at least `_MOVES` of its usual swing. A still beat between
    two moving ones counts too (a kick on every second beat)."""
    moves = swing >= _MOVES * usual
    moves[1:-1] |= moves[:-2] & moves[2:]
    return moves


def _restarts(steady: np.ndarray, stop: int) -> bool:
    """Whether the bass coming back after a fill that starts at beat `stop` restarts the count: the bass played six
    bars or more up to it, or came in after a break (or at the start) just before it, a tease before the drop.
    Inside a groove of short stops (two bars on, one off) the returns mark no phrase: on two samples of about 145
    tracks, those after under six bars of bass fell on the 8-bar count 1-33% of the time, those after six to eight
    bars 85-90%."""
    gone = np.flatnonzero(steady[:stop] == 0)
    if not len(gone):
        return True
    began = int(gone[-1]) + 1                                # where the bass run before the stop began
    if stop - began >= _PLAYED:
        return True
    played = np.flatnonzero(steady[:began] == 1)
    return not len(played) or began - int(played[-1]) - 1 >= _PAUSE


def _drops_without_sub(on: np.ndarray, steady: np.ndarray, bass: np.ndarray, mid_bass: np.ndarray) -> list[tuple[int, int]]:
    """Runs (start, end) where the kick-bass plays without its sub right after a short stop: the bass
    run before it ends, both bands stop for at least `_FILL` beats, the mid-bass comes back within
    `_PAUSE` beats of that end and holds for a phrase, and the full bass returns within `_BACK` beats.
    Shorter ones are fills and rolls with something in the mid-bass: measured, they start off the bar line."""
    n = len(on)
    held = _merge_short((mid_bass | bass).astype(np.int8), _FILL)
    whole = held.copy()
    for a, b in _runs(held)[1:-1]:
        if not held[a] and b - a < _MIN_RUN:
            whole[a:b] = 1                                   # a fill inside it does not end it
    drops = []
    for a, b in _runs(on)[1:]:
        still = np.flatnonzero(held[a:b] == 0)
        if on[a] or not len(still) or still[0] >= _MIN_RUN:
            continue                                         # no stop: the mid-bass runs on (a sub filtered out, an outro)
        stop = a + int(still[0])
        back = np.flatnonzero(held[stop:b])
        if not len(back):
            continue
        start = stop + int(back[0])
        if start - stop < _FILL or start - a >= _PAUSE:
            continue
        gone = np.flatnonzero(whole[start:b] == 0)
        end = start + int(gone[0]) if len(gone) else b
        returns = (end == b and b < n) or bool(steady[end:end + _BACK].any())
        if end - start >= PHRASE_BEATS and returns:
            drops.append((start, end))
    return drops


def structure_from_beats(per_beat: np.ndarray, times: np.ndarray, downbeat: Optional[int] = None,
                         swing: Optional[np.ndarray] = None) -> Optional[Structure]:
    """`per_beat`: band energies per beat (bands x beats, from the lowest band up). `times`: when each
    of those beats starts, in seconds. `downbeat`: the index of a beat on the grid's bar line (it may
    lie outside the beats); without it no anchor moves. `swing`: how far the energy moves inside each
    beat, for 0-120 Hz and for 120-250 Hz (2 x beats); without it every loud beat is bass and nothing
    is read from the mid-bass. None when the track has no bass on/off structure to read."""
    n = per_beat.shape[1]
    if n < _MIN_BEATS or len(times) != n:
        return None
    low = np.log1p(np.expm1(per_beat[0]) + np.expm1(per_beat[1]))        # 0-120 Hz
    threshold, quality = _split(low)
    if quality < MIN_QUALITY:
        return None
    loud = low > threshold
    usual = float(np.median(swing[0][loud])) if swing is not None else 0.0
    share = np.clip(swing[0] / usual, 0.0, 1.0) if usual > 0 else None    # the low end's movement, 1 = as on the loud beats
    bass = loud & _moving(swing[0], usual) if share is not None else loud
    steady = _merge_short(bass.astype(np.int8), _FILL)
    on = _merge_short(steady)
    if not _MIN_CLASS <= on.mean() <= 1 - _MIN_CLASS:
        return None                                          # the merge left one class: no sections to tell apart
    gap = float(low[loud].mean() - low[~loud].mean())

    def comes_in(a: int) -> bool:
        """The bass does not fade in at beat `a` (a filter opening): its level or its movement steps up."""
        before = slice(max(0, a - 4), a)
        return a == 0 or low[a:a + 4].mean() - low[before].mean() >= _STEP * gap or (
            share is not None and share[a:a + 4].mean() - share[before].mean() >= _STEP)

    anchors = {a for a, _ in _runs(on) if on[a] and comes_in(a)}
    # A stop too short for a section, with the bass back for at least two bars: a drop, so it restarts the count.
    stops = _runs(steady)
    fills = [(a, b) for (a, b), (_, c) in zip(stops[1:-1], stops[2:])
             if not steady[a] and b - a < _MIN_RUN and c - b >= _MIN_RUN and on[a - 1]]
    if share is not None and bass.any():
        usual_mid = float(np.median(swing[1][bass]))
        if usual_mid > 0 and usual_mid >= _MID_WEIGHT * usual:
            mid_bass = _moving(swing[1], usual_mid) & (per_beat[2] >= np.median(per_beat[2][bass]) - _MID_LEVEL)
            for start, end in _drops_without_sub(on, steady, bass, mid_bass):
                a = start - int(np.argmax(on[:start][::-1])) if on[:start].any() else start    # the end of the bass run before it
                on[start:end] = 1
                anchors.add(start)
                if start - a < _MIN_RUN:
                    on[a:start] = 1
                    fills.append((a, start))
    # A stop under three bars between two bass runs is a fill too, unless the run before it is weaker
    # (a build-up, a tease): then the stop stays, and the drop after it starts a section.
    runs = _runs(on)
    for (before, a), (_, b), (_, after) in zip(runs, runs[1:], runs[2:]):
        if on[a] or b - a >= _PAUSE:
            continue
        if share is not None and np.median(share[before:a]) < _WEAKER * np.median(share[b:min(after, b + 2 * PHRASE_BEATS)]):
            continue
        fills.append((a, b))
    for a, b in fills:
        on[a:b] = 1
        if _restarts(steady, a):
            anchors.add(b)
    anchors = sorted(a for a in anchors if on[a])
    if not anchors:
        return None
    bounds = np.concatenate([[0], np.flatnonzero(np.diff(on)) + 1, [n]])
    volume = per_beat.mean(axis=0)
    levels = np.array([volume[a:b].mean() for a, b in zip(bounds[:-1], bounds[1:])])
    top = float(levels.max())
    sections = tuple(
        Section(start_s=round(float(times[a]), 3), beats=int(b - a), bass=bool(on[a]),
                level=round(float(level / top), 3) if top > 0 else 0.0)
        for a, b, level in zip(bounds[:-1], bounds[1:], levels))
    if downbeat is not None:
        # One beat off the bar line is the grid's bar line: the count starts on it (a kick roll, a late bass).
        anchors = sorted({a + {1: -1, 3: 1}.get((a - downbeat) % 4, 0) if 0 < a < n - 1 else a for a in anchors})
    lines = list(range(anchors[0], -1, -PHRASE_BEATS))[::-1]           # the intro, counted back from the first bass
    for a, nxt in zip(anchors, anchors[1:] + [n + _LATE_LINE]):
        lines += [k for k in range(a + PHRASE_BEATS, nxt, PHRASE_BEATS) if nxt - k >= _LATE_LINE and k < n]
        if nxt < n:
            lines.append(nxt)
    return Structure(
        quality=round(quality, 3), sections=sections,
        anchors=tuple(round(float(times[a]), 3) for a in anchors),
        phrases=tuple(round(float(times[k]), 3) for k in lines),
        fills=tuple(Fill(start_s=round(float(times[a]), 3), beats=b - a) for a, b in sorted(fills)))


def _swing(bands: np.ndarray, edges: np.ndarray) -> np.ndarray:
    """How far the energy moves inside each beat (2 x beats): the highest minus the lowest of the
    beat's `_SLICES` slices, for 0-120 Hz and for 120-250 Hz. `edges`: the first frame of each beat."""
    start, width = edges[:-1], edges[1:] - edges[:-1]
    cuts = start + width * np.arange(_SLICES + 1)[:, None] // _SLICES     # (slices + 1) x beats
    lo = cuts[:-1]
    hi = np.minimum(np.maximum(cuts[1:], lo + 1), bands.shape[1])         # every slice holds a frame
    lo = np.minimum(lo, hi - 1)
    out = []
    for group in (bands[:2], bands[2:3]):
        c = np.concatenate([[0.0], np.cumsum(np.expm1(group).sum(axis=0))])
        mean = (c[hi] - c[lo]) / (hi - lo)
        out.append(mean.max(axis=0) - mean.min(axis=0))
    return np.vstack(out)


def detect_structure(bands: np.ndarray, beat_times: np.ndarray, downbeat: Optional[int] = None) -> Optional[Structure]:
    """The structure of a track from its per-frame band energies (`beatgrid_detect.spectral`) and the
    beat times of its grid, in seconds. `downbeat`: the index in `beat_times` of a beat on the bar line."""
    times = np.asarray(beat_times, dtype=float)
    frames = (times - _FRAME0_S - _ONSET_LEAD_S) * FPS
    # A beat at 0:00 starts just before the first frame's centre: it is kept, measured from frame 0 on.
    inside = (np.append(frames[1:], np.inf) >= 1) & (frames < bands.shape[1] - 1)
    if downbeat is not None and inside.any():
        downbeat -= int(np.argmax(inside))                   # the beats before the audio are dropped
    times, edges = times[inside], np.clip(np.round(frames[inside]), 0, None).astype(int)
    if len(edges) < _MIN_BEATS + 1:
        return None
    c = np.concatenate([np.zeros((bands.shape[0], 1)), np.cumsum(bands, axis=1)], axis=1)
    per_beat = (c[:, edges[1:]] - c[:, edges[:-1]]) / np.maximum(1, edges[1:] - edges[:-1])
    return structure_from_beats(per_beat, times[:-1], downbeat, _swing(bands, edges))
