"""Library grouping by crates: GET /api/searches/membership."""
from __future__ import annotations

from sqlmodel import Session

from app.db import reindex_track
from app.models import SavedSearch, Track, TrackDJProfile


def _engine():
    import app.db as dbmod

    return dbmod.get_engine()


def test_membership_returns_crate_ids_in_list_order(client):
    with Session(_engine(), expire_on_commit=False) as session:
        tracks = []
        for path, energy in (("/lib/a.mp3", 9), ("/lib/b.mp3", 4), ("/lib/c.mp3", 8)):
            t = Track(absolute_path=path, title=path, missing=False)
            session.add(t)
            session.commit()
            session.refresh(t)
            session.add(TrackDJProfile(track_id=t.id, energy=energy))
            tracks.append(t)
        session.commit()
        for t in tracks:
            reindex_track(session, t.id)
        session.add_all([
            SavedSearch(name="B calm", query="energy:1-5", sort_order=0),
            SavedSearch(name="Z pinned high", query="energy:8+", pinned=True, sort_order=5),
            SavedSearch(name="A empty", query="energy:10", sort_order=0),
            SavedSearch(name="C later", query="energy:1+", sort_order=1),
        ])
        session.commit()
        a, b, c = (t.id for t in tracks)

    response = client.get("/api/searches/membership")
    assert response.status_code == 200, response.text
    rows = response.json()
    # Pinned first, then sort_order, then name: the crate list's own order.
    assert [r["name"] for r in rows] == ["Z pinned high", "A empty", "B calm", "C later"]
    by_name = {r["name"]: r for r in rows}
    assert set(by_name["Z pinned high"]["track_ids"]) == {a, c}
    assert by_name["Z pinned high"]["query"] == "energy:8+"
    assert by_name["A empty"]["track_ids"] == []
    assert by_name["B calm"]["track_ids"] == [b]
    assert sorted(by_name["C later"]["track_ids"]) == sorted([a, b, c])
    assert set(rows[0]) == {"id", "name", "query", "track_ids"}
