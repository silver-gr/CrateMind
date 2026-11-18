"""Chromaprint fingerprints: the NumPy decoder and the same-recording match (synthetic fpcalc fixtures)."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from app.services import fingerprint_match

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "fingerprints.json").read_text())


def test_decode_matches_fpcalc_raw():
    decoded = fingerprint_match.decode(FIXTURE["preview"])
    assert decoded.dtype == np.uint32
    assert decoded.tolist() == [v & 0xFFFFFFFF for v in FIXTURE["preview_raw"]]


@pytest.mark.parametrize("bad", ["AQ", FIXTURE["preview"][:40]])
def test_decode_refuses_a_damaged_fingerprint(bad):
    with pytest.raises(ValueError):
        fingerprint_match.decode(bad)


def test_a_preview_matches_its_full_track_and_another_track_does_not():
    fps = {1: fingerprint_match.decode(FIXTURE["full"]), 2: fingerprint_match.decode(FIXTURE["preview"]),
           3: fingerprint_match.decode(FIXTURE["other"])}
    pairs = fingerprint_match.same_audio_pairs(fps)
    assert [(a, b) for a, b, *_ in pairs] == [(1, 2)]
    _, _, bit_error, overlap = pairs[0]
    assert bit_error <= 0.01 and overlap >= 40
