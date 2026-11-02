"""Acceptance: search robustness over HTTP (therapy Phase A).

Black-box tests against the interfaces in
docs/superpowers/plans/2026-11-02-therapy-phase-a.md. Each test crosses at
least two plan tasks: the grammar (Task 1), folded prefix/exact FTS and the
order tiebreak (Task 2), facet values and the FTS value part (Task 5), facet,
valence and folder tokens (Task 6), /facets/counts (Task 7), bulk query scope
and dry runs (Task 8) and the queue order, limit=0 and `after` (Task 15).

Fixtures are built by hand on the hermetic temp DB; no audio files are needed.
"""
from __future__ import annotations

from sqlalchemy import text
from sqlmodel import Session

import app.db as dbmod
from app.db import reindex_track
from app.models import Track, TrackDJProfile
from app.services.text_fold import fold_text

# --------------------------------------------------------------------------
# helpers (HTTP first; direct DB writes only to create tracks)
# --------------------------------------------------------------------------


def _seed(rows: list[dict]) -> list[int]:
    """Create tracks (and optional profiles) and index them. Returns ids in order."""
    ids: list[int] = []
    with Session(dbmod.get_engine()) as s:
        for r in rows:
            t = Track(absolute_path=r["path"], artist=r.get("artist"),
                      title=r.get("title"), missing=False)
            s.add(t)
            s.commit()
            s.refresh(t)
            if r.get("profile"):
                s.add(TrackDJProfile(track_id=t.id, **r["profile"]))
                s.commit()
            reindex_track(s, t.id)
            ids.append(t.id)
    return ids


def _table_counts() -> dict[str, int]:
    with Session(dbmod.get_engine()) as s:
        return {
            t: s.execute(text(f"SELECT count(*) FROM {t}")).scalar_one()
            for t in ("tags", "track_tags", "track_dj_profile", "audit_log")
        }


def _ok(resp):
    # 2xx: the plan does not pin 200 vs 201 for the facet create routes.
    assert 200 <= resp.status_code < 300, (resp.request.url, resp.status_code, resp.text[:500])
    return resp.json()


def _load_preset(client) -> None:
    _ok(client.post("/api/facets/presets/therapy"))


def _facet(client, key: str) -> dict:
    for f in _ok(client.get("/api/facets")):
        if f["key"] == key:
            return f
    raise AssertionError(f"facet {key!r} missing")


def _value_id(client, key: str, value: str) -> int:
    # Folded values are unique within a facet (Task 5), so this is unambiguous
    # and immune to NFC/NFD differences in the transcribed preset.
    for v in _facet(client, key)["values"]:
        if fold_text(v["value"]) == fold_text(value):
            return v["id"]
    raise AssertionError(f"value {key}:{value} missing")


def _bulk(client, body: dict) -> dict:
    return _ok(client.post("/api/tracks/batch-profile", json=body))


def _tag(client, track_ids, *value_ids: int) -> None:
    res = _bulk(client, {"track_ids": list(track_ids), "add_tag_ids": list(value_ids)})
    assert res["updated"] == len(track_ids), res


def _set_profile(client, track_ids, **fields) -> None:
    res = _bulk(client, {"track_ids": list(track_ids), "profile": fields})
    assert res["updated"] == len(track_ids), res


def _list_ids(client, q: str, route: str = "/api/tracks", limit: int = 0, **extra) -> list[int]:
    # limit=0 ("everything") is pinned only for GET /api/tracks (Tasks 2, 15);
    # callers of other routes pass an explicit positive limit.
    rows = _ok(client.get(route, params={"q": q, "limit": limit, **extra}))
    assert isinstance(rows, list)
    return [r["id"] for r in rows]


def _count(client, q: str) -> int:
    n = _ok(client.get("/api/tracks/count", params={"q": q}))["count"]
    assert isinstance(n, int) and n >= 0
    return n


def _facet_counts(client, q: str) -> dict:
    body = _ok(client.get("/api/facets/counts", params={"q": q}))
    assert isinstance(body["total"], int) and body["total"] >= 0
    assert isinstance(body["counts"], dict)
    assert all(isinstance(n, int) and n >= 0 for n in body["counts"].values())
    return body


