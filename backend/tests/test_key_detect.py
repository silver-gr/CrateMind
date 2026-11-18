"""The whole-track key method and the analysis phase that re-keys tracks keyed by an older method."""
from __future__ import annotations

from datetime import UTC, datetime

import numpy as np
import pytest

from app.models import Track
from app.services import audio_analysis as aa
from app.services import key_detect as kd

SR = kd.SAMPLE_RATE


def _triad(root: int, minor: bool) -> np.ndarray:
    """An 84-semitone profile with a triad on `root` in every octave."""
    octaves = np.full((kd.OCTAVES, 12), 0.1)
    octaves[:, root] = 1.0
    octaves[:, (root + (3 if minor else 4)) % 12] = 0.6
    octaves[:, (root + 7) % 12] = 0.7
    return octaves.ravel()


@pytest.mark.parametrize("root", range(12))
@pytest.mark.parametrize("minor", [False, True])
def test_a_triad_is_recognised_in_every_key(root, minor):
    key, confidence = kd.key_of_profile(_triad(root, minor))
    assert key == f"{kd.PITCHES[root]} {'minor' if minor else 'major'}"
    assert 0.9 < confidence <= 1.0


def test_weights_cover_seven_octaves_of_twelve_semitones():
    assert kd.WEIGHTS_MAJOR.shape == kd.WEIGHTS_MINOR.shape == (kd.OCTAVES, 12)


def test_flat_profile_is_refused():
    with pytest.raises(RuntimeError):
        kd.key_of_profile(np.ones(kd.OCTAVES * 12))


def _chord(*frequencies: float) -> np.ndarray:
    t = np.arange(SR * 12) / SR
    return (sum(np.sin(2 * np.pi * f * t) for f in frequencies) / len(frequencies)).astype(np.float32)


def test_chords_from_audio_with_the_root_in_the_bass():
    assert kd.pitch_profile(_chord(55.0, 110.0, 220.0, 261.63, 329.63)).shape == (kd.OCTAVES * 12,)
    assert kd.estimate_key(_chord(55.0, 110.0, 220.0, 261.63, 329.63))[0] == "A minor"
    assert kd.estimate_key(_chord(65.41, 130.81, 261.63, 329.63, 392.0))[0] == "C major"


def test_too_short_audio_is_refused():
    with pytest.raises(RuntimeError):
        kd.estimate_key(np.zeros(SR * 5, dtype=np.float32))


def _analysed(db, path, **fields):
    track = Track(absolute_path=path, missing=False, analyzed_at=datetime.now(UTC), bpm_analyzed=145.0,
                  bpm_analyzed_method=aa.BPM_METHOD, **fields)
    db.add(track)
    db.commit()
    return track


def _no_grids(monkeypatch):
    monkeypatch.setattr(aa, "_grid_targets", lambda *args, **kwargs: [])


def test_key_phase_rekeys_only_older_methods_without_a_first_pass(db, monkeypatch):
    _no_grids(monkeypatch)
    old = _analysed(db, "/old.mp3", key_analyzed="C major", key_analyzed_confidence=0.7)
    current = _analysed(db, "/current.mp3", key_analyzed="E minor", key_analyzed_method=kd.METHOD)
    decoded = []
    monkeypatch.setattr(aa, "analyze_file", lambda *a, **k: pytest.fail("the first pass must not run again"))
    monkeypatch.setattr(aa, "decode_audio", lambda path, **kwargs: decoded.append(path) or np.zeros(1, np.float32))
    monkeypatch.setattr(aa, "estimate_key", lambda audio: ("A minor", 0.9))

    result = aa.analyze_all(db, local_only=True)
    db.refresh(old)
    db.refresh(current)
    assert decoded == ["/old.mp3"] and result["keys"] == 1 and result["keys_failed"] == 0
    assert (old.key_analyzed, old.key_analyzed_confidence, old.key_analyzed_method) == ("A minor", 0.9, kd.METHOD)
    assert old.bpm_analyzed == 145.0
    assert current.key_analyzed == "E minor"
    assert aa.analyze_all(db, local_only=True)["keys"] == 0     # nothing left on the old method


def test_key_phase_failure_keeps_the_old_key_and_retries(db, monkeypatch):
    _no_grids(monkeypatch)
    old = _analysed(db, "/broken.mp3", key_analyzed="C major")

    def decode(path, **kwargs):
        raise RuntimeError("invalid audio")

    monkeypatch.setattr(aa, "decode_audio", decode)
    assert aa.analyze_all(db, local_only=True)["keys_failed"] == 1
    db.refresh(old)
    assert old.key_analyzed == "C major" and old.key_analyzed_method is None
    assert aa.analyze_all(db, local_only=True)["keys_failed"] == 1   # tried again next run


def test_first_pass_keys_with_the_current_method_and_is_not_rekeyed(db, monkeypatch):
    _no_grids(monkeypatch)
    track = Track(absolute_path="/new.mp3", missing=False)
    db.add(track)
    db.commit()
    monkeypatch.setattr(aa, "analyze_file", lambda path, **_: aa.AnalysisResult(
        bpm=145.0, bpm_raw=145.0, bpm_confidence=0.9, bpm_method=aa.BPM_METHOD, key="D minor", key_confidence=0.8))
    monkeypatch.setattr(aa, "_key_for", lambda path: pytest.fail("the key phase must skip first-pass tracks"))
    result = aa.analyze_all(db, local_only=True)
    db.refresh(track)
    assert result["analyzed"] == 1 and result["keys"] == 0
    assert (track.key_analyzed, track.key_analyzed_method) == ("D minor", kd.METHOD)
