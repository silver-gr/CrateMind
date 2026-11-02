"""Acceptance: triage at scale (Phase A, Tasks 2, 5, 6, 7, 8 and 15 together).

Black-box flows over HTTP on a hand-built 1,234-track library: keyset paging of
the `-purpose:*` queue, bulk tagging (query and selection scope) between pages,
folder-scoped progress counts, the folders route and draining the queue, all
under SQLite's variable cap lowered to 100 (`low_variable_limit`, Task 2).

The library and the therapy preset are written *before* the cap is applied, so
seeding through the ORM (which batches multi-row INSERTs) cannot fail for
reasons unrelated to the code under test. Every request after that runs capped.
No audio files are written; paths are plain strings and never touched on disk.
"""
from __future__ import annotations

from dataclasses import dataclass

import pytest
from sqlalchemy import text
from sqlmodel import Session

import app.db as dbmod
from app.db import reindex_track
from app.models import Track

N = 1234
PAGE = 500  # Task 15 QUEUE_PAGE
QUEUE = "-purpose:*"

# Source folders (as stored) and the `/api/tracks/folders` path each must produce.
DIRS = {
    "relax": "C:\\Music\\Relax\\",
    "relaxation": "C:\\Music\\Relaxation\\",
    "sub": "c:\\music\\relax\\sub\\",
    "posix": "/Users/x/Music/Relax/",
    "greek": "C:\\Μουσική\\Χαλάρωση\\",
}
FOLDER = {
    "relax": "C:/Music/Relax",
    "relaxation": "C:/Music/Relaxation",
    "sub": "c:/music/relax/sub",
    "posix": "/Users/x/Music/Relax",
    "greek": "C:/Μουσική/Χαλάρωση",
}
RELAX = FOLDER["relax"]
RELAX_Q = f'folder:"{RELAX}/"'

# Mixed case, accents and Greek so QUEUE_ORDER is not trivially insertion order.
ARTISTS = ["Μάνος Χατζιδάκις", "Brian Eno", "brian eno", "Ólafur Arnalds",
           "Max Richter", "Άλκηστις", "aphex twin"]
TITLES = ["Χαλάρωση", "Ambient 1", "ambient 1", "Ύπνος", "An Ending",
          "Σ' αγαπώ", "Nuvole Bianche", "Ήρεμα", "Zero", "Avril 14th", "Κόσμος"]


@dataclass
class Library:
    client: object
    by_dir: dict[str, list[int]]   # dir key -> track ids
    order: list[int]               # all ids in QUEUE_ORDER, from raw SQL
    purpose: dict[str, int]        # purpose value text -> value id (Tag.id)


def _seed() -> tuple[dict[str, list[int]], list[int]]:
    keys = list(DIRS)
    by_dir: dict[str, list[int]] = {k: [] for k in keys}
    with Session(dbmod.get_engine(), expire_on_commit=False) as s:
        rows: list[tuple[str, Track]] = []
        for i in range(N):
            key = keys[i % len(keys)]
            t = Track(
                absolute_path=f"{DIRS[key]}{i:04d} take.mp3",
                artist=None if i % 10 == 0 else ARTISTS[i % len(ARTISTS)],
                title=None if i % 97 == 5 else TITLES[i % len(TITLES)],
                missing=False,
            )
            s.add(t)
            rows.append((key, t))
        s.commit()
        for key, t in rows:
            by_dir[key].append(t.id)
            reindex_track(s, t.id, commit=False)
        s.commit()
        order = [r[0] for r in s.execute(text(
            "SELECT id FROM tracks ORDER BY coalesce(artist,''), coalesce(title,''), id"
        ))]
        # Fixture shape the scenario relies on.
        nulls = s.execute(text("SELECT count(*) FROM tracks WHERE artist IS NULL")).scalar_one()
        dup_pairs = s.execute(text(
            "SELECT count(*) FROM (SELECT 1 FROM tracks GROUP BY artist, title HAVING count(*) > 1)"
        )).scalar_one()
    assert 100 <= nulls <= 140
    assert dup_pairs >= 5
    assert len(order) == N
    return by_dir, order