def _assert_listing(client, q: str, expected: set[int], *, facet_total: bool = False) -> None:
    ids = _list_ids(client, q)
    assert set(ids) == expected, q
    assert len(ids) == len(set(ids)) == _count(client, q), q
    if facet_total:
        assert _facet_counts(client, q)["total"] == len(ids), q


def _order_key(rows: dict[int, tuple]):
    """QUEUE_ORDER: (coalesce(artist,''), coalesce(title,''), id)."""
    return lambda tid: (rows[tid][0] or "", rows[tid][1] or "", tid)


# --------------------------------------------------------------------------
# 1. Hostile input never 500s on any query-taking route
# --------------------------------------------------------------------------

TASK2_HOSTILE = ['"', 'a"b', "-", "*", "AND", "OR", "NOT", "(", "title:", ":", '""', "'"]
EXTRA_HOSTILE = [
    "purpose:", 'purpose:"', "-purpose:", 'purpose:""', "purpose:**", '-purpose:*"',
    'purpose:"χαλάρωση',  # unterminated quote
    "PURPOSE:*", "-*", "*:*", ":*",
    "folder:", 'folder:""', "folder:\\", "folder:\\\\server\\share",
    "valence:", "valence:abc", "valence:9-2", "valence:-",
    "valence:99999999999999999999", "valence:6-8-9",
    "NEAR(a b)", "\u0301", "\u200b", "\ufeff", "\U0001f3b5",
    "Σ'", "\u2019", "a:b:c",
    " ".join(f"w{i}" for i in range(300)),
    "α" * 5000,
    " ".join(f"-x{i}" for i in range(100)),
]
HOSTILE = TASK2_HOSTILE + EXTRA_HOSTILE


def test_hostile_queries_never_500_on_any_query_route(client):
    _load_preset(client)
    ids = _seed([
        {"path": "/lib/h1.mp3", "artist": "Μάνος Χατζιδάκις", "title": "Χαλάρωση"},
        {"path": "/lib/h2.mp3", "artist": "Μαρινέλλα", "title": "Σ' αγαπώ"},
        {"path": "C:\\Music\\Relax\\h3.mp3", "title": "Ύπνος"},
        {"path": "/lib/h4.mp3", "title": "Ambient"},
    ])
    chal = _value_id(client, "purpose", "χαλάρωση")
    kin = _value_id(client, "purpose", "κίνηση")
    _tag(client, ids[:2], chal)
    control = _ok(client.post("/api/searches", json={"name": "control", "query": "purpose:χαλάρωση"}))

    before = _table_counts()
    saved: dict[int, str] = {}
    for i, q in enumerate(HOSTILE):
        for route in ("/api/tracks", "/api/tracks/search"):
            assert isinstance(_ok(client.get(route, params={"q": q})), list), (route, q)
        paged = _ok(client.get("/api/tracks", params={"q": q, "limit": 500, "after": ids[0]}))
        assert isinstance(paged, list), q
        _count(client, q)
        _facet_counts(client, q)

        r = client.post("/api/tracks/batch-profile",
                        json={"query": q, "add_tag_ids": [kin], "dry_run": True})
        assert r.status_code < 500, (q, r.status_code, r.text[:300])
        if r.status_code == 200:
            body = r.json()
            assert body["dry_run"] is True and body["updated"] == 0, (q, body)
            assert isinstance(body["matched"], int) and body["matched"] >= 0, (q, body)

        s = _ok(client.post("/api/searches", json={"name": f"hostile {i}", "query": q}))
        saved[s["id"]] = q
        assert isinstance(_ok(client.get(f"/api/searches/{s['id']}/tracks")), list), q

    assert _table_counts() == before, "a dry run or a read wrote to the database"

    listed = {s["id"]: s for s in _ok(client.get("/api/searches"))}
    for sid, q in saved.items():
        assert listed[sid]["query"] == q
        assert isinstance(listed[sid]["count"], int) and listed[sid]["count"] >= 0

    renamed = _ok(client.post(f"/api/facets/values/{chal}", json={"value": "ηρεμία"}))
    assert renamed["rewritten_searches"] == 1  # only the control query uses the value
    after = {s["id"]: s["query"] for s in _ok(client.get("/api/searches"))}
    assert after[control["id"]] == "purpose:ηρεμία"
    for sid, q in saved.items():
        assert after[sid] == q, f"rename rewrote hostile saved query {q[:40]!r}"


