"""Stage 5 of «Καθαρά ονόματα»: the artist pages follow the names job's artist folders while the switch is on.

Plan: .omc/plans/2026-11-28-names-stage5-artist-pages.md (S1). Every name here is invented.
"""
from __future__ import annotations

import json
from collections import Counter
from datetime import UTC, datetime

from sqlmodel import Session, SQLModel, create_engine, select

from app.models import ArtistProfile, ArtistReview, Track, TrackName
from app.services import names_store, names_switch
from app.services.artist_catalog import carry_sources, rebuild_artist_profiles
from app.services.artist_intelligence import PLACEHOLDER_ARTISTS, confirmed_substyles
from app.services.artist_normalizer import normalize_primary_artist_name, primary_artist_name


# ---------------------------------------------------------------- today's rebuild, frozen (main 9c52655)
def _rebuild_today(session: Session) -> dict[str, int]:
    tracks = session.exec(select(Track).where(Track.missing == False)).all()  # noqa: E712
    buckets: dict[str, Counter[str]] = {}
    updated_tracks = 0
    now = datetime.now(UTC)
    for track in tracks:
        normalized = normalize_primary_artist_name(track.artist)
        if track.artist_normalized != normalized:
            track.artist_normalized = normalized
            session.add(track)
            updated_tracks += 1
        if normalized is None:
            continue
        canonical = primary_artist_name(track.artist) or track.artist or normalized
        buckets.setdefault(normalized, Counter())[canonical] += 1
    existing = {p.normalized_name: p for p in session.exec(select(ArtistProfile)).all()}
    created = 0
    updated_profiles = 0
    for normalized_name, names in buckets.items():
        profile = existing.get(normalized_name)
        if profile is None:
            legacy = [p for key, p in existing.items() if key not in buckets
                      and normalize_primary_artist_name(p.canonical_name) == normalized_name]
            if len(legacy) == 1:
                profile = legacy[0]
                existing.pop(profile.normalized_name)
                profile.normalized_name = normalized_name
                existing[normalized_name] = profile
        if profile is None:
            profile = ArtistProfile(normalized_name=normalized_name, canonical_name=names.most_common(1)[0][0],
                                    track_count=sum(names.values()))
            created += 1
        else:
            profile.canonical_name = names.most_common(1)[0][0]
            profile.track_count = sum(names.values())
            profile.updated_at = now
            updated_profiles += 1
        session.add(profile)
    for normalized_name, profile in existing.items():
        if normalized_name in buckets:
            continue
        if profile.track_count != 0:
            profile.track_count = 0
            profile.updated_at = now
            session.add(profile)
            updated_profiles += 1
    session.commit()
    return {"tracks_seen": len(tracks), "tracks_updated": updated_tracks, "artists_seen": len(buckets),
            "artists_created": created, "artists_updated": updated_profiles}


# ---------------------------------------------------------------- helpers
def _track(session, n, artist, *, missing=False, key=None):
    t = Track(absolute_path=f"/lib/{n}.mp3", artist=artist, title=f"T{n}", missing=missing, artist_normalized=key)
    session.add(t)
    session.flush()
    return t


def _name(session, track, folder, status="sure", artist=None, title=None):
    session.add(TrackName(track_id=track.id, artist=artist if artist is not None else folder,
                          title=title or track.title, folder=folder, status=status))


def _confirm(session, profile, genre="Darkpsy"):
    profile.primary_subgenre = genre
    profile.raw_llm_json = json.dumps({"research": {"status": "classified"}})
    session.add(profile)
    session.flush()
    session.add(ArtistReview(artist_id=profile.id, baseline_json="{}", state="confirmed", confirmed_choice="manual",
                             confirmed_at=datetime.now(UTC)))


def _profiles(session):
    return {p.normalized_name: p for p in session.exec(select(ArtistProfile)).all()}


def _keys(session):
    return {t.id: t.artist_normalized for t in session.exec(select(Track).order_by(Track.id)).all()}


def _state(session):
    profiles = [{k: v for k, v in p.model_dump().items() if k not in ("created_at", "updated_at")}
                for p in session.exec(select(ArtistProfile).order_by(ArtistProfile.id)).all()]
    reviews = [{k: v for k, v in r.model_dump().items() if k not in ("confirmed_at", "updated_at")}
               for r in session.exec(select(ArtistReview).order_by(ArtistReview.artist_id)).all()]
    return profiles, reviews, _keys(session)


