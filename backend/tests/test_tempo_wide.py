"""Therapy wide estimator (final-A): 40-240 BPM, no octave pull, no value when unclear.

Every expected tempo was measured on the ported synthetic generators in
tests/tempo_signals.py (final-A/scoreboard_final1.json and the skeptic results_*.json);
each case runs at 60 s and 30 s and must land within 2 % of its measured value.
Synthetic signals only: no real audio, no ffmpeg.
"""
from __future__ import annotations

import numpy as np
import pytest

from app.models import Track
from app.services import audio_analysis as aa
from app.services import bpm_consensus as bc
from app.services.tempo import effective_bpm
from app.services.tempo_ranges import TEMPO_RANGES
from tests import tempo_signals as ts

SR = aa.SAMPLE_RATE
THERAPY = TEMPO_RANGES["therapy"]
SECONDS = (60.0, 30.0)


def _near(bpm: float, expected: float) -> bool:
    return abs(bpm - expected) <= 0.02 * expected


def _wide(audio: np.ndarray) -> tuple[float, float]:
    return aa._estimate_bpm_wide(audio)


@pytest.mark.parametrize("seconds", SECONDS)
@pytest.mark.parametrize("name, measured", [("click-50", 50.01), ("click-60", 60.0), ("click-72", 72.0)])
def test_spec_clicks_50_60_72(name, measured, seconds):
    bpm, raw, conf, method = aa.estimate_bpm(ts.bench_signal(name, seconds), THERAPY)
    assert _near(bpm, measured), (name, seconds, bpm)
    assert bpm == raw
    assert conf >= aa.THERAPY_CONF_GATE
    assert method == "librosa-onset-wide-v1@40-240"


@pytest.mark.parametrize("seconds", SECONDS)
@pytest.mark.parametrize("name, measured", [("piano-60", 60.0), ("piano-72", 72.0), ("click-40", 40.0)])
def test_slow_music_and_floor(name, measured, seconds):
    bpm, _conf = _wide(ts.bench_signal(name, seconds))
    assert _near(bpm, measured), (name, seconds, bpm)


@pytest.mark.parametrize("seconds", SECONDS)
@pytest.mark.parametrize("case, measured", [
    (lambda sec: ts.rm_signal("minimal-128", sec), 128.01),   # house(128, ..., "minimal")
    (lambda sec: ts.rm_signal("minimal2-124", sec), 124.01),  # house(124, ..., "minimal")
    (lambda sec: ts.bench_signal("psy-142", sec), 142.01),
])
def test_fast_stays_fast(case, measured, seconds):
    bpm, _conf = _wide(case(seconds))
    assert _near(bpm, measured), (measured, seconds, bpm)


@pytest.mark.parametrize("seconds", SECONDS)
@pytest.mark.parametrize("case, measured", [
    (lambda sec: ts.rm_signal("pop68-50", sec), 50.0),        # measured 50.01 / 49.99
    (lambda sec: ts.rm_signal("pop68-70", sec), 69.99),
    (lambda sec: ts.slow_signal("lull68-piano-dq56", sec), 56.0),  # measured 56.0 / 55.99
])
def test_six_eight_reports_dotted_quarter(case, measured, seconds):
    bpm, _conf = _wide(case(seconds))
    assert _near(bpm, measured), (measured, seconds, bpm)
    assert not _near(bpm, 3 * measured)


@pytest.mark.parametrize("seconds", SECONDS)
@pytest.mark.parametrize("case, measured", [
    (lambda sec: ts.rm_signal("met-120-acc3", sec), 119.99),  # metronome(120, every=3)
    (lambda sec: ts.slow_signal("lull34-piano-voice-72", sec), 72.0),
])
def test_waltz_reports_beat(case, measured, seconds):
    bpm, _conf = _wide(case(seconds))
    assert _near(bpm, measured), (measured, seconds, bpm)
    assert not _near(bpm, measured / 3)  # never the bar


@pytest.mark.parametrize("seconds", SECONDS)
@pytest.mark.parametrize("name, measured", [("heartbeat-60", 60.0), ("heartbeat-72", 72.0)])
def test_heartbeat(name, measured, seconds):
    bpm, conf = _wide(ts.rm_signal(name, seconds))  # measured conf 0.850 / 0.820 at 60 s
    assert _near(bpm, measured), (name, seconds, bpm)
    assert conf >= aa.THERAPY_CONF_GATE


@pytest.mark.parametrize("seconds", SECONDS)
def test_gait_metronome(seconds):
    # metronome(116, every=2, accent_db=12), measured 116.0
    bpm, _conf = _wide(ts.rm_signal("met-116-acc2-strong", seconds))
    assert _near(bpm, 116.0), (seconds, bpm)
    assert not _near(bpm, 58.0)


@pytest.mark.parametrize("seconds", SECONDS)
def test_no_clear_tempo(seconds):
    noise = np.random.default_rng(1).standard_normal(int(SR * seconds)) * 0.1
    for audio in (ts.bench_signal("ambient", seconds), noise, np.zeros(int(SR * seconds), dtype=np.float32)):
        with pytest.raises(aa.NoClearTempo) as info:
            _wide(audio)
        assert info.value.confidence < aa.THERAPY_CONF_GATE
        assert str(info.value) == "no clear tempo"


def test_invalid_input():
    short = ts.click_train(60, 9.99, 1)
    nan = ts.click_train(60, 20.0, 1)
    nan[1000] = np.nan
    inf = ts.click_train(60, 20.0, 1)
    inf[1000] = np.inf
    for audio in (short, nan, inf):
        with pytest.raises(RuntimeError) as info:
            _wide(audio)
        assert type(info.value) is RuntimeError  # not NoClearTempo, never librosa's ParameterError


