"""Acceptance: backup and restore of vocabularies (Phase A, Tasks 3-9).

Black-box flows across the JSON export (web), the desktop JSON import through
the facets service, and the SQLite bundle round trip. Every catalog lives under
tmp_path; tracks are hand-built rows (no audio, no djay files).
"""
from __future__ import annotations

import csv
import json
import sqlite3
from contextlib import closing, contextmanager
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

import app.config as cfg
import app.db as dbmod
from app.app_factory import create_app
from app.db import reindex_track
from app.models import Track
from app.runtime_profile import RuntimeProfile
from app.services import backup
from app.services.text_fold import fold_text

# (letter, artist, title): no title or artist contains "purpose" or "ζεστ".
TRACKS = (
    ("a", "Άλφα", "Πρωινό φως"),
    ("b", "Βήτα", "Μεσημέρι"),
    ("c", "Γάμμα", "Απόγευμα"),
    ("d", "Δέλτα", "Βράδυ"),
)
SOURCE_PATHS = {letter: f"/lib/{letter}.wav" for letter, _, _ in TRACKS}
WINDOWS_PATHS = {letter: f"C:\\Users\\her\\Music\\{letter}.mp3" for letter, _, _ in TRACKS}
VOICE_TAGS = {"voice:οργανικό", "voice:φωνή χωρίς λόγια", "voice:με στίχους"}
ADOPTION_CONFLICT = "Η υιοθέτηση θα έδινε σε 1 κομμάτι περισσότερες από μία τιμές στο λεξιλόγιο «Φωνή»."


# ---------------------------------------------------------------- helpers

def _ok(resp, status: int | None = None):
    if status is None:
        assert 200 <= resp.status_code < 300, (resp.status_code, resp.text)
    else:
        assert resp.status_code == status, (resp.status_code, resp.text)
    return resp.json()


def _seed_tracks(paths: dict[str, str], specs=TRACKS) -> dict[str, int]:
    ids = {}
    with Session(dbmod.get_engine()) as s:
        for letter, artist, title in specs:
            t = Track(absolute_path=paths[letter], artist=artist, title=title,
                      full_hash=f"fh-{letter}", missing=False)
            s.add(t)
            s.commit()
            s.refresh(t)
            reindex_track(s, t.id)
            ids[letter] = t.id
    return ids


@contextmanager
def _app_on(monkeypatch, db_path: Path, work: Path, profile: RuntimeProfile, *,
            seed: dict[str, str] | None = None, specs=TRACKS, raise_server_exceptions: bool = True):
    """Point settings and the engine at `db_path` (as conftest does), optionally
    create the tables and seed tracks before startup, then serve `profile`."""
    work.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("CRATEMIND_DB_PATH", str(db_path))
    monkeypatch.setenv("CRATEMIND_BACKUP_DIR", str(work / "bk"))
    monkeypatch.setenv("CRATEMIND_OUTPUT_DIR", str(work / "out"))
    cfg.get_settings.cache_clear()
    dbmod._engine = None
    dbmod._settings = cfg.get_settings()
    ids = None
    if seed is not None:
        dbmod.init_db()
        ids = _seed_tracks(seed, specs)
    try:
        with TestClient(create_app(profile), raise_server_exceptions=raise_server_exceptions) as c:
            yield c, ids
    finally:
        if dbmod._engine is not None:
            dbmod._engine.dispose()
        dbmod._engine = None
        cfg.get_settings.cache_clear()  # never leave settings cached on this test's tmp paths


def _facet(facets: list[dict], key: str) -> dict:
    matches = [f for f in facets if f["key"] == key]
    assert len(matches) == 1, [f["key"] for f in facets]
    return matches[0]


def _value_id(facets: list[dict], key: str, value: str) -> int:
    return next(v["id"] for v in _facet(facets, key)["values"] if v["value"] == value)


def _batch(c, track_ids: list[int], **body) -> dict:
    result = _ok(c.post("/api/tracks/batch-profile", json={"track_ids": track_ids, **body}), 200)
    assert result["updated"] == len(track_ids), result
    return result