def _fixture(session):
    """A small library with every case today's rebuild handles, plus `track_names` rows and a switch row."""
    session.add(ArtistProfile(normalized_name="old artist", canonical_name="Old Artist", track_count=3))
    session.add(ArtistProfile(normalized_name="zorvik", canonical_name="Zørvik", track_count=1))  # legacy re-key
    kept = ArtistProfile(normalized_name="atyya", canonical_name="ATYYA", track_count=1)
    session.add(kept)
    session.flush()
    _confirm(session, kept)
    rows = [("ATYYA", False), ("AtYyA", False), ("Dark_Whisper", False), ("Dark Whisper", False),
            ("Kelvaro & Mintrel", False), ("Kelvaro feat Ossa", False), ("Zørvik", False), ("Unknown Artist", False),
            (None, False), ("Gone Act", True), ("Mintrel", False)]
    for n, (artist, missing) in enumerate(rows, 1):
        t = _track(session, n, artist, missing=missing, key="stale" if n == 3 else None)
        _name(session, t, (artist or "Unknown Artist").replace("_", " "), "none" if artist is None else "sure")
    session.commit()
    names_switch.set_on(session, True)
    names_switch.set_on(session, False)


def _engine(tmp_path, name):
    engine = create_engine(f"sqlite:///{tmp_path / name}")
    SQLModel.metadata.create_all(engine)
    return engine


# ---------------------------------------------------------------- the switch off is today
def test_switch_off_gives_exactly_todays_rebuild(tmp_path):
    today, ours = _engine(tmp_path, "today.sqlite"), _engine(tmp_path, "ours.sqlite")
    with Session(today, expire_on_commit=False) as a, Session(ours, expire_on_commit=False) as b:
        _fixture(a)
        _fixture(b)
        assert not names_switch.is_on(b) and b.exec(select(TrackName)).all()
        for _ in range(2):  # the first rebuild and an idempotent second one
            expected = _rebuild_today(a)
            got = rebuild_artist_profiles(b)
            assert {k: got[k] for k in expected} == expected
            assert (got["artists_carried"], got["artists_merged"], got["artists_split"]) == (0, 0, 0)
            assert _state(a) == _state(b)
        assert _profiles(b)["zørvik"].canonical_name == "Zørvik"  # the legacy re-key ran on both sides


# ---------------------------------------------------------------- the switch on
def test_switch_on_keys_tracks_by_their_artist_folder(db):
    tracks = [_track(db, n, a) for n, a in enumerate(
        ["Kelvaro & Mintrel", "KELVARO", "Nobra & Dyvel", "Nobra & Dyvel", "Who", "Who Else", "Raw Only", "Ossa",
         "[Prog] Babalos"], 1)]
    _name(db, tracks[0], "Kelvaro", artist="Kelvaro & Mintrel")
    _name(db, tracks[1], "Kelvaro", "look")
    _name(db, tracks[2], "Nobra & Dyvel")  # N25: the whole credit is the folder
    _name(db, tracks[3], "Nobra & Dyvel", "hand")
    _name(db, tracks[4], "Who", "open")
    _name(db, tracks[5], "", "none")
    _name(db, tracks[7], "Unknown Artist")  # guard: the engine's no-artist folder never makes an artist
    _name(db, tracks[8], "Babalos")
    # tracks[6] has no row: today's key
    db.commit()
    names_switch.set_on(db, True)

    rebuild_artist_profiles(db)

    keys = _keys(db)
    assert [keys[t.id] for t in tracks] == [
        "act:kelvaro", "act:kelvaro", "act:nobraanddyvel", "act:nobraanddyvel", None, None, "raw only", None,
        "act:babalos"]
    assert names_store.act_key("Nobra & Dyvel") == "nobraanddyvel"
    profiles = _profiles(db)
    assert profiles["act:kelvaro"].canonical_name == "Kelvaro" and profiles["act:kelvaro"].track_count == 2
    assert profiles["act:nobraanddyvel"].track_count == 2
    assert profiles["raw only"].track_count == 1
    assert "who" not in profiles and not any("prog" in k for k in profiles)


