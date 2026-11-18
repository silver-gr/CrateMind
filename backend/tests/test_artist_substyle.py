"""A track with no substyle of its own shows the genre of its artist, once the user confirmed that genre in
«Καλλιτέχνες». Unconfirmed estimates and placeholder credits never count, and nothing is written to the tracks."""
from __future__ import annotations

from sqlmodel import Session, select

from app.artist_vocab import artist_substyle


def _seed() -> dict[str, int]:
    import app.db as dbmod
    from app.models import ArtistProfile, ArtistReview, Track, TrackDJProfile

    with Session(dbmod.get_engine()) as s:
        artists = {
            "gotalien": ("Gotalien", "Hi-Tech Psytrance", "confirmed"),
            "estimated": ("Estimated", "Darkpsy", "ready"),           # an AI finding the user never confirmed
            "unknown artist": ("Unknown Artist", "Hi-Tech", "confirmed"),  # a placeholder credit, never trusted
        }
        for name, (canonical, genre, state) in artists.items():
            profile = ArtistProfile(normalized_name=name, canonical_name=canonical, primary_subgenre=genre)
            s.add(profile); s.flush()
            s.add(ArtistReview(artist_id=profile.id, baseline_json="{}", state=state))
        tracks = {
            "plain": Track(absolute_path="/lib/plain.wav", artist_normalized="gotalien", missing=False),
            "own": Track(absolute_path="/lib/own.wav", artist_normalized="gotalien", missing=False),
            "empty": Track(absolute_path="/lib/empty.wav", artist_normalized="gotalien", missing=False),
            "estimated": Track(absolute_path="/lib/est.wav", artist_normalized="estimated", missing=False),
            "placeholder": Track(absolute_path="/lib/unknown.wav", artist_normalized="unknown artist", missing=False),
        }
        s.add_all(tracks.values()); s.flush()
        s.add(TrackDJProfile(track_id=tracks["own"].id, psy_substyle="darkpsy"))
        s.add(TrackDJProfile(track_id=tracks["empty"].id, psy_substyle="", energy=5))
        s.commit()
        return {key: t.id for key, t in tracks.items()}


def test_artist_genres_map_to_track_substyles():
    assert artist_substyle("Hi-Tech Psytrance") == "hi-tech"
    assert artist_substyle("Hitech") == "hi-tech"
    assert artist_substyle("Goa Trance") == "goa"
    assert artist_substyle("Night Full-On") == "night-full-on"
    assert artist_substyle("Futureprog") == "Futureprog"     # outside the list: kept as spelled
    assert artist_substyle("  ") is None and artist_substyle(None) is None


def test_list_and_detail_show_only_confirmed_artist_genres(client):
    ids = _seed()
    rows = {r["id"]: r for r in client.get("/api/tracks").json()}
    assert rows[ids["plain"]]["artist_substyle"] == "hi-tech"
    assert rows[ids["plain"]]["psy_substyle"] is None
    assert rows[ids["own"]]["artist_substyle"] == "hi-tech" and rows[ids["own"]]["psy_substyle"] == "darkpsy"
    assert rows[ids["estimated"]]["artist_substyle"] is None
    assert rows[ids["placeholder"]]["artist_substyle"] is None
    assert client.get(f"/api/tracks/{ids['plain']}").json()["track"]["artist_substyle"] == "hi-tech"
    assert client.get(f"/api/tracks/{ids['placeholder']}").json()["track"]["artist_substyle"] is None


def test_substyle_search_counts_the_confirmed_artist_genre(client):
    ids = _seed()

    def found(q):
        return {r["id"] for r in client.get("/api/tracks/search", params={"q": q}).json()}

    # Own substyle wins; a track without one takes its confirmed artist's genre.
    assert found("substyle:hi-tech") == {ids["plain"], ids["empty"]}
    assert found("substyle:darkpsy") == {ids["own"]}
    assert ids["plain"] in found("-substyle:darkpsy") and ids["own"] not in found("-substyle:darkpsy")


def test_showing_the_artist_genre_writes_no_profiles(client):
    import app.db as dbmod
    from app.models import TrackDJProfile

    ids = _seed()
    client.get("/api/tracks"); client.get(f"/api/tracks/{ids['plain']}")
    client.get("/api/tracks/search", params={"q": "substyle:hi-tech"})
    with Session(dbmod.get_engine()) as s:
        assert s.get(TrackDJProfile, ids["plain"]) is None   # still «Αταξινόμητα»
        assert len(s.exec(select(TrackDJProfile)).all()) == 2