# --------------------------------------------------------------------------
# 2. Greek elision combines with facets
# --------------------------------------------------------------------------


def test_greek_elision_combines_with_facets_and_counts(client):
    _load_preset(client)
    t1, t2, t3 = _seed([
        {"path": "/lib/e1.mp3", "title": "Σ' αγαπώ", "artist": "Μαρινέλλα"},
        {"path": "/lib/e2.mp3", "title": "Σ\u2019 αγαπώ"},  # typographic apostrophe
        {"path": "/lib/e3.mp3", "title": "Αγάπη μου"},
    ])
    _tag(client, [t1], _value_id(client, "purpose", "αναπόληση"))

    both = {t1, t2}
    cases = [
        ("Σ' αγαπώ", both),
        ("σ' αγαπω", both),
        ("Σ\u2019 αγαπώ", both),
        ('"Σ\' αγαπώ"', both),
        ("Σ' αγαπώ purpose:αναποληση", {t1}),
        ('artist:"Μαρινέλλα" Σ\' αγαπώ', {t1}),
        # inclusion is prefix, exclusion is exact, accentless on both sides
        ("αγαπ -αγαπη", both),
        ('-"Σ\' αγαπώ"', {t3}),
    ]
    for q, expected in cases:
        _assert_listing(client, q, expected)


# --------------------------------------------------------------------------
# 3. Quoted, slashed, colon and apostrophe facet values
# --------------------------------------------------------------------------


def test_quoted_slashed_colon_and_apostrophe_facet_values(client):
    _load_preset(client)
    tv, ti, tt, tab, ts, t0 = _seed([
        {"path": f"/lib/q{i}.mp3", "title": title}
        for i, title in enumerate(["Ένα", "Δύο", "Τρία", "Τέσσερα", "Πέντε", "Έξι"])
    ])
    voice = _value_id(client, "voice", "φωνή χωρίς λόγια")
    _tag(client, [tv], voice)
    _tag(client, [ti], _value_id(client, "instruments", "φωνή/χορωδία"))
    _tag(client, [tt], _value_id(client, "tradition", "ποπ/ροκ"))

    fav = _ok(client.post("/api/facets", json={"label": "Αγαπημένα", "multi": True}))
    k = fav["key"]
    ab = _ok(client.post(f"/api/facets/{fav['id']}/values", json={"value": "a:b"}))
    sa = _ok(client.post(f"/api/facets/{fav['id']}/values", json={"value": "Σ' αγαπώ"}))
    assert ab["value"] == "a:b" and sa["value"] == "Σ' αγαπώ"
    _tag(client, [tab], ab["id"])
    _tag(client, [ts], sa["id"])

    everyone = {tv, ti, tt, tab, ts, t0}
    cases = [
        ('voice:"φωνη χωρις λογια"', {tv}),
        ('-voice:"φωνή χωρίς λόγια"', everyone - {tv}),
        ("voice:φωνή χωρίς λόγια", set()),  # voice:φωνή is an unknown value
        ("instruments:φωνή/χορωδία", {ti}),
        ('tradition:"ποπ/ροκ"', {tt}),
        (f"{k}:a:b", {tab}),
        (f'{k}:"a:b"', {tab}),
        (f"{k}:\"σ' αγαπω\"", {ts}),
    ]
    for q, expected in cases:
        _assert_listing(client, q, expected, facet_total=True)

    counts = _facet_counts(client, 'voice:"φωνη χωρις λογια"')["counts"]
    assert counts.get(str(voice), 0) == 1
    assert counts.get(str(ab["id"]), 0) == 0


