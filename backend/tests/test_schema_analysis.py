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


def test_adding_bpm_grid_fills_it_from_grids_stored_before(db):
    """An upgrade: own grids exist, the column does not. The first start fills it, once."""
    from app.models import TrackBeatgrid

    steady = Track(absolute_path="/steady.wav")
    weak = Track(absolute_path="/weak.wav")
    sections = Track(absolute_path="/sections.wav")
    db.add_all([steady, weak, sections]); db.commit()
    own = dict(source="cratemind", anchor_s=0.2, straight=True, confidence=0.95, source_version=2)
    db.add_all([
        TrackBeatgrid(track_id=steady.id, bpm=145.9997, **own),
        TrackBeatgrid(track_id=steady.id, bpm=73.0, source="djay", anchor_s=0.1, straight=True),
        TrackBeatgrid(track_id=weak.id, bpm=140.0, **{**own, "confidence": 0.4}),
        TrackBeatgrid(track_id=sections.id, bpm=150.0, **{**own, "straight": False}),
    ])
    db.commit()
    ids = (steady.id, weak.id, sections.id)
    db.exec(text("ALTER TABLE tracks DROP COLUMN bpm_grid")); db.commit()

    dbmod.ensure_track_columns()
    db.expire_all()
    assert [db.exec(text("SELECT bpm_grid FROM tracks WHERE id = :i").bindparams(i=i)).one()[0] for i in ids] == [146.0, None, None]

    db.exec(text("UPDATE tracks SET bpm_grid = NULL")); db.commit()
    dbmod.ensure_track_columns()  # the column exists now: no second fill
    assert db.exec(text("SELECT count(*) FROM tracks WHERE bpm_grid IS NOT NULL")).one()[0] == 0
