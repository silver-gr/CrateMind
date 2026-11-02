"""Acceptance: the vocabulary (facet) lifecycle over HTTP, therapy Phase A.

Black-box tests against the plan's Shared Interfaces: the preset, bulk
assignment through ``batch-profile`` (ids and query scope, dry run, single-value
replacement), folded facet tokens and free text, ``/facets/counts``, value
rename/delete with saved searches, facet delete, and the CSV export. Each test
crosses several plan tasks; the per-task unit tests stay in their own files.

Only hand-built tracks are seeded (no audio, no djay files). Tags are assigned
through HTTP only. Raw SQL is used solely to count rows and read audit rows.
"""
from __future__ import annotations

import csv
import io
import json
import os
import re
import unicodedata
from pathlib import Path

from sqlmodel import Session

from app.models import Track

SUMMARY_KEYS = ("updated", "matched", "replaced", "dry_run")
SLUG_RE = re.compile(r"^[a-z][a-z0-9_]{1,30}$")
CONFIRM_TAIL = "Επιβεβαίωσε για διαγραφή."
WATCHED_TABLES = ("tags", "track_tags", "track_dj_profile", "audit_log")

SAVED_SEARCHES = [
    ("Α", "purpose:χαλαρωση -mood:γαλήνια"),
    ("Β", '-purpose:"Χαλάρωση"'),
    ("Γ", "PURPOSE:χαλάρωση valence:6-8"),
    ("Δ", "purpose:κίνηση"),
    ("Ε", "energy:7+"),
]


# ---------------------------------------------------------------- helpers ---

def _strip_accents(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c))


def _seed(rows: list[dict]) -> list[int]:
    """Insert hand-built tracks and index them; returns ids in input order."""
    import app.db as dbmod

    ids: list[int] = []
    with Session(dbmod.get_engine()) as s:
        for row in rows:
            t = Track(missing=False, **row)
            s.add(t)
            s.commit()
            s.refresh(t)
            ids.append(t.id)
        for tid in ids:
            dbmod.reindex_track(s, tid)
    return ids


def _table_counts() -> dict[str, int]:
    import app.db as dbmod

    with dbmod.get_engine().connect() as c:
        return {t: c.exec_driver_sql(f"SELECT count(*) FROM {t}").scalar_one() for t in WATCHED_TABLES}


def _last_audit_before(track_id: int) -> dict:
    import app.db as dbmod

    with dbmod.get_engine().connect() as c:
        raw = c.exec_driver_sql(
            "SELECT before_json FROM audit_log WHERE entity_id = ? AND action = 'batch_update' "
            "ORDER BY id DESC LIMIT 1",
            (track_id,),
        ).scalar_one()
    return json.loads(raw)


def _facets(client) -> list[dict]:
    r = client.get("/api/facets")
    assert r.status_code == 200, r.text
    return r.json()


def _facet(client, key: str) -> dict:
    for f in _facets(client):
        if f["key"] == key:
            return f
    raise AssertionError(f"facet {key!r} not listed")


def _value(client, key: str, value: str) -> dict:
    for v in _facet(client, key)["values"]:
        if v["value"] == value:
            return v
    raise AssertionError(f"value {value!r} not in facet {key!r}")


def _vid(client, key: str, value: str) -> int:
    return _value(client, key, value)["id"]


def _ids(client, q: str) -> list[int]:
    r = client.get("/api/tracks", params={"q": q, "limit": 0})
    assert r.status_code == 200, r.text
    return sorted(row["id"] for row in r.json())


def _count(client, q: str) -> int:
    r = client.get("/api/tracks/count", params={"q": q})
    assert r.status_code == 200, r.text
    return r.json()["count"]


def _counts(client, q: str = "") -> dict:
    r = client.get("/api/facets/counts", params={"q": q})
    assert r.status_code == 200, r.text
    return r.json()


def _bulk(client, **body):
    return client.post("/api/tracks/batch-profile", json=body)


def _summary(resp) -> dict:
    assert resp.status_code == 200, resp.text
    body = resp.json()
    return {k: body[k] for k in SUMMARY_KEYS}