# --------------------------------------------------------------------------
# 4. Folder paths with backslashes combine with other tokens
# --------------------------------------------------------------------------


def test_folder_paths_with_backslashes_combine_with_other_tokens(client):
    _load_preset(client)
    a, c, d, b, e, f = _seed([
        {"path": "C:\\Music\\Relax\\a.mp3", "title": "a"},
        {"path": "C:\\Music\\Relaxation\\c.mp3", "title": "c"},
        {"path": "c:\\music\\relax\\sub\\d.mp3", "title": "d"},
        {"path": "/Users/x/Music/Relax/b.mp3", "title": "b"},
        {"path": "C:\\Μουσική\\Χαλάρωση\\e.mp3", "title": "e"},
        {"path": "C:\\Music\\Relax\\f.mp3", "title": "f"},
    ])
    _set_profile(client, [a], valence=6)
    _set_profile(client, [d], valence=7)
    _set_profile(client, [f], valence=3)
    _set_profile(client, [c], valence=9)
    _tag(client, [d], _value_id(client, "purpose", "χαλάρωση"))

    relax = {a, d, f}
    cases = [
        ("folder:C:\\Music\\Relax\\", relax),           # unquoted, backslashes
        ('folder:"C:\\Music/Relax\\"', relax),          # mixed separators
        ("folder:c:/MUSIC/relax/", relax),              # drive-letter and case fold
        ('-folder:"C:/Music/Relax/"', {b, c, e}),
        ('folder:"c:/μουσικη/χαλαρωση/"', {e}),
        # d has a purpose, f is below valence 5, c is outside the folder
        ('folder:"C:/Music/Relax/" -purpose:* valence:5+', {a}),
    ]
    for q, expected in cases:
        _assert_listing(client, q, expected, facet_total=True)

    q = 'folder:"C:/Music/Relax/"'
    dry = _bulk(client, {"query": q, "add_tag_ids": [_value_id(client, "purpose", "κίνηση")],
                         "dry_run": True})
    assert dry["dry_run"] is True and dry["updated"] == 0
    assert dry["matched"] == _count(client, q) == 3


# --------------------------------------------------------------------------
# 5. Valence ranges combine with facets and free text, in a stable order
# --------------------------------------------------------------------------


