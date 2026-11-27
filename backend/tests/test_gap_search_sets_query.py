"""Search gaps a DJ hits live: OR with negation, quoted and Greek text, tempo
bounds, degenerate input, and `sort:` / `limit:` seen the same way by every
consumer (list, count, ids, saved searches, facet counts, bulk edit)."""
from __future__ import annotations

import pytest
from sqlmodel import Session, select

from app.db import reindex_track
from app.models import SavedSearch, Track, TrackDJProfile
from app.services import search

# path -> (title, artist, bpm, key, profile or None)
LIBRARY = {
    "/a.wav": ("Alpha Centauri", "Astrix", 145.0, "8A", {"energy": 9, "personal_status": "approved"}),
    "/b.wav": ("Beta Pictoris", "Ace Ventura", 72.5, "9A", {"energy": 5, "personal_status": "retired"}),
    "/c.wav": ("Σ' αγαπώ", "Μάνος Χατζιδάκις", 100.0, None, {"energy": 3, "personal_status": "approved"}),
    "/d.wav": ("Relax One", "Shpongle", None, None, {"energy": 4, "personal_status": "testing"}),
    "/e.wav": ("Relaxation Two", "Shpongle & Friends", 290.0, "8B", {"energy": 7, "personal_status": "weapon"}),
    "/f.wav": ("Two Words Here", "Ácid Ünïcode", 138.0, "8A", {"energy": 9, "personal_status": "testing"}),
}
ALL = set(LIBRARY)


def _seed(session: Session) -> dict[str, int]:
    ids = {}
    for path, (title, artist, bpm, key, profile) in LIBRARY.items():
        track = Track(absolute_path=path, file_name=path.strip("/"), title=title, artist=artist,
                      bpm=bpm, key_text=key, missing=False)
        session.add(track)
        session.commit()
        session.refresh(track)
        if profile:
            session.add(TrackDJProfile(track_id=track.id, **profile))
            session.commit()
        reindex_track(session, track.id)
        ids[path] = track.id
    return ids


@pytest.fixture
def lib(db):
    _seed(db)
    return db


def _paths(rows) -> set[str]:
    return {t.absolute_path for t in rows}


def _order(rows) -> list[str]:
    return [t.absolute_path for t in rows]


@pytest.mark.parametrize("query, expected", [
    # OR with negation on either side, and negated free text
    ("energy:9 OR -relax", {"/a.wav", "/b.wav", "/c.wav", "/e.wav", "/f.wav"}),
    ("-relax OR -alpha", ALL),                         # no track holds both words
    ("-relax -alpha", {"/b.wav", "/c.wav", "/e.wav", "/f.wav"}),
    ("-status:approved OR -energy:9", ALL - {"/a.wav"}),
    ("-energy:9 OR energy:9", ALL),
    # OR binds tighter than the AND around it
    ("relax OR energy:9 shpongle", {"/d.wav", "/e.wav"}),
    ("shpongle relax OR alpha", {"/d.wav", "/e.wav"}),
    ("status:weapon OR status:retired -relaxation", {"/b.wav"}),
    # a doubled OR is one join
    ("energy:9 OR OR energy:5", {"/a.wav", "/b.wav", "/f.wav"}),
    # quoted text: a phrase, its negation, and a quoted OR stays a word
    ('"two words"', {"/f.wav"}),
    ('-"two words"', ALL - {"/f.wav"}),
    ('"relaxation two" OR "alpha centauri"', {"/a.wav", "/e.wav"}),
    ('"OR" alpha', set()),
    # an excluded word is exact, an included one is a prefix
    ("relax", {"/d.wav", "/e.wav"}),
    ("-relax", ALL - {"/d.wav"}),
    # Greek and accented text: as typed, without accents, in capitals
    ("Σ' αγαπώ", {"/c.wav"}),
    ('"Σ\' αγαπώ"', {"/c.wav"}),
    ("αγαπω", {"/c.wav"}),
    ("ΑΓΑΠΏ", {"/c.wav"}),
    ("μανος χατζιδ", {"/c.wav"}),
    ("-χατζιδακις", ALL - {"/c.wav"}),
    ("acid unicode", {"/f.wav"}),
    ("artist:ACID", {"/f.wav"}),
    ('artist:"Shpongle & Friends"', {"/e.wav"}),
    ("artist:shpongle", {"/d.wav", "/e.wav"}),
    ("-artist:shpongle", {"/a.wav", "/b.wav", "/c.wav", "/f.wav"}),
    # an unknown field falls back to free text, negation included
    ("colour:alpha", {"/a.wav"}),
    ("-colour:alpha", ALL - {"/a.wav"}),
    # status lists, alone and in an OR
    ("status:approved,weapon", {"/a.wav", "/c.wav", "/e.wav"}),
    ("status:retired OR status:approved,weapon", {"/a.wav", "/b.wav", "/c.wav", "/e.wav"}),
])
def test_or_negation_quotes_and_unicode(lib, query, expected):
    assert _paths(search.search(lib, query)) == expected
    assert search.count(lib, query) == len(expected)