def test_profile_name_is_the_commonest_folder_spelling(db):
    for n, folder in enumerate(["Mimo Vex", "Mimo Vex", "MIMO VEX"], 1):
        _name(db, _track(db, n, folder), folder)
    db.commit()
    names_switch.set_on(db, True)
    rebuild_artist_profiles(db)
    assert _profiles(db)["act:mimovex"].canonical_name == "Mimo Vex"


# ---------------------------------------------------------------- carry-over
def test_mutual_majority_copies_the_profile_and_its_confirmed_review(db):
    for n in range(1, 4):
        _name(db, _track(db, n, "[Prog] Kelvaro"), "Kelvaro")
    stray = _track(db, 4, "Unknown Artist")  # a placeholder source does not break the majority
    _name(db, stray, "Kelvaro")
    db.commit()
    rebuild_artist_profiles(db)
    old = _profiles(db)["prog kelvaro"]
    _confirm(db, old, "Full-On")
    old.notes = "εύρημα"
    db.commit()
    names_switch.set_on(db, True)

    stats = rebuild_artist_profiles(db)

    profiles = _profiles(db)
    new = profiles["act:kelvaro"]
    assert stats["artists_carried"] == 1 and new.id != old.id
    assert (new.primary_subgenre, new.notes, new.track_count, new.canonical_name) == ("Full-On", "εύρημα", 4, "Kelvaro")
    assert profiles["prog kelvaro"].primary_subgenre == "Full-On"  # the old row stays as it was
    assert profiles["prog kelvaro"].track_count == 0
    review = db.get(ArtistReview, new.id)
    assert review.state == "confirmed" and review.confirmed_choice == "manual"
    assert db.get(ArtistReview, old.id).state == "confirmed"
    assert confirmed_substyles(db) == {"prog kelvaro": "full-on", "act:kelvaro": "full-on"}


def test_a_merge_of_equals_a_tie_and_a_split_copy_nothing(db):
    # two old artists of equal weight merge into one act
    for n, artist in enumerate(["Zarvo", "Zarvo", "Zarvo Music", "Zarvo Music"], 1):
        _name(db, _track(db, n, artist), "Zarvo")
    # one old artist splits three ways (a compiler credit)
    for n, folder in enumerate(["Ajjo", "Sifu", "Cojo"], 5):
        _name(db, _track(db, n, "Compiled by Gravo"), folder)
    db.commit()
    rebuild_artist_profiles(db)
    for key in ("zarvo", "zarvo music", "compiled by gravo"):
        _confirm(db, _profiles(db)[key])
    db.commit()
    names_switch.set_on(db, True)

    stats = rebuild_artist_profiles(db)

    profiles = _profiles(db)
    assert stats["artists_carried"] == 0
    assert stats["artists_merged"] == 1 and stats["artists_split"] == 1
    for key in ("act:zarvo", "act:ajjo", "act:sifu", "act:cojo"):
        assert profiles[key].primary_subgenre is None and db.get(ArtistReview, profiles[key].id) is None


def test_carry_sources_rules():
    ph = PLACEHOLDER_ARTISTS
    # a 2-of-3 majority both ways
    assert carry_sources({1: "a", 2: "a", 3: "b"}, {1: "act:a", 2: "act:a", 3: "act:a"}, ph).sources == {"act:a": "a"}
    # the largest share alone is enough on the new side (a solo name with its collaborations)
    got = carry_sources({1: "a", 2: "a", 3: "a and b", 4: "a and c", 5: "a, d"}, {n: "act:a" for n in range(1, 6)}, ph)
    assert got.sources == {"act:a": "a"} and got.merges == {"act:a": ["a", "a and b", "a and c", "a, d"]}
    # a tie on the new side
    assert carry_sources({1: "a", 2: "b"}, {1: "act:a", 2: "act:a"}, ph).sources == {}
    assert carry_sources({1: "a", 2: "a", 3: "b", 4: "b", 5: "c"}, {n: "act:a" for n in range(1, 6)}, ph).sources == {}
    # a tie on the old side: half of «a» went elsewhere
    assert carry_sources({1: "a", 2: "a"}, {1: "act:a", 2: "act:b"}, ph).sources == {}
    # placeholder and missing sources are left out of both counts; tracks that lost their artist still count
    got = carry_sources({1: "unknown artist", 2: None, 3: "a", 4: "act:unknownartist"},
                        {1: "act:a", 2: "act:a", 3: "act:a", 4: "act:a"}, ph)
    assert got.sources == {"act:a": "a"} and got.merges == {}
    assert carry_sources({1: "a", 2: "a"}, {1: "act:a", 2: None}, ph).sources == {}
    # nothing is carried into a placeholder
    assert carry_sources({1: "va"}, {1: "act:va"}, ph).sources == {}
    assert carry_sources({1: "various"}, {1: "act:variousartists"}, ph).sources == {}