def _build_source(c) -> dict:
    """Flow 1 setup: preset, a custom multi facet K with «ζεστό», four tracks."""
    _ok(c.post("/api/facets/presets/therapy"), 200)
    color = _ok(c.post("/api/facets", json={"label": "Χρώμα ήχου", "multi": True}))
    warm = _ok(c.post(f"/api/facets/{color['id']}/values", json={"value": "ζεστό"}))
    _ok(c.post(f"/api/facets/{color['id']}", json={"sort_order": 20}))
    ids = _seed_tracks(SOURCE_PATHS)
    facets = _ok(c.get("/api/facets"), 200)
    _batch(c, [ids["a"]], add_tag_ids=[_value_id(facets, "purpose", "χαλάρωση"),
                                       _value_id(facets, "purpose", "ύπνος")])
    _batch(c, [ids["b"]], add_tag_ids=[_value_id(facets, "voice", "οργανικό")])
    _batch(c, [ids["c"]], add_tag_ids=[warm["id"]])
    _batch(c, [ids["a"], ids["c"]], profile={"valence": 7})
    return {"key": color["key"], "facet_id": color["id"], "warm_id": warm["id"], "ids": ids}


def _export_json(c, filename: str = "b.json") -> tuple[Path, dict]:
    path = Path(_ok(c.post("/api/export/json-backup", json={"filename": filename}), 200)["path"])
    return path, json.loads(path.read_text(encoding="utf-8"))


def _export_csv(c, filename: str) -> Path:
    return Path(_ok(c.post("/api/export/csv", json={"all_tracks": True, "filename": filename}), 200)["path"])


def _hashes(c, q: str) -> list[str]:
    return sorted(r["full_hash"] for r in _ok(c.get("/api/tracks", params={"q": q, "limit": 1000}), 200))


def _ids(c, q: str) -> list[int]:
    return [r["id"] for r in _ok(c.get("/api/tracks", params={"q": q, "limit": 1000}), 200)]


def _facet_shape(facets: list[dict]) -> list[tuple]:
    # The plan pins key/label/multi/values through the JSON import, not sort_order
    # (create_facet takes no sort_order) nor value order, so compare order-free.
    return sorted((f["key"], f["label"], f["multi"],
                   sorted((v["value"], v["count"]) for v in f["values"])) for f in facets)


def _values_by_hash(c) -> dict[str, list[str]]:
    keys = {f["key"] for f in _ok(c.get("/api/facets"), 200)}
    out = {}
    for row in _ok(c.get("/api/tracks", params={"limit": 1000}), 200):
        tags = _ok(c.get(f"/api/tracks/{row['id']}"), 200)["tags"]
        out[row["full_hash"]] = sorted(t["name"] for t in tags if t["category"] in keys)
    return out


def _counts_by_text(c, q: str = "") -> tuple[int, dict]:
    names = {v["id"]: (f["key"], v["value"])
             for f in _ok(c.get("/api/facets"), 200) for v in f["values"]}
    body = _ok(c.get("/api/facets/counts", params={"q": q}), 200)
    return body["total"], {names[int(vid)]: n for vid, n in body["counts"].items()}


def _csv_facet_cells(path: Path, labels: set[str]) -> tuple[list[str], dict]:
    """Facet headers (sorted) and {(artist, title): {header: cell}}; column order
    depends on sort_order, which the JSON import does not pin."""
    with path.open(newline="", encoding="utf-8-sig") as stream:
        rows = list(csv.reader(stream, delimiter=";"))
    header = rows[0]
    cols = [i for i, h in enumerate(header) if h in labels]
    artist, title = header.index("artist"), header.index("title")
    return (sorted(header[i] for i in cols),
            {(r[artist], r[title]): {header[i]: r[i] for i in cols} for r in rows[1:]})


def _track_tags(c, track_id: int) -> list[dict]:
    return _ok(c.get(f"/api/tracks/{track_id}"), 200)["tags"]


def _voice_names(c, track_id: int) -> list[str]:
    return [t["name"] for t in _track_tags(c, track_id) if t["name"].startswith("voice:")]


def _db_snapshot(path: Path) -> dict:
    tables = ("tracks", "track_dj_profile", "tags", "track_tags", "facets", "saved_searches")
    with closing(sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)) as conn:
        snap = {t: conn.execute(f"SELECT * FROM {t} ORDER BY 1, 2").fetchall() for t in tables}
        snap["user_version"] = conn.execute("PRAGMA user_version").fetchone()[0]
    return snap


# ---------------------------------------------------------------- flow 1

