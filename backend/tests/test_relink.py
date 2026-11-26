"""Review-only relink of moved and retagged tracks: hand-built rows and synthetic fpcalc fingerprints."""
from __future__ import annotations

import json
from pathlib import Path

from sqlmodel import Session, select

from app.models import (AuditLog, DJSet, Fingerprint, PlayEvent, SetTrack, Tag, Track, TrackDJProfile,
                        TrackTag)
from app.services import relink

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "fingerprints.json").read_text())


def _track(session, name, fingerprint="full", duration=300.0, missing=False, **values):
    track = Track(absolute_path=f"/lib/{name}", file_name=name.rsplit("/", 1)[-1], extension="mp3",
                  duration=duration, missing=missing, quick_hash=name, **values)
    session.add(track)
    session.flush()
    if fingerprint:
        session.add(Fingerprint(track_id=track.id, chromaprint=FIXTURE[fingerprint]))
    return track


def _moved(session):
    """An old missing row with the user's work, its retagged copy at a new path, and an unrelated track."""
    old = _track(session, "old/Artist - Song.mp3", missing=True, title="Song", play_count=2)
    new = _track(session, "new/01 Song (tagged).mp3", duration=300.4, title="Song (tagged)")
    other = _track(session, "new/other.mp3", fingerprint="other", duration=300.0)
    dj_set, tag = DJSet(title="Set"), Tag(name="acid")
    session.add_all([dj_set, tag, TrackDJProfile(track_id=old.id, energy=9, personal_status="weapon")])
    session.flush()
    session.add_all([SetTrack(set_id=dj_set.id, position=0, track_id=old.id),
                     TrackTag(track_id=old.id, tag_id=tag.id), PlayEvent(track_id=old.id)])
    session.commit()
    return old.id, new.id, other.id


def _engine_session():
    from app.db import get_engine
    return Session(get_engine(), expire_on_commit=False)


def test_moved_and_retagged_track_is_offered(client):
    with _engine_session() as session:
        old_id, new_id, _ = _moved(session)
    found = client.get("/api/duplicates/moved").json()
    assert [(p["old"]["track_id"], p["new"]["track_id"]) for p in found["pairs"]] == [(old_id, new_id)]
    assert found["pairs"][0]["old"]["absolute_path"] == "/lib/old/Artist - Song.mp3"
    assert found["pairs"][0]["new"]["absolute_path"] == "/lib/new/01 Song (tagged).mp3"
    assert (found["missing_with_data"], found["not_checked"], found["ambiguous"]) == (1, 0, 0)


def test_pair_is_not_offered_when_the_new_row_has_its_own_data(db):
    _, new_id, _ = _moved(db)
    db.add(TrackDJProfile(track_id=new_id, energy=3))
    db.commit()
    assert relink.candidates(db)["pairs"] == []


def test_pair_needs_a_fingerprint_a_matching_duration_and_a_single_candidate(db):
    _track(db, "old/no-fingerprint.mp3", fingerprint=None, missing=True, play_count=1)
    _track(db, "old/other-length.mp3", fingerprint="other", duration=200.0, missing=True, play_count=1)
    _track(db, "new/other-length.mp3", fingerprint="other", duration=260.0)
    _track(db, "old/twice.mp3", missing=True, play_count=1)
    _track(db, "new/copy-1.mp3")
    _track(db, "new/copy-2.mp3")
    db.commit()
    found = relink.candidates(db)
    assert found["pairs"] == []
    assert (found["missing_with_data"], found["not_checked"], found["ambiguous"]) == (3, 1, 1)


def test_missing_track_without_user_work_is_not_offered(db):
    _track(db, "old/plain.mp3", missing=True)
    _track(db, "new/plain.mp3")
    db.commit()
    assert relink.candidates(db) == {"pairs": [], "missing_with_data": 0, "not_checked": 0, "ambiguous": 0}


def test_confirmed_merge_keeps_profile_tags_sets_and_plays(client):
    with _engine_session() as session:
        old_id, new_id, other_id = _moved(session)
    done = client.post("/api/duplicates/moved/merge", json={"pairs": [{"old_id": old_id, "new_id": new_id}]})
    assert done.status_code == 200 and done.json() == {"merged": 1, "skipped": 0}
    with _engine_session() as session:
        new = session.get(Track, new_id)
        assert session.get(Track, old_id) is None and session.get(Track, other_id) is not None
        assert (new.missing, new.play_count, new.title, new.absolute_path) == (
            False, 2, "Song (tagged)", "/lib/new/01 Song (tagged).mp3")
        assert session.get(TrackDJProfile, new_id).personal_status == "weapon"
        assert session.exec(select(TrackTag.track_id)).all() == [new_id]
        assert session.exec(select(SetTrack.track_id)).all() == [new_id]
        assert session.exec(select(PlayEvent.track_id)).all() == [new_id]
        log = session.exec(select(AuditLog).where(AuditLog.action == "merge_moved_track")).one()
        assert log.entity_id == old_id
    assert client.get("/api/duplicates/moved").json()["pairs"] == []


def test_declined_or_unknown_pair_leaves_both_rows_untouched(client):
    with _engine_session() as session:
        old_id, new_id, other_id = _moved(session)
    # Declining is simply not confirming; a pair that is not a current candidate is refused.
    done = client.post("/api/duplicates/moved/merge", json={"pairs": [{"old_id": old_id, "new_id": other_id}]})
    assert done.json() == {"merged": 0, "skipped": 1}
    assert client.post("/api/duplicates/moved/merge", json={"pairs": []}).json() == {"merged": 0, "skipped": 0}
    with _engine_session() as session:
        old, new = session.get(Track, old_id), session.get(Track, new_id)
        assert old.missing and old.play_count == 2 and not new.missing and new.play_count == 0
        assert session.get(TrackDJProfile, old_id).energy == 9 and session.get(TrackDJProfile, new_id) is None
        assert session.exec(select(SetTrack.track_id)).all() == [old_id]
        assert session.exec(select(AuditLog).where(AuditLog.action == "merge_moved_track")).all() == []


def test_merge_keeps_the_old_rows_manual_bpm_over_the_new_rows_analysis(db):
    _, new_id, _ = _moved(db)
    old = db.exec(select(Track).where(Track.missing.is_(True))).one()
    old.bpm_consensus, old.bpm_consensus_sources = 74.0, "manual:octave"
    new = db.get(Track, new_id)
    new.bpm_consensus, new.bpm_consensus_sources, new.bpm_needs_review = 148.0, "librosa,djay", True
    db.commit()
    assert relink.merge(db, [(old.id, new_id)]) == {"merged": 1, "skipped": 0}
    db.expire_all()
    new = db.get(Track, new_id)
    assert (new.bpm_consensus, new.bpm_consensus_sources, new.bpm_needs_review) == (74.0, "manual:octave", False)
