"""Triage queue backend: keyset paging, the LIMIT 0 fix and the folders route."""
from __future__ import annotations

from sqlalchemy import insert
from sqlmodel import Session, select

from app.db import reindex_track
from app.models import Tag, Track
from app.services import facets

PAGE = 500


def _engine():
    import app.db as dbmod

    return dbmod.get_engine()


def _seed(rows: list[dict]) -> None:
    with Session(_engine()) as session:
        session.execute(insert(Track), rows)
        session.commit()
        for (track_id,) in session.execute(select(Track.id)).all():
            reindex_track(session, track_id, commit=False)
        session.commit()


def _library(n: int = 1234) -> None:
    # The first 1100 have no artist or title: one ('', '') tie group that sorts
    # first and spans the page boundaries at 499/500 and 999/1000, so only the
    # id in the cursor keeps the walk exact. The rest repeat (artist, title) pairs.
    _seed([{"absolute_path": f"/lib/{i}.mp3", "artist": None if i < 1100 else f"Artist {i % 37}",
            "title": None if i < 1100 else f"Title {i % 50}"} for i in range(n)])


def _ids(response) -> list[int]:
    assert response.status_code == 200, response.text
    return [row["id"] for row in response.json()]


def _walk(client, q: str | None, first_after: int | None = None) -> list[list[int]]:
    pages, after = [], first_after
    for _attempt in range(20):  # bounded: an ignored cursor must fail, not hang
        params = {"limit": PAGE}
        if q is not None:
            params["q"] = q
        if after is not None:
            params["after"] = after
        page = _ids(client.get("/api/tracks", params=params))
        pages.append(page)
        if len(page) < PAGE:
            return pages
        after = page[-1]
    raise AssertionError("keyset paging never reached a short page")


def test_list_tracks_limit_zero_returns_everything(client):
    _seed([{"absolute_path": f"/z/{i}.mp3", "title": f"T{i}"} for i in range(3)])
    assert len(_ids(client.get("/api/tracks", params={"limit": 0}))) == 3
    assert len(_ids(client.get("/api/tracks", params={"limit": 0, "q": "untagged"}))) == 3


def test_folders_route_groups_normalised_parents(client):
    _seed([{"absolute_path": "C:\\Music\\A\\1.mp3"}, {"absolute_path": "C:\\Music\\A\\2.mp3"},
           {"absolute_path": "/home/u/B/3.mp3"}, {"absolute_path": "c:\\Music\\A\\4.mp3"},
           {"absolute_path": "C:\\Music/A\\5.mp3"}])
    r = client.get("/api/tracks/folders")
    assert r.status_code == 200, r.text
    assert r.json() == [{"path": "/home/u/B", "count": 1}, {"path": "C:/Music/A", "count": 4}]
    picked = client.get("/api/tracks/count", params={"q": 'folder:"C:/Music/A/"'}).json()["count"]
    assert picked == 4


def test_folders_route_counts_nested_tracks_like_the_folder_token(client):
    _seed([{"absolute_path": "C:\\Music\\Relax\\1.mp3"}, {"absolute_path": "C:\\Music\\Relax\\Piano\\2.mp3"},
           {"absolute_path": "c:\\music\\relax\\piano\\3.mp3"}, {"absolute_path": "/home/u/Relax/4.mp3"},
           {"absolute_path": "/mnt/home/u/Relax/5.mp3"}])
    listed = client.get("/api/tracks/folders").json()
    assert listed == [{"path": "/home/u/Relax", "count": 2}, {"path": "/mnt/home/u/Relax", "count": 1},
                      {"path": "C:/Music/Relax", "count": 3}, {"path": "C:/Music/Relax/Piano", "count": 2}]
    for row in listed:
        q = f'folder:"{row["path"]}/"'
        assert client.get("/api/tracks/count", params={"q": q}).json()["count"] == row["count"], q


def test_keyset_traversal_stable(client):
    _library()
    for q in (None, "untagged"):
        params = {"limit": 0} if q is None else {"limit": 0, "q": q}
        everything = _ids(client.get("/api/tracks", params=params))
        assert len(everything) == 1234
        pages = _walk(client, q)
        walked = [track_id for page in pages for track_id in page]
        assert walked == everything, q
        assert len(set(walked)) == len(walked)
        assert len(pages[-1]) < PAGE


def test_keyset_traversal_shrinking(client):
    _library()
    with Session(_engine()) as session:
        facets.seed_preset(session, "therapy")
        relax = session.exec(select(Tag.id).where(Tag.name == "purpose:χαλάρωση")).one()
    queue = "-purpose:*"
    order = _ids(client.get("/api/tracks", params={"q": queue, "limit": 0}))
    first = _ids(client.get("/api/tracks", params={"q": queue, "limit": PAGE}))
    assert first == order[:PAGE]

    tagged = first[-100:] + order[PAGE + 200:PAGE + 250]  # includes the cursor track itself
    r = client.post("/api/tracks/batch-profile", json={"track_ids": tagged, "add_tag_ids": [relax]})
    assert r.status_code == 200, r.text

    rest = [track_id for page in _walk(client, queue, first_after=first[-1]) for track_id in page]
    assert rest == [track_id for track_id in order[PAGE:] if track_id not in set(tagged)]


def test_keyset_unknown_cursor(client):
    _library(3)
    r = client.get("/api/tracks", params={"after": 999999})
    assert r.status_code == 404
    assert r.json()["detail"] == "Το σημείο συνέχειας δεν βρέθηκε. Φόρτωσε ξανά την ουρά."
    assert client.get("/api/tracks", params={"after": 999999, "q": "untagged"}).status_code == 404