def test_valence_ranges_combine_with_facets_and_free_text_in_stable_order(client):
    _load_preset(client)
    spec = [  # artist, title, valence, energy, purpose χαλάρωση?, mood γαλήνια?
        ("Χατζιδάκις", "Αύρα", 6, 3, True, False),
        ("Χατζιδάκις", "Βράδυ", 7, 8, True, True),
        ("Χατζιδάκις", "Γαλήνη", 9, 5, True, False),
        ("Χατζιδάκις", "Δρόμος", 8, 2, False, True),
        ("Θεοδωράκης", "Ένα", 7, 9, True, False),
        ("Χατζιδάκις", "Αύρα", 8, 7, True, False),   # duplicate (artist, title) of row 0
        ("Θεοδωράκης", "Ζωή", 5, 6, False, False),
        (None, "Ήλιος", 6, 4, True, False),
    ]
    ids = _seed([{"path": f"/lib/v{i}.mp3", "artist": s[0], "title": s[1]}
                 for i, s in enumerate(spec)])
    rows = {tid: s for tid, s in zip(ids, spec)}
    h1, h2, h3, h4, th5, h6, th7, n8 = ids

    for energy in {s[3] for s in spec}:
        _set_profile(client, [t for t in ids if rows[t][3] == energy], energy=energy)
    _tag(client, [t for t in ids if rows[t][4]], _value_id(client, "purpose", "χαλάρωση"))
    _tag(client, [t for t in ids if rows[t][5]], _value_id(client, "mood", "γαλήνια"))

    energy_queries = {"energy:5+": {h2, h3, th5, h6, th7}, "energy:1-4": {h1, h4, n8},
                      "energy:8": {h2}}
    energy_before = {q: _list_ids(client, q) for q in energy_queries}
    for q, expected in energy_queries.items():
        assert set(energy_before[q]) == expected, q

    for valence in {s[2] for s in spec}:
        _set_profile(client, [t for t in ids if rows[t][2] == valence], valence=valence)

    for q in energy_queries:  # setting valence leaves every energy: result unchanged
        assert _list_ids(client, q) == energy_before[q], q

    key = _order_key(rows)
    cases = [
        ("valence:6-8 purpose:χαλαρωση χατζιδ", {h1, h2, h6}),
        ("valence:7+ -mood:*", {h3, th5, h6}),
        ("purpose:χαλαρωση valence:6-8", {h1, h2, h6, th5, n8}),
    ]
    for q, expected in cases:
        _assert_listing(client, q, expected)
        first = _list_ids(client, q)
        assert first == sorted(expected, key=key), q
        assert _list_ids(client, q) == first, q
        assert _list_ids(client, q, route="/api/tracks/search", limit=10000) == first, q

    # BOM and NBSP are whitespace: same ids, same order as the plain-spaced query
    assert (_list_ids(client, "\ufeffpurpose:χαλαρωση\u00a0valence:6-8")
            == _list_ids(client, "purpose:χαλαρωση valence:6-8"))

    # duplicate (artist, title) falls back to id order; NULL artist sorts as ''
    everything = _ok(client.get("/api/tracks", params={"limit": 0}))
    assert [r["id"] for r in everything] == sorted(ids, key=key)
    q1 = _list_ids(client, "valence:6-8 purpose:χαλαρωση χατζιδ")
    assert q1.index(min(h1, h6)) < q1.index(max(h1, h6))

    # keyset pages concatenate to the same stable order
    q = "purpose:χαλαρωση"
    full = _list_ids(client, q)
    walked: list[int] = []
    cursor = None
    while True:
        params = {"q": q, "limit": 2, **({"after": cursor} if cursor else {})}
        page = [r["id"] for r in _ok(client.get("/api/tracks", params=params))]
        walked += page
        if len(page) < 2:
            break
        cursor = page[-1]
    assert walked == full


# --------------------------------------------------------------------------
# 6. Accented exclusions reach the FTS value parts
# --------------------------------------------------------------------------


def test_accented_exclusions_reach_fts_value_parts(client):
    _load_preset(client)
    u, v, w, x = _seed([
        {"path": "/lib/u.mp3", "title": "Ύπνος"},
        {"path": "/lib/v.mp3", "title": "Θάλασσα"},
        {"path": "/lib/w.mp3", "title": "Ήλιος"},
        {"path": "/lib/x.mp3", "title": "Βουνό"},
    ])
    _tag(client, [v], _value_id(client, "purpose", "ύπνος"))
    _tag(client, [w], _value_id(client, "purpose", "συναισθηματική έκφραση"))

    everyone = {u, v, w, x}
    cases = [
        ("-ύπνος", {w, x}),     # V's FTS tags column holds the value part
        ("-ΥΠΝΟΣ", {w, x}),
        ("-υπνος", {w, x}),
        ("-ύπν", everyone),     # exclusion is exact, not prefix
        ("-purpose:ΥΠΝΟΣ", {u, w, x}),
        ('-"συναισθηματική έκφραση"', {u, v, x}),
        ("-purpose", everyone),  # facet keys are not indexed
        ("ύπνος -purpose:ύπνος", {u}),
    ]
    for q, expected in cases:
        _assert_listing(client, q, expected, facet_total=True)


# --------------------------------------------------------------------------
# 7. Four independent resolution paths agree under the variable cap
# --------------------------------------------------------------------------

