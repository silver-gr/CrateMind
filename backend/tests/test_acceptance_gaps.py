"""Acceptance gaps: Phase A flows the other acceptance suites do not cover.

Black-box over HTTP (and the startup path / library_exchange API where the
flow is the API itself). Every catalog lives under tmp_path; tracks are
hand-built rows (no audio, no djay files). Flows:

1. Upgrading from 0.2.1 with a launch bundle younger than 24 h (revision 1).
2. Vocabulary maintenance under the 100-variable cap with 160 tracks.
3. Desktop JSON import whose value differs from a local one by accent/case.
4. Re-loading the therapy preset after the user customised it.
5. Saved searches after their facet is force-deleted.
6. A bulk edit failing part-way leaves the FTS index unchanged.
7. library_exchange export -> prepare_import -> apply_import with Phase A data,
   and a pre-Phase-A exchange applied to a Phase A install.
8. Label-only facets whose slug hits a reserved word.
"""
from __future__ import annotations

import csv
import io
import json
import shutil
import sqlite3
from contextlib import closing, contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event
from sqlmodel import Session, create_engine

import app.config as cfg
import app.db as dbmod
from app.models import SavedSearch, Tag, Track, TrackTag
from app.runtime_profile import RuntimeProfile
from app.services.text_fold import fold_text

FTS_COLUMNS = "artist, title, album, label, genre, comment, notes, tags"
LEGACY_TAG = "purpose:χαλάρωση"
UNFOLDED_MANOS = ("Μάνος Χατζιδάκις", "Χαλάρωση", "", "", "", "", "", LEGACY_TAG)
CONFIRM_TAIL = "Επιβεβαίωσε για διαγραφή."
N_CAP = 160  # > the 100-variable cap the fixture sets


# ================================================================ helpers ===

def _ok(resp, status: int | None = 200):
    if status is None:
        assert 200 <= resp.status_code < 300, (resp.status_code, resp.text)
    else:
        assert resp.status_code == status, (resp.status_code, resp.text)
    return resp.json()


def _seed(rows: list[dict]) -> list[int]:
    """Insert hand-built tracks one row per statement (safe under the variable
    cap) and index them in one transaction; ids in input order."""
    ids: list[int] = []
    with Session(dbmod.get_engine()) as s:
        for row in rows:
            t = Track(missing=False, **row)
            s.add(t)
            s.flush()
            ids.append(t.id)
        s.commit()
        for tid in ids:
            dbmod.reindex_track(s, tid, commit=False)
        s.commit()
    return ids


def _seed_many(n: int, prefix: str = "Ambient") -> list[int]:
    return _seed([
        {"absolute_path": f"/gaps/{prefix.lower()}/{i:03d}.wav", "artist": "Field Ensemble",
         "title": f"{prefix} {i:03d}"}
        for i in range(n)
    ])


def _facets(c) -> list[dict]:
    return _ok(c.get("/api/facets"))


def _facet(c, key: str) -> dict:
    found = [f for f in _facets(c) if f["key"] == key]
    assert len(found) == 1, [f["key"] for f in _facets(c)]
    return found[0]


def _vid(c, key: str, value: str) -> int:
    found = [v["id"] for v in _facet(c, key)["values"] if v["value"] == value]
    assert len(found) == 1, (key, value, _facet(c, key)["values"])
    return found[0]


def _ids(c, q: str) -> list[int]:
    return sorted(row["id"] for row in _ok(c.get("/api/tracks", params={"q": q, "limit": 0})))


def _count(c, q: str) -> int:
    return _ok(c.get("/api/tracks/count", params={"q": q}))["count"]


def _counts(c, q: str = "") -> dict:
    return _ok(c.get("/api/facets/counts", params={"q": q}))


def _bulk(c, **body) -> dict:
    return _ok(c.post("/api/tracks/batch-profile", json=body))


def _saved(c) -> dict[str, dict]:
    return {s["name"]: s for s in _ok(c.get("/api/searches"))}


def _save(c, name: str, query: str) -> int:
    return _ok(c.post("/api/searches", json={"name": name, "query": query}))["id"]


def _saved_ids(c, search_id: int) -> list[int]:
    return sorted(row["id"] for row in _ok(c.get(f"/api/searches/{search_id}/tracks", params={"limit": 1000})))


def _fts_rows() -> dict[int, tuple]:
    with dbmod.get_engine().connect() as conn:
        return {r[0]: tuple(r[1:]) for r in conn.exec_driver_sql(
            f"SELECT rowid, {FTS_COLUMNS} FROM track_search ORDER BY rowid")}


def _table_rows(table: str) -> list[tuple]:
    with dbmod.get_engine().connect() as conn:
        return [tuple(r) for r in conn.exec_driver_sql(f"SELECT * FROM {table} ORDER BY 1, 2")]


def _assert_no_fold_duplicates(c) -> None:
    for f in _facets(c):
        folded = [fold_text(v["value"]) for v in f["values"]]
        assert len(folded) == len(set(folded)), (f["key"], [v["value"] for v in f["values"]])
    names = [t["name"] for t in _ok(c.get("/api/tags"))]
    assert len(names) == len(set(names)), names


