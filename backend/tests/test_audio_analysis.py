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


def test_only_unprocessed_excludes_previous_attempts_even_with_pending_validation(db, monkeypatch):
    from datetime import UTC, datetime
    settings = aa.get_settings().model_copy(update={'essentia_enabled': True})
    monkeypatch.setattr(aa, 'get_settings', lambda: settings)
    monkeypatch.setattr(aa, 'EasyLoader', object())
    monkeypatch.setattr(aa, 'RhythmExtractor2013', object())
    now = datetime.now(UTC)
    db.add(Track(absolute_path='/processed.wav', analyzed_at=now, bpm_analyzed=128))
    db.add(Track(absolute_path='/failed.wav', analyzed_at=now, analysis_error='decode failed'))
    db.add(Track(absolute_path='/new.wav'))
    db.add(Track(absolute_path='/missing.wav', missing=True))
    db.commit()
    calls = []
    def analyze(path, **kwargs):
        calls.append(path)
        return aa.AnalysisResult(bpm=128, key='A minor', bpm_essentia=128)
    monkeypatch.setattr(aa, 'analyze_file', analyze)
    aa.analyze_all(db, only_unprocessed=True)
    assert calls == ['/new.wav']
    calls.clear()
    aa.analyze_all(db, only_unprocessed=True)
    assert calls == []
    aa.analyze_all(db, force=True, only_unprocessed=True)
    assert set(calls) == {'/new.wav', '/processed.wav', '/failed.wav'}


def test_refined_psytrance_tempos():
    for tempo in (140, 150, 170, 190, 193, 210, 245, 270, 286):
        bpm, confidence = aa._estimate_bpm_librosa(_click_track(tempo, 30))
        assert abs(bpm - tempo) < 0.3, (tempo, bpm)
        assert 0 <= confidence <= 1


def test_section_sampling_and_median(monkeypatch):
    calls = []
    def decode(path, **kwargs):
        calls.append(kwargs)
        return np.ones(SR * 60, dtype=np.float32)
    monkeypatch.setattr(aa, 'decode_audio', decode)
    results = iter([(190, 190, .8, aa.BPM_METHOD), (210, 210, .7, aa.BPM_METHOD), (190.1, 190.1, .9, aa.BPM_METHOD)])
    monkeypatch.setattr(aa, 'estimate_bpm', lambda audio: next(results))
    result = aa.estimate_file_bpm('/track', np.ones(SR * 120, dtype=np.float32))
    assert result == (190.1, 190.1, .8, aa.BPM_METHOD)
    assert calls == [{'start': 120, 'seconds': 60}, {'start': 210, 'seconds': 60}]


def test_silence_does_not_produce_tempo():
    import pytest
    with pytest.raises(RuntimeError):
        aa.estimate_bpm(np.zeros(SR * 15, dtype=np.float32))