def _load_preset(client) -> dict:
    r = client.post("/api/facets/presets/therapy")
    assert r.status_code == 200, r.text
    return r.json()


def _saved(client) -> dict[str, dict]:
    r = client.get("/api/searches")
    assert r.status_code == 200, r.text
    return {s["name"]: s for s in r.json()}


def _saved_ids(client, search_id: int) -> list[int]:
    r = client.get(f"/api/searches/{search_id}/tracks")
    assert r.status_code == 200, r.text
    return sorted(row["id"] for row in r.json())


def _export_csv(client, filename: str) -> tuple[list[str], dict[int, dict[str, str]], str]:
    r = client.post("/api/export/csv", json={"all_tracks": True, "filename": filename})
    assert r.status_code == 200, r.text
    path = Path(r.json()["path"])
    assert path.resolve().parent == Path(os.environ["CRATEMIND_OUTPUT_DIR"]).resolve()
    raw = path.read_text(encoding="utf-8-sig")
    rows = list(csv.reader(io.StringIO(raw, newline="")))
    headers = rows[0]
    assert len(set(headers)) == len(headers), headers
    by_id = {int(r_[headers.index("id")]): dict(zip(headers, r_)) for r_ in rows[1:]}
    return headers, by_id, raw


def _expected_facet_headers(facets: list[dict]) -> dict[int, str]:
    """facet id -> CSV header: label, a repeated label gets " (2)", " (3)"."""
    seen: dict[str, int] = {}
    out: dict[int, str] = {}
    for f in facets:
        n = seen.get(f["label"], 0) + 1
        seen[f["label"]] = n
        out[f["id"]] = f["label"] if n == 1 else f"{f['label']} ({n})"
    return out


# ------------------------------------------------- staged shared library ---

def _seed_library() -> tuple[list[int], list[int]]:
    hatz = _seed([
        {"absolute_path": f"/accept/vocab/hatz-{i}.wav", "artist": "Μάνος Χατζιδάκις", "title": t}
        for i, t in enumerate(["Οδός Ονείρων", "Ο Κύκλος", "Παιχνίδια"])
    ])
    others = _seed([
        {"absolute_path": f"/accept/vocab/other-{i}.wav", "artist": "Field Ensemble",
         "title": f"Field Recording {i}"}
        for i in range(4)
    ])
    return hatz, others


def _tag_relaxation(client) -> int:
    relax = _vid(client, "purpose", "χαλάρωση")
    assert _summary(_bulk(client, query="χατζιδακις", add_tag_ids=[relax])) == {
        "updated": 3, "matched": 3, "replaced": 0, "dry_run": False,
    }
    return relax


def _stage_relaxed_library(client) -> dict:
    """Flow 2 end state: preset, 3 Χατζιδάκις tracks tagged χαλάρωση, 4 others."""
    _load_preset(client)
    hatz, others = _seed_library()
    relax = _tag_relaxation(client)
    return {"hatz": hatz, "others": others, "all": hatz + others, "relax": relax}


def _stage_all_organic(client, lib: dict) -> None:
    organic = _vid(client, "voice", "οργανικό")
    s = _summary(_bulk(client, query="", add_tag_ids=[organic]))
    assert s["matched"] == len(lib["all"])
    lib["organic"] = organic


def _stage_saved_searches(client, lib: dict) -> dict[str, dict]:
    """Give Γ, Δ and Ε something to match, create «Α»..«Ε», record counts and ids."""
    hatz, others = lib["hatz"], lib["others"]
    assert _bulk(client, track_ids=[hatz[0]], profile={"valence": 7}).status_code == 200
    assert _bulk(client, track_ids=[others[0]], profile={"energy": 8}).status_code == 200
    lib["kinisi"] = _vid(client, "purpose", "κίνηση")
    assert _bulk(client, track_ids=[others[1]], add_tag_ids=[lib["kinisi"]]).status_code == 200
    for name, query in SAVED_SEARCHES:
        r = client.post("/api/searches", json={"name": name, "query": query})
        assert r.status_code == 200, r.text
    saved = _saved(client)
    return {
        name: {"id": saved[name]["id"], "query": saved[name]["query"],
               "count": saved[name]["count"], "ids": _saved_ids(client, saved[name]["id"])}
        for name, _ in SAVED_SEARCHES
    }