def _purpose_values(client) -> dict[str, int]:
    r = client.get("/api/facets")
    assert r.status_code == 200, r.text
    facet = next(f for f in r.json() if f["key"] == "purpose")
    return {v["value"]: v["id"] for v in facet["values"]}


@pytest.fixture
def library(client, request) -> Library:
    by_dir, order = _seed()
    r = client.post("/api/facets/presets/therapy")
    assert r.is_success, r.text
    # Cap applied only after seeding (see module docstring); requested after `client`.
    request.getfixturevalue("low_variable_limit")
    return Library(client=client, by_dir=by_dir, order=order, purpose=_purpose_values(client))


def _ids(resp) -> list[int]:
    assert resp.status_code == 200, resp.text
    return [row["id"] for row in resp.json()]


def _page(client, q: str | None, *, after: int | None = None, limit: int = PAGE) -> list[int]:
    params: dict[str, object] = {"limit": limit}
    if q is not None:
        params["q"] = q
    if after is not None:
        params["after"] = after
    return _ids(client.get("/api/tracks", params=params))


def _walk(client, q: str, *, after: int | None = None) -> list[list[int]]:
    """Follow `after=<last id>` until a short page, as the queue does."""
    pages: list[list[int]] = []
    while True:
        page = _page(client, q, after=after)
        pages.append(page)
        if len(page) < PAGE:
            return pages
        after = page[-1]


def _count(client, q: str) -> int:
    r = client.get("/api/tracks/count", params={"q": q})
    assert r.status_code == 200, r.text
    return r.json()["count"]


