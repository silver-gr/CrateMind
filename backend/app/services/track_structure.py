"""A track's sections and phrase lines, measured from the sub-bass along CrateMind's own beat grid.

NumPy only. Read-only by construction: it takes the band energies the grid detector computes and the
grid's beat times, and returns numbers.

Method (measured on real tracks, see docs/TRACK_STRUCTURE.md):
1. Sub-bass energy per beat splits into two classes, bass on and bass off (Otsu threshold).
2. Runs shorter than two bars are merged into their neighbours: a short dropout is a fill, not a section.
3. The beat where the bass comes in is an anchor. Phrase lines are counted from it, every 8 bars, up
   to the next anchor; before the first anchor they are counted backwards from it.

A global phrase grid does not hold (the phrase shifts inside tracks), and bass-outs are too irregular
to anchor anything, so neither is used.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from .beatgrid_detect import FPS, _FRAME0_S, _ONSET_LEAD_S

VERSION = 1                      # TrackStructure.version: bump when the method changes
PHRASE_BEATS = 32                # 8 bars
MIN_QUALITY = 0.7                # below this the sub-bass does not split into on and off (one bell curve gives 0.64)
_MIN_BEATS = 64
_MIN_RUN = 8                     # beats: a shorter run is not a section
_MIN_CLASS = 0.05                # each class holds at least this share of the beats
_LATE_LINE = 8                   # a phrase line this close before the next anchor gives way to it
_STEP = 0.5                      # the bass comes in when it rises this share of the on/off gap within a bar


@dataclass(frozen=True)
class Section:
    start_s: float
    beats: int
    bass: bool
    level: float                 # mean energy of all bands, 0..1 relative to the track's loudest section


@dataclass(frozen=True)
class Structure:
    quality: float               # share of the sub-bass variance the on/off split explains (0..1)
    sections: tuple[Section, ...]
    anchors: tuple[float, ...]   # seconds: where the bass comes in (the start, when it plays from the first beat)
    phrases: tuple[float, ...]   # seconds: every phrase line, anchors included


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


def _merge_short(on: np.ndarray) -> np.ndarray:
    """`on` with every run shorter than _MIN_RUN beats flipped into its neighbours, shortest first.
    A short lead-in without bass stays: flipped, it would move the first bass-in to the first beat."""
    on = on.copy()
    while True:
        bounds = np.concatenate([[0], np.flatnonzero(np.diff(on)) + 1, [len(on)]])
        runs = np.diff(bounds).astype(float)
        if not on[0]:
            runs[0] = np.inf
        if len(runs) < 2 or runs.min() >= _MIN_RUN:
            return on
        i = int(np.argmin(runs))
        on[bounds[i]:bounds[i + 1]] = 1 - on[bounds[i]]


def structure_from_beats(per_beat: np.ndarray, times: np.ndarray) -> Optional[Structure]:
    """`per_beat`: band energies per beat (bands x beats, the sub-bass first). `times`: when each of
    those beats starts, in seconds. None when the track has no bass on/off structure to read."""
    n = per_beat.shape[1]
    if n < _MIN_BEATS or len(times) != n:
        return None
    threshold, quality = _split(per_beat[0])
    if quality < MIN_QUALITY:
        return None
    on = _merge_short((per_beat[0] > threshold).astype(np.int8))
    if not _MIN_CLASS <= on.mean() <= 1 - _MIN_CLASS:
        return None                                          # the merge left one class: no sections to tell apart
    bounds = np.concatenate([[0], np.flatnonzero(np.diff(on)) + 1, [n]])
    loud = per_beat.mean(axis=0)
    levels = np.array([loud[a:b].mean() for a, b in zip(bounds[:-1], bounds[1:])])
    top = float(levels.max())
    sections = tuple(
        Section(start_s=round(float(times[a]), 3), beats=int(b - a), bass=bool(on[a]),
                level=round(float(level / top), 3) if top > 0 else 0.0)
        for a, b, level in zip(bounds[:-1], bounds[1:], levels))
    sub = per_beat[0]
    gap = float(sub[on == 1].mean() - sub[on == 0].mean())
    # A bass run that fades in (a filter opening) has no beat where the bass comes in: it restarts no count.
    anchors = [int(a) for a in bounds[:-1] if on[a] and (a == 0 or sub[a:a + 4].mean() - sub[max(0, a - 4):a].mean() >= _STEP * gap)]
    if not anchors:
        return None
    lines = list(range(anchors[0], -1, -PHRASE_BEATS))[::-1]           # the intro, counted back from the first bass
    for a, nxt in zip(anchors, anchors[1:] + [n + _LATE_LINE]):
        lines += [k for k in range(a + PHRASE_BEATS, nxt, PHRASE_BEATS) if nxt - k >= _LATE_LINE and k < n]
        if nxt < n:
            lines.append(nxt)
    return Structure(
        quality=round(quality, 3), sections=sections,
        anchors=tuple(round(float(times[a]), 3) for a in anchors),
        phrases=tuple(round(float(times[k]), 3) for k in lines))


def detect_structure(bands: np.ndarray, beat_times: np.ndarray) -> Optional[Structure]:
    """The structure of a track from its per-frame band energies (`beatgrid_detect.spectral`) and the
    beat times of its grid, in seconds."""
    times = np.asarray(beat_times, dtype=float)
    frames = (times - _FRAME0_S - _ONSET_LEAD_S) * FPS
    # A beat at 0:00 starts just before the first frame's centre: it is kept, measured from frame 0 on.
    inside = (np.append(frames[1:], np.inf) >= 1) & (frames < bands.shape[1] - 1)
    times, edges = times[inside], np.clip(np.round(frames[inside]), 0, None).astype(int)
    if len(edges) < _MIN_BEATS + 1:
        return None
    c = np.concatenate([np.zeros((bands.shape[0], 1)), np.cumsum(bands, axis=1)], axis=1)
    per_beat = (c[:, edges[1:]] - c[:, edges[:-1]]) / np.maximum(1, edges[1:] - edges[:-1])
    return structure_from_beats(per_beat, times[:-1])
