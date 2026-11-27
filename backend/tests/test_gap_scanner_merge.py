"""scanner.merge_tracks gaps: play-stat combining, column filling, many-per-track records, sets that
hold both rows, one-per-track conflicts, chained pairs and the search index. Hand-built rows only."""
from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlmodel import select

from app.db import reindex_track
from app.models import (AuditLog, DJSet, Fingerprint, SetTrack, SetTransition, Tag, Track, TrackBeatgrid,
                        TrackCue, TrackDJProfile, TrackDownbeat, TrackTag)
from app.services import scanner

T1, T2 = datetime(2026, 3, 1, 21, 0, tzinfo=UTC), datetime(2026, 11, 20, 23, 30, tzinfo=UTC)


def _row(db, name, **values):
    track = Track(absolute_path=f"/lib/{name}", file_name=name, **values)
    db.add(track)
    db.flush()
    reindex_track(db, track.id, commit=False)
    return track


def _pair(db, old=None, new=None):
    a = _row(db, "old.wav", missing=True, **(old or {}))
    b = _row(db, "new.wav", **(new or {}))
    db.commit()
    return a.id, b.id


def test_no_pairs_changes_nothing(db):
    old_id, new_id = _pair(db)
    assert scanner.merge_tracks(db, []) == 0
    assert db.get(Track, old_id) is not None and db.get(Track, new_id) is not None
    assert db.exec(select(AuditLog)).all() == []


@pytest.mark.parametrize("old_last,new_last,expected", [
    (None, None, None),
    (T1, None, T1),
    (None, T2, T2),
    (T1, T2, T2),
    (T2, T1, T2),
])
def test_play_stats_add_up_and_keep_the_latest_play(db, old_last, new_last, expected):
    old_id, new_id = _pair(db, {"play_count": 3, "last_played_at": old_last, "imported_at": T1},
                           {"play_count": 4, "last_played_at": new_last, "imported_at": T2})
    scanner.merge_tracks(db, [(old_id, new_id)])
    db.commit()
    db.expire_all()
    new = db.get(Track, new_id)
    assert (new.play_count, new.last_played_at, new.imported_at) == (7, expected, T1)


@pytest.mark.parametrize("column,old_value,new_value,expected", [
    ("rating", 5, None, 5),           # the new row's empty column is filled
    ("rating", 5, 3, 3),              # the new row's own value wins
    ("title", "Old title", None, "Old title"),
    ("genre", "Psytrance", "Techno", "Techno"),
    ("modified_time", 1.0, None, None),   # file-system facts of the old file never move over
    ("created_time", 2.0, None, None),
    ("volume_root", "/Volumes/Old", None, None),
])
def test_columns_fill_only_the_new_rows_gaps(db, column, old_value, new_value, expected):
    old_id, new_id = _pair(db, {column: old_value}, {column: new_value})
    scanner.merge_tracks(db, [(old_id, new_id)])
    db.commit()
    db.expire_all()
    new = db.get(Track, new_id)
    assert getattr(new, column) == expected
    assert (new.absolute_path, new.file_name, new.missing) == ("/lib/new.wav", "new.wav", False)


def test_tags_union_and_a_shared_tag_is_kept_once(db):
    old_id, new_id = _pair(db)
    acid, peak = Tag(name="acid"), Tag(name="peak")
    db.add_all([acid, peak])
    db.flush()
    db.add_all([TrackTag(track_id=old_id, tag_id=acid.id), TrackTag(track_id=old_id, tag_id=peak.id),
                TrackTag(track_id=new_id, tag_id=acid.id)])
    db.commit()
    scanner.merge_tracks(db, [(old_id, new_id)])
    db.commit()
    rows = db.exec(select(TrackTag.track_id, TrackTag.tag_id)).all()
    assert sorted(rows) == sorted([(new_id, acid.id), (new_id, peak.id)])
    log = db.exec(select(AuditLog).where(AuditLog.action == "merge_moved_track")).one()
    dropped = json.loads(log.before_json)["track_tags"]
    assert [(r["track_id"], r["tag_id"]) for r in dropped] == [(old_id, acid.id)]


def test_a_set_holding_both_rows_keeps_every_position(db):
    old_id, new_id = _pair(db)
    other = _row(db, "other.wav")
    dj_set = DJSet(title="Sunrise")
    db.add(dj_set)
    db.flush()
    db.add_all([SetTrack(set_id=dj_set.id, position=0, track_id=old_id),
                SetTrack(set_id=dj_set.id, position=1, track_id=other.id),
                SetTrack(set_id=dj_set.id, position=2, track_id=new_id)])
    db.commit()
    scanner.merge_tracks(db, [(old_id, new_id)])
    db.commit()
    order = db.exec(select(SetTrack.position, SetTrack.track_id).order_by(SetTrack.position)).all()
    assert order == [(0, new_id), (1, other.id), (2, new_id)]