def test_json_export_carries_vocabulary_state(client):
    src = _build_source(client)
    path, payload = _export_json(client)

    facets = _ok(client.get("/api/facets"), 200)
    assert len(payload["facets"]) == 9
    for row in payload["facets"]:
        assert {"key", "label", "multi", "sort_order"} <= row.keys()
    k_row = next(r for r in payload["facets"] if r["key"] == src["key"])
    assert (k_row["label"], k_row["multi"], k_row["sort_order"]) == ("Χρώμα ήχου", True, 20)
    assert next(r for r in payload["facets"] if r["key"] == "voice")["multi"] is False

    # Facet value tags: category == key and name == "<key>:<value>", one per value.
    for f in facets:
        names = {t["name"] for t in payload["tags"] if t["category"] == f["key"]}
        assert names == {f"{f['key']}:{v['value']}" for v in f["values"]}
    assert f"{src['key']}:ζεστό" in {t["name"] for t in payload["tags"]}

    by_id = {t["id"]: t["full_hash"] for t in payload["tracks"]}
    valence = {by_id[p["track_id"]]: p["valence"] for p in payload["profiles"]}
    assert valence["fh-a"] == valence["fh-c"] == 7

    tag_names = {t["id"]: t["name"] for t in payload["tags"]}
    links = {(by_id[link["track_id"]], tag_names[link["tag_id"]]) for link in payload["track_tags"]}
    assert links >= {("fh-a", "purpose:χαλάρωση"), ("fh-a", "purpose:ύπνος"),
                     ("fh-b", "voice:οργανικό"), ("fh-c", f"{src['key']}:ζεστό")}

    companion = path.parent.resolve() / payload["application_backup"]["directory"]
    assert companion.is_dir()


# ---------------------------------------------------------------- flow 2

def test_desktop_json_import_restores_vocabularies_into_fresh_catalog(client, tmp_path, monkeypatch):
    src = _build_source(client)
    key = src["key"]
    _, payload = _export_json(client)
    source = {
        "facets": _ok(client.get("/api/facets"), 200),
        "values": _values_by_hash(client),
        "valence_purpose": _hashes(client, "valence:6-8 purpose:χαλαρωση"),
        "warm": _hashes(client, f"{key}:ζεστο"),
        "counts": _counts_by_text(client, ""),
    }
    assert source["valence_purpose"] == ["fh-a"] and source["warm"] == ["fh-c"]
    labels = {f["label"] for f in source["facets"]}
    src_headers, src_cells = _csv_facet_cells(_export_csv(client, "source.csv"), labels)
    assert len(src_headers) == 9

    target = tmp_path / "target"
    with _app_on(monkeypatch, target / "catalog.sqlite", target, RuntimeProfile.DESKTOP_CORE,
                 seed=WINDOWS_PATHS) as (c, _):
        result = _ok(c.post("/api/import/json-backup", json=payload), 200)
        assert result["matched_tracks"] == 4

        assert _facet_shape(_ok(c.get("/api/facets"), 200)) == _facet_shape(source["facets"])
        assert _values_by_hash(c) == source["values"]
        assert _hashes(c, "valence:6-8 purpose:χαλαρωση") == source["valence_purpose"]
        assert _hashes(c, f"{key}:ζεστο") == source["warm"]
        assert "fh-c" in _hashes(c, "ζεστο")
        assert _hashes(c, "purpose") == []
        assert _counts_by_text(c, "") == source["counts"]

        headers, cells = _csv_facet_cells(_export_csv(c, "target.csv"), labels)
        assert headers == src_headers
        assert cells == src_cells


# ---------------------------------------------------------------- flow 3