def _stage_renamed(client, lib: dict) -> dict[str, dict]:
    recorded = _stage_saved_searches(client, lib)
    r = client.post(f"/api/facets/values/{lib['relax']}", json={"value": "ηρεμία"})
    assert r.status_code == 200, r.text
    r = client.post(f"/api/facets/values/{lib['kinisi']}", json={"value": "ελεύθερη κίνηση"})
    assert r.status_code == 200, r.text
    return recorded


def _stage_value_deleted(client, lib: dict) -> None:
    """hatz[1] also holds ύπνος, so only hatz[0] and hatz[2] lose every purpose value."""
    lib["ypnos"] = _vid(client, "purpose", "ύπνος")
    assert _bulk(client, track_ids=[lib["hatz"][1]], add_tag_ids=[lib["ypnos"]]).status_code == 200
    r = client.delete(f"/api/facets/values/{lib['relax']}", params={"force": "true"})
    assert r.status_code == 200, r.text


def _stage_custom_voice_facet(client, lib: dict) -> None:
    r = client.post("/api/facets", json={"label": "Φωνή", "multi": True})
    assert r.status_code == 200, r.text
    lib["custom"] = r.json()
    r = client.post(f"/api/facets/{lib['custom']['id']}/values", json={"value": "σοπράνο"})
    assert r.status_code == 200, r.text
    lib["soprano"] = r.json()["id"]
    others = lib["others"]
    assert _bulk(client, track_ids=[others[2]], add_tag_ids=[lib["soprano"]]).status_code == 200
    lib["geiosi"] = _vid(client, "purpose", "γείωση")
    resp = _bulk(client, track_ids=[others[3]], add_tag_ids=[lib["ypnos"], lib["geiosi"]],
                 profile={"valence": 7})
    assert _summary(resp)["updated"] == 1


# ------------------------------------------------------------------ tests ---

def test_every_preset_value_is_searchable_end_to_end(client):
    """Flow 1: preset -> one track per value -> bulk by ids -> tagQuery, folded,
    free text, /facets and /facets/counts all agree."""
    seeded = _load_preset(client)
    assert {k: seeded[k] for k in ("created_facets", "created_values", "adopted_tags")} == {
        "created_facets": 8, "created_values": 47, "adopted_tags": 0,
    }
    pairs = [(f["key"], v["value"], v["id"]) for f in _facets(client) for v in f["values"]]
    assert len(pairs) == 47
    keyed = {(k, v) for k, v, _ in pairs}
    assert ("voice", "φωνή χωρίς λόγια") in keyed and ("instruments", "φωνή/χορωδία") in keyed

    tracks = _seed([
        {"absolute_path": f"/accept/vocab/value-{i:02d}.wav", "artist": "Acceptance Ensemble",
         "title": f"Item {i:02d}"}
        for i in range(len(pairs))
    ])
    for t, (_, _, vid) in zip(tracks, pairs):
        assert _summary(_bulk(client, track_ids=[t], add_tag_ids=[vid])) == {
            "updated": 1, "matched": 1, "replaced": 0, "dry_run": False,
        }

    for t, (key, value, _) in zip(tracks, pairs):
        tag_query = f'{key}:"{value}"'  # the shape Task 10 tagQuery builds
        assert _ids(client, tag_query) == [t], tag_query
        folded_upper = f'{key}:"{_strip_accents(value).upper()}"'
        assert _ids(client, folded_upper) == [t], folded_upper
        words = [w for w in re.split(r"[\W_]+", value) if w]
        longest = _strip_accents(max(words, key=len)).lower()
        assert t in _ids(client, longest), (value, longest)

    for f in _facets(client):
        assert all(v["count"] == 1 for v in f["values"]), f["key"]
    counts = _counts(client, "")
    assert counts["total"] == 47
    for _, _, vid in pairs:
        assert counts["counts"][str(vid)] == 1

    for key_word in ("purpose", "instruments", "tradition"):
        assert _ids(client, key_word) == [], key_word
        assert _count(client, key_word) == 0