def _batch(client, **body) -> dict:
    r = client.post("/api/tracks/batch-profile", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def _facet_counts(client, q: str) -> dict:
    r = client.get("/api/facets/counts", params={"q": q})
    assert r.status_code == 200, r.text
    return r.json()


def _folders(client) -> list[dict]:
    r = client.get("/api/tracks/folders")
    assert r.status_code == 200, r.text
    return r.json()


# 1 ---------------------------------------------------------------------------
def test_full_keyset_traversal_under_variable_cap(library):
    c = library.client
    assert _count(c, QUEUE) == N

    pages = _walk(c, QUEUE)
    assert [len(p) for p in pages] == [500, 500, 234]
    walked = [i for p in pages for i in p]
    assert len(walked) == len(set(walked))
    # 500-row pages exceed the 100-variable cap: _list_payload must use ids_in.
    assert walked == _page(c, QUEUE, limit=0)
    assert walked == library.order
    assert _page(c, QUEUE, after=walked[-1]) == []


# 2 ---------------------------------------------------------------------------
def test_query_scope_tagging_between_pages_skips_nothing(library):
    c = library.client
    relax_ids = set(library.by_dir["relax"]) | set(library.by_dir["sub"])
    page1 = _page(c, QUEUE)
    assert relax_ids & set(page1) and relax_ids - set(page1)  # folder spans page 1 and later pages

    expected_matched = _count(c, RELAX_Q)
    assert expected_matched == len(relax_ids)
    res = _batch(c, query=RELAX_Q, add_tag_ids=[library.purpose["χαλάρωση"]])
    assert res["matched"] == expected_matched
    assert res["updated"] == expected_matched
    assert res["dry_run"] is False

    rest = [i for p in _walk(c, QUEUE, after=page1[-1]) for i in p]
    pos = library.order.index(page1[-1])
    assert rest == [i for i in library.order[pos + 1:] if i not in relax_ids]
    assert not set(rest) & relax_ids  # no newly tagged track
    seen = page1 + rest
    assert len(seen) == len(set(seen))
    untagged_now = set(_page(c, QUEUE, limit=0))
    assert untagged_now == set(library.order) - relax_ids
    assert untagged_now <= set(seen)  # nothing skipped


# 3 ---------------------------------------------------------------------------
def test_selection_scope_tags_whole_page_including_cursor(library):
    c = library.client
    page1 = _page(c, QUEUE)
    page2 = _page(c, QUEUE, after=page1[-1])
    assert len(page2) == PAGE

    res = _batch(c, track_ids=page2, add_tag_ids=[library.purpose["ύπνος"]])
    assert res["matched"] == PAGE
    assert res["updated"] == PAGE
    assert _count(c, QUEUE) == N - PAGE

    cursor = page2[-1]
    assert cursor not in _page(c, QUEUE, limit=0)  # the cursor no longer matches the query
    # The cursor is a position: the original third page follows, nothing skipped.
    assert _page(c, QUEUE, after=cursor) == library.order[2 * PAGE:]


# 4 ---------------------------------------------------------------------------
def test_progress_counts_stay_coherent_per_folder(library):
    c = library.client
    assert RELAX in {e["path"] for e in _folders(c)}
    folder_q = RELAX_Q  # Task 15 queueQuery("", RELAX)
    queue_q = '-purpose:* folder:"C:/Music/Relax/"'  # Task 15 queueQuery("-purpose:*", RELAX)

    total = _count(c, folder_q)
    assert total == len(library.by_dir["relax"]) + len(library.by_dir["sub"])
    assert _count(c, queue_q) == total
    untagged_before = _count(c, "untagged")

    in_folder = _page(c, folder_q, limit=0)
    assert len(in_folder) == total
    k = 120  # more than the 100-variable cap
    chosen = in_folder[::3][:k]
    assert len(chosen) == k
    assert set(chosen) & set(library.by_dir["sub"])  # nested folder is part of F
    value_id = library.purpose["χαλάρωση"]
    res = _batch(c, track_ids=chosen, add_tag_ids=[value_id])
    assert res["updated"] == k

    remaining = _count(c, queue_q)
    assert total - remaining == k  # progressLine(total - remaining, total)
    walked = [i for p in _walk(c, queue_q) for i in p]
    assert len(walked) == remaining
    assert not set(walked) & set(chosen)
    assert _count(c, folder_q) == total

    counts = _facet_counts(c, folder_q)
    assert counts["total"] == total
    assert counts["counts"][str(value_id)] == k
    assert _count(c, "untagged") == untagged_before  # tag-only bulk creates no profiles


# 5 ---------------------------------------------------------------------------
def test_folders_route_round_trips_into_folder_token(library):
    c = library.client
    entries = _folders(c)  # 200: not captured by /{track_id}
    paths = [e["path"] for e in entries]
    assert all("\\" not in p for p in paths)
    assert paths == sorted(paths)
    counts = {e["path"]: e["count"] for e in entries}
    assert set(counts) == {FOLDER[k] for k in library.by_dir}
    # A count is what picking the folder returns: `folder:` is a folded substring
    # match, so it includes subfolders (nested folders overlap; counts do not sum to N).
    for path, n in counts.items():
        assert _count(c, f'folder:"{path}/"') == n
    # drive-letter case folds: the lower-case nested sub folder is inside Relax
    assert counts[RELAX] == len(library.by_dir["relax"]) + len(library.by_dir["sub"])
    relax_listing = set(_page(c, RELAX_Q, limit=0))
    assert not relax_listing & set(library.by_dir["relaxation"])
    assert _count(c, 'folder:"c:/μουσικη/χαλαρωση/"') == counts[FOLDER["greek"]]


# 6 ---------------------------------------------------------------------------
def test_draining_the_queue(library):
    c = library.client
    page1 = _page(c, QUEUE)
    stale = page1[-1]
    gid = library.purpose["γείωση"]
    queued = _count(c, QUEUE)
    assert queued == N

    dry = _batch(c, query=QUEUE, add_tag_ids=[gid], dry_run=True)
    assert dry["matched"] == queued
    assert dry["dry_run"] is True
    assert dry["updated"] == 0
    assert _count(c, QUEUE) == N
    assert _facet_counts(c, "")["counts"].get(str(gid), 0) == 0

    res = _batch(c, query=QUEUE, add_tag_ids=[gid], dry_run=False)
    assert res["matched"] == N
    assert res["updated"] == N
    assert _count(c, QUEUE) == 0
    assert _page(c, QUEUE) == []
    assert _page(c, QUEUE, after=stale) == []  # the track still exists, so 200 and empty
    after_drain = _facet_counts(c, "")
    assert after_drain["total"] == N
    assert after_drain["counts"][str(gid)] == N

    # LIMIT 0 without q lists everything, in QUEUE_ORDER.
    assert _page(c, None, limit=0) == library.order