def test_json_import_merge_with_local_edits_keeps_single_value_rule(client, tmp_path, monkeypatch):
    _build_source(client)
    _, payload = _export_json(client)  # links track b to voice:οργανικό
    source_keys = sorted(f["key"] for f in _ok(client.get("/api/facets"), 200))

    target = tmp_path / "target"
    with _app_on(monkeypatch, target / "catalog.sqlite", target, RuntimeProfile.DESKTOP_CORE,
                 seed=WINDOWS_PATHS) as (c, ids):
        _ok(c.post("/api/facets/presets/therapy"), 200)
        local = _ok(c.get("/api/facets"), 200)
        x = ids["b"]
        _batch(c, [x], add_tag_ids=[_value_id(local, "voice", "με στίχους")])

        _ok(c.post("/api/import/json-backup", json=payload), 200)

        assert len(_voice_names(c, x)) == 1
        facets = _ok(c.get("/api/facets"), 200)
        voice = _facet(facets, "voice")
        has_voice = _ok(c.get("/api/tracks/count", params={"q": "voice:*"}), 200)["count"]
        assert sum(v["count"] for v in voice["values"]) == has_voice
        keys = sorted(f["key"] for f in facets)
        assert keys == source_keys
        assert not [k for k in keys if k.startswith("voice_")]

        names = [t["name"] for t in _ok(c.get("/api/tags"), 200)]
        assert len(names) == len(set(names))
        assert {n for n in names if n.startswith("voice:")} == VOICE_TAGS
        for f in facets:
            folded = [fold_text(v["value"]) for v in f["values"]]
            assert len(folded) == len(set(folded)), f["key"]


# ---------------------------------------------------------------- flow 4

def _legacy_payload() -> dict:
    """A version-2 payload from before Phase A: no 'facets', uncategorised names."""
    return {
        "version": 2,
        "tracks": [{"id": 10, "absolute_path": "/old/y.wav", "full_hash": "fh-y"}],
        "tags": [{"id": 1, "name": "voice:οργανικό", "category": None},
                 {"id": 2, "name": "voice:με στίχους", "category": None},
                 {"id": 3, "name": "purpose:χαλάρωση", "category": None}],
        "track_tags": [{"track_id": 10, "tag_id": 1}, {"track_id": 10, "tag_id": 2},
                       {"track_id": 10, "tag_id": 3}],
    }


Y_TRACK = (("y", "Ψι", "Νανούρισμα"),)
Y_PATHS = {"y": "C:\\Users\\her\\Music\\y.mp3"}


def test_pre_phase_a_payload_then_preset_refuses_and_later_adopts(tmp_path, monkeypatch):
    with _app_on(monkeypatch, tmp_path / "t" / "catalog.sqlite", tmp_path / "t",
                 RuntimeProfile.DESKTOP_CORE, seed=Y_PATHS, specs=Y_TRACK) as (c, ids):
        y = ids["y"]
        _ok(c.post("/api/import/json-backup", json=_legacy_payload()), 200)

        refused = c.post("/api/facets/presets/therapy")
        assert refused.status_code == 409, refused.text
        assert refused.json()["detail"] == ADOPTION_CONFLICT
        assert _ok(c.get("/api/facets"), 200) == []
        assert set(_voice_names(c, y)) == {"voice:οργανικό", "voice:με στίχους"}

        lyrics = next(t["id"] for t in _track_tags(c, y) if t["name"] == "voice:με στίχους")
        _ok(c.delete(f"/api/tracks/{y}/tags/{lyrics}"))

        seeded = _ok(c.post("/api/facets/presets/therapy"), 200)
        # Adoption is by tag name, not by link: the now-unlinked «με στίχους» row
        # is adopted too (Task 5 adopts an unlinked uncategorised tag).
        assert seeded["adopted_tags"] == 3
        assert _hashes(c, "voice:οργανικο") == ["fh-y"]
        assert _hashes(c, "purpose:χαλαρωση") == ["fh-y"]


def test_pre_phase_a_payload_into_catalog_with_preset_never_500s(tmp_path, monkeypatch):
    with _app_on(monkeypatch, tmp_path / "t" / "catalog.sqlite", tmp_path / "t",
                 RuntimeProfile.DESKTOP_CORE, seed=Y_PATHS, specs=Y_TRACK,
                 raise_server_exceptions=False) as (c, ids):
        y = ids["y"]
        _ok(c.post("/api/facets/presets/therapy"), 200)
        before = (_ok(c.get("/api/tags"), 200), _track_tags(c, y), _ok(c.get("/api/facets"), 200))

        response = c.post("/api/import/json-backup", json=_legacy_payload())
        assert response.status_code in (200, 422), (response.status_code, response.text)
        if response.status_code == 422:
            after = (_ok(c.get("/api/tags"), 200), _track_tags(c, y), _ok(c.get("/api/facets"), 200))
            assert after == before

        assert len(_voice_names(c, y)) <= 1
        names = [t["name"] for t in _ok(c.get("/api/tags"), 200)]
        assert {n for n in names if n.startswith("voice:")} == VOICE_TAGS
        assert len(names) == len(set(names))


