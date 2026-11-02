"""Acceptance: data safety and guards across Therapy Phase A.

Black-box tests over the plan's Shared Interfaces (HTTP routes through the
`client` fixture). Each test crosses at least two plan tasks:

- audio files stay byte/size/mtime identical through the whole facet,
  bulk, export and triage lifecycle (Tasks 5, 7, 8, 9, 15);
- generic tag routes cannot reach runtime-created vocabularies, before or
  after a rename, while the bulk path can (Tasks 5, 7, 8);
- a force-deleted facet frees its namespace and the preset re-adopts the
  tag (Tasks 5, 6, 7);
- rejected requests write nothing, whichever task rejects them (Tasks 4, 5,
  6, 7, 8);
- tag-only bulk edits keep tracks in `untagged` and audit per-track diffs
  (Tasks 4, 6, 8).

Fixtures are hand-built; audio only via conftest.make_wav under tmp_path.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from sqlalchemy import text
from sqlmodel import Session, select

from app import db as dbmod
from app.db import reindex_track
from app.models import AuditLog, Track
from tests.conftest import make_wav

GUARD = "Οι τιμές λεξιλογίων αλλάζουν μόνο από τα Λεξιλόγια ή την ουρά ταξινόμησης."
UNKNOWN_TAG = "Άγνωστο tag."
KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,30}$")
COUNTED_TABLES = ("track_dj_profile", "audit_log", "track_tags", "tags")
CREATED = (200, 201)  # the plan does not pin the status of creating POSTs


# ---- helpers ---------------------------------------------------------------

def _seed(paths, titles=None) -> list[int]:
    """Insert profile-less, present tracks and index them; return their ids."""
    ids = []
    with Session(dbmod.get_engine()) as s:
        for i, path in enumerate(paths):
            title = titles[i] if titles else f"Κομμάτι {chr(65 + i)}"
            t = Track(absolute_path=str(path), file_name=str(path).rsplit("/", 1)[-1],
                      artist="Δοκιμαστής", title=title, missing=False)
            s.add(t)
            s.commit()
            s.refresh(t)
            reindex_track(s, t.id)
            ids.append(t.id)
    return ids


def _row_counts() -> dict[str, int]:
    with dbmod.get_engine().connect() as c:
        return {t: c.execute(text(f"SELECT count(*) FROM {t}")).scalar_one() for t in COUNTED_TABLES}


def _facets(client) -> list[dict]:
    r = client.get("/api/facets")
    assert r.status_code == 200, r.text
    return r.json()


def _facet(client, key: str) -> dict:
    return next(f for f in _facets(client) if f["key"] == key)


def _value(client, key: str, value: str) -> dict:
    return next(v for v in _facet(client, key)["values"] if v["value"] == value)


def _snapshot(client) -> tuple[dict, list]:
    return _row_counts(), _facets(client)


def _ids_in_order(client, q: str) -> list[int]:
    r = client.get("/api/tracks", params={"q": q, "limit": 0})
    assert r.status_code == 200, r.text
    return [row["id"] for row in r.json()]


def _ids(client, q: str) -> list[int]:
    return sorted(_ids_in_order(client, q))


def _count(client, q: str) -> int:
    r = client.get("/api/tracks/count", params={"q": q})
    assert r.status_code == 200, r.text
    return r.json()["count"]


def _batch(client, body: dict):
    return client.post("/api/tracks/batch-profile", json=body)


def _load_preset(client) -> dict:
    r = client.post("/api/facets/presets/therapy")
    assert r.status_code in CREATED, r.text
    return r.json()


def _audit_rows_after(last_id: int) -> list[AuditLog]:
    with Session(dbmod.get_engine()) as s:
        return list(s.exec(select(AuditLog).where(AuditLog.id > last_id).order_by(AuditLog.id)).all())


def _max_audit_id() -> int:
    with dbmod.get_engine().connect() as c:
        return c.execute(text("SELECT coalesce(max(id), 0) FROM audit_log")).scalar_one()


def _mentions(row: AuditLog, value_id: int) -> bool:
    """True when value_id appears in any list inside before_json/after_json."""
    for raw in (row.before_json, row.after_json):
        data = json.loads(raw) if raw else None
        if not isinstance(data, dict):  # tolerate "null"/"{}"-style empty sides
            continue
        for v in data.values():
            if isinstance(v, list) and value_id in v:
                return True
    return False


def _file_state(path):
    st = path.stat()
    return hashlib.sha256(path.read_bytes()).hexdigest(), st.st_size, st.st_mtime_ns


def _tree(root) -> list[str]:
    return sorted(str(p.relative_to(root)) + ("/" if p.is_dir() else "") for p in root.rglob("*"))


# ---- 1. audio files untouched across the whole lifecycle -------------------

def test_audio_files_untouched_across_facet_bulk_export_and_triage_lifecycle(client, tmp_path):
    lib = tmp_path / "lib"      # CRATEMIND_LIBRARY_ROOTS (conftest client fixture)
    out = tmp_path / "out"      # CRATEMIND_OUTPUT_DIR
    wavs = [
        make_wav(lib / "Χαλάρωση" / "πρώτο.wav", freq_seed=1),
        make_wav(lib / "Χαλάρωση" / "δεύτερο.wav", freq_seed=2),
        make_wav(lib / "Ύπνος και γείωση" / "τρίτο.wav", freq_seed=3),
        make_wav(lib / "Ambient" / "four.wav", freq_seed=4),
        make_wav(lib / "Ambient" / "Βαθιά" / "πέμπτο.wav", freq_seed=5),
        make_wav(lib / "six.wav", freq_seed=6),
    ]
    ids = _seed(wavs)
    before_files = {p: _file_state(p) for p in wavs}
    before_tree = _tree(lib)

    # preset
    _load_preset(client)
    calm = _value(client, "purpose", "χαλάρωση")["id"]
    serene = _value(client, "mood", "γαλήνια")["id"]
    organic = _value(client, "voice", "οργανικό")["id"]
    lyrics = _value(client, "voice", "με στίχους")["id"]

    # bulk by ids with profile + tags
    r = _batch(client, {"track_ids": ids[:2], "profile": {"valence": 6, "energy": 4},
                        "add_tag_ids": [calm]})
    assert r.status_code == 200, r.text
    # bulk by query scope (Task 6 facet token, accentless) with profile + tags
    r = _batch(client, {"query": "purpose:χαλαρωση", "profile": {"valence": 7},
                        "add_tag_ids": [serene]})
    assert r.status_code == 200, r.text
    assert r.json()["matched"] == 2
    # single-value replace on voice
    assert _batch(client, {"track_ids": [ids[0]], "add_tag_ids": [organic]}).status_code == 200
    r = _batch(client, {"track_ids": [ids[0]], "add_tag_ids": [lyrics]})
    assert r.status_code == 200, r.text
    assert r.json()["replaced"] == 1
    # rename a value
    assert client.post(f"/api/facets/values/{calm}", json={"value": "ηρεμία"}).status_code == 200
    # force-delete a value
    assert client.delete(f"/api/facets/values/{serene}", params={"force": "true"}).status_code == 200
    # force-delete a facet
    voice_id = _facet(client, "voice")["id"]
    assert client.delete(f"/api/facets/{voice_id}", params={"force": "true"}).status_code == 200
    # multi -> single (each purpose track holds one value, so it is allowed)
    purpose_id = _facet(client, "purpose")["id"]
    r = client.post(f"/api/facets/{purpose_id}", json={"multi": False})
    assert r.status_code == 200, r.text
    # exports
    csv = client.post("/api/export/csv", json={"all_tracks": True})
    assert csv.status_code == 200, csv.text
    backup = client.post("/api/export/json-backup", json={})
    assert backup.status_code == 200, backup.text
    # folders
    r = client.get("/api/tracks/folders")
    assert r.status_code == 200, r.text
    folders = r.json()
    assert {f["path"] for f in folders} == {str(p.parent).replace("\\", "/") for p in wavs}
    for f in folders:  # a count is what picking the folder returns, subfolders included
        r = client.get("/api/tracks/count", params={"q": f'folder:"{f["path"]}/"'})
        assert r.status_code == 200, r.text
        assert r.json()["count"] == f["count"]
    # triage queue with keyset cursor
    full = _ids_in_order(client, "-mood:*")
    assert len(full) == len(wavs)
    page1 = client.get("/api/tracks", params={"q": "-mood:*", "limit": 2})
    assert page1.status_code == 200, page1.text
    first = [row["id"] for row in page1.json()]
    page2 = client.get("/api/tracks", params={"q": "-mood:*", "limit": 500, "after": first[-1]})
    assert page2.status_code == 200, page2.text
    assert first + [row["id"] for row in page2.json()] == full

    # every audio file is byte-, size- and mtime-identical; nothing new under lib
    assert {p: _file_state(p) for p in wavs} == before_files
    assert _tree(lib) == before_tree
    # exports live only under the output dir
    out_resolved = out.resolve()
    for resp in (csv, backup):
        exported = Path(resp.json()["path"]).resolve()
        assert exported.is_file()
        assert exported.is_relative_to(out_resolved)
    for name in ("cratemind.csv", "cratemind-backup.json"):
        hits = [p.resolve() for p in tmp_path.rglob(name)]
        assert hits and all(h.is_relative_to(out_resolved) for h in hits)


# ---- 2. tag routes cannot reach runtime vocabularies ------------------------

def test_generic_tag_routes_cannot_reach_runtime_vocabulary_before_or_after_rename(client):
    t1, _t2 = _seed(["/acc/guard-1.wav", "/acc/guard-2.wav"])

    r = client.post("/api/facets", json={"label": "Χρώμα ήχου", "multi": True})
    assert r.status_code in CREATED, r.text
    facet = r.json()
    key = facet["key"]
    assert KEY_RE.match(key)
    r = client.post(f"/api/facets/{facet['id']}/values", json={"value": "ζεστό"})
    assert r.status_code in CREATED, r.text
    value_id = r.json()["id"]

    def assert_refused(method, url, body):
        before = _row_counts()
        resp = client.request(method, url, json=body)
        assert resp.status_code == 400, (url, body, resp.text)
        assert resp.json()["detail"] == GUARD
        assert _row_counts() == before, (url, body)

    def attempts(name: str):
        assert_refused("POST", "/api/tags", {"name": f"{key}:{name}"})
        assert_refused("POST", "/api/tags", {"name": f"{key}:νέο"})
        assert_refused("POST", "/api/tags", {"name": "x", "category": key})
        assert_refused("POST", f"/api/tracks/{t1}/tags", {"name": f"{key}:{name}"})
        assert_refused("POST", f"/api/tracks/{t1}/tags", {"tag_id": value_id})

    attempts("ζεστό")

    r = client.post(f"/api/facets/values/{value_id}", json={"value": "θερμό"})
    assert r.status_code == 200, r.text
    attempts("θερμό")
    assert _ids(client, f"{key}:θερμο") == []

    # sanctioned path: bulk
    r = _batch(client, {"track_ids": [t1], "add_tag_ids": [value_id]})
    assert r.status_code == 200, r.text
    assert r.json()["updated"] == 1
    assert _value(client, key, "θερμό")["count"] == 1
    assert _ids(client, f"{key}:θερμο") == [t1]
    assert t1 in _ids(client, "θερμο")  # FTS holds the value part

    # removal through the generic route is allowed and goes through the service
    r = client.delete(f"/api/tracks/{t1}/tags/{value_id}")
    assert r.status_code == 200, r.text
    assert _value(client, key, "θερμό")["count"] == 0
    assert t1 not in _ids(client, f"{key}:θερμο")
    assert t1 not in _ids(client, "θερμο")


# ---- 3. a deleted facet frees its namespace --------------------------------

def test_force_deleted_facet_frees_namespace_and_preset_readopts_tag(client):
    _t1, t2 = _seed(["/acc/ns-1.wav", "/acc/ns-2.wav"])
    _load_preset(client)
    voice_id = _facet(client, "voice")["id"]

    r = client.delete(f"/api/facets/{voice_id}", params={"force": "true"})
    assert r.status_code == 200, r.text
    assert all(f["key"] != "voice" for f in _facets(client))

    r = client.post("/api/tags", json={"name": "voice:οργανικό"})
    assert r.status_code == 200, r.text
    tag_id = r.json()["id"]
    r = client.post(f"/api/tracks/{t2}/tags", json={"tag_id": tag_id})
    assert r.status_code == 200, r.text

    result = _load_preset(client)
    assert result["created_facets"] == 1
    assert result["adopted_tags"] == 1

    organic = _value(client, "voice", "οργανικό")
    assert organic["id"] == tag_id
    assert organic["count"] == 1
    assert _ids(client, "voice:οργανικο") == [t2]
    tag_row = next(t for t in client.get("/api/tags").json() if t["id"] == tag_id)
    assert tag_row["category"] == "voice"

    # the namespace is owned again
    before = _row_counts()
    r = client.post("/api/tags", json={"name": "voice:οργανικό"})
    assert r.status_code == 400
    assert r.json()["detail"] == GUARD
    assert _row_counts() == before


# ---- 4. rejected requests write nothing ------------------------------------

def test_rejected_requests_write_nothing_whichever_task_rejects(client):
    t1, t2, t3, _t4 = _seed([f"/acc/rej-{i}.wav" for i in range(4)])
    _load_preset(client)
    purpose = _facet(client, "purpose")
    mood = _facet(client, "mood")
    calm = _value(client, "purpose", "χαλάρωση")["id"]
    serene = _value(client, "mood", "γαλήνια")["id"]
    tender = _value(client, "mood", "τρυφερή")["id"]

    def assert_unchanged(before):
        assert _snapshot(client) == before

    # (a) a value id force-deleted moments earlier
    r = client.post(f"/api/facets/{purpose['id']}/values", json={"value": "προσωρινό"})
    assert r.status_code in CREATED, r.text
    dead = r.json()["id"]
    assert client.delete(f"/api/facets/values/{dead}", params={"force": "true"}).status_code == 200
    before = _snapshot(client)
    r = _batch(client, {"track_ids": [t1], "add_tag_ids": [dead]})
    assert r.status_code == 404
    assert r.json()["detail"] == UNKNOWN_TAG
    assert_unchanged(before)

    # (b) two values of a facet switched to single moments earlier
    r = client.post(f"/api/facets/{mood['id']}", json={"multi": False})
    assert r.status_code == 200, r.text
    before = _snapshot(client)
    r = _batch(client, {"track_ids": [t1], "add_tag_ids": [serene, tender]})
    assert r.status_code == 422
    assert_unchanged(before)

    # (c) valid tag add with an out-of-range valence
    before = _snapshot(client)
    r = _batch(client, {"track_ids": [t1], "profile": {"valence": 11}, "add_tag_ids": [calm]})
    assert r.status_code == 422
    assert_unchanged(before)
    assert _ids(client, "purpose:χαλάρωση") == []

    # (d) a facet-token query scope (Task 6) that no track satisfies yet
    before = _snapshot(client)
    r = _batch(client, {"query": "purpose:ενεργοποιηση", "add_tag_ids": [calm]})
    assert r.status_code == 200, r.text
    assert r.json()["matched"] == 0
    assert r.json()["updated"] == 0
    assert_unchanged(before)

    # (e) deleting a used value without force
    assert _batch(client, {"track_ids": [t3], "add_tag_ids": [calm]}).status_code == 200
    before = _snapshot(client)
    r = client.delete(f"/api/facets/values/{calm}")
    assert r.status_code == 409
    assert_unchanged(before)

    # (f) label + multi->single while two tracks hold two mood values: atomic refusal
    assert client.post(f"/api/facets/{mood['id']}", json={"multi": True}).status_code == 200
    r = _batch(client, {"track_ids": [t1, t2], "add_tag_ids": [serene, tender]})
    assert r.status_code == 200, r.text
    before = _snapshot(client)
    r = client.post(f"/api/facets/{mood['id']}", json={"label": "Νέα", "multi": False})
    assert r.status_code == 409
    assert_unchanged(before)
    after_mood = _facet(client, "mood")
    assert after_mood["label"] == "Διάθεση"
    assert after_mood["multi"] is True


# ---- 5. tag-only bulk keeps tracks in untagged -----------------------------

def test_tag_only_bulk_keeps_tracks_untagged_and_audits_diffs(client):
    ids = _seed([f"/acc/untagged-{i}.wav" for i in range(5)])
    _load_preset(client)
    calm = _value(client, "purpose", "χαλάρωση")["id"]

    # (2) add over the whole library
    mark = _max_audit_id()
    r = _batch(client, {"query": "", "add_tag_ids": [calm]})
    assert r.status_code == 200, r.text
    assert r.json()["matched"] == 5
    assert _count(client, "untagged") == 5
    assert _row_counts()["track_dj_profile"] == 0
    assert _count(client, "-purpose:*") == 0
    rows = client.get("/api/tracks", params={"limit": 0}).json()
    assert len(rows) == 5
    assert all(row["valence"] is None and row["energy"] is None for row in rows)
    added_rows = _audit_rows_after(mark)
    assert sorted(a.entity_id for a in added_rows) == sorted(ids)
    for a in added_rows:
        assert _mentions(a, calm)
        assert len(a.before_json or "") < 200 and len(a.after_json or "") < 200

    # (3) remove over the whole library
    mark = _max_audit_id()
    r = _batch(client, {"query": "", "remove_tag_ids": [calm]})
    assert r.status_code == 200, r.text
    assert _count(client, "-purpose:*") == 5
    assert _row_counts()["track_dj_profile"] == 0
    removed_rows = _audit_rows_after(mark)
    assert sorted(a.entity_id for a in removed_rows) == sorted(ids)
    for a in removed_rows:
        assert _mentions(a, calm)
        assert len(a.before_json or "") < 200 and len(a.after_json or "") < 200

    # (4) a profile edit on two tracks takes exactly those out of untagged
    a, b = ids[0], ids[1]
    r = _batch(client, {"track_ids": [a, b], "profile": {"valence": 6}})
    assert r.status_code == 200, r.text
    assert _count(client, "untagged") == 3
    assert _ids(client, "valence:6") == sorted([a, b])
