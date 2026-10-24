"""BPM + key estimation and the analyze_all DB writer.

DSP tests use synthesized numpy arrays (no ffmpeg, no real files) so they are
fast and hermetic. analyze_all is tested with analyze_file monkeypatched, so it
exercises selection/idempotency without decoding audio.
"""
from __future__ import annotations

from datetime import UTC, datetime

import numpy as np
import pytest

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


def test_analyze_all_track_ids_limit_selection(db, monkeypatch):
    now = datetime.now(UTC)
    selected = Track(absolute_path='/selected.wav')
    unrelated = Track(absolute_path='/unrelated.wav')
    missing = Track(absolute_path='/missing.wav', missing=True)
    analyzed = Track(absolute_path='/analyzed.wav', analyzed_at=now, bpm_analyzed=130)
    for track in (selected, unrelated, missing, analyzed):
        db.add(track)
    db.commit()
    calls = []

    def analyze(path, **kwargs):
        calls.append(path)
        return aa.AnalysisResult(bpm=128, key='A minor')

    monkeypatch.setattr(aa, 'analyze_file', analyze)
    track_ids = [selected.id, missing.id, analyzed.id]
    result = aa.analyze_all(db, track_ids=track_ids, local_only=True)
    assert result['analyzed'] == 1
    assert calls == ['/selected.wav']
    assert unrelated.analyzed_at is None
    assert missing.analyzed_at is None
    assert analyzed.analyzed_at == now
    assert analyzed.bpm_analyzed == 130

    calls.clear()
    result = aa.analyze_all(db, track_ids=track_ids, local_only=True, force=True)
    assert result['analyzed'] == 2
    assert set(calls) == {'/selected.wav', '/analyzed.wav'}
    assert unrelated.analyzed_at is None
    assert missing.analyzed_at is None


def test_analyze_all_empty_track_ids_selects_none(db, monkeypatch):
    track = Track(absolute_path='/unrelated.wav')
    db.add(track)
    db.commit()

    def unexpected_analysis(*args, **kwargs):
        pytest.fail('empty track_ids must not analyze any track')

    monkeypatch.setattr(aa, 'analyze_file', unexpected_analysis)
    result = aa.analyze_all(db, track_ids=[], local_only=True, force=True)
    assert result['analyzed'] == 0
    assert track.analyzed_at is None


@pytest.mark.parametrize('essentia_available', [False, True])
def test_local_only_uses_primary_analysis_without_optional_engines(
    db, monkeypatch, essentia_available,
):
    settings = aa.get_settings().model_copy(update={
        'essentia_enabled': True,
        'reccobeats_enabled': True,
        'getsongbpm_enabled': True,
        'getsongbpm_bulk_enabled': True,
        'getsongbpm_api_key': 'test-key',
        'cyanite_enabled': True,
        'cyanite_access_token': 'test-token',
    })
    monkeypatch.setattr(aa, 'get_settings', lambda: settings)
    monkeypatch.setattr(aa, 'EasyLoader', object() if essentia_available else None)
    monkeypatch.setattr(aa, 'RhythmExtractor2013', object() if essentia_available else None)

    def unexpected_optional_engine(*args, **kwargs):
        pytest.fail('local_only must not use optional engines or external clients')

    for name in ('estimate_bpm_essentia', 'ReccoBeatsClient', 'GetSongBpmClient', 'CyaniteClient'):
        monkeypatch.setattr(aa, name, unexpected_optional_engine)
    decoded = []

    def decode(path):
        decoded.append(path)
        return np.ones(SR, dtype=np.float32)

    monkeypatch.setattr(aa, 'decode_audio', decode)
    monkeypatch.setattr(aa, 'estimate_file_bpm', lambda path, audio: (128, 128, .9, aa.BPM_METHOD))
    monkeypatch.setattr(aa, 'estimate_key', lambda audio: ('A minor', .8))
    track = Track(absolute_path='/local.wav', bpm=132, key_text='C major')
    db.add(track)
    db.commit()

    result = aa.analyze_all(db, track_ids=[track.id], local_only=True)
    db.refresh(track)
    assert decoded == ['/local.wav']
    assert result['analyzed'] == 1
    assert result['validated'] == 0
    assert result['reccobeats_analyzed'] == 0
    assert result['getsongbpm_matched'] == 0
    assert result['cyanite_submitted'] == 0
    assert track.bpm == 132
    assert track.key_text == 'C major'
    assert track.bpm_analyzed == 128
    assert track.key_analyzed == 'A minor'
    assert track.analyzed_at is not None
    assert track.essentia_analyzed_at is None
    assert track.reccobeats_analyzed_at is None
    assert track.getsongbpm_updated_at is None
    assert track.cyanite_updated_at is None

    # Pending optional analysis must not select this track for a second local run.
    assert aa.analyze_all(db, track_ids=[track.id], local_only=True)['analyzed'] == 0
    assert decoded == ['/local.wav']


def test_scoped_local_analysis_persists_failure_without_retry(db, monkeypatch):
    track = Track(absolute_path='/bad.wav', bpm=132, key_text='C major')
    db.add(track)
    db.commit()
    calls = []

    def decode(path):
        calls.append(path)
        raise RuntimeError('invalid audio')

    monkeypatch.setattr(aa, 'decode_audio', decode)
    result = aa.analyze_all(db, track_ids=[track.id], local_only=True)
    db.refresh(track)
    assert result['analyzed'] == 0
    assert result['failed'] == 1
    assert track.analysis_error == 'decode: invalid audio'
    assert track.analyzed_at is not None
    assert track.bpm == 132
    assert track.key_text == 'C major'
    assert track.bpm_analyzed is None
    assert track.key_analyzed is None
    assert aa.analyze_all(db, track_ids=[track.id], local_only=True)['failed'] == 0
    assert calls == ['/bad.wav']


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
