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
from app.services import bpm_consensus as bc
from app.services.tempo_ranges import TEMPO_RANGES

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
    monkeypatch.setattr(aa, 'estimate_file_bpm', lambda path, audio, *_, **__: (128, 128, .9, aa.BPM_METHOD))
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
    monkeypatch.setattr(aa, 'estimate_bpm', lambda audio, *_, **__: next(results))
    result = aa.estimate_file_bpm('/track', np.ones(SR * 120, dtype=np.float32))
    assert result == (190.1, 190.1, .8, aa.BPM_METHOD)
    assert calls == [{'start': 120, 'seconds': 60}, {'start': 210, 'seconds': 60}]


def test_silence_does_not_produce_tempo():
    import pytest
    with pytest.raises(RuntimeError):
        aa.estimate_bpm(np.zeros(SR * 15, dtype=np.float32))


def click_track(bpm: float, seconds: float, sr: int = SR) -> np.ndarray:
    """Impulses on the beat, each with a short decaying noise burst (seeded)."""
    rng = np.random.default_rng(int(bpm * 100))
    audio = np.zeros(int(sr * seconds), dtype=np.float32)
    burst_len = int(sr * 0.01)
    burst = (rng.standard_normal(burst_len) * np.exp(-np.arange(burst_len) / (burst_len / 5))).astype(np.float32) * 0.5
    step = sr * 60.0 / bpm
    for i in range(int(len(audio) / step) + 1):
        start = int(round(i * step))
        if start >= len(audio):
            break
        audio[start] = 1.0
        end = min(len(audio), start + burst_len)
        audio[start:end] += burst[: end - start]
    return audio


def rolling_psy(bpm: float, seconds: float = 30.0, sr: int = SR) -> np.ndarray:
    """A kick on every beat and a bass note on the three off-beat 16ths."""
    audio = np.zeros(int(sr * seconds), dtype=np.float32)
    beat = sr * 60.0 / bpm
    kick_t = np.arange(int(sr * 0.12)) / sr
    kick = (np.sin(2 * np.pi * (50 * kick_t + 60 * (1 - np.exp(-kick_t * 30)) / 30)) * np.exp(-kick_t * 25)).astype(np.float32)
    bass_t = np.arange(int(beat / 4 * 0.8)) / sr
    bass = (0.6 * np.sin(2 * np.pi * 55 * bass_t) * np.exp(-bass_t * 40)).astype(np.float32)
    for i in range(int(len(audio) / beat) + 1):
        for sixteenth, sound in ((0, kick), (1, bass), (2, bass), (3, bass)):
            start = int(round(i * beat + sixteenth * beat / 4))
            if start >= len(audio):
                continue
            end = min(len(audio), start + len(sound))
            audio[start:end] += sound[: end - start]
    return audio


# Captured from the 135-286 grid before the windows existed (Task 2, Step 1).
LEGACY_GOLDEN = {
    ("click", 60): (180.0, 0.2771),
    ("click", 120): (240.02, 0.4222),
    ("click", 140): (140.0, 0.8904),
    ("psy", 142): (142.0, 0.9842),
}


def test_multilag_with_legacy_grid_matches_golden():
    for (kind, bpm), expected in LEGACY_GOLDEN.items():
        audio = click_track(bpm, 30) if kind == "click" else rolling_psy(bpm)
        assert aa._estimate_bpm_librosa(audio, 135, 286) == expected, (kind, bpm)


def test_psy_window_reads_133():
    window = TEMPO_RANGES["psy"]
    bpm, _conf = aa._estimate_bpm_librosa(click_track(133, 30), window.lo, window.hi)
    assert abs(bpm - 133) <= 0.3  # the legacy 135 floor read 266


def test_mixed_window_reads_house():
    window = TEMPO_RANGES["mixed"]
    bpm, _conf = aa._estimate_bpm_librosa(click_track(124, 30), window.lo, window.hi)
    assert abs(bpm - 124) <= 0.3


