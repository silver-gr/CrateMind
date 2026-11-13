"""CrateMind's own beat grid, on audio synthesised here (never on real files)."""
import numpy as np
import pytest

from app.services import beatgrid_detect as bd

SR = bd.SAMPLE_RATE
RNG = np.random.default_rng(7)


def _kick() -> np.ndarray:
    t = np.arange(int(0.18 * SR)) / SR
    body = np.sin(2 * np.pi * (50 * t + 60 * (1 - np.exp(-t * 40)) / 40)) * np.exp(-t * 22)
    click = RNG.standard_normal(len(t)) * np.exp(-t * 900) * 0.6
    return (body + click).astype(np.float32)


def _hat() -> np.ndarray:
    t = np.arange(int(0.05 * SR)) / SR
    noise = RNG.standard_normal(len(t) + 4)
    highs = np.diff(noise, n=4)                         # four differences: almost nothing below 3 kHz
    return (highs / np.abs(highs).max() * np.exp(-t * 90)).astype(np.float32)


def _place(track: np.ndarray, sound: np.ndarray, times, gain: float = 1.0) -> None:
    for t in times:
        i = int(round(t * SR))
        if 0 <= i < len(track) - len(sound):
            track[i:i + len(sound)] += sound * gain


def _track(bpm: float, first: float, seconds: float = 90.0) -> tuple[np.ndarray, np.ndarray]:
    track = RNG.standard_normal(int(seconds * SR)).astype(np.float32) * 0.002
    beats = np.arange(first, seconds - 1, 60.0 / bpm)
    _place(track, _kick(), beats)
    return track, beats


def _phase_error_ms(anchor: float, first: float, bpm: float) -> float:
    period = 60.0 / bpm
    return abs((anchor - first + period / 2) % period - period / 2) * 1000


def test_steady_kicks_give_the_tempo_and_the_beat():
    track, _ = _track(140.0, first=0.25)
    grid = bd.detect_grid(track, hint_bpm=140)
    assert grid is not None
    assert grid.bpm == pytest.approx(140.0, abs=0.02)
    # The onset lead is calibrated on real kicks; a synthetic click is sharper and reads ~6 ms early.
    assert _phase_error_ms(grid.anchor_s, 0.25, 140.0) < 8
    assert grid.confidence >= 0.95
    assert -bd._EARLY_S <= grid.anchor_s < 4 * 60 / 140


def test_louder_offbeat_hats_do_not_steal_the_beat():
    track, beats = _track(128.0, first=0.1)
    _place(track, _hat(), beats + 30.0 / 128.0, gain=4.0)
    grid = bd.detect_grid(track, hint_bpm=128)
    assert grid.bpm == pytest.approx(128.0, abs=0.02)
    assert _phase_error_ms(grid.anchor_s, 0.1, 128.0) < 8


def test_the_bar_line_follows_arrangement_changes():
    bpm, first = 140.0, 0.2
    track, beats = _track(bpm, first)
    period = 60.0 / bpm
    t = np.arange(len(track)) / SR
    pad = np.sin(2 * np.pi * 330 * t) + np.sin(2 * np.pi * 495 * t)
    # A pad comes and goes every 16 beats, starting two beats in: the bars start at beat 2.
    section = np.floor((t - (first + 2 * period)) / (16 * period)).astype(int)
    track += (pad * 0.15 * ((section % 2 == 0) & (section >= 0))).astype(np.float32)
    grid = bd.detect_grid(track, hint_bpm=bpm)
    bars_off = ((grid.anchor_s - (first + 2 * period)) / period) % 4
    assert min(bars_off, 4 - bars_off) < 0.05
    assert grid.downbeat_confidence > 0.5


def test_a_tempo_ramp_is_not_steady():
    seconds = 90.0
    track = RNG.standard_normal(int(seconds * SR)).astype(np.float32) * 0.002
    t, beats = 0.2, []
    while t < seconds - 1:
        beats.append(t)
        t += 60.0 / (120.0 + 20.0 * t / seconds)      # 120 -> 140 BPM
    _place(track, _kick(), beats)
    grid = bd.detect_grid(track)
    assert grid is None or grid.confidence < bd.MIN_CONFIDENCE


def test_no_grid_for_short_silent_or_overlong_audio():
    assert bd.detect_grid(np.zeros(SR * 10, np.float32)) is None            # too short
    assert bd.detect_grid(np.zeros(SR * 60, np.float32)) is None            # silent
    assert bd.detect_grid(np.zeros(SR * (bd.MAX_SECONDS + 5), np.float32)) is None


def test_the_hint_only_chooses_the_octave():
    track, _ = _track(100.0, first=0.3)
    assert bd.detect_grid(track, hint_bpm=200).bpm == pytest.approx(200.0, abs=0.05)
    assert bd.detect_grid(track, hint_bpm=97).bpm == pytest.approx(100.0, abs=0.02)   # a wrong hint cannot move the tempo
    assert bd.fold_bpm(100.0, 190.0) == 200.0
    assert bd.fold_bpm(100.0, None) == 100.0