@pytest.mark.parametrize("query", ["", "   ", "!!!", "-", "- - -", "OR", "OR OR", '""', '-""'])
def test_degenerate_queries_match_the_whole_library(lib, query):
    assert _paths(search.search(lib, query)) == ALL
    assert search.count(lib, query) == len(ALL)


def test_an_unclosed_quote_still_searches_the_words(lib):
    assert _paths(search.search(lib, '"two words')) == {"/f.wav"}


@pytest.mark.parametrize("bpm, inside", [
    (139.49, False), (139.5, True), (145.49, True), (145.5, False),
])
def test_whole_bpm_range_edges_follow_the_rounded_bpm(db, bpm, inside):
    track = Track(absolute_path="/edge.wav", title="Edge", bpm=bpm, missing=False)
    db.add(track)
    db.commit()
    assert search.count(db, "bpm:140-145") == (1 if inside else 0)
    assert search.count(db, "-bpm:140-145") == (0 if inside else 1)


@pytest.mark.parametrize("query, expected", [
    # the search never folds an octave: half and double tempo are their own BPM
    ("bpm:140-150", {"/a.wav"}),
    ("bpm:137-150", {"/a.wav", "/f.wav"}),
    ("bpm:72-73", {"/b.wav"}),
    ("bpm:290", {"/e.wav"}),
    ("bpm:72.5", {"/b.wav"}),
    ("bpm:150.0-137.0", {"/a.wav", "/f.wav"}),         # decimal bounds in either order
    # a track without a BPM never matches a positive filter and stays in a negated one
    ("-bpm:140-150", ALL - {"/a.wav"}),
    ("bpm:200+", {"/e.wav"}),
    ("bpm:100-", {"/b.wav", "/c.wav"}),
])
def test_bpm_filters_on_half_and_double_tempo(lib, query, expected):
    assert _paths(search.search(lib, query)) == expected


@pytest.mark.parametrize("query, expected", [
    # Latin before Greek, accents and case folded: «Ácid» sorts as "acid", after "ace"
    ("sort:artist", ["/b.wav", "/f.wav", "/a.wav", "/d.wav", "/e.wav", "/c.wav"]),
    ("sort:-artist", ["/c.wav", "/e.wav", "/d.wav", "/a.wav", "/f.wav", "/b.wav"]),
    # directives are case-insensitive
    ("SORT:BPM LIMIT:2", ["/b.wav", "/c.wav"]),
    ("Sort:-Bpm", ["/e.wav", "/a.wav", "/f.wav", "/c.wav", "/b.wav", "/d.wav"]),
    # equal sort values fall back to the artist/title order
    ("sort:-energy limit:2", ["/a.wav", "/f.wav"]),
    ("energy:9 sort:energy", ["/a.wav", "/f.wav"]),
])
def test_sort_order_with_unicode_ties_and_case(lib, query, expected):
    assert _order(search.search(lib, query)) == expected


def test_limit_beyond_the_matches_and_limit_with_no_matches(lib):
    assert search.count(lib, "energy:9 limit:50") == 2
    assert search.count(lib, "energy:10 limit:5") == 0
    assert search.search(lib, "energy:10 sort:bpm limit:5") == []
    assert search.ids(lib, "energy:10 limit:5") == []


def test_every_key_in_one_list_under_a_low_variable_limit(lib, low_variable_limit):
    keys = ",".join(f"{n}{m}" for n in range(1, 13) for m in "AB")
    assert _paths(search.search(lib, f"key:{keys}")) == {"/a.wav", "/b.wav", "/e.wav", "/f.wav"}
    assert _paths(search.search(lib, f"-key:{keys}")) == {"/c.wav", "/d.wav"}


def test_huge_or_chains_and_huge_words_do_not_fail(lib):
    chain = " OR ".join(["energy:1"] * 299 + ["energy:5"])
    assert _paths(search.search(lib, chain)) == {"/b.wav"}
    words = " OR ".join(f"nomatch{n}" for n in range(200)) + " OR alpha"
    assert _paths(search.search(lib, words)) == {"/a.wav"}
    assert search.count(lib, "zzz" * 2000) == 0


# --- every consumer sees the same `sort:` / `limit:` result -------------------

CONSUMER_CASES = [
    ("energy:9 OR relax sort:-bpm limit:3", ["/e.wav", "/a.wav", "/f.wav"]),
    ("-relax sort:title limit:2", ["/a.wav", "/b.wav"]),
    ('"two words" OR status:retired sort:bpm limit:1', ["/b.wav"]),
    ("αγαπω OR energy:5 sort:-bpm", ["/c.wav", "/b.wav"]),
    ("limit:4 sort:-energy -status:retired", ["/a.wav", "/f.wav", "/e.wav", "/d.wav"]),
    ("status:approved,weapon limit:2", ["/a.wav", "/e.wav"]),   # first two in artist/title order
]


