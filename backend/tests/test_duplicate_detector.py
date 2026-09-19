"""Duplicate detection: exact grouping + remix-safety (no false auto-merge)."""
from __future__ import annotations

from app.models import Track
from app.services import duplicate_detector, hashing
from tests.conftest import make_wav


def test_quick_hash_deterministic(tmp_path):
    p = make_wav(tmp_path / "a.wav", freq_seed=3)
    assert hashing.quick_hash(p) == hashing.quick_hash(p)


def _add(db, **kw) -> Track:
    t = Track(**kw)
    db.add(t)
    db.commit()
    db.refresh(t)
    return t


def test_exact_byte_duplicates_grouped(db):
    _add(db, absolute_path="/x/a.wav", artist="A", title="X", quick_hash="HASH1", duration=200)
    _add(db, absolute_path="/y/a.wav", artist="A", title="X", quick_hash="HASH1", duration=200)
    result = duplicate_detector.detect(db)
    assert result["exact_groups"] == 1


def test_radio_edit_not_merged_with_extended(db):
    # same artist/title, very different durations -> NOT one exact group;
    # they must stay in separate duration clusters (human review).
    _add(db, absolute_path="/a.mp3", artist="Mandragora", title="X Radio Edit",
         quick_hash="H_A", duration=200)
    _add(db, absolute_path="/b.mp3", artist="Mandragora", title="X (Extended)",
         quick_hash="H_B", duration=400)
    result = duplicate_detector.detect(db)
    assert result["exact_groups"] == 0
    # different durations beyond tolerance -> no metadata group either
    assert result["metadata_groups"] == 0


def test_same_recording_metadata_suspect(db):
    _add(db, absolute_path="/a.wav", artist="Astrix", title="Y", quick_hash="A1", duration=300)
    _add(db, absolute_path="/b.mp3", artist="Astrix", title="Y", quick_hash="B2", duration=302)
    result = duplicate_detector.detect(db)
    assert result["metadata_groups"] == 1