def _csv(c, filename: str) -> tuple[list[str], dict[int, dict[str, str]]]:
    path = Path(_ok(c.post("/api/export/csv", json={"all_tracks": True, "filename": filename}))["path"])
    rows = list(csv.reader(io.StringIO(path.read_text(encoding="utf-8-sig"), newline="")))
    headers = rows[0]
    return headers, {int(r[headers.index("id")]): dict(zip(headers, r)) for r in rows[1:]}


@contextmanager
def _commit_counter():
    commits: list[int] = []
    listener = lambda _conn: commits.append(1)
    engine = dbmod.get_engine()
    event.listen(engine, "commit", listener)
    try:
        yield commits
    finally:
        event.remove(engine, "commit", listener)


# ---- launching an app on a dataset or a web-mode catalog -------------------

@contextmanager
def _launch(monkeypatch, *, profile: str, dataset_root: Path | None = None,
            db_path: Path | None = None, backup_dir: Path | None = None):
    """TestClient(create_app()) through the real startup; yields (client, launch_phase copy, backup root)."""
    from app.app_factory import create_app

    monkeypatch.delenv("CRATEMIND_IDENTITY_DB_PATH", raising=False)
    if dataset_root is not None:
        for name in ("CRATEMIND_DB_PATH", "CRATEMIND_BACKUP_DIR", "CRATEMIND_OUTPUT_DIR"):
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv("CRATEMIND_DATASET_ROOT", str(dataset_root))
    else:
        monkeypatch.setenv("CRATEMIND_DATASET_ROOT", "")
        monkeypatch.setenv("CRATEMIND_DB_PATH", str(db_path))
        monkeypatch.setenv("CRATEMIND_BACKUP_DIR", str(backup_dir))
        monkeypatch.setenv("CRATEMIND_OUTPUT_DIR", str(Path(backup_dir).parent / "exports"))
    monkeypatch.setenv("CRATEMIND_RUNTIME_PROFILE", profile)
    cfg.get_settings.cache_clear()
    monkeypatch.setattr(dbmod, "_engine", None)
    monkeypatch.setattr(dbmod, "_settings", cfg.get_settings())
    dbmod.launch_phase.clear()
    try:
        with TestClient(create_app()) as client:
            assert client.get("/api/health").status_code == 200
            yield client, dict(dbmod.launch_phase), Path(cfg.get_settings().backup_path).expanduser().resolve()
    finally:
        dbmod.get_engine().dispose()
        monkeypatch.setattr(dbmod, "_engine", None)
        cfg.get_settings.cache_clear()


@contextmanager
def _app_on(monkeypatch, db_path: Path, work: Path, profile: RuntimeProfile):
    """Serve `profile` on a plain catalog file (tables created first)."""
    from app.app_factory import create_app

    work.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("CRATEMIND_DB_PATH", str(db_path))
    monkeypatch.setenv("CRATEMIND_BACKUP_DIR", str(work / "bk"))
    monkeypatch.setenv("CRATEMIND_OUTPUT_DIR", str(work / "out"))
    cfg.get_settings.cache_clear()
    dbmod._engine = None
    dbmod._settings = cfg.get_settings()
    dbmod.init_db()
    try:
        with TestClient(create_app(profile)) as c:
            yield c
    finally:
        if dbmod._engine is not None:
            dbmod._engine.dispose()
        dbmod._engine = None
        cfg.get_settings.cache_clear()


# ---- a pre-Phase-A (0.2.1-shaped) catalog -------------------------------------

def _seed_old_catalog(path: Path) -> dict:
    """Unfolded FTS, user_version 0, no facets table, no valence column."""
    from app.db import FTS_SQL

    engine = create_engine(f"sqlite:///{path}")
    with Session(engine, expire_on_commit=False) as s:
        manos = Track(absolute_path="/lib/manos.wav", artist="Μάνος Χατζιδάκις", title="Χαλάρωση", missing=False)
        agapo = Track(absolute_path="/lib/agapo.wav", artist="Γιώργος Νταλάρας", title="Σ' αγαπώ", missing=False)
        s.add_all([manos, agapo])
        s.commit()
        tag = Tag(name=LEGACY_TAG, category=None)
        s.add(tag)
        s.commit()
        s.add(TrackTag(track_id=manos.id, tag_id=tag.id))
        s.add(SavedSearch(name="Χαλαρά", query="purpose:χαλάρωση"))
        s.commit()
        ids = {"manos": manos.id, "agapo": agapo.id, "tag": tag.id}
    engine.dispose()
    rows = [
        (ids["manos"], *UNFOLDED_MANOS),
        (ids["agapo"], "Γιώργος Νταλάρας", "Σ' αγαπώ", "", "", "", "", "", ""),
    ]
    with closing(sqlite3.connect(path)) as c:
        c.execute(FTS_SQL)
        c.execute("DELETE FROM track_search")
        c.executemany(f"INSERT INTO track_search (rowid, {FTS_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?)", rows)
        c.execute("DROP TABLE facets")
        c.execute("ALTER TABLE track_dj_profile DROP COLUMN valence")
        c.execute("PRAGMA user_version = 0")
        c.commit()
    return ids