CAP_CORPUS = [
    "Σ' αγαπώ", "σ' αγαπω", "Σ\u2019 αγαπώ", '"Σ\' αγαπώ"',
    "Σ' αγαπώ purpose:αναποληση", 'artist:"Μαρινέλλα" Σ\' αγαπώ',
    "αγαπ -αγαπη", '-"Σ\' αγαπώ"',
    "-ύπνος", "-ΥΠΝΟΣ", "-ύπν", "-purpose:ΥΠΝΟΣ", "ύπνος -purpose:ύπνος", "-purpose",
    'voice:"φωνη χωρις λογια"', '-voice:"φωνή χωρίς λόγια"', "voice:φωνή χωρίς λόγια",
    "<K>:a:b", '<K>:"a:b"', "<K>:\"σ' αγαπω\"",
    "folder:C:\\Music\\Relax\\", 'folder:"C:\\Music/Relax\\"', "folder:c:/MUSIC/relax/",
    '-folder:"C:/Music/Relax/"', 'folder:"c:/μουσικη/χαλαρωση/"',
    'folder:"C:/Music/Relax/" -purpose:* valence:5+',
    "valence:6-8 purpose:χαλαρωση χατζιδ", "valence:7+ -mood:*",
    "\ufeffpurpose:χαλαρωση\u00a0valence:6-8",
    "purpose:*", "-purpose:*", "untagged", "ambient", "ambient -ambient", "energy:5+",
    'a"b', "*", "valence:9-2", " ".join(f"-x{i}" for i in range(100)),
]


def test_four_resolution_paths_agree_under_variable_cap(client, low_variable_limit):
    _load_preset(client)
    folders = ["C:\\Music\\Relax\\", "C:\\Music\\Relaxation\\",
               "/Users/x/Music/Relax/", "C:\\Μουσική\\Χαλάρωση\\"]
    titles = ["Σ' αγαπώ", "Σ\u2019 αγαπώ", "Αγάπη μου", "Ύπνος", "Ambient"]
    artists = ["Χατζιδάκις", "Μαρινέλλα", None]
    _seed([
        {
            "path": f"{folders[i % 4]}t{i}.mp3",
            "artist": artists[i % 3],
            "title": f"{titles[i % 5]} {i}",
            "profile": None if i % 7 == 0 else {"valence": 5 + i % 5, "energy": 1 + i % 10},
        }
        for i in range(160)
    ])

    fav = _ok(client.post("/api/facets", json={"label": "Αγαπημένα", "multi": True}))
    ab = _ok(client.post(f"/api/facets/{fav['id']}/values", json={"value": "a:b"}))
    sa = _ok(client.post(f"/api/facets/{fav['id']}/values", json={"value": "Σ' αγαπώ"}))
    for scope, value_id in [
        ('folder:"C:/Music/Relax/"', _value_id(client, "purpose", "χαλάρωση")),
        ("ύπνος", _value_id(client, "purpose", "ύπνος")),
        ('artist:"Μαρινέλλα"', _value_id(client, "purpose", "αναπόληση")),
        ("valence:8+", _value_id(client, "mood", "γαλήνια")),
        ("χατζιδ", _value_id(client, "voice", "φωνή χωρίς λόγια")),
        ("Σ' αγαπώ", sa["id"]),
        ("ambient", ab["id"]),
    ]:  # bulk query scope, resolved by subquery under the cap
        assert _bulk(client, {"query": scope, "add_tag_ids": [value_id]})["updated"] > 0, scope

    kin = _value_id(client, "purpose", "κίνηση")
    seen: dict[str, int] = {}
    for raw in CAP_CORPUS:
        q = raw.replace("<K>", fav["key"])
        listed = _list_ids(client, q)                       # LIMIT 0 listing
        counted = _count(client, q)                         # count subquery
        faceted = _facet_counts(client, q)["total"]         # /facets/counts subquery
        dry = _bulk(client, {"query": q, "add_tag_ids": [kin], "dry_run": True})  # bulk scope
        assert dry["dry_run"] is True and dry["updated"] == 0, q
        assert len(listed) == len(set(listed)), q
        assert len(listed) == counted == faceted == dry["matched"], (
            q, len(listed), counted, faceted, dry["matched"])
        seen[q] = counted

    assert seen["ambient"] == 32
    assert seen["folder:c:/MUSIC/relax/"] == 40  # never C:\Music\Relaxation\
    assert seen["ambient -ambient"] == 0
    assert len(set(seen.values())) > 5, "corpus degenerated to a few trivial counts"