def test_todays_key_still_in_use_still_gives_its_finding_to_the_act(db):
    # A track scanned after the last names run has no row yet and keeps today's key; the act made at switch-on
    # must still get the finding, or the act profile exists from then on and never copies it.
    tracks = [_track(db, n, "Kelvaro") for n in range(1, 5)]
    for t in tracks[:3]:
        _name(db, t, "Kelvaro Crew")
    db.commit()
    rebuild_artist_profiles(db)
    _confirm(db, _profiles(db)["kelvaro"])
    db.commit()
    names_switch.set_on(db, True)
    assert rebuild_artist_profiles(db)["artists_carried"] == 1
    _name(db, tracks[3], "Kelvaro Crew")  # the run reads the fourth track
    db.commit()
    rebuild_artist_profiles(db)
    act = _profiles(db)["act:kelvarocrew"]
    assert act.track_count == 4 and act.primary_subgenre == "Darkpsy"
    assert db.get(ArtistReview, act.id).state == "confirmed"


def test_an_old_act_key_still_in_use_keeps_its_finding(db):
    tracks = [_track(db, n, "Kelvaro") for n in range(1, 4)]
    for t in tracks:
        _name(db, t, "Kelvaro")
    db.commit()
    names_switch.set_on(db, True)
    rebuild_artist_profiles(db)
    _confirm(db, _profiles(db)["act:kelvaro"])
    db.commit()
    for t in tracks[:2]:  # two of three move to another folder; the third stays on «act:kelvaro»
        db.get(TrackName, t.id).folder = "Kelvaro Crew"
    db.commit()
    assert rebuild_artist_profiles(db)["artists_carried"] == 0
    assert db.get(ArtistReview, _profiles(db)["act:kelvarocrew"].id) is None


def test_a_full_scan_of_unchanged_files_leaves_the_act_and_no_artist_keys(db, monkeypatch):
    from pathlib import Path

    from app.services import scanner

    act, open_ = _track(db, 1, "Kelvaro", key="act:kelvarocrew"), _track(db, 2, "Mintrel", key=None)
    for t in (act, open_):
        t.created_time = 1.0
    db.commit()
    tags = {1: "Kelvaro", 2: "Mintrel"}
    monkeypatch.setattr(scanner, "_read_embedded_record", lambda path, root: {
        "artist": tags[int(path.stem)], "artist_normalized": tags[int(path.stem)].lower(), "title": f"T{path.stem}"})

    def refresh(t):
        return scanner._refresh_track(db, t, None, Path(t.absolute_path), Path("/lib"), None, datetime.now(UTC), True)

    assert [refresh(act), refresh(open_)] == ["unchanged", "unchanged"]
    assert (act.artist_normalized, open_.artist_normalized) == ("act:kelvarocrew", None)
    tags[1] = "Kelvaro Crew"  # a new artist tag still marks the row and gives today's key until the rebuild
    assert refresh(act) == "updated" and act.artist_normalized == "kelvaro crew"


def test_the_unknown_folder_is_the_engines():
    from app.services import artist_catalog
    from app.services.names.resolve import UNKNOWN_ARTIST

    assert artist_catalog.UNKNOWN_FOLDER == UNKNOWN_ARTIST


