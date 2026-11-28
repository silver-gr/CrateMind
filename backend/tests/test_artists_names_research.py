"""Stage 5 of «Καθαρά ονόματα»: the guards and the research input on act keys, and the readers that follow them.

Plan: .omc/plans/2026-11-28-names-stage5-artist-pages.md (S3). Every name here is invented.
"""
from __future__ import annotations

import json
from datetime import UTC, datetime

from sqlmodel import select

from app.api import artists as artists_api
from app.api.tracks import _list_payload, _track_payload
from app.models import ArtistProfile, ArtistReview, Track, TrackName
from app.services import artist_intelligence, names_switch, recommender, search
from app.services.artist_catalog import rebuild_artist_profiles


def _profile(db, key):
    return db.exec(select(ArtistProfile).where(ArtistProfile.normalized_name == key)).one()


def _confirm(db, profile, genre, scene):
    profile.primary_subgenre, profile.scene_cluster = genre, scene
    db.add(profile)
    db.flush()
    review = db.get(ArtistReview, profile.id) or ArtistReview(artist_id=profile.id, baseline_json="{}")
    review.state, review.confirmed_at = "confirmed", datetime.now(UTC)
    db.add(review)
    db.commit()


def _switch(db, on):
    names_switch.set_on(db, on)
    rebuild_artist_profiles(db)


def _ossa(db):
    """Two tracks credited «[Prog] Ossa» whose artist folder is «Ossa»; today's profile confirmed Darkpsy and,
    once the switch is on, the act profile confirmed Full-On."""
    tracks = []
    for n in (1, 2):
        t = Track(absolute_path=f"/lib/{n}.mp3", artist="[Prog] Ossa", title=f"Raw {n} [190bpm]", missing=False)
        db.add(t)
        db.flush()
        db.add(TrackName(track_id=t.id, artist="Ossa", title=f"Clean {n}", folder="Ossa", status="sure"))
        tracks.append(t)
    db.commit()
    rebuild_artist_profiles(db)
    _confirm(db, _profile(db, "prog ossa"), "Darkpsy", "darkpsy")
    _switch(db, True)
    _confirm(db, _profile(db, "act:ossa"), "Full-On", "full-on")
    return tracks


def test_an_act_placeholder_is_never_due_and_never_a_genre(db):
    for key in ("act:unknownartist", "act:variousartists"):
        profile = ArtistProfile(normalized_name=key, canonical_name="Unknown Artist", track_count=9)
        assert not artist_intelligence.research_pending(profile, None)
        assert not artist_intelligence.research_again_pending(profile, None, "m")
        db.add(profile)
    db.commit()
    _confirm(db, _profile(db, "act:variousartists"), "Darkpsy", "darkpsy")
    assert artist_intelligence.confirmed_substyles(db) == {}


def test_a_search_for_act_lists_no_act_profile(db):
    db.add(ArtistProfile(normalized_name="act:kelvaro", canonical_name="Kelvaro", track_count=3))
    db.add(ArtistProfile(normalized_name="act:mintrel", canonical_name="Mintrel", track_count=3))
    db.add(ArtistProfile(normalized_name="factory", canonical_name="The Factory", track_count=3))
    db.commit()

    def names(q):
        rows = artists_api.list_artists(q=q, confidence_label=None, needs_review=None, min_track_count=0,
                                        limit=200, offset=0, session=db)
        return sorted(r["normalized_name"] for r in rows)

    assert names("act") == ["factory"]
    assert names("kelv") == ["act:kelvaro"]  # the shown name still matches


def test_research_examples_carry_shown_names_only_while_on(db):
    tracks = []
    for n in (1, 2):
        t = Track(absolute_path=f"/lib/{n}.mp3", artist="[Prog] Ossa", title=f"Raw {n} [190bpm]", missing=False)
        db.add(t)
        db.flush()
        db.add(TrackName(track_id=t.id, artist="Ossa", title=f"Clean {n}", folder="Ossa", status="sure"))
        tracks.append(t)
    db.commit()
    rebuild_artist_profiles(db)

    payload, _, _ = artist_intelligence._prepare(db, _profile(db, "prog ossa").id, False, "")
    assert payload["normalized_name"] == "prog ossa"
    assert [e["artist_credit"] for e in payload["library_examples"]] == ["[Prog] Ossa"] * 2
    assert [e["title"] for e in payload["library_examples"]] == ["Raw 1 [190bpm]", "Raw 2 [190bpm]"]

    _switch(db, True)
    payload, _, _ = artist_intelligence._prepare(db, _profile(db, "act:ossa").id, False, "")
    assert payload["normalized_name"] == "ossa" and payload["canonical_name"] == "Ossa"
    assert [e["artist_credit"] for e in payload["library_examples"]] == ["Ossa"] * 2
    assert [e["title"] for e in payload["library_examples"]] == ["Clean 1", "Clean 2"]

    db.get(TrackName, tracks[1].id).title = ""  # a file with no tags has no engine title: the stored one goes
    db.commit()
    payload, _, _ = artist_intelligence._prepare(db, _profile(db, "act:ossa").id, False, "")
    assert [e["title"] for e in payload["library_examples"]] == ["Clean 1", "Raw 2 [190bpm]"]


def test_the_artist_genre_readers_follow_the_act_on_and_todays_key_off(db):
    first, _ = _ossa(db)
    for on, substyle, genre in ((True, "full-on", "Full-On"), (False, "darkpsy", "Darkpsy"),
                                (True, "full-on", "Full-On")):
        _switch(db, on)
        track = db.get(Track, first.id)
        db.refresh(track)
        assert _track_payload(db, track)["track"]["artist_substyle"] == substyle
        assert _list_payload(db, [track])[0]["artist_substyle"] == substyle
        assert recommender.artist_genre(db, track) == genre
        hit = {t.id for t in search.search(db, f"artist_scene:{substyle}")}
        miss = {t.id for t in search.search(db, "artist_scene:" + ("darkpsy" if on else "full-on"))}
        assert first.id in hit and first.id not in miss
        assert first.id in {t.id for t in search.search(db, f"substyle:{substyle}")}


def test_compare_marks_act_placeholders_as_skipped(db, monkeypatch):
    db.add(ArtistProfile(normalized_name="act:unknownartist", canonical_name="Unknown Artist", track_count=4))
    db.add(ArtistProfile(normalized_name="act:kelvaro", canonical_name="Kelvaro", track_count=4))
    db.commit()
    monkeypatch.setattr(artists_api.llm_client, "is_configured", lambda: True)
    monkeypatch.setattr(artists_api.worker, "start_artist_enrich", lambda *a, **k: None)
    artists_api.compare_artists(session=db)
    states = {p.normalized_name: db.get(ArtistReview, p.id).state for p in db.exec(select(ArtistProfile)).all()}
    assert states == {"act:unknownartist": "skipped", "act:kelvaro": "pending"}
    assert json.loads(db.get(ArtistReview, _profile(db, "act:kelvaro").id).baseline_json)["canonical_name"] == "Kelvaro"



def test_research_running_sees_only_a_waiting_or_running_research_job(db):
    from app.models import Job

    assert artist_intelligence.research_running(db) is None
    db.add(Job(kind="artist_enrich", status="done"))
    db.add(Job(kind="scan", status="running"))
    db.commit()
    assert artist_intelligence.research_running(db) is None
    for kind, status in (("artist_enrich", "running"), ("artist_compare", "pending")):
        job = Job(kind=kind, status=status)
        db.add(job)
        db.commit()
        assert artist_intelligence.research_running(db).kind == kind
        job.status = "done"
        db.add(job)
        db.commit()
