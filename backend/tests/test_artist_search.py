from __future__ import annotations

from sqlmodel import Session


def _seed_artist_search_rows():
    import app.db as dbmod
    from app.models import ArtistProfile, Track

    with Session(dbmod.get_engine()) as s:
        t1 = Track(
            absolute_path="/lib/a.wav",
            artist="ATYYA",
            artist_normalized="atyya",
            missing=False,
        )
        t2 = Track(
            absolute_path="/lib/b.wav",
            artist="Carbon Based Lifeforms",
            artist_normalized="carbon based lifeforms",
            missing=False,
        )
        s.add(t1)
        s.add(t2)
        s.add(ArtistProfile(
            normalized_name="atyya",
            canonical_name="ATYYA",
            track_count=1,
            primary_subgenre="deep_dubstep",
            scene_cluster="organic bass / glitch-hop",
            confidence_label="high",
            needs_review=False,
        ))
        s.add(ArtistProfile(
            normalized_name="carbon based lifeforms",
            canonical_name="Carbon Based Lifeforms",
            track_count=1,
            primary_subgenre="space psybient",
            scene_cluster="psybient / psychill",
            confidence_label="medium",
            needs_review=True,
        ))
        s.commit()


def test_artist_scene_filter(client):
    _seed_artist_search_rows()
    rows = client.get("/api/tracks?q=artist_scene%3A%22psybient%20%2F%20psychill%22").json()
    assert len(rows) == 1
    assert rows[0]["artist"] == "Carbon Based Lifeforms"


def test_artist_subgenre_filter(client):
    _seed_artist_search_rows()
    rows = client.get("/api/tracks?q=artist_subgenre:deep_dubstep").json()
    assert len(rows) == 1
    assert rows[0]["artist"] == "ATYYA"


def test_artist_review_filter(client):
    _seed_artist_search_rows()
    rows = client.get("/api/tracks?q=artist_review:true").json()
    assert len(rows) == 1
    assert rows[0]["artist"] == "Carbon Based Lifeforms"
