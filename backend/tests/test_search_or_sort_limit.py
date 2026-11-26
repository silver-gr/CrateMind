"""Search mini-language: OR, plays:, key lists, sort: and limit:."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from sqlmodel import Session

from app.db import reindex_track
from app.models import SavedSearch, Track, TrackDJProfile
from app.services import search


def _mk(db, path, title=None, bpm=None, key=None, plays=0, **profile) -> Track:
    t = Track(absolute_path=path, title=title or path.strip("/"), bpm=bpm, key_text=key,
              play_count=plays, missing=False)
    db.add(t)
    db.commit()
    db.refresh(t)
    if profile:
        db.add(TrackDJProfile(track_id=t.id, **profile))
        db.commit()
    reindex_track(db, t.id)
    return t


def _engine():
    import app.db as dbmod

    return dbmod.get_engine()


def _paths(rows):
    return {t.absolute_path for t in rows}


def _order(rows):
    return [t.absolute_path for t in rows]


def test_or_joins_a_term_to_the_next_and_everything_else_stays_and(db):
    _mk(db, "/high.wav", energy=9, set_role="build", personal_status="approved")
    _mk(db, "/peak.wav", energy=5, set_role="peak", personal_status="approved")
    _mk(db, "/peak-retired.wav", energy=5, set_role="peak", personal_status="retired")
    _mk(db, "/calm.wav", energy=3, set_role="opener", personal_status="approved")

    assert _paths(search.search(db, "energy:8-9 OR role:peak")) == {"/high.wav", "/peak.wav", "/peak-retired.wav"}
    # a AND (b OR c)
    assert _paths(search.search(db, "status:approved energy:8-9 OR role:peak")) == {"/high.wav", "/peak.wav"}
    # negation inside an OR group
    assert _paths(search.search(db, "-status:approved OR energy:9")) == {"/high.wav", "/peak-retired.wav"}
    # a chain is one group
    assert _paths(search.search(db, "energy:9 OR role:opener OR status:retired")) == {
        "/high.wav", "/calm.wav", "/peak-retired.wav"}
    # a dangling OR is ignored
    assert _paths(search.search(db, "energy:9 OR")) == {"/high.wav"}
    assert _paths(search.search(db, "OR energy:9")) == {"/high.wav"}
    # only a bare, upper-case OR joins: `or` and "OR" stay free text
    assert _paths(search.search(db, "energy:9 or role:peak")) == set()
    assert _paths(search.search(db, 'energy:9 "OR" role:peak')) == set()


def test_or_with_free_text_and_excluded_words(db):
    _mk(db, "/a.wav", title="Alpha Centauri", energy=9)
    _mk(db, "/b.wav", title="Beta Pictoris", energy=2)
    _mk(db, "/c.wav", title="Gamma Ray", energy=2)

    assert _paths(search.search(db, "alph OR beta")) == {"/a.wav", "/b.wav"}
    assert _paths(search.search(db, "gamma OR energy:9")) == {"/a.wav", "/c.wav"}
    assert _paths(search.search(db, "-gamma OR energy:9")) == {"/a.wav", "/b.wav"}
    # two OR groups with free text each get their own FTS binds
    assert _paths(search.search(db, "alpha OR gamma ray OR beta")) == {"/c.wav"}
    assert search.count(db, "alpha OR beta") == 2


def test_plays_counts_ranges_and_bounds(db):
    for plays in (0, 1, 3, 5, 9):
        _mk(db, f"/p{plays}.wav", plays=plays)

    assert _paths(search.search(db, "plays:0")) == {"/p0.wav"}
    assert _paths(search.search(db, "plays:1-3")) == {"/p1.wav", "/p3.wav"}
    assert _paths(search.search(db, "plays:5+")) == {"/p5.wav", "/p9.wav"}
    assert _paths(search.search(db, "plays:5-")) == {"/p0.wav", "/p1.wav", "/p3.wav", "/p5.wav"}
    assert _paths(search.search(db, "-plays:0")) == {"/p1.wav", "/p3.wav", "/p5.wav", "/p9.wav"}


def test_key_list_with_bpm_range_matches_the_resolved_key(db):
    _mk(db, "/8a.wav", key="8A", bpm=142)
    _mk(db, "/am.wav", key="Am", bpm=144)           # Am is 8A
    _mk(db, "/9a-slow.wav", key="9A", bpm=120)
    _mk(db, "/8b.wav", key="8B", bpm=145.4)
    _mk(db, "/3a.wav", key="3A", bpm=142)
    _mk(db, "/nokey.wav", bpm=142)

    q = "key:8A,9A,7A,8B bpm:140-145"
    assert _paths(search.search(db, q)) == {"/8a.wav", "/am.wav", "/8b.wav"}
    assert _paths(search.search(db, "key:8A,nonsense")) == {"/8a.wav", "/am.wav"}
    assert _paths(search.search(db, "key:nonsense,")) == set()
    # negation keeps tracks with no key, as for a single key
    assert _paths(search.search(db, "-key:8A,9A,8B")) == {"/3a.wav", "/nokey.wav"}
    # the same with OR
    assert _paths(search.search(db, "key:8A OR key:8B bpm:140-145")) == {"/8a.wav", "/am.wav", "/8b.wav"}


def test_sort_directions_keep_missing_values_last(db):
    _mk(db, "/fast.wav", bpm=150)
    _mk(db, "/none.wav")
    _mk(db, "/slow.wav", bpm=120)
    _mk(db, "/mid.wav", bpm=140)

    assert _order(search.search(db, "sort:bpm")) == ["/slow.wav", "/mid.wav", "/fast.wav", "/none.wav"]
    assert _order(search.search(db, "sort:-bpm")) == ["/fast.wav", "/mid.wav", "/slow.wav", "/none.wav"]
    assert _order(search.search(db, "-sort:bpm")) == ["/fast.wav", "/mid.wav", "/slow.wav", "/none.wav"]
    # an unknown sort field is ignored: the usual artist/title order
    assert _order(search.search(db, "sort:colour")) == ["/fast.wav", "/mid.wav", "/none.wav", "/slow.wav"]


def test_sort_by_key_follows_the_camelot_wheel_then_tempo(db):
    _mk(db, "/10a.wav", key="10A", bpm=140)
    _mk(db, "/2b.wav", key="2B", bpm=140)
    _mk(db, "/2a-fast.wav", key="2A", bpm=150)
    _mk(db, "/2a-slow.wav", key="2A", bpm=130)
    _mk(db, "/nokey.wav", bpm=140)

    assert _order(search.search(db, "sort:key")) == [
        "/2a-slow.wav", "/2a-fast.wav", "/2b.wav", "/10a.wav", "/nokey.wav"]
    assert _order(search.search(db, "sort:-key")) == [
        "/10a.wav", "/2b.wav", "/2a-slow.wav", "/2a-fast.wav", "/nokey.wav"]


def test_sort_by_plays_played_title_and_a_second_key(db):
    now = datetime.now(UTC)
    a = _mk(db, "/a.wav", title="Zeta", plays=3, energy=5)
    b = _mk(db, "/b.wav", title="Ápsis", plays=7, energy=8)
    _mk(db, "/c.wav", title="beta", plays=3, energy=8)
    a.last_played_at, b.last_played_at = now - timedelta(days=5), now - timedelta(days=1)
    db.add_all([a, b])
    db.commit()

    assert _order(search.search(db, "sort:-plays")) == ["/b.wav", "/a.wav", "/c.wav"]
    assert _order(search.search(db, "sort:-played")) == ["/b.wav", "/a.wav", "/c.wav"]
    assert _order(search.search(db, "sort:title")) == ["/b.wav", "/c.wav", "/a.wav"]   # accents and case ignored
    assert _order(search.search(db, "sort:-energy sort:title")) == ["/b.wav", "/c.wav", "/a.wav"]
    assert _order(search.search(db, "sort:plays sort:-title")) == ["/a.wav", "/c.wav", "/b.wav"]


def test_limit_caps_results_paging_and_count(db):
    for bpm in (120, 125, 130, 135, 140):
        _mk(db, f"/{bpm}.wav", bpm=bpm, energy=8)
    _mk(db, "/calm.wav", bpm=100, energy=2)

    q = "energy:8 sort:-bpm limit:3"
    assert _order(search.search(db, q)) == ["/140.wav", "/135.wav", "/130.wav"]
    assert search.count(db, q) == 3
    assert sorted(search.ids(db, q)) == sorted(t.id for t in search.search(db, q))
    # paging stays inside the first N
    assert _order(search.search(db, q, limit=2)) == ["/140.wav", "/135.wav"]
    assert _order(search.search(db, q, limit=2, offset=2)) == ["/130.wav"]
    assert search.search(db, q, limit=2, offset=4) == []
    # limit: without sort: takes the first N in the usual order; bad limits are ignored
    assert search.count(db, "energy:8 limit:2") == 2
    assert search.count(db, "energy:8 limit:0") == 5
    assert search.count(db, "energy:8 limit:abc") == 5
    assert search.count(db, "energy:8 limit:99999999999999999999") == 5
    # limit: and sort: stand anywhere and never join an OR
    assert _order(search.search(db, "limit:1 energy:2 OR sort:bpm bpm:140")) == ["/calm.wav"]


def test_after_cursor_pages_a_sorted_query_without_gaps(client):
    with Session(_engine(), expire_on_commit=False) as session:
        for n, (bpm, energy) in enumerate(((150, 5), (120, None), (150, 9), (None, 7), (135, 7))):
            _mk(session, f"/t{n}.wav", title=f"T{n}", bpm=bpm, energy=energy)
    q = "sort:-energy sort:bpm"
    whole = [row["absolute_path"] for row in client.get("/api/tracks", params={"q": q, "limit": 0}).json()]
    assert whole[:3] == ["/t2.wav", "/t4.wav", "/t3.wav"]

    paged: list[str] = []
    after = None
    while True:
        params = {"q": q, "limit": 2, **({"after": after} if after else {})}
        page = client.get("/api/tracks", params=params).json()
        if not page:
            break
        paged += [row["absolute_path"] for row in page]
        after = page[-1]["id"]
    assert paged == whole


def test_saved_searches_keep_sort_and_limit(client):
    with Session(_engine(), expire_on_commit=False) as session:
        for bpm in (128, 145, 138, 150):
            t = Track(absolute_path=f"/lib/{bpm}.wav", title=str(bpm), bpm=bpm, missing=False)
            session.add(t)
            session.commit()
            reindex_track(session, t.id)
        crate = SavedSearch(name="Γρήγορα", query="bpm:130+ sort:-bpm limit:2")
        session.add(crate)
        session.commit()
        crate_id = crate.id

    rows = client.get(f"/api/searches/{crate_id}/tracks").json()
    assert [row["absolute_path"] for row in rows] == ["/lib/150.wav", "/lib/145.wav"]
    assert next(s for s in client.get("/api/searches").json() if s["id"] == crate_id)["count"] == 2
    membership = next(s for s in client.get("/api/searches/membership").json() if s["id"] == crate_id)
    assert sorted(membership["track_ids"]) == sorted(row["id"] for row in rows)
    assert client.get("/api/tracks/count", params={"q": "bpm:130+ sort:-bpm limit:2"}).json() == {"count": 2}
