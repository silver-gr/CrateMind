"""The tempo window registry: pure lookups, octave folding and per-folder windows."""
from __future__ import annotations

import pytest

from app.services import tempo_ranges as tr


def test_registry_and_methods():
    expected = {
        "psy": (133.0, 286.0, "multilag", "librosa-onset-multilag-v2@133-286", "ffmpeg+onset-autocorr-v1@133-286"),
        "mixed": (118.0, 250.0, "multilag", "librosa-onset-multilag-v2@118-250", "ffmpeg+onset-autocorr-v1@118-250"),
        "slow": (70.0, 125.0, "multilag", "librosa-onset-multilag-v2@70-125", "ffmpeg+onset-autocorr-v1@70-125"),
        "therapy": (40.0, 240.0, "wide", "librosa-onset-wide-v1@40-240", None),
    }
    assert set(tr.TEMPO_RANGES) == set(expected)
    for key, (lo, hi, estimator, method, fallback) in expected.items():
        window = tr.TEMPO_RANGES[key]
        assert (window.key, window.lo, window.hi, window.estimator, window.method, window.fallback_method) == (
            key, lo, hi, estimator, method, fallback,
        )
        assert tr.get_range(key) is window
    assert tr.DEFAULT_TEMPO_RANGE == "psy"
    with pytest.raises(ValueError, match="unknown tempo range"):
        tr.get_range("techno")


def test_range_for_method_roundtrip():
    for window in tr.TEMPO_RANGES.values():
        assert tr.range_for_method(window.method) is window
        if window.fallback_method:
            assert tr.range_for_method(window.fallback_method) is window
    for legacy in ("librosa-onset-multilag-v2", "ffmpeg+onset-autocorr-v1", "essentia-rhythmextractor2013-multifeature-v1", "", None):
        assert tr.range_for_method(legacy) is None


def test_fold_into():
    assert tr.fold_into(62, 133, 286) == 248
    assert tr.fold_into(300, 133, 286) == 150
    assert tr.fold_into(130, 70, 125) == 130  # no octave fits; the closest
    assert tr.fold_into(100, 40, 240) == 100


def test_resolve_track_range():
    roots = {"/Music/Downtempo": "slow", "/Music": "mixed"}
    assert tr.resolve_track_range("/Music/Downtempo/a.mp3", "psy", roots) == "slow"
    assert tr.resolve_track_range("/Music/House/b.mp3", "psy", roots) == "mixed"
    assert tr.resolve_track_range("/Other/c.mp3", "psy", roots) == "psy"
    assert tr.resolve_track_range("C:\\Music\\Downtempo\\x.flac", "psy", {"c:/music/downtempo": "slow"}) == "slow"
    assert tr.resolve_track_range("/Music/Downtempo/a.mp3", "psy", {"/Music/Down": "slow"}) == "psy"
    assert tr.resolve_track_range("/Music/Downtempo/a.mp3", "therapy", roots) == "therapy"
