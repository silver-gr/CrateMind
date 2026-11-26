"""A forced re-run that cannot read a file keeps the last BPM and key; a first run still records the failure."""
from datetime import UTC, datetime

from sqlmodel import select

from app.models import Track
from app.services import audio_analysis


def test_forced_rerun_keeps_values_when_decode_fails(db, tmp_path):
    db.add(Track(absolute_path=str(tmp_path / "gone.wav"), file_name="gone.wav", bpm_analyzed=147.0,
                 key_analyzed="8A", key_analyzed_confidence=0.9,
                 bpm_analyzed_method="librosa-onset-multilag-v2@133-286",
                 analyzed_at=datetime(2026, 9, 19, tzinfo=UTC)))
    db.commit()
    audio_analysis.analyze_all(db, force=True, local_only=True)
    t = db.exec(select(Track)).one()
    assert t.bpm_analyzed == 147.0 and t.key_analyzed == "8A"
    assert t.analysis_error and t.analysis_error.startswith("decode:")


def test_fresh_track_decode_failure_still_recorded(db, tmp_path):
    db.add(Track(absolute_path=str(tmp_path / "gone.wav"), file_name="gone.wav"))
    db.commit()
    audio_analysis.analyze_all(db, local_only=True, only_unprocessed=True)
    t = db.exec(select(Track)).one()
    assert t.analyzed_at is not None and t.bpm_analyzed is None
    assert t.analysis_error.startswith("decode:")