@pytest.mark.parametrize("seconds", SECONDS)
@pytest.mark.parametrize("bpm", (  # bench.CLICK_BPMS
    40, 45, 50, 55, 60, 66, 72, 80, 90, 100, 110, 120, 128, 135, 140, 145, 150, 160, 175, 190))
def test_click_sweep(bpm, seconds):
    got, _conf = _wide(ts.bench_signal(f"click-{bpm}", seconds))
    assert _near(got, bpm), (bpm, seconds, got)


def test_deterministic():
    audio = ts.bench_signal("piano-60", 30.0)
    assert _wide(audio) == _wide(audio)


def test_therapy_never_falls_back(monkeypatch):
    calls = []

    def wide(audio, lo=40.0, hi=240.0):
        raise RuntimeError("x")

    def autocorr(audio):
        calls.append(audio)
        return 100.0, 0.5

    monkeypatch.setattr(aa, "_estimate_bpm_wide", wide)
    monkeypatch.setattr(aa, "_estimate_bpm_autocorr", autocorr)
    with pytest.raises(RuntimeError, match="x"):
        aa.estimate_bpm(ts.bench_signal("click-60", 30.0), THERAPY)
    assert calls == []


def _sections(monkeypatch, by_start):
    """intro covers the first section (30-90 s); decode_audio serves the 120 s and 210 s ones."""
    monkeypatch.setattr(aa, "decode_audio", lambda path, *, start=0, seconds=0: by_start[start])
    calls = []
    real = aa.estimate_bpm

    def counting(audio, tempo_range=TEMPO_RANGES["psy"]):
        calls.append(audio.size)
        return real(audio, tempo_range)

    monkeypatch.setattr(aa, "estimate_bpm", counting)
    return calls


def test_file_bpm_skips_unclear_sections(monkeypatch):
    clicks = ts.click_train(60, 120.0, 7)
    ambient = ts.ambient(60.0, 11)
    calls = _sections(monkeypatch, {120: ambient, 210: ts.click_train(60, 60.0, 8)})
    bpm, raw, _conf, method = aa.estimate_file_bpm("/track", clicks, THERAPY)
    assert _near(bpm, 60.0) and bpm == raw
    assert method == THERAPY.method
    assert len(calls) == 3

    intro = ts.ambient(120.0, 12)
    later = {120: ts.ambient(60.0, 13), 210: ts.ambient(60.0, 14)}
    confidences = []
    for section in (intro[30 * SR:90 * SR], later[120], later[210]):
        with pytest.raises(aa.NoClearTempo) as info:
            aa._estimate_bpm_wide(section)
        confidences.append(info.value.confidence)
    calls = _sections(monkeypatch, later)
    with pytest.raises(aa.NoClearTempo) as info:
        aa.estimate_file_bpm("/track", intro, THERAPY)
    assert info.value.confidence == max(confidences)
    assert len(calls) == 3  # the intro is not re-run


def _therapy_track(**values) -> Track:
    return Track(absolute_path="/therapy.wav", bpm_analyzed_method=THERAPY.method, **values)


def test_therapy_consensus_never_masks_local():
    track = _therapy_track(bpm_analyzed=60.0, bpm_essentia=180.0, bpm_reccobeats=180.0)
    bc._refresh_consensus(track, 5.0)
    assert track.bpm_consensus is None and track.bpm_consensus_sources is None
    assert effective_bpm(track) == 60.0

    track = _therapy_track(bpm_analyzed=60.0, bpm_essentia=120.0)
    bc._refresh_consensus(track, 5.0)
    assert track.bpm_consensus == 60.0
    assert track.bpm_consensus_sources == "local+essentia"

    track = _therapy_track(bpm_analyzed=None, bpm_essentia=180.0, bpm_reccobeats=180.0)
    bc._refresh_consensus(track, 5.0)
    assert track.bpm_consensus is None
    assert effective_bpm(track) is None

    track = _therapy_track(bpm=100.0, bpm_analyzed=60.0, bpm_essentia=180.0, bpm_reccobeats=180.0)
    bc._refresh_consensus(track, 5.0)
    assert (track.bpm_consensus, track.bpm_consensus_sources) == (100.0, "metadata")

    track = _therapy_track(bpm_consensus=120.0, bpm_consensus_sources="manual:octave",
                           bpm_analyzed=60.0, bpm_essentia=180.0, bpm_reccobeats=180.0)
    bc._refresh_consensus(track, 5.0)
    assert (track.bpm_consensus, track.bpm_consensus_sources) == (120.0, "manual:octave")
    assert effective_bpm(track) == 120.0

    # DJ-window tracks keep today's rule: the providers' cluster wins without the local vote.
    track = Track(absolute_path="/dj.wav", bpm_analyzed_method=TEMPO_RANGES["psy"].method,
                  bpm_analyzed=140.0, bpm_essentia=180.0, bpm_reccobeats=180.0)
    bc._refresh_consensus(track, 5.0)
    assert (track.bpm_consensus, track.bpm_consensus_sources) == (180.0, "essentia+reccobeats")


def test_analyze_file_stores_no_clear_tempo_without_error(monkeypatch):
    monkeypatch.setattr(aa, "decode_audio",
                        lambda path, *, start=0, seconds=aa.WINDOW_SECONDS: ts.ambient(seconds, 21 + start))
    res = aa.analyze_file("/ambient.wav", run_essentia=False, tempo_range=THERAPY)
    assert res.bpm is None and res.bpm_raw is None
    assert res.error is None
    assert res.bpm_method == TEMPO_RANGES["therapy"].method
    assert res.bpm_confidence is not None and res.bpm_confidence < aa.THERAPY_CONF_GATE
    assert res.key is not None  # key analysis still runs
