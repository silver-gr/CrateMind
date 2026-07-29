"""BPM + key estimation and the analyze_all DB writer.

DSP tests use synthesized numpy arrays (no ffmpeg, no real files) so they are
fast and hermetic. analyze_all is tested with analyze_file monkeypatched, so it
exercises selection/idempotency without decoding audio.
"""
from __future__ import annotations

import numpy as np

from app.models import Track
from app.services import audio_analysis as aa

SR = aa.SAMPLE_RATE


def _sine(freq: float, seconds: float = 12.0) -> np.ndarray:
    t = np.arange(int(SR * seconds)) / SR
    return np.sin(2 * np.pi * freq * t).astype(np.float32)


def _click_track(bpm: float, seconds: float = 20.0) -> np.ndarray:
    audio = np.zeros(int(SR * seconds), dtype=np.float32)
    step = int(SR * 60.0 / bpm)
    audio[::step] = 1.0  # impulses at the beat
    return audio


def test_estimate_bpm_recovers_tempo():
    bpm, raw, conf, method = aa.estimate_bpm(_click_track(120.0))
    # accept the tempo or its octaves (120/60/240)
    assert min(abs(bpm - 120), abs(bpm - 60), abs(bpm - 240)) < 8
    assert 0.0 <= conf <= 1.0
    assert method in (aa.BPM_METHOD, aa.FALLBACK_METHOD)


def test_estimate_key_returns_valid_key():
    # C-major triad → tonic C or a member of the C-major / A-minor family
    audio = _sine(261.63) + _sine(329.63) + _sine(392.00)
    key, conf = aa.estimate_key(audio.astype(np.float32))
    assert key is not None
    assert key.split()[0] in {"C", "A", "E", "G", "D", "F"}
    assert key.endswith("major") or key.endswith("minor")
    assert 0.0 <= conf <= 1.0


def test_analyze_file_bad_path_sets_error():
    res = aa.analyze_file("/no/such/file.wav")
    assert res.error is not None
    assert res.bpm is None and res.key is None


def test_analyze_all_writes_and_is_idempotent(db, monkeypatch):
    monkeypatch.setattr(aa, "analyze_file", lambda path, **_: aa.AnalysisResult(
        bpm=128.0, bpm_raw=128.0, bpm_confidence=0.9,
        bpm_method=aa.BPM_METHOD, key="A minor", key_confidence=0.8))
    for i in range(2):
        db.add(Track(absolute_path=f"/t{i}.wav", missing=False))
    db.commit()

    first = aa.analyze_all(db, force=False)
    assert first["analyzed"] == 2
    t0 = db.exec(__import__("sqlmodel").select(Track)).first()
    assert t0.bpm_analyzed == 128.0 and t0.key_analyzed == "A minor"
    assert t0.analyzed_at is not None

    second = aa.analyze_all(db, force=False)   # already analyzed → skipped
    assert second["analyzed"] == 0

    third = aa.analyze_all(db, force=True)     # force re-analyzes
    assert third["analyzed"] == 2
