import pytest
from sqlmodel import select

from app.models import Track, TrackDJProfile, Tag, DJSet, PlayEvent
from app.services.legacy_import import import_metadata


def test_legacy_matches_safely_and_preserves_manual_tempo_and_paths(db):
    tracks = [Track(absolute_path="/local/a.wav", full_hash="a", bpm_consensus=140, bpm_consensus_sources="manual:metadata"),
              Track(absolute_path="/local/b.wav", quick_hash="ambiguous"),
              Track(absolute_path="/local/c.wav", quick_hash="ambiguous")]
    db.add_all(tracks)
    db.commit()
    payload = {"version": 2, "tracks": [
        {"id": 50, "absolute_path": "/old/a.wav", "full_hash": "a", "bpm_consensus": 130, "bpm_consensus_sources": "manual:local", "key_text": "Am"},
        {"id": 51, "absolute_path": "/old/b.wav", "quick_hash": "ambiguous"},
        {"id": 52, "absolute_path": "/old/missing.wav"},
    ], "profiles": [{"track_id": 50, "energy": 7}], "tags": [{"id": 40, "name": "peak"}],
        "track_tags": [{"track_id": 50, "tag_id": 40}], "sets": [{"id": 30, "title": "Imported"}],
        "set_tracks": [{"set_id": 30, "track_id": 50, "position": 0}],
        "play_events": [{"track_id": 50, "played_at": "2026-10-01T10:00:00", "set_id": 30}]}
    first = import_metadata(db, payload)
    assert first["matched_tracks"] == 1 and first["ambiguous_track_ids"] == [51]
    assert first["unmatched_track_ids"] == [52]
    db.expire_all()
    current = db.get(Track, tracks[0].id)
    assert current.absolute_path == "/local/a.wav" and current.bpm_consensus == 140
    assert current.key_text == "Am" and current.play_count == 1
    assert db.get(TrackDJProfile, current.id).energy == 7
    second = import_metadata(db, payload)
    assert second["tags"] == second["sets"] == second["play_events"] == 0
    assert len(db.exec(select(Track)).all()) == 3
    assert len(db.exec(select(Tag)).all()) == len(db.exec(select(DJSet)).all()) == len(db.exec(select(PlayEvent)).all()) == 1


def test_legacy_invalid_payload_never_creates_tracks(db):
    with pytest.raises(ValueError):
        import_metadata(db, {"version": 99, "tracks": []})
    assert db.exec(select(Track)).all() == []
