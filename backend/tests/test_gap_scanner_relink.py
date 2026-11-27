"""relink gaps: every kind of user work, the duration tolerance's edges, rows that cannot be checked,
two old rows for one file, broken fingerprints and stale or reversed confirmations.
Hand-built rows with the synthetic fpcalc fingerprints of tests/fixtures/fingerprints.json."""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlmodel import select

from app.models import (DJSet, Fingerprint, PlayEvent, SetTrack, SetTransition, Tag, Track, TrackCue,
                        TrackDJProfile, TrackDownbeat, TrackPairNote, TrackTag)
from app.services import relink

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "fingerprints.json").read_text())


def _track(db, name, fingerprint="full", duration=300.0, missing=False, **values):
    track = Track(absolute_path=f"/lib/{name}", file_name=name.rsplit("/", 1)[-1], extension="mp3",
                  duration=duration, missing=missing, quick_hash=name, **values)
    db.add(track)
    db.flush()
    if fingerprint:
        db.add(Fingerprint(track_id=track.id, chromaprint=FIXTURE.get(fingerprint, fingerprint)))
    return track


def _pairs(found):
    return [(p["old"]["track_id"], p["new"]["track_id"]) for p in found["pairs"]]


def _work(db, kind, track_id, other_id):
    """Give track_id one kind of the user's work; other_id is a third, unrelated track."""
    plan = {"preset": "blend", "bars": 16, "volume_curve": "linear", "eq_curve": "bass_swap", "filter_curve": "none"}
    if kind in {"set_track", "transition_from", "transition_to"}:
        dj_set = DJSet(title="Set")
        db.add(dj_set)
        db.flush()
    if kind == "profile":
        db.add(TrackDJProfile(track_id=track_id, energy=7))
    elif kind == "tag":
        tag = Tag(name="acid")
        db.add(tag)
        db.flush()
        db.add(TrackTag(track_id=track_id, tag_id=tag.id))
    elif kind == "cue":
        db.add(TrackCue(track_id=track_id, position_ms=32000, kind="entry"))
    elif kind == "downbeat":
        db.add(TrackDownbeat(track_id=track_id, downbeat_s=0.42))
    elif kind == "set_track":
        db.add(SetTrack(set_id=dj_set.id, position=0, track_id=track_id))
    elif kind == "transition_from":
        db.add(SetTransition(set_id=dj_set.id, from_track_id=track_id, to_track_id=other_id, **plan))
    elif kind == "transition_to":
        db.add(SetTransition(set_id=dj_set.id, from_track_id=other_id, to_track_id=track_id, **plan))
    elif kind == "pair_note_from":
        db.add(TrackPairNote(from_track_id=track_id, to_track_id=other_id, rating=5))
    elif kind == "pair_note_to":
        db.add(TrackPairNote(from_track_id=other_id, to_track_id=track_id, rating=1))
    elif kind == "play_event":
        db.add(PlayEvent(track_id=track_id))
    elif kind == "play_count":
        db.get(Track, track_id).play_count = 3
    elif kind == "manual_bpm":
        row = db.get(Track, track_id)
        row.bpm_consensus, row.bpm_consensus_sources = 72.0, "manual:octave"
    else:  # pragma: no cover - a typo in the table
        raise AssertionError(kind)


_KINDS = ["profile", "tag", "cue", "downbeat", "set_track", "transition_from", "transition_to",
          "pair_note_from", "pair_note_to", "play_event", "play_count", "manual_bpm"]


@pytest.mark.parametrize("kind", _KINDS)
def test_every_kind_of_user_work_makes_a_missing_row_worth_relinking(db, kind):
    old = _track(db, "old/Song.mp3", missing=True)
    new = _track(db, "new/01 Song.mp3", duration=300.5)
    other = _track(db, "other.mp3", fingerprint="other", duration=120.0)
    _work(db, kind, old.id, other.id)
    db.commit()
    found = relink.candidates(db)
    assert _pairs(found) == [(old.id, new.id)]
    assert found["missing_with_data"] == 1