# ---------------------------------------------------------------- on, off, on
def test_on_off_on_keeps_both_sets_and_orphans_nothing(db):
    tracks = [_track(db, n, a) for n, a in enumerate(["[Prog] Ossa", "[Prog] Ossa", "Pexlo", "Pexlo"], 1)]
    for t, folder in zip(tracks, ["Ossa", "Ossa", "Pexlo", "Pexlo"]):
        _name(db, t, folder)
    db.commit()
    rebuild_artist_profiles(db)
    off_keys = _keys(db)
    _confirm(db, _profiles(db)["pexlo"], "Darkpsy")
    db.commit()

    names_switch.set_on(db, True)
    rebuild_artist_profiles(db)
    on_keys = _keys(db)
    assert set(on_keys.values()) == {"act:ossa", "act:pexlo"}
    assert _profiles(db)["act:pexlo"].primary_subgenre == "Darkpsy"  # carried
    ossa = _profiles(db)["act:ossa"]
    ossa.primary_subgenre = "Prog-psy"  # research made while on lands on the act profile
    db.add(ossa)
    db.add(ArtistReview(artist_id=ossa.id, baseline_json="{}", state="ready"))
    db.commit()
    ids_on = {k: p.id for k, p in _profiles(db).items()}

    names_switch.set_on(db, False)
    stats = rebuild_artist_profiles(db)
    assert _keys(db) == off_keys
    profiles = _profiles(db)
    assert profiles["prog ossa"].primary_subgenre is None and profiles["prog ossa"].track_count == 2
    assert profiles["act:ossa"].primary_subgenre == "Prog-psy" and profiles["act:ossa"].track_count == 0
    assert stats["artists_created"] == 0 and stats["artists_carried"] == 0

    names_switch.set_on(db, True)
    rebuild_artist_profiles(db)
    assert _keys(db) == on_keys
    profiles = _profiles(db)
    assert {k: p.id for k, p in profiles.items()} == ids_on  # nothing deleted, re-keyed or re-created
    assert profiles["act:ossa"].primary_subgenre == "Prog-psy" and profiles["act:ossa"].track_count == 2
    names = [p.normalized_name for p in profiles.values()]
    assert len(names) == len(set(names))
    profile_ids = {p.id for p in profiles.values()}
    assert all(r.artist_id in profile_ids for r in db.exec(select(ArtistReview)).all())


def test_an_artist_first_seen_while_on_gets_its_act_finding_when_off(db):
    tracks = [_track(db, n, "Velkro") for n in (1, 2)]
    for t in tracks:
        _name(db, t, "Velkro")
    db.commit()
    names_switch.set_on(db, True)
    rebuild_artist_profiles(db)
    _confirm(db, _profiles(db)["act:velkro"], "Twilight")
    db.commit()
    names_switch.set_on(db, False)
    assert rebuild_artist_profiles(db)["artists_carried"] == 1
    assert _profiles(db)["velkro"].primary_subgenre == "Twilight"
    assert _profiles(db)["act:velkro"].normalized_name == "act:velkro"


def test_the_legacy_re_key_never_takes_an_act_profile(db):
    db.add(ArtistProfile(normalized_name="act:durovan", canonical_name="Durovan", track_count=0, notes="act"))
    _track(db, 1, "Durovan")  # no previous key: no copy runs, so only the legacy re-key could take it
    db.commit()
    stats = rebuild_artist_profiles(db)
    profiles = _profiles(db)
    assert profiles["act:durovan"].notes == "act" and profiles["durovan"].notes is None
    assert stats["artists_created"] == 1


def test_act_placeholders_are_the_act_keys_of_todays_placeholders():
    today = {p for p in PLACEHOLDER_ARTISTS if not p.startswith("act:")}
    assert {p for p in PLACEHOLDER_ARTISTS if p.startswith("act:")} == {"act:" + names_store.act_key(p) for p in today}


# ---------------------------------------------------------------- the rebuild the names hooks call (S2)
def test_rebuild_quietly_rebuilds_and_never_raises(db, monkeypatch, caplog):
    from app.services import artist_catalog

    _name(db, _track(db, 1, "Kelvaro"), "Kelvaro")
    db.commit()
    names_switch.set_on(db, True)
    assert artist_catalog.rebuild_quietly(db)["artists_seen"] == 1
    assert _keys(db) == {1: "act:kelvaro"}

    def boom(session):
        session.add(ArtistProfile(normalized_name="half", canonical_name="Half"))
        session.flush()
        raise RuntimeError("disk")

    monkeypatch.setattr(artist_catalog, "_rebuild", boom)
    assert artist_catalog.rebuild_quietly(db) is None
    assert "half" not in _profiles(db) and "artist_rebuild_failed" in caplog.text
    assert not artist_catalog._LOCK.locked()