# ---------------------------------------------------------------- flow 5

def test_existing_facet_key_wins_over_payload_definition(tmp_path, monkeypatch):
    payload = {
        "version": 2,
        "facets": [{"id": 1, "key": "voice", "label": "Φωνές", "multi": True, "sort_order": 0}],
        "tracks": [{"id": 10, "absolute_path": "/old/z.wav", "full_hash": "fh-z"}],
        "tags": [{"id": 1, "name": "voice:οργανικό", "category": "voice"},
                 {"id": 2, "name": "voice:με στίχους", "category": "voice"}],
        "track_tags": [{"track_id": 10, "tag_id": 1}, {"track_id": 10, "tag_id": 2}],
    }
    with _app_on(monkeypatch, tmp_path / "t" / "catalog.sqlite", tmp_path / "t",
                 RuntimeProfile.DESKTOP_CORE, seed={"z": "C:\\Users\\her\\Music\\z.mp3"},
                 specs=(("z", "Ζήτα", "Ησυχία"),)) as (c, ids):
        _ok(c.post("/api/facets/presets/therapy"), 200)

        result = _ok(c.post("/api/import/json-backup", json=payload), 200)

        assert result["replaced_facet_values"] >= 1
        voice = _facet(_ok(c.get("/api/facets"), 200), "voice")
        assert (voice["label"], voice["multi"]) == ("Φωνή", False)
        assert len(_voice_names(c, ids["z"])) == 1


# ---------------------------------------------------------------- flow 6

def test_sqlite_bundle_round_trip_keeps_full_state(client, tmp_path, monkeypatch):
    src = _build_source(client)
    key = src["key"]
    _ok(client.post("/api/searches", json={"name": "Χ", "query": "purpose:χαλαρωση valence:6-8"}))
    _ok(client.post("/api/searches", json={"name": "Ζ", "query": f"{key}:ζεστό"}))
    renamed = _ok(client.post(f"/api/facets/values/{src['warm_id']}", json={"value": "θερμό"}))
    assert renamed["rewritten_searches"] == 1

    queries = ["purpose:χαλαρωση", "valence:6-8", "valence:6-8 purpose:χαλαρωση",
               f"{key}:θερμο", f"{key}:*", "voice:*", "-purpose:*"]
    source = {
        "facets": _ok(client.get("/api/facets"), 200),
        "searches": [(s["id"], s["name"], s["query"], s["count"])
                     for s in _ok(client.get("/api/searches"), 200)],
        "queries": {q: _ids(client, q) for q in queries},
    }
    assert source["queries"]["valence:6-8 purpose:χαλαρωση"] == [src["ids"]["a"]]
    assert source["queries"][f"{key}:θερμο"] == [src["ids"]["c"]]
    source_csv_path = _export_csv(client, "same.csv")
    source_csv = source_csv_path.read_bytes()
    json_path, payload = _export_json(client)
    bundle = json_path.parent.resolve() / payload["application_backup"]["directory"]
    catalog = Path(_ok(client.get("/api/settings"), 200)["db_path"])
    snapshot = _db_snapshot(catalog)

    restored = backup.restore_backup(bundle, tmp_path / "restored")
    restored_catalog = restored / "catalog.sqlite"
    assert _db_snapshot(restored_catalog)["user_version"] == snapshot["user_version"]
    assert snapshot["user_version"] >= dbmod.FTS_INDEX_VERSION

    with _app_on(monkeypatch, restored_catalog, tmp_path / "restored-run", RuntimeProfile.WEB) as (c, _):
        assert "fts_rebuild" not in dbmod.launch_phase
        assert _ok(c.get("/api/facets"), 200) == source["facets"]
        assert [(s["id"], s["name"], s["query"], s["count"])
                for s in _ok(c.get("/api/searches"), 200)] == source["searches"]
        assert {q: _ids(c, q) for q in queries} == source["queries"]
        restored_csv = _export_csv(c, "same.csv")
        assert restored_csv.resolve() != source_csv_path.resolve()
        assert restored_csv.read_bytes() == source_csv

    assert _db_snapshot(catalog) == snapshot
    with pytest.raises(FileExistsError):
        backup.restore_backup(bundle, restored)