def test_query_scope_assignment_agrees_with_every_count_source(client):
    """Flow 2: dry run matches /tracks/count and writes nothing; the real call
    agrees with /facets/counts (scoped and whole library) and /facets."""
    _load_preset(client)
    hatz, others = _seed_library()
    relax = _vid(client, "purpose", "χαλάρωση")

    before = _table_counts()
    dry = _summary(_bulk(client, query="χατζιδακις", add_tag_ids=[relax], dry_run=True))
    assert dry["matched"] == _count(client, "χατζιδακις") == 3
    assert dry["updated"] == 0 and dry["dry_run"] is True
    assert _table_counts() == before

    _tag_relaxation(client)
    scoped = _counts(client, "χατζιδακις")
    assert scoped["total"] == 3 and scoped["counts"][str(relax)] == 3
    whole = _counts(client, "")
    assert whole["total"] == 7 and whole["counts"][str(relax)] == 3
    assert _value(client, "purpose", "χαλάρωση")["count"] == 3
    assert _ids(client, "purpose:χαλαρωση") == sorted(hatz)
    assert set(others).isdisjoint(_ids(client, "purpose:*"))


def test_folded_facet_tokens_and_free_text_partition_the_library(client):
    """Flow 3: folded/upper/quoted facet tokens and the free-text prefix agree;
    negation and key:* partition the library; list length == count everywhere."""
    lib = _stage_relaxed_library(client)
    hatz, everything = sorted(lib["hatz"]), set(lib["all"])

    for q in ("purpose:χαλαρωση", "PURPOSE:ΧΑΛΑΡΩΣΗ", 'purpose:"Χαλάρωση"', "χαλαρ"):
        assert _ids(client, q) == hatz, q
    assert _ids(client, "-purpose:χαλαρωση") == sorted(lib["others"])

    has_any, has_none = set(_ids(client, "purpose:*")), set(_ids(client, "-purpose:*"))
    assert has_any.isdisjoint(has_none)
    assert has_any | has_none == everything

    for q in ("purpose:χαλαρωση", "PURPOSE:ΧΑΛΑΡΩΣΗ", 'purpose:"Χαλάρωση"', "χαλαρ",
              "-purpose:χαλαρωση", "purpose:*", "-purpose:*"):
        assert len(_ids(client, q)) == _count(client, q), q


