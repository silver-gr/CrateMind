"""Audio-analysis columns exist after init and never collide with tag columns."""
from __future__ import annotations

from sqlalchemy import text

import app.db as dbmod
from app.models import Track

ANALYSIS_COLS = {
    "bpm_analyzed", "bpm_analyzed_raw", "bpm_analyzed_confidence",
    "bpm_analyzed_method", "key_analyzed", "key_analyzed_confidence",
    "analyzed_at", "analysis_error",
}


def test_analysis_columns_present(db):
    cols = {row[1] for row in db.exec(text("PRAGMA table_info(tracks)"))}
    assert ANALYSIS_COLS <= cols
    # tag columns are untouched and distinct
    assert {"bpm", "key_text"} <= cols
    assert "bpm" not in ANALYSIS_COLS


def test_ensure_track_columns_is_idempotent(db):
    dbmod.ensure_track_columns()
    dbmod.ensure_track_columns()  # second call must not raise
    cols = {row[1] for row in db.exec(text("PRAGMA table_info(tracks)"))}
    assert ANALYSIS_COLS <= cols


def test_track_model_roundtrips_analyzed_fields(db):
    t = Track(absolute_path="/x.wav", bpm=150, key_text="Am",
              bpm_analyzed=128.0, key_analyzed="A minor", missing=False)
    db.add(t)
    db.commit()
    db.refresh(t)
    assert t.bpm == 150 and t.bpm_analyzed == 128.0
    assert t.key_text == "Am" and t.key_analyzed == "A minor"