def _catalog_state(path: Path, track_id: int, scratch: Path | None = None) -> dict:
    if scratch is not None:  # inspect a copy so a bundle stays byte-identical
        scratch.mkdir(parents=True, exist_ok=True)
        copy = scratch / f"inspect-{path.parent.name}.sqlite"
        shutil.copyfile(path, copy)
        path = copy
    with closing(sqlite3.connect(path)) as c:
        return {
            "tables": {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")},
            "user_version": c.execute("PRAGMA user_version").fetchone()[0],
            "fts": c.execute(f"SELECT {FTS_COLUMNS} FROM track_search WHERE rowid = ?", (track_id,)).fetchone(),
        }


def _bundles(root: Path) -> list[Path]:
    return sorted(p for p in root.glob("cratemind-*") if p.is_dir() and not p.is_symlink())


# =================================================== flow 1: 0.2.1 upgrade ===

def _young_revision_1_bundle(catalog: Path, backup_root: Path) -> Path:
    """What 0.2.1's launch left behind: a verified bundle of the very same
    catalog bytes (signatures match), younger than 24 h, migration_revision 1."""
    from app.services.backup import create_backup, verify_backup

    bundle = create_backup(catalog, backup_root, keep=3, reuse=False, migration_revision=1)
    manifest = verify_backup(bundle, deep=False)
    assert manifest["migration_revision"] == 1
    age = datetime.now(UTC) - datetime.fromisoformat(manifest["created_at"])
    assert timedelta(0) <= age < timedelta(hours=24)
    return bundle


@pytest.mark.parametrize("profile", ["web", "desktop-core"])
def test_upgrade_from_021_with_young_bundle_backs_up_again_in_dataset_mode(tmp_path, monkeypatch, profile):
    from app.library_exchange.operations import initialize_empty

    dataset = initialize_empty(tmp_path / "data")
    ids = _seed_old_catalog(dataset.catalog_path)
    old_bundle = _young_revision_1_bundle(dataset.catalog_path, dataset.dataset_root / "backups")

    with _launch(monkeypatch, profile=profile, dataset_root=dataset.dataset_root) as (client, phase, root):
        assert phase["backup"].startswith("new:"), phase
        assert "fts_rebuild" in phase
        assert _ids(client, "μανος") == [ids["manos"]]

    bundles = _bundles(root)
    assert old_bundle in bundles and len(bundles) == 2
    newest = bundles[-1]
    assert newest != old_bundle
    snap = _catalog_state(newest / "catalog.sqlite", ids["manos"], tmp_path / "inspect")
    assert snap["user_version"] == 0 and snap["fts"] == UNFOLDED_MANOS  # taken before the rebuild
    assert "facets" not in snap["tables"]  # dataset mode: before init_db as well
    live = _catalog_state(dataset.catalog_path, ids["manos"])
    assert live["user_version"] == dbmod.FTS_INDEX_VERSION
    assert live["fts"][0] == "μανοσ χατζιδακισ"


def test_upgrade_from_021_with_young_bundle_backs_up_again_in_web_mode(tmp_path, monkeypatch):
    from app.library_exchange.operations import initialize_empty

    template = initialize_empty(tmp_path / "template")
    db_path = tmp_path / "web" / "cratemind.sqlite"
    db_path.parent.mkdir(parents=True)
    with closing(sqlite3.connect(template.catalog_path)) as src, closing(sqlite3.connect(db_path)) as dst:
        src.backup(dst)
    ids = _seed_old_catalog(db_path)
    backups = tmp_path / "web-backups"
    old_bundle = _young_revision_1_bundle(db_path, backups)

    with _launch(monkeypatch, profile="web", db_path=db_path, backup_dir=backups) as (client, phase, root):
        assert phase["backup"].startswith("new:"), phase
        assert "fts_rebuild" in phase
        assert _ids(client, "μανος") == [ids["manos"]]

    assert root == backups.resolve()
    bundles = _bundles(root)
    assert old_bundle in bundles and len(bundles) == 2
    snap = _catalog_state(bundles[-1] / "catalog.sqlite", ids["manos"], tmp_path / "inspect")
    assert snap["user_version"] == 0 and snap["fts"] == UNFOLDED_MANOS
    assert _catalog_state(db_path, ids["manos"])["user_version"] == dbmod.FTS_INDEX_VERSION


# ========================================== flow 2: maintenance under cap ===

def _stage_capped_relaxation(client) -> dict:
    _ok(client.post("/api/facets/presets/therapy"))
    ids = _seed_many(N_CAP)
    relax = _vid(client, "purpose", "χαλάρωση")
    s = _bulk(client, query="ambient", add_tag_ids=[relax])
    assert s["matched"] == s["updated"] == N_CAP
    searches = {
        "Α": _save(client, "Α", "purpose:χαλάρωση"),
        "Β": _save(client, "Β", '-PURPOSE:"Χαλαρωση" energy:7+'),
        "Γ": _save(client, "Γ", "ambient"),
    }
    return {"ids": ids, "relax": relax, "searches": searches}


def test_rename_value_under_variable_cap_rewrites_searches_and_reindexes_in_one_commit(client, low_variable_limit):
    st = _stage_capped_relaxation(client)
    with _commit_counter() as commits:
        body = _ok(client.post(f"/api/facets/values/{st['relax']}", json={"value": "ηρεμία"}))
    assert len(commits) == 1
    assert body["count"] == N_CAP and body["rewritten_searches"] == 2

    saved = _saved(client)
    assert saved["Α"]["query"] == "purpose:ηρεμία"
    assert saved["Β"]["query"] == '-PURPOSE:"ηρεμία" energy:7+'
    assert saved["Γ"]["query"] == "ambient"
    assert saved["Α"]["count"] == N_CAP and saved["Β"]["count"] == 0
    assert _saved_ids(client, st["searches"]["Α"]) == sorted(st["ids"])

    assert _count(client, "purpose:ηρεμια") == N_CAP
    assert _count(client, "ηρεμια") == N_CAP
    assert _count(client, "χαλαρωση") == 0
    assert _counts(client, "ambient")["counts"][str(st["relax"])] == N_CAP
    assert {v["value"]: v["count"] for v in _facet(client, "purpose")["values"]}["ηρεμία"] == N_CAP


def test_rename_failing_mid_reindex_rolls_back_searches_tag_and_index(client, low_variable_limit, monkeypatch):
    st = _stage_capped_relaxation(client)
    queries = {n: s["query"] for n, s in _saved(client).items()}
    fts_before = _fts_rows()
    real = dbmod.reindex_track
    calls: list[int] = []

    def flaky(*args, **kwargs):
        calls.append(1)
        if len(calls) == 100:
            raise RuntimeError("boom")
        return real(*args, **kwargs)

    monkeypatch.setattr(dbmod, "reindex_track", flaky)
    with pytest.raises(RuntimeError):
        client.post(f"/api/facets/values/{st['relax']}", json={"value": "ηρεμία"})
    monkeypatch.setattr(dbmod, "reindex_track", real)

    assert {n: s["query"] for n, s in _saved(client).items()} == queries
    assert _vid(client, "purpose", "χαλάρωση") == st["relax"]
    assert _fts_rows() == fts_before
    assert _count(client, "χαλαρωση") == N_CAP and _count(client, "ηρεμια") == 0


def test_force_delete_value_under_variable_cap(client, low_variable_limit):
    st = _stage_capped_relaxation(client)
    r = client.delete(f"/api/facets/values/{st['relax']}")
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert detail.startswith(f"Η τιμή «χαλάρωση» χρησιμοποιείται σε {N_CAP} κομμάτια.")
    assert "«Α»" in detail and "«Β»" in detail and "«Γ»" not in detail
    assert _count(client, "purpose:χαλαρωση") == N_CAP

    body = _ok(client.delete(f"/api/facets/values/{st['relax']}", params={"force": "true"}))
    assert body["removed_assignments"] == N_CAP
    assert sorted(body["broken_searches"]) == ["Α", "Β"]
    assert _count(client, "purpose:*") == 0
    assert _count(client, "χαλαρωση") == 0
    assert str(st["relax"]) not in _counts(client, "")["counts"]
    assert "χαλάρωση" not in {v["value"] for v in _facet(client, "purpose")["values"]}
    assert _saved(client)["Α"]["query"] == "purpose:χαλάρωση" and _saved(client)["Α"]["count"] == 0


def test_force_delete_facet_under_variable_cap(client, low_variable_limit):
    _ok(client.post("/api/facets/presets/therapy"))
    ids = _seed_many(N_CAP)
    organic, lyrics = _vid(client, "voice", "οργανικό"), _vid(client, "voice", "με στίχους")
    half = N_CAP // 2
    assert _bulk(client, query="", add_tag_ids=[organic])["updated"] == N_CAP
    assert _bulk(client, track_ids=ids[:half], add_tag_ids=[lyrics])["replaced"] == half
    voice = _facet(client, "voice")
    assert _count(client, "voice:*") == N_CAP

    r = client.delete(f"/api/facets/{voice['id']}")
    assert r.status_code == 409, r.text
    assert r.json()["detail"] == f"Το λεξιλόγιο «Φωνή» έχει 3 τιμές σε {N_CAP} κομμάτια. {CONFIRM_TAIL}"

    body = _ok(client.delete(f"/api/facets/{voice['id']}", params={"force": "true"}))
    assert body == {"deleted_values": 3, "untagged_tracks": N_CAP}
    assert "voice" not in {f["key"] for f in _facets(client)}
    assert _count(client, "οργανικο") == 0 and _count(client, "στιχουσ") == 0
    counts = _counts(client, "")
    assert counts["total"] == N_CAP
    assert not {str(v["id"]) for v in voice["values"]} & set(counts["counts"])
    assert _count(client, "ambient") == N_CAP


# ============================= flow 3: JSON import, accent/case difference ===

TRACK_SPECS = (("a", "Άλφα", "Πρωινό φως"), ("b", "Βήτα", "Μεσημέρι"), ("c", "Γάμμα", "Απόγευμα"))


def _seed_letters(prefix: str) -> dict[str, int]:
    ids = _seed([{"absolute_path": f"{prefix}{letter}.wav", "artist": artist, "title": title,
                  "full_hash": f"fh-{letter}"} for letter, artist, title in TRACK_SPECS])
    return {letter: tid for (letter, _a, _t), tid in zip(TRACK_SPECS, ids)}


def test_desktop_json_import_lands_on_accent_and_case_variant_values(client, tmp_path, monkeypatch):
    # Source (web): preset values as shipped, plus a label-only facet with «ζεστό».
    _ok(client.post("/api/facets/presets/therapy"))
    color = _ok(client.post("/api/facets", json={"label": "Χρώμα ήχου", "multi": True}))
    warm = _ok(client.post(f"/api/facets/{color['id']}/values", json={"value": "ζεστό"}))
    src = _seed_letters("/lib/")
    _bulk(client, track_ids=[src["a"], src["b"]], add_tag_ids=[_vid(client, "purpose", "χαλάρωση")])
    _bulk(client, track_ids=[src["b"]], add_tag_ids=[_vid(client, "voice", "οργανικό")])
    _bulk(client, track_ids=[src["c"]], add_tag_ids=[warm["id"]])
    path = Path(_ok(client.post("/api/export/json-backup", json={"filename": "b.json"}))["path"])
    payload = json.loads(path.read_text(encoding="utf-8"))

    target = tmp_path / "target"
    with _app_on(monkeypatch, target / "catalog.sqlite", target, RuntimeProfile.DESKTOP_CORE) as c:
        local = _seed_letters("C:\\Users\\her\\Music\\")
        _ok(c.post("/api/facets/presets/therapy"))
        # Local spellings differ only by case or accent from the backup's.
        relax = _vid(c, "purpose", "χαλάρωση")
        _ok(c.post(f"/api/facets/values/{relax}", json={"value": "Χαλάρωση"}))
        organic = _vid(c, "voice", "οργανικό")
        _ok(c.post(f"/api/facets/values/{organic}", json={"value": "Οργανικο"}))
        lcolor = _ok(c.post("/api/facets", json={"label": "Χρώμα ήχου", "multi": True}))
        assert lcolor["key"] == color["key"]
        lwarm = _ok(c.post(f"/api/facets/{lcolor['id']}/values", json={"value": "ΖΕΣΤΟ"}))
        tags_before = {t["name"] for t in _ok(c.get("/api/tags"))}

        result = _ok(c.post("/api/import/json-backup", json=payload))
        assert result["matched_tracks"] == 3

        _assert_no_fold_duplicates(c)
        purpose = {v["value"]: v for v in _facet(c, "purpose")["values"]}
        assert "χαλάρωση" not in purpose and purpose["Χαλάρωση"]["id"] == relax
        assert purpose["Χαλάρωση"]["count"] == 2
        voice = {v["value"]: v for v in _facet(c, "voice")["values"]}
        assert "οργανικό" not in voice and voice["Οργανικο"]["id"] == organic
        assert voice["Οργανικο"]["count"] == 1
        colour = _facet(c, color["key"])
        assert [(v["id"], v["value"], v["count"]) for v in colour["values"]] == [(lwarm["id"], "ΖΕΣΤΟ", 1)]
        assert len([f for f in _facets(c) if f["label"] == "Χρώμα ήχου"]) == 1
        assert {t["name"] for t in _ok(c.get("/api/tags"))} == tags_before

        assert _ids(c, "purpose:χαλαρωση") == sorted([local["a"], local["b"]])
        assert _ids(c, f"{color['key']}:ζεστό") == [local["c"]]
        assert _ids(c, "voice:οργανικό") == [local["b"]]

        # Re-importing the same payload changes nothing.
        snapshot = (_facets(c), _counts(c, ""))
        _ok(c.post("/api/import/json-backup", json=payload))
        assert (_facets(c), _counts(c, "")) == snapshot


# =========================================== flow 4: preset after edits ===

def test_reloading_the_preset_keeps_every_user_customisation(client):
    _ok(client.post("/api/facets/presets/therapy"))
    ids = _seed_many(4, "Item")
    relax = _vid(client, "purpose", "χαλάρωση")
    organic = _vid(client, "voice", "οργανικό")
    calm = _vid(client, "mood", "γαλήνια")
    _bulk(client, track_ids=ids[:2], add_tag_ids=[relax])
    _bulk(client, track_ids=ids, add_tag_ids=[organic])

    mood, voice, purpose = _facet(client, "mood"), _facet(client, "voice"), _facet(client, "purpose")
    assert voice["multi"] is False and mood["multi"] is True
    _ok(client.post(f"/api/facets/values/{relax}", json={"value": "ηρεμία"}))       # renamed value
    _ok(client.post(f"/api/facets/values/{organic}", json={"value": "ΟΡΓΑΝΙΚΟ"}))    # case/accent-only rename
    _ok(client.post(f"/api/facets/values/{calm}", json={"value": "γαληνια"}))        # accent dropped
    _ok(client.post(f"/api/facets/{mood['id']}", json={"label": "Συναίσθημα", "multi": False}))
    _ok(client.post(f"/api/facets/{voice['id']}", json={"multi": True}))
    _ok(client.post(f"/api/facets/{purpose['id']}", json={"sort_order": 99}))
    mine = _ok(client.post(f"/api/facets/{purpose['id']}/values", json={"value": "δικό μου"}))
    _bulk(client, track_ids=[ids[0]], add_tag_ids=[_vid(client, "voice", "με στίχους")])  # voice is multi now
    before = {f["key"]: f for f in _facets(client)}

    again = _ok(client.post("/api/facets/presets/therapy"))
    assert again["created_facets"] == 0 and again["adopted_tags"] == 0

    after = {f["key"]: f for f in _facets(client)}
    assert set(after) == set(before) and len(after) == 8
    for key, f in before.items():
        a = after[key]
        assert (a["id"], a["label"], a["multi"], a["sort_order"]) == \
            (f["id"], f["label"], f["multi"], f["sort_order"]), key
        old_values = {v["id"]: (v["value"], v["count"]) for v in f["values"]}
        new_values = {v["id"]: (v["value"], v["count"]) for v in a["values"]}
        assert {k: new_values.get(k) for k in old_values} == old_values, key  # nothing renamed back or unlinked
    assert after["mood"]["label"] == "Συναίσθημα" and after["mood"]["multi"] is False
    assert after["voice"]["multi"] is True
    assert after["purpose"]["sort_order"] == 99
    assert mine["id"] in {v["id"] for v in after["purpose"]["values"]}
    # Case/accent-only renames are the same value to the preset: never re-created.
    voice_values = [fold_text(v["value"]) for v in after["voice"]["values"]]
    mood_values = [fold_text(v["value"]) for v in after["mood"]["values"]]
    assert voice_values.count(fold_text("οργανικό")) == 1
    assert mood_values.count(fold_text("γαλήνια")) == 1
    _assert_no_fold_duplicates(client)
    assert _ids(client, "purpose:ηρεμία") == sorted(ids[:2])
    assert _ids(client, "voice:οργανικο") == sorted(ids)

    # A third load is a no-op.
    assert _ok(client.post("/api/facets/presets/therapy")) == {
        "created_facets": 0, "created_values": 0, "adopted_tags": 0}


# ===================================== flow 5: searches after facet delete ===

def test_saved_searches_survive_a_force_deleted_facet(client):
    _ok(client.post("/api/facets/presets/therapy"))
    tagged = _seed_many(3, "Calm")
    untouched = _seed_many(3, "Plain")
    total = len(tagged) + len(untouched)
    relax = _vid(client, "purpose", "χαλάρωση")
    expr = _vid(client, "purpose", "συναισθηματική έκφραση")
    _bulk(client, track_ids=tagged[:2], add_tag_ids=[relax])
    _bulk(client, track_ids=[tagged[2]], add_tag_ids=[expr])
    queries = {
        "value": "purpose:χαλάρωση",
        "quoted": 'purpose:"συναισθηματική έκφραση"',
        "combined": "purpose:χαλαρωση calm",
        "any": "purpose:*",
    }
    sids = {name: _save(client, name, q) for name, q in queries.items()}
    assert _saved(client)["any"]["count"] == 3

    purpose = _facet(client, "purpose")
    _ok(client.delete(f"/api/facets/{purpose['id']}", params={"force": "true"}))

    saved = _saved(client)
    assert {n: saved[n]["query"] for n in queries} == queries
    for name, q in queries.items():
        listed = _saved_ids(client, sids[name])
        assert saved[name]["count"] == len(listed) == _count(client, q), name
    # A deleted key is an unknown field again (spec A3): its value falls back to
    # free text, exactly like a key that never existed.
    for q in queries.values():
        unknown = q.replace("purpose:", "nosuchkey:")
        assert _count(client, q) == _count(client, unknown) <= total, q


# ================================== flow 6: failed bulk leaves FTS as-is ===

@pytest.mark.parametrize("failing", ["apply_tag_changes", "reindex_track", "audit_log"])
def test_bulk_edit_failing_part_way_leaves_fts_unchanged(client, monkeypatch, failing):
    from app.services import audit, facets

    _ok(client.post("/api/facets/presets/therapy"))
    ids = _seed_many(4, "Quiet")
    relax = _vid(client, "purpose", "χαλάρωση")
    fts_before = _fts_rows()
    tables_before = {t: _table_rows(t) for t in ("track_tags", "track_dj_profile", "audit_log")}

    target, name = {"apply_tag_changes": (facets, "apply_tag_changes"),
                    "reindex_track": (dbmod, "reindex_track"),
                    "audit_log": (audit, "log")}[failing]
    real = getattr(target, name)
    calls: list[int] = []

    def flaky(*args, **kwargs):
        calls.append(1)
        if len(calls) == 3:
            raise RuntimeError("boom")
        return real(*args, **kwargs)

    monkeypatch.setattr(target, name, flaky)
    with pytest.raises(RuntimeError):
        client.post("/api/tracks/batch-profile", json={
            "track_ids": ids, "profile": {"notes": "Σημείωση θεραπείας"}, "add_tag_ids": [relax]})
    monkeypatch.setattr(target, name, real)

    assert len(calls) >= 3
    assert _fts_rows() == fts_before
    assert {t: _table_rows(t) for t in tables_before} == tables_before
    assert _count(client, "σημειωση") == 0 and _count(client, "χαλαρωση") == 0
    assert _count(client, "purpose:*") == 0


# ====================================== flow 7: library_exchange round trip ===

def _summary_row(preview, table: str) -> dict | None:
    rows = [r for r in preview.change_summary if r["table"] == table]
    assert len(rows) <= 1
    return rows[0] if rows else None


def test_exchange_with_phase_a_dataset_previews_vocabularies_and_round_trips(tmp_path, monkeypatch):
    from app.library_exchange import operations as exchange

    a_root, b_root = tmp_path / "A", tmp_path / "B"
    exchange.initialize_empty(a_root)
    with _launch(monkeypatch, profile="web", dataset_root=a_root) as (c, _phase, _root):
        _ok(c.post("/api/facets/presets/therapy"))
        color = _ok(c.post("/api/facets", json={"label": "Χρώμα ήχου", "multi": True}))
        _ok(c.post(f"/api/facets/{color['id']}/values", json={"value": "ζεστό"}))
        ids = _seed_many(3, "Exchange")
        _bulk(c, track_ids=ids[:2], add_tag_ids=[_vid(c, "purpose", "χαλάρωση")], profile={"valence": 7})
        source_facets = _facets(c)
    assert len(source_facets) == 9

    s0 = exchange.export_exchange(a_root, tmp_path / "S0.cmexchange")
    preview = exchange.prepare_import(s0.path, b_root)
    assert preview.status == "ready", preview.reason
    row = _summary_row(preview, "facets")
    assert row is not None, [r["table"] for r in preview.change_summary]
    assert row["label"] == "Λεξιλόγια"
    assert row["incoming_only"] == row["incoming_rows"] == 9 and row["local_rows"] == 0
    exchange.apply_import(preview, b_root)

    with _launch(monkeypatch, profile="desktop-core", dataset_root=b_root) as (c, phase, _root):
        assert "fts_rebuild" not in phase
        shape = lambda fs: [(f["key"], f["label"], f["multi"], f["sort_order"],
                             [(v["value"], v["count"]) for v in f["values"]]) for f in fs]
        assert shape(_facets(c)) == shape(source_facets)
        assert _ids(c, "purpose:χαλαρωση valence:6-8") == sorted(ids[:2])
        assert _ids(c, "χαλαρωση") == sorted(ids[:2])
        mood = _facet(c, "mood")
        _ok(c.post(f"/api/facets/{mood['id']}", json={"label": "Συναίσθημα"}))

    s1 = exchange.export_exchange(b_root, tmp_path / "S1.cmexchange")
    back = exchange.prepare_import(s1.path, a_root)
    assert back.status == "ready", back.reason
    row = _summary_row(back, "facets")
    assert row is not None and row["label"] == "Λεξιλόγια"
    assert row["local_only"] == 1 and row["incoming_only"] == 1
    exchange.apply_import(back, a_root)
    with _launch(monkeypatch, profile="web", dataset_root=a_root) as (c, _phase, _root):
        assert _facet(c, "mood")["label"] == "Συναίσθημα"
        assert _ids(c, "purpose:χαλαρωση") == sorted(ids[:2])


def test_pre_phase_a_exchange_applies_to_a_phase_a_install(tmp_path, monkeypatch):
    from app.library_exchange import operations as exchange

    old_root, new_root = tmp_path / "old", tmp_path / "new"
    old = exchange.initialize_empty(old_root)
    ids = _seed_old_catalog(old.catalog_path)
    s0 = exchange.export_exchange(old_root, tmp_path / "S0.cmexchange")

    # The Phase A machine adopts the old lineage, then upgrades: preset, tags.
    exchange.apply_import(exchange.prepare_import(s0.path, new_root), new_root)
    with _launch(monkeypatch, profile="web", dataset_root=new_root) as (c, _phase, _root):
        assert _ids(c, "μανος") == [ids["manos"]]
        assert _ok(c.post("/api/facets/presets/therapy"))["adopted_tags"] == 1
        assert _ids(c, "purpose:χαλαρωση") == [ids["manos"]]

    # The old machine (pre-Phase-A schema) keeps working and exports again.
    with closing(sqlite3.connect(old.catalog_path)) as db:
        db.execute("INSERT INTO tags(name) VALUES ('νέο από παλιό')")
        db.commit()
    s1 = exchange.export_exchange(old_root, tmp_path / "S1.cmexchange")

    preview = exchange.prepare_import(s1.path, new_root)
    assert preview.conflict, preview.status  # local Phase A work not exported yet
    row = _summary_row(preview, "facets")
    assert row is not None and row["label"] == "Λεξιλόγια"
    assert row["local_only"] == 8 and row["incoming_rows"] == 0
    replaced = exchange.apply_import(preview, new_root, decision="replace",
                                     confirmation_digest=preview.local_digest)
    assert replaced.conflict_archive is not None

    for profile in ("web", "desktop-core"):
        with _launch(monkeypatch, profile=profile, dataset_root=new_root) as (c, phase, _root):
            assert _ids(c, "μανος") == [ids["manos"]]
            assert _ids(c, "σ' αγαπω") == [ids["agapo"]]
            assert _ok(c.patch(f"/api/tracks/{ids['agapo']}/profile", json={"valence": 6}))["valence"] == 6
            if profile == "web":  # first launch on the replaced generation
                assert "fts_rebuild" in phase
                assert _facets(c) == []
                assert _ok(c.post("/api/facets/presets/therapy"))["adopted_tags"] == 1
                assert _ids(c, "purpose:χαλαρωση") == [ids["manos"]]
                assert _saved(c)["Χαλαρά"]["count"] == 1
            else:  # second launch: the preset loaded above is still there
                assert "fts_rebuild" not in phase
                assert len(_facets(c)) == 8
                assert _ids(c, "purpose:χαλαρωση") == [ids["manos"]]


# ========================== flow 8: label-only facets on reserved words ===

RESERVED_LABELS = {"Folder": "f_folder", "Valence": "f_valence", "Tag": "f_tag", "Energy": "f_energy"}
VALUES = {"Folder": "αρχείο α", "Valence": "θετική", "Tag": "σημαντικό", "Energy": "ήπια"}


def test_label_only_facets_on_reserved_words_work_everywhere(client):
    ids = _seed([
        {"absolute_path": f"/music/Relax/{i}.wav", "artist": "Reserved Ensemble", "title": f"Piece {i}"}
        for i in range(4)
    ])
    _bulk(client, track_ids=ids[:2], profile={"valence": 7, "energy": 8})
    made = {}
    for label, key in RESERVED_LABELS.items():
        f = _ok(client.post("/api/facets", json={"label": label, "multi": True}))
        assert f["key"] == key and f["label"] == label
        v = _ok(client.post(f"/api/facets/{f['id']}/values", json={"value": VALUES[label]}))
        made[label] = (f, v)

    # bulk: by ids and by query
    _bulk(client, track_ids=[ids[0]], add_tag_ids=[made["Folder"][1]["id"]])
    _bulk(client, track_ids=[ids[1]], add_tag_ids=[made["Valence"][1]["id"]])
    s = _bulk(client, query="piece", add_tag_ids=[made["Tag"][1]["id"]])
    assert s["matched"] == 4
    _bulk(client, query="f_valence:*", add_tag_ids=[made["Energy"][1]["id"]])

    # search: the facet token, folded, quoted, any/none, free text
    assert _ids(client, 'f_folder:"αρχείο α"') == [ids[0]]
    assert _ids(client, 'F_FOLDER:"ΑΡΧΕΙΟ Α"') == [ids[0]]
    assert _ids(client, "f_valence:θετικη") == [ids[1]]
    assert _ids(client, "f_tag:*") == sorted(ids)
    assert _ids(client, "-f_energy:*") == sorted(set(ids) - {ids[1]})
    assert _ids(client, "σημαντικο") == sorted(ids)
    # the built-in fields keep their meaning
    assert _ids(client, "folder:relax") == sorted(ids)
    assert _ids(client, "valence:6-8") == sorted(ids[:2])
    assert _ids(client, "energy:7+") == sorted(ids[:2])
    assert _ids(client, "f_valence") == []  # the key is never free text

    # counts
    counts = _counts(client, "f_tag:*")
    assert counts["total"] == 4
    assert counts["counts"][str(made["Tag"][1]["id"])] == 4
    assert counts["counts"][str(made["Folder"][1]["id"])] == 1
    assert _counts(client, "f_folder:*")["total"] == 1

    # CSV: one column per label, base columns untouched
    headers, rows = _csv(client, "reserved.csv")
    assert len(headers) == len(set(headers)), headers
    for label in RESERVED_LABELS:
        assert headers.count(label) == 1, label
    assert headers.count("valence") == 1 and headers.count("energy") == 1
    assert rows[ids[0]]["Folder"] == "αρχείο α" and rows[ids[1]]["Folder"] == ""
    assert rows[ids[1]]["Valence"] == "θετική"
    assert rows[ids[1]]["Energy"] == "ήπια"
    assert all(rows[t]["Tag"] == "σημαντικό" for t in ids)
    assert rows[ids[0]]["valence"] == "7" and rows[ids[0]]["energy"] == "8"


def test_lowercase_reserved_label_gets_its_own_key_and_csv_column(client):
    (tid,) = _seed([{"absolute_path": "/music/one.wav", "artist": "Solo", "title": "One"}])
    _bulk(client, track_ids=[tid], profile={"valence": 4})
    first = _ok(client.post("/api/facets", json={"label": "Valence", "multi": True}))
    low = _ok(client.post("/api/facets", json={"label": "valence", "multi": True}))
    assert first["key"] == "f_valence" and low["key"] == "f_valence_2"
    v = _ok(client.post(f"/api/facets/{low['id']}/values", json={"value": "ουδέτερη"}))
    _bulk(client, track_ids=[tid], add_tag_ids=[v["id"]])
    assert _ids(client, "f_valence_2:ουδετερη") == [tid]
    assert _ids(client, "valence:4") == [tid]

    headers, rows = _csv(client, "lower.csv")
    assert len(headers) == len(set(headers)), headers
    assert rows[tid]["valence"] == "4"
    assert rows[tid]["valence (2)"] == "ουδέτερη"