def test_single_value_replacement_through_bulk_and_multi_to_single_switch(client):
    """Flow 4: voice replacement (dry run == counts, real call, audit diff), then
    the mood multi->single switch refused, unblocked, and enforced by bulk."""
    lib = _stage_relaxed_library(client)
    hatz, others, total = lib["hatz"], lib["others"], len(lib["all"])
    lyrics = _vid(client, "voice", "με στίχους")
    wordless = _vid(client, "voice", "φωνή χωρίς λόγια")
    organic = _vid(client, "voice", "οργανικό")

    assert _summary(_bulk(client, track_ids=[hatz[0], hatz[1]], add_tag_ids=[lyrics]))["updated"] == 2
    assert _summary(_bulk(client, track_ids=[others[0]], add_tag_ids=[wordless]))["updated"] == 1

    counts = _counts(client, "")
    assert counts["total"] == total
    other_voice = counts["counts"].get(str(lyrics), 0) + counts["counts"].get(str(wordless), 0)
    before = _table_counts()
    dry = _summary(_bulk(client, query="", add_tag_ids=[organic], dry_run=True))
    assert dry["matched"] == total
    assert dry["replaced"] == other_voice == 3
    assert dry["updated"] == 0 and dry["dry_run"] is True
    assert _table_counts() == before

    real = _summary(_bulk(client, query="", add_tag_ids=[organic]))
    assert real["replaced"] == 3 and real["matched"] == total and real["updated"] == total
    voice_ids = {v["id"] for v in _facet(client, "voice")["values"]}
    after = _counts(client, "")["counts"]
    assert {vid: after.get(str(vid), 0) for vid in voice_ids} == {
        organic: total, lyrics: 0, wordless: 0,
    }
    assert lyrics in _last_audit_before(hatz[0])["tags_removed"]
    assert wordless in _last_audit_before(others[0])["tags_removed"]

    # mood is still multi: two values in one request succeed. Exactly one track
    # ends up with two values, so the refusal is the plan's pinned message (n=1).
    mood = _facet(client, "mood")
    calm, tender = _vid(client, "mood", "γαλήνια"), _vid(client, "mood", "τρυφερή")
    pair = [hatz[0], others[1]]
    assert _summary(_bulk(client, track_ids=[hatz[0]], add_tag_ids=[calm, tender]))["updated"] == 1
    assert _summary(_bulk(client, track_ids=[others[1]], add_tag_ids=[calm]))["updated"] == 1

    r = client.post(f"/api/facets/{mood['id']}", json={"multi": False})
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == "Κομμάτια με περισσότερες από μία τιμές: 1. Αφαίρεσέ τες πρώτα."
    assert _facet(client, "mood")["multi"] is True

    assert _summary(_bulk(client, track_ids=[hatz[0]], remove_tag_ids=[tender]))["updated"] == 1
    r = client.post(f"/api/facets/{mood['id']}", json={"multi": False})
    assert r.status_code == 200, r.text
    assert r.json()["multi"] is False

    assert _summary(_bulk(client, track_ids=pair, add_tag_ids=[tender]))["replaced"] == 2
    mood_counts = _counts(client, "")["counts"]
    mood_ids = {v["id"] for v in _facet(client, "mood")["values"]}
    assert mood_counts.get(str(tender), 0) == 2 and mood_counts.get(str(calm), 0) == 0
    assert sum(mood_counts.get(str(vid), 0) for vid in mood_ids) == 2
    assert _ids(client, "mood:*") == sorted(pair)  # 2 tracks, 2 assignments: one value each

    before = _table_counts()
    snapshot = _counts(client, "")
    r = _bulk(client, track_ids=pair, add_tag_ids=[calm, tender])
    assert r.status_code == 422, r.text
    assert _table_counts() == before
    assert _counts(client, "") == snapshot


