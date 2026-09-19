from __future__ import annotations

from sqlmodel import select

from app.models import ArtistProfile, Track
from app.services.artist_catalog import rebuild_artist_profiles


def test_rebuild_artist_profiles_normalizes_tracks_and_creates_profiles(db):
    db.add(Track(absolute_path="/lib/a.wav", artist="ATYYA", missing=False))
    db.add(Track(absolute_path="/lib/b.wav", artist="AtYyA", missing=False))
    db.add(Track(absolute_path="/lib/c.wav", artist="Carbon Based Lifeforms", missing=False))
    db.commit()

    stats = rebuild_artist_profiles(db)

    assert stats["artists_seen"] == 2
    tracks = db.exec(select(Track).order_by(Track.absolute_path)).all()
    assert [t.artist_normalized for t in tracks] == [
        "atyya",
        "atyya",
        "carbon based lifeforms",
    ]

    profiles = db.exec(select(ArtistProfile).order_by(ArtistProfile.normalized_name)).all()
    assert [p.normalized_name for p in profiles] == ["atyya", "carbon based lifeforms"]
    assert profiles[0].track_count == 2
    assert profiles[1].track_count == 1


def test_rebuild_artist_profiles_zeroes_profiles_no_longer_in_library(db):
    db.add(ArtistProfile(normalized_name="old artist", canonical_name="Old Artist", track_count=3))
    db.add(Track(absolute_path="/lib/a.wav", artist="New Artist", missing=False))
    db.commit()

    rebuild_artist_profiles(db)

    profiles = {
        p.normalized_name: p
        for p in db.exec(select(ArtistProfile)).all()
    }
    assert profiles["old artist"].track_count == 0
    assert profiles["new artist"].track_count == 1


def test_rebuild_artist_profiles_merges_underscore_artist_variants(db):
    db.add(Track(absolute_path="/lib/a.wav", artist="Dark_Whisper", missing=False))
    db.add(Track(absolute_path="/lib/b.wav", artist="Dark Whisper", missing=False))
    db.add(Track(absolute_path="/lib/c.wav", artist="Drip_Drop", missing=False))
    db.add(Track(absolute_path="/lib/d.wav", artist="Drip Drop", missing=False))
    db.commit()

    rebuild_artist_profiles(db)

    profiles = {
        p.normalized_name: p
        for p in db.exec(select(ArtistProfile)).all()
    }
    assert profiles["dark whisper"].track_count == 2
    assert profiles["drip drop"].track_count == 2