def test_transition_conflict_keeps_the_new_rows_plan_and_logs_the_old_one(db):
    old_id, new_id = _pair(db)
    other = _row(db, "other.wav")
    dj_set = DJSet(title="Night")
    db.add(dj_set)
    db.flush()
    plan = {"bars": 16, "volume_curve": "linear", "eq_curve": "bass_swap", "filter_curve": "none"}
    db.add_all([SetTransition(set_id=dj_set.id, from_track_id=old_id, to_track_id=other.id, preset="old", **plan),
                SetTransition(set_id=dj_set.id, from_track_id=new_id, to_track_id=other.id, preset="new", **plan),
                SetTransition(set_id=dj_set.id, from_track_id=other.id, to_track_id=old_id, preset="back", **plan)])
    db.commit()
    scanner.merge_tracks(db, [(old_id, new_id)])
    db.commit()
    rows = db.exec(select(SetTransition.from_track_id, SetTransition.to_track_id, SetTransition.preset)).all()
    assert sorted(rows) == sorted([(new_id, other.id, "new"), (other.id, new_id, "back")])
    log = json.loads(db.exec(select(AuditLog)).one().before_json)
    assert [r["preset"] for r in log["set_transitions"]] == ["old"]


def test_one_per_track_records_new_wins_and_many_per_track_records_union(db):
    old_id, new_id = _pair(db)
    db.add_all([
        Fingerprint(track_id=old_id, chromaprint="OLD"), Fingerprint(track_id=new_id, chromaprint="NEW"),
        TrackDownbeat(track_id=old_id, downbeat_s=1.0), TrackDownbeat(track_id=new_id, downbeat_s=2.0),
        TrackBeatgrid(track_id=old_id, source="djay", bpm=145.0),
        TrackBeatgrid(track_id=old_id, source="cratemind", bpm=72.5),
        TrackBeatgrid(track_id=new_id, source="cratemind", bpm=145.0),
        TrackCue(track_id=old_id, position_ms=1000, kind="entry"),
        TrackCue(track_id=new_id, position_ms=2000, kind="exit"),
    ])
    db.commit()
    scanner.merge_tracks(db, [(old_id, new_id)])
    db.commit()
    db.expire_all()
    assert db.get(Fingerprint, new_id).chromaprint == "NEW"
    assert db.exec(select(TrackDownbeat.track_id, TrackDownbeat.downbeat_s)).all() == [(new_id, 2.0)]
    grids = db.exec(select(TrackBeatgrid.track_id, TrackBeatgrid.source, TrackBeatgrid.bpm)).all()
    assert sorted(grids) == [(new_id, "cratemind", 145.0), (new_id, "djay", 145.0)]
    cues = db.exec(select(TrackCue.track_id, TrackCue.position_ms)).all()
    assert sorted(cues) == [(new_id, 1000), (new_id, 2000)]
    for table in ("fingerprints", "track_downbeats", "track_beatgrids", "track_cues"):
        assert db.execute(text(f"SELECT count(*) FROM {table} WHERE track_id = :i"), {"i": old_id}).scalar() == 0


@pytest.mark.parametrize("old_sources,new_bpm,new_sources,expected", [
    ("manual:tap", 148.0, "librosa", (74.0, "manual:tap")),   # the user's fix wins
    ("djay", 148.0, "librosa", (148.0, "librosa")),           # analysis never beats analysis
    ("djay", None, None, (74.0, "djay")),                     # an empty new value is filled
])
def test_bpm_consensus_after_merge(db, old_sources, new_bpm, new_sources, expected):
    old_id, new_id = _pair(db, {"bpm_consensus": 74.0, "bpm_consensus_sources": old_sources},
                           {"bpm_consensus": new_bpm, "bpm_consensus_sources": new_sources})
    scanner.merge_tracks(db, [(old_id, new_id)])
    db.commit()
    db.expire_all()
    new = db.get(Track, new_id)
    assert (new.bpm_consensus, new.bpm_consensus_sources) == expected


def test_chained_pairs_end_on_the_last_row(db):
    a = _row(db, "a.wav", missing=True, play_count=1, rating=4)
    b = _row(db, "b.wav", missing=True, play_count=2)
    c = _row(db, "c.wav", play_count=3)
    db.add(TrackDJProfile(track_id=a.id, energy=9, personal_status="weapon"))
    db.commit()
    a_id, b_id, c_id = a.id, b.id, c.id
    assert scanner.merge_tracks(db, [(a_id, b_id), (b_id, c_id)]) == 2
    db.commit()
    db.expunge_all()
    assert db.get(Track, a_id) is None and db.get(Track, b_id) is None
    survivor = db.get(Track, c_id)
    assert (survivor.play_count, survivor.rating) == (6, 4)
    assert db.get(TrackDJProfile, c_id).personal_status == "weapon"
    assert len(db.exec(select(AuditLog).where(AuditLog.action == "merge_moved_track")).all()) == 2


def test_search_index_follows_the_merge(db):
    old_id, new_id = _pair(db, {"title": "Zyxwortle"}, {"title": None})
    tag = Tag(name="qooblix")
    db.add(tag)
    db.flush()
    db.add(TrackTag(track_id=old_id, tag_id=tag.id))
    reindex_track(db, old_id, commit=False)
    db.commit()
    scanner.merge_tracks(db, [(old_id, new_id)])
    db.commit()
    rowids = {r[0] for r in db.execute(text("SELECT rowid FROM track_search"))}
    assert old_id not in rowids and new_id in rowids
    for word in ("Zyxwortle", "qooblix"):
        hits = db.execute(text("SELECT rowid FROM track_search WHERE track_search MATCH :q"), {"q": word}).all()
        assert [h[0] for h in hits] == [new_id]
