from __future__ import annotations

from app.models import ArtistProfile, Track


def test_list_artists_sorts_by_track_count(client, db):
    db.add(ArtistProfile(normalized_name="b", canonical_name="B", track_count=1))
    db.add(ArtistProfile(normalized_name="a", canonical_name="A", track_count=3))
    db.commit()

    rows = client.get("/api/artists").json()
    assert [row["canonical_name"] for row in rows[:2]] == ["A", "B"]


def test_artist_stats_counts_active_unenriched_and_review(client, db):
    db.add(ArtistProfile(normalized_name="a", canonical_name="A", track_count=3, needs_review=True))
    db.add(ArtistProfile(normalized_name="b", canonical_name="B", track_count=0))
    db.commit()

    body = client.get("/api/artists/stats").json()
    assert body["total_artists"] == 1
    assert body["active_artists"] == 1
    assert body["unenriched_artists"] == 1
    assert body["needs_review_artists"] == 1


def test_rebuild_artists_updates_profiles_from_tracks(client, db):
    db.add(Track(absolute_path="/lib/a.wav", artist="ATYYA", missing=False))
    db.add(Track(absolute_path="/lib/b.wav", artist="AtYyA", missing=False))
    db.commit()

    body = client.post("/api/artists/rebuild").json()
    assert body["artists_seen"] == 1

    rows = client.get("/api/artists").json()
    assert len(rows) == 1
    assert rows[0]["normalized_name"] == "atyya"


def test_enrich_artists_returns_job(client, monkeypatch):
    monkeypatch.setattr("app.api.artists.llm_client.is_configured", lambda: True)
    monkeypatch.setattr("app.api.artists.worker.start_artist_enrich", lambda *a: None)
    body = client.post("/api/artists/enrich", json={"limit": 10}).json()
    assert body["kind"] == "artist_enrich"
    assert body["status"] == "pending"


def test_accept_artist_prefill_reuses_profile_update_shape(client, db):
    db.add(Track(absolute_path="/lib/a.wav", artist="ATYYA", missing=False))
    db.commit()
    body = client.post(
        "/api/artists/tracks/1/accept-prefill",
        json={"psy_substyle": "deep_dubstep", "human_confirmed": True},
    ).json()
    assert body["psy_substyle"] == "deep_dubstep"
    assert body["human_confirmed"] is True


def test_rebuild_and_enrich_reject_active_job(client, db):
    from app.models import Job
    db.add(Job(kind="artist_enrich", status="running")); db.commit()
    assert client.post("/api/artists/rebuild").status_code == 409
    assert client.post("/api/artists/enrich", json={}).status_code == 409


def test_enrich_requires_configuration_and_positive_limit(client, monkeypatch):
    monkeypatch.setattr("app.api.artists.llm_client.is_configured", lambda: False)
    assert client.post("/api/artists/enrich", json={}).status_code == 400
    assert client.post("/api/artists/enrich", json={"limit": -1}).status_code == 422