def test_rename_carries_saved_searches_and_search_along(client):
    """Flow 5: a value rename rewrites matching saved queries (negation, quotes,
    field case kept), keeps every result set, moves free text, quotes a new
    multi-word value, and refuses a fold-duplicate without side effects."""
    lib = _stage_relaxed_library(client)
    _stage_all_organic(client, lib)
    recorded = _stage_saved_searches(client, lib)
    assert recorded["Α"]["count"] == 3 and recorded["Β"]["count"] == 4
    assert recorded["Γ"]["count"] == recorded["Δ"]["count"] == recorded["Ε"]["count"] == 1

    r = client.post(f"/api/facets/values/{lib['relax']}", json={"value": "ηρεμία"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == lib["relax"] and body["value"] == "ηρεμία"
    assert body["count"] == 3 and body["rewritten_searches"] == 3

    saved = _saved(client)
    assert saved["Α"]["query"] == "purpose:ηρεμία -mood:γαλήνια"
    assert saved["Β"]["query"] == '-purpose:"ηρεμία"'
    assert saved["Γ"]["query"] == "PURPOSE:ηρεμία valence:6-8"
    assert saved["Δ"]["query"] == recorded["Δ"]["query"]
    assert saved["Ε"]["query"] == recorded["Ε"]["query"]
    for name, rec in recorded.items():
        assert saved[name]["count"] == rec["count"], name
        assert _saved_ids(client, rec["id"]) == rec["ids"], name

    assert set(lib["hatz"]).isdisjoint(_ids(client, "χαλαρωση"))
    assert set(lib["hatz"]) <= set(_ids(client, "ηρεμια"))

    r = client.post(f"/api/facets/values/{lib['kinisi']}", json={"value": "ελεύθερη κίνηση"})
    assert r.status_code == 200, r.text
    assert r.json()["rewritten_searches"] == 1
    delta = _saved(client)["Δ"]
    assert delta["query"] == 'purpose:"ελεύθερη κίνηση"'
    assert _saved_ids(client, delta["id"]) == recorded["Δ"]["ids"] == [lib["others"][1]]

    queries_before = {n: s["query"] for n, s in _saved(client).items()}
    r = client.post(f"/api/facets/values/{lib['relax']}", json={"value": "ΥΠΝΟΣ"})
    assert r.status_code == 409, r.text
    assert "purpose" not in r.json()["detail"]
    purpose_values = {v["value"] for v in _facet(client, "purpose")["values"]}
    assert "ηρεμία" in purpose_values and "ΥΠΝΟΣ" not in purpose_values
    assert _value(client, "purpose", "ηρεμία")["count"] == 3
    assert _ids(client, "purpose:ηρεμία") == sorted(lib["hatz"])
    assert {n: s["query"] for n, s in _saved(client).items()} == queries_before


def test_value_delete_reports_breakage_and_leaves_queries_untouched(client):
    """Flow 6: delete without force reports tracks and searches and changes
    nothing; with force it unassigns, keeps query text, and every count source
    follows (unknown value -> nothing, negation -> everything)."""
    lib = _stage_relaxed_library(client)
    _stage_all_organic(client, lib)
    _stage_renamed(client, lib)
    lib["ypnos"] = _vid(client, "purpose", "ύπνος")
    assert _bulk(client, track_ids=[lib["hatz"][1]], add_tag_ids=[lib["ypnos"]]).status_code == 200

    queries_before = {n: s["query"] for n, s in _saved(client).items()}
    missing_before = set(_ids(client, "-purpose:*"))
    tables_before = _table_counts()

    r = client.delete(f"/api/facets/values/{lib['relax']}")
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail.startswith("Η τιμή «ηρεμία» χρησιμοποιείται σε 3 κομμάτια.")
    for name in ("«Α»", "«Β»", "«Γ»"):
        assert name in detail
    assert "«Δ»" not in detail and "«Ε»" not in detail
    assert detail.endswith(CONFIRM_TAIL)
    assert _table_counts() == tables_before
    assert _value(client, "purpose", "ηρεμία")["count"] == 3
    assert {n: s["query"] for n, s in _saved(client).items()} == queries_before

    r = client.delete(f"/api/facets/values/{lib['relax']}", params={"force": "true"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["removed_assignments"] == 3
    assert set(body["broken_searches"]) == {"Α", "Β", "Γ"}

    saved = _saved(client)
    assert {n: s["query"] for n, s in saved.items()} == queries_before
    assert saved["Α"]["count"] == 0 and saved["Γ"]["count"] == 0
    assert saved["Β"]["count"] == len(lib["all"])
    missing_after = set(_ids(client, "-purpose:*"))
    assert missing_after == missing_before | {lib["hatz"][0], lib["hatz"][2]}
    assert _count(client, "-purpose:*") == len(missing_before) + 2

    tags = client.get("/api/tags")
    assert tags.status_code == 200, tags.text
    tag_names = {t["name"] for t in tags.json()}
    assert "purpose:ηρεμία" not in tag_names
    assert str(lib["relax"]) not in _counts(client, "")["counts"]


def test_csv_export_mirrors_the_vocabulary_state(client):
    """Flow 7: a label-only facet gets a server slug; CSV has valence after
    darkness, one Greek-labelled column per facet in (sort_order, id) order with
    «Φωνή (2)» for the repeat, "; "-joined values, renamed/deleted values
    reflected, and valence equal to the list API."""
    lib = _stage_relaxed_library(client)
    _stage_all_organic(client, lib)
    _stage_renamed(client, lib)
    _stage_value_deleted(client, lib)
    _stage_custom_voice_facet(client, lib)
    hatz, others = lib["hatz"], lib["others"]

    custom = lib["custom"]
    assert custom["key"] != "voice" and SLUG_RE.match(custom["key"])
    assert custom["key"] == "foni"  # Task 5 transliteration of «Φωνή»
    assert custom["label"] == "Φωνή" and custom["multi"] is True

    facets = _facets(client)
    assert [(f["sort_order"], f["id"]) for f in facets] == sorted((f["sort_order"], f["id"]) for f in facets)
    expected = _expected_facet_headers(facets)
    headers, rows, raw = _export_csv(client, "lib.csv")

    assert headers.index("valence") == headers.index("darkness") + 1
    assert [h for h in headers if h in set(expected.values())] == [expected[f["id"]] for f in facets]
    assert "Φωνή" in headers and "Φωνή (2)" in headers
    keys = {f["key"] for f in facets}
    assert not keys & set(headers), keys & set(headers)
    assert not any(h.startswith("facet:") for h in headers)

    by_key = {f["key"]: f for f in facets}
    purpose_h = expected[by_key["purpose"]["id"]]
    voice_h = expected[by_key["voice"]["id"]]
    custom_h = expected[custom["id"]]
    assert {voice_h, custom_h} == {"Φωνή", "Φωνή (2)"}

    two = sorted([(lib["ypnos"], "ύπνος"), (lib["geiosi"], "γείωση")])
    assert rows[others[3]][purpose_h] == "; ".join(v for _, v in two)
    assert rows[hatz[1]][purpose_h] == "ύπνος"
    assert rows[others[1]][purpose_h] == "ελεύθερη κίνηση"
    assert rows[hatz[0]][purpose_h] == "" and rows[hatz[2]][purpose_h] == ""
    assert "ηρεμία" not in raw and "χαλάρωση" not in raw

    for tid in lib["all"]:
        assert rows[tid][voice_h] == "οργανικό", tid
        assert rows[tid][custom_h] == ("σοπράνο" if tid == others[2] else ""), tid

    listed = client.get("/api/tracks", params={"limit": 1000})
    assert listed.status_code == 200, listed.text
    api_valence = {row["id"]: row["valence"] for row in listed.json()}
    assert set(rows) == set(api_valence) == set(lib["all"])
    for tid, row in rows.items():
        v = api_valence[tid]
        assert row["valence"] == ("" if v is None else str(v)), tid
    assert api_valence[hatz[0]] == api_valence[others[3]] == 7


def test_facet_delete_cascades_through_search_counts_and_csv(client):
    """Flow 8: deleting the preset «Φωνή» needs force (Greek label, never the
    key), reports values and the voice:* count, and search, counts and a fresh
    CSV no longer see it."""
    lib = _stage_relaxed_library(client)
    _stage_all_organic(client, lib)
    _stage_renamed(client, lib)
    _stage_value_deleted(client, lib)
    _stage_custom_voice_facet(client, lib)

    voice = _facet(client, "voice")
    voice_value_ids = [v["id"] for v in voice["values"]]
    tagged = _count(client, "voice:*")
    assert tagged == len(lib["all"])
    assert _ids(client, "οργανικο") == sorted(lib["all"])
    tables_before = _table_counts()

    r = client.delete(f"/api/facets/{voice['id']}")
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail == f"Το λεξιλόγιο «Φωνή» έχει 3 τιμές σε {tagged} κομμάτια. {CONFIRM_TAIL}"
    assert "voice" not in detail
    assert _table_counts() == tables_before

    r = client.delete(f"/api/facets/{voice['id']}", params={"force": "true"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["deleted_values"] == 3 and body["untagged_tracks"] == tagged

    assert "voice" not in {f["key"] for f in _facets(client)}
    counts = _counts(client, "")["counts"]
    assert not {str(vid) for vid in voice_value_ids} & set(counts)
    assert _ids(client, "οργανικο") == [] and _count(client, "οργανικο") == 0

    headers, rows, _ = _export_csv(client, "lib-after-delete.csv")
    assert headers.count("Φωνή") == 1 and "Φωνή (2)" not in headers
    assert rows[lib["others"][2]]["Φωνή"] == "σοπράνο"
    assert "voice" not in headers