def test_slow_window_reads_downtempo():
    window = TEMPO_RANGES["slow"]
    bpm, _conf = aa._estimate_bpm_librosa(click_track(90, 30), window.lo, window.hi)
    assert abs(bpm - 90) <= 0.3


def test_estimate_bpm_method_carries_window():
    bpm, raw, _conf, method = aa.estimate_bpm(click_track(124, 30), TEMPO_RANGES["mixed"])
    assert method == "librosa-onset-multilag-v2@118-250"
    assert bpm == raw


def test_fallback_folds_into_window(monkeypatch):
    def fail(*_args, **_kwargs):
        raise RuntimeError("librosa failed")

    monkeypatch.setattr(aa, "_estimate_bpm_librosa", fail)
    monkeypatch.setattr(aa, "_estimate_bpm_autocorr", lambda audio: (100.0, 0.5))
    audio = np.ones(SR * 20, dtype=np.float32)
    assert aa.estimate_bpm(audio, TEMPO_RANGES["psy"]) == (200.0, 100.0, 0.5, "ffmpeg+onset-autocorr-v1@133-286")
    assert aa.estimate_bpm(audio)[3] == aa.FALLBACK_METHOD
    slow = aa.estimate_bpm(audio, TEMPO_RANGES["slow"])
    assert slow == (100.0, 100.0, 0.5, "ffmpeg+onset-autocorr-v1@70-125")


def test_section_median_keeps_window_methods(monkeypatch):
    window = TEMPO_RANGES["mixed"]
    seen = []
    results = iter([
        (124.0, 124.0, .8, window.method),
        (200.0, 100.0, .3, window.fallback_method),
        (124.2, 124.2, .9, window.method),
    ])

    def estimate(audio, tempo_range=None):
        seen.append(tempo_range)
        return next(results)

    monkeypatch.setattr(aa, "decode_audio", lambda path, **_: np.ones(SR * 60, dtype=np.float32))
    monkeypatch.setattr(aa, "estimate_bpm", estimate)
    result = aa.estimate_file_bpm("/track", np.ones(SR * 120, dtype=np.float32), window)
    assert result == (124.1, 124.1, .85, window.method)
    assert seen == [window, window, window]


def test_intro_fallback_forwards_window(monkeypatch):
    window = TEMPO_RANGES["slow"]
    seen = []

    def estimate(audio, tempo_range=None):
        seen.append(tempo_range)
        return (90.0, 90.0, .7, window.method)

    monkeypatch.setattr(aa, "estimate_bpm", estimate)
    assert aa.estimate_file_bpm("/short", np.ones(SR * 20, dtype=np.float32), window)[0] == 90.0
    assert seen == [window]


def test_consensus_folds_into_window():
    votes = [("local", 60.0), ("essentia", 120.0)]
    assert aa.bpm_consensus(votes, 5.0, window=TEMPO_RANGES["therapy"])[0] == 60.0
    assert aa.bpm_consensus(votes, 5.0, window=None)[0] == 120.0
    assert aa.bpm_consensus(votes, 5.0)[0] == 120.0


def test_refresh_consensus_uses_the_tracks_window():
    def refreshed(method):
        track = Track(absolute_path="/w.wav", bpm_analyzed=90.0, bpm_essentia=180.0, bpm_analyzed_method=method)
        bc._refresh_consensus(track, 5.0)
        return track.bpm_consensus

    assert refreshed(TEMPO_RANGES["slow"].method) == 90.0
    assert refreshed(TEMPO_RANGES["slow"].fallback_method) == 90.0
    assert refreshed(TEMPO_RANGES["therapy"].method) == 90.0
    assert refreshed(TEMPO_RANGES["psy"].method) == 180.0
    assert refreshed("librosa-onset-multilag-v2") == 180.0  # a pre-Phase-B row keeps the legacy rule
    assert refreshed(None) == 180.0