@pytest.mark.parametrize("kind", _KINDS)
def test_a_present_row_with_any_user_work_is_never_offered_as_the_new_file(db, kind):
    old = _track(db, "old/Song.mp3", missing=True, play_count=1)
    new = _track(db, "new/01 Song.mp3", duration=300.5)
    other = _track(db, "other.mp3", fingerprint="other", duration=120.0)
    _work(db, kind, new.id, other.id)
    db.commit()
    assert relink.candidates(db)["pairs"] == []


@pytest.mark.parametrize("new_duration,offered", [
    (300.0, True), (303.0, True), (297.0, True),      # DURATION_TOLERANCE is inclusive
    (303.01, False), (296.9, False),
])
def test_duration_tolerance_edges(db, new_duration, offered):
    old = _track(db, "old/Song.mp3", missing=True, play_count=1)
    new = _track(db, "new/Song.mp3", duration=new_duration)
    db.commit()
    assert _pairs(relink.candidates(db)) == ([(old.id, new.id)] if offered else [])


@pytest.mark.parametrize("duration", [None, 0.0])
def test_a_missing_row_without_a_known_length_is_counted_as_not_checked(db, duration):
    _track(db, "old/Song.mp3", missing=True, play_count=1, duration=duration)
    _track(db, "new/Song.mp3")
    db.commit()
    assert relink.candidates(db) == {"pairs": [], "missing_with_data": 1, "not_checked": 1, "ambiguous": 0}


def test_two_old_rows_claiming_one_new_file_are_both_ambiguous(db):
    _track(db, "old/a/Song.mp3", missing=True, play_count=1)
    _track(db, "old/b/Song.mp3", missing=True, play_count=2)
    _track(db, "new/Song.mp3")
    db.commit()
    found = relink.candidates(db)
    assert found["pairs"] == [] and (found["missing_with_data"], found["ambiguous"]) == (2, 2)


@pytest.mark.parametrize("broken", ["", "A", "!!!not-base64!!!"])
def test_a_broken_fingerprint_is_skipped_without_failing_the_page(db, broken):
    old = _track(db, "old/Song.mp3", missing=True, play_count=1)
    _track(db, "new/broken.mp3", fingerprint=None)
    broken_row = db.exec(select(Track).where(Track.file_name == "broken.mp3")).one()
    db.add(Fingerprint(track_id=broken_row.id, chromaprint=broken))
    good = _track(db, "new/Song.mp3")
    db.commit()
    assert _pairs(relink.candidates(db)) == [(old.id, good.id)]


def test_a_repeated_confirmation_after_the_merge_is_refused(db):
    old = _track(db, "old/Song.mp3", missing=True, play_count=1)
    new = _track(db, "new/Song.mp3")
    db.commit()
    pair = (old.id, new.id)
    assert relink.merge(db, [pair]) == {"merged": 1, "skipped": 0}
    assert relink.merge(db, [pair]) == {"merged": 0, "skipped": 1}
    db.expunge_all()
    assert db.get(Track, new.id).play_count == 1


def test_a_reversed_pair_never_merges_the_present_file_away(db):
    old = _track(db, "old/Song.mp3", missing=True, play_count=1)
    new = _track(db, "new/Song.mp3")
    db.commit()
    old_id, new_id = old.id, new.id
    assert relink.merge(db, [(new_id, old_id)]) == {"merged": 0, "skipped": 1}
    db.expunge_all()
    assert db.get(Track, old_id).missing and not db.get(Track, new_id).missing


def test_work_added_to_the_new_row_after_listing_blocks_the_confirmation(db):
    old = _track(db, "old/Song.mp3", missing=True, play_count=1)
    new = _track(db, "new/Song.mp3")
    db.commit()
    listed = _pairs(relink.candidates(db))
    assert listed == [(old.id, new.id)]
    db.add(TrackDJProfile(track_id=new.id, energy=2))
    db.commit()
    assert relink.merge(db, listed) == {"merged": 0, "skipped": 1}
    db.expunge_all()
    assert db.get(Track, old.id) is not None and db.get(TrackDJProfile, new.id).energy == 2