@pytest.mark.parametrize("query, expected", CONSUMER_CASES)
def test_every_consumer_agrees_on_sort_and_limit(client, query, expected):
    import app.db as dbmod

    with Session(dbmod.get_engine(), expire_on_commit=False) as session:
        ids = _seed(session)
        crate = SavedSearch(name="Κιβώτιο", query=query)
        session.add(crate)
        session.commit()
        crate_id = crate.id
    want_ids = sorted(ids[p] for p in expected)

    rows = client.get("/api/tracks", params={"q": query, "limit": 0}).json()
    assert [r["absolute_path"] for r in rows] == expected
    assert client.get("/api/tracks/count", params={"q": query}).json() == {"count": len(expected)}
    assert client.get("/api/facets/counts", params={"q": query}).json()["total"] == len(expected)

    saved = client.get(f"/api/searches/{crate_id}/tracks").json()
    assert [r["absolute_path"] for r in saved] == expected
    assert next(s for s in client.get("/api/searches").json() if s["id"] == crate_id)["count"] == len(expected)
    member = next(s for s in client.get("/api/searches/membership").json() if s["id"] == crate_id)
    assert sorted(member["track_ids"]) == want_ids

    dry = client.post("/api/tracks/batch-profile", json={"query": query, "profile": {"mixability": 3},
                                                          "dry_run": True})
    assert dry.status_code == 200, dry.text
    assert dry.json()["matched"] == len(expected)


def test_saved_search_route_limit_and_query_limit_both_cap(client):
    import app.db as dbmod

    with Session(dbmod.get_engine(), expire_on_commit=False) as session:
        _seed(session)
        crate = SavedSearch(name="Γρήγορα", query="sort:-bpm limit:3")
        session.add(crate)
        session.commit()
        crate_id = crate.id
    one = client.get(f"/api/searches/{crate_id}/tracks", params={"limit": 1}).json()
    assert [r["absolute_path"] for r in one] == ["/e.wav"]
    many = client.get(f"/api/searches/{crate_id}/tracks", params={"limit": 100}).json()
    assert [r["absolute_path"] for r in many] == ["/e.wav", "/a.wav", "/f.wav"]


def test_bulk_edit_scope_is_fixed_before_it_writes_the_sorted_field(client):
    """`sort:-energy limit:2` then energy=1: only the two first tracks change,
    even though the write moves them out of the top two."""
    import app.db as dbmod

    with Session(dbmod.get_engine(), expire_on_commit=False) as session:
        ids = _seed(session)
    r = client.post("/api/tracks/batch-profile", json={"query": "sort:-energy limit:2", "profile": {"energy": 1}})
    assert r.status_code == 200, r.text
    assert (r.json()["matched"], r.json()["updated"]) == (2, 2)
    with Session(dbmod.get_engine()) as session:
        energy = {p: session.get(TrackDJProfile, i).energy for p, i in ids.items()}
    assert energy == {"/a.wav": 1, "/b.wav": 5, "/c.wav": 3, "/d.wav": 4, "/e.wav": 7, "/f.wav": 1}
    # the same query now names the next two
    now = client.get("/api/tracks", params={"q": "sort:-energy limit:2", "limit": 0}).json()
    assert [row["absolute_path"] for row in now] == ["/e.wav", "/b.wav"]


def test_bulk_edit_by_query_with_or_and_negation_touches_only_matches(client):
    import app.db as dbmod

    with Session(dbmod.get_engine(), expire_on_commit=False) as session:
        ids = _seed(session)
    r = client.post("/api/tracks/batch-profile",
                    json={"query": "-relax status:testing OR status:retired", "profile": {"mixability": 8}})
    assert r.status_code == 200, r.text
    assert r.json()["updated"] == 2
    with Session(dbmod.get_engine()) as session:
        changed = {p for p, i in ids.items() if session.get(TrackDJProfile, i).mixability == 8}
        assert changed == {"/b.wav", "/f.wav"}
        assert all(p.mixability in (None, 8) for p in session.exec(select(TrackDJProfile)).all())


def test_keyset_pages_stay_inside_the_limit(client):
    import app.db as dbmod

    with Session(dbmod.get_engine(), expire_on_commit=False) as session:
        _seed(session)
    q = "sort:bpm limit:3"
    seen: list[str] = []
    after = None
    for _ in range(5):
        params = {"q": q, "limit": 2, **({"after": after} if after else {})}
        page = client.get("/api/tracks", params=params).json()
        if not page:
            break
        seen += [row["absolute_path"] for row in page]
        after = page[-1]["id"]
    assert seen == ["/b.wav", "/c.wav", "/f.wav"]
    # offset paging past the limit is empty, as on /search
    assert client.get("/api/tracks/search", params={"q": q, "limit": 2, "offset": 3}).json() == []
