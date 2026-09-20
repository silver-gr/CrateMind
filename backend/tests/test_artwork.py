"""Tests for track artwork endpoint with embedded artwork and SoundCloud fallback."""
from __future__ import annotations

from pathlib import Path
from sqlmodel import Session

from app.models import SoundCloudTrack, Track, TrackSoundCloudMatch
import app.db as dbmod


def test_artwork_not_found(client):
    res = client.get("/api/tracks/999999/artwork")
    assert res.status_code == 404


def test_artwork_soundcloud_fallback(client):
    with Session(dbmod.get_engine()) as s:
        t = Track(
            absolute_path="/nonexistent/track.mp3",
            extension="mp3",
            file_name="track.mp3",
            missing=False,
        )
        s.add(t)
        s.commit()
        s.refresh(t)

        sc = SoundCloudTrack(
            soundcloud_track_id=123456789,
            urn="soundcloud:tracks:123456789",
            title="SC Test",
            artwork_url="https://i1.sndcdn.com/artworks-test-large.jpg",
            raw_json="{}",
            fetched_at="2026-09-19T18:00:00Z",
        )
        s.add(sc)
        s.commit()

        match = TrackSoundCloudMatch(
            track_id=t.id,
            soundcloud_track_id=sc.soundcloud_track_id,
            confidence=0.95,
            method="auto_high_confidence",
            reasons_json="[]",
            matched_at="2026-09-19T18:00:00Z",
        )
        s.add(match)
        s.commit()
        track_id = t.id

    res = client.get(f"/api/tracks/{track_id}/artwork", follow_redirects=False)
    assert res.status_code == 307
    assert res.headers["location"] == "https://i1.sndcdn.com/artworks-test-large.jpg"
