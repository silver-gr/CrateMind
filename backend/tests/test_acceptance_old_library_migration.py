"""Acceptance: a catalog created before Therapy Phase A migrates safely.

Black-box over the startup path (TestClient(create_app())) and the HTTP API.
The old catalog is built by hand: user_version 0, unfolded FTS rows, no
`facets` table and no `track_dj_profile.valence` column. Each flow crosses
Task 2 (folded search), Task 3 (FTS rebuild after the launch backup),
Task 4 (valence + facets table on an old catalog), Task 5 (preset adoption),
Task 6 (facet/valence tokens) and Task 7 (facet routes in both profiles).
Never touches real data: every path lives under tmp_path.
"""
from __future__ import annotations

import shutil
import sqlite3
from contextlib import closing, contextmanager
from pathlib import Path

import pytest
from sqlmodel import Session, create_engine

from app.models import SavedSearch, Tag, Track, TrackDJProfile, TrackTag

PROFILES = ["web", "desktop-core"]
LEGACY_TAG = "purpose:χαλάρωση"
SAVED_NAME = "Χαλαρά"
FTS_COLUMNS = "artist, title, album, label, genre, comment, notes, tags"


# ---- building a pre-Phase-A catalog by hand --------------------------------------------------------

def _seed_old_catalog(path: Path) -> dict:
    """Fill a full-schema catalog, write unfolded FTS rows the way the old
    reindex did, then strip it back to the pre-Phase-A shape."""
    from app.db import FTS_SQL

    engine = create_engine(f"sqlite:///{path}")
    with Session(engine, expire_on_commit=False) as s:
        manos = Track(absolute_path="/lib/manos.wav", artist="Μάνος Χατζιδάκις", title="Χαλάρωση", missing=False)
        agapo = Track(absolute_path="/lib/agapo.wav", artist="Γιώργος Νταλάρας", title="Σ' αγαπώ", missing=False)
        sleep = Track(absolute_path="/lib/sleep.wav", artist="Ελένη Καραΐνδρου", title="Νανούρισμα", missing=False)
        s.add_all([manos, agapo, sleep])
        s.commit()
        s.add(TrackDJProfile(track_id=sleep.id, notes="Ύπνος βαθύς"))
        tag = Tag(name=LEGACY_TAG, category=None)
        s.add(tag)
        s.commit()
        s.add(TrackTag(track_id=manos.id, tag_id=tag.id))
        s.add(SavedSearch(name=SAVED_NAME, query="purpose:χαλάρωση"))
        s.commit()
        ids = {"manos": manos.id, "agapo": agapo.id, "sleep": sleep.id, "tag": tag.id}
    engine.dispose()

    rows = [
        (ids["manos"], "Μάνος Χατζιδάκις", "Χαλάρωση", "", "", "", "", "", LEGACY_TAG),
        (ids["agapo"], "Γιώργος Νταλάρας", "Σ' αγαπώ", "", "", "", "", "", ""),
        (ids["sleep"], "Ελένη Καραΐνδρου", "Νανούρισμα", "", "", "", "", "Ύπνος βαθύς", ""),
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


def _old_dataset(root: Path):
    from app.library_exchange.operations import initialize_empty

    dataset = initialize_empty(root)
    ids = _seed_old_catalog(dataset.catalog_path)
    return dataset, ids


def _old_web_db(tmp_path: Path, name: str) -> tuple[Path, dict]:
    """The same stripped catalog, as a plain web-mode database file."""
    from app.library_exchange.operations import initialize_empty

    template = initialize_empty(tmp_path / f"{name}-template")
    target = tmp_path / name / "cratemind.sqlite"
    target.parent.mkdir(parents=True)
    with closing(sqlite3.connect(template.catalog_path)) as src, closing(sqlite3.connect(target)) as dst:
        src.backup(dst)
    return target, _seed_old_catalog(target)


# ---- inspecting catalogs ----------------------------------------------------------------------------

def _state(path: Path, track_id: int) -> dict:
    """Inspect a catalog. Bundles are copied first so the bundle stays byte-identical."""
    with closing(sqlite3.connect(path)) as c:
        tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        return {
            "tables": tables,
            "profile_columns": {r[1] for r in c.execute("PRAGMA table_info(track_dj_profile)")},
            "user_version": c.execute("PRAGMA user_version").fetchone()[0],
            "fts": c.execute(f"SELECT {FTS_COLUMNS} FROM track_search WHERE rowid = ?", (track_id,)).fetchone(),
        }


def _bundle_state(bundle: Path, track_id: int, scratch: Path) -> dict:
    scratch.mkdir(parents=True, exist_ok=True)
    copy = scratch / f"inspect-{bundle.name}.sqlite"
    shutil.copyfile(bundle / "catalog.sqlite", copy)
    return _state(copy, track_id)


def _bundles(root: Path) -> list[Path]:
    return sorted(p for p in root.glob("cratemind-*") if p.is_dir() and not p.is_symlink())


UNFOLDED_MANOS = ("Μάνος Χατζιδάκις", "Χαλάρωση", "", "", "", "", "", LEGACY_TAG)


# ---- launching the app ------------------------------------------------------------------------------

@contextmanager
def _launch(monkeypatch, *, profile: str, dataset=None, db_path: Path | None = None, backup_dir: Path | None = None):
    """Start TestClient(create_app()); yields (client, launch_phase copy, backup root)."""
    from fastapi.testclient import TestClient

    import app.config as cfg
    import app.db as dbmod
    from app.app_factory import create_app

    monkeypatch.delenv("CRATEMIND_IDENTITY_DB_PATH", raising=False)
    if dataset is not None:  # modelled on test_djay_import.py dataset-root startup
        for name in ("CRATEMIND_DB_PATH", "CRATEMIND_BACKUP_DIR", "CRATEMIND_OUTPUT_DIR"):
            monkeypatch.delenv(name, raising=False)
        monkeypatch.setenv("CRATEMIND_DATASET_ROOT", str(dataset.dataset_root))
    else:
        monkeypatch.setenv("CRATEMIND_DATASET_ROOT", "")
        monkeypatch.setenv("CRATEMIND_DB_PATH", str(db_path))
        monkeypatch.setenv("CRATEMIND_BACKUP_DIR", str(backup_dir))
        monkeypatch.setenv("CRATEMIND_OUTPUT_DIR", str(Path(backup_dir).parent / "exports"))
    monkeypatch.setenv("CRATEMIND_RUNTIME_PROFILE", profile)
    cfg.get_settings.cache_clear()
    monkeypatch.setattr(dbmod, "_engine", None)
    monkeypatch.setattr(dbmod, "_settings", cfg.get_settings())
    try:
        with TestClient(create_app()) as client:
            assert client.get("/api/health").status_code == 200
            yield client, dict(dbmod.launch_phase), Path(cfg.get_settings().backup_path).expanduser().resolve()
    finally:
        dbmod.get_engine().dispose()
        monkeypatch.setattr(dbmod, "_engine", None)
        cfg.get_settings.cache_clear()


def _ids(client, q: str) -> set[int]:
    r = client.get("/api/tracks", params={"q": q, "limit": 1000})
    assert r.status_code == 200, (q, r.text)
    return {row["id"] for row in r.json()}


def _rows_by_id(client) -> dict[int, dict]:
    r = client.get("/api/tracks", params={"limit": 1000})
    assert r.status_code == 200, r.text
    return {row["id"]: row for row in r.json()}


def _purpose_value(client, value: str) -> dict:
    r = client.get("/api/facets")
    assert r.status_code == 200, r.text
    purpose = [f for f in r.json() if f["key"] == "purpose"]
    assert len(purpose) == 1
    matches = [v for v in purpose[0]["values"] if v["value"] == value]
    assert len(matches) == 1
    return matches[0]


def _saved_count(client, name: str) -> int:
    r = client.get("/api/searches")
    assert r.status_code == 200, r.text
    rows = [s for s in r.json() if s["name"] == name]
    assert len(rows) == 1
    return rows[0]["count"]


# ---- flow 1 -----------------------------------------------------------------------------------------

@pytest.mark.parametrize("profile", PROFILES)
def test_dataset_first_launch_backs_up_the_true_old_state_then_migrates(tmp_path, monkeypatch, profile):
    import app.db as dbmod

    dataset, ids = _old_dataset(tmp_path / "data")
    with _launch(monkeypatch, profile=profile, dataset=dataset) as (_client, phase, root):
        pass

    assert phase["backup"].startswith("new:")
    assert "fts_rebuild" in phase
    bundles = _bundles(root)
    assert len(bundles) == 1

    old = _bundle_state(bundles[0], ids["manos"], tmp_path / "inspect")
    assert "facets" not in old["tables"] and "tracks" in old["tables"]
    assert "valence" not in old["profile_columns"]
    assert old["user_version"] == 0
    assert old["fts"] == UNFOLDED_MANOS

    live = _state(dataset.catalog_path, ids["manos"])
    assert "facets" in live["tables"]
    assert "valence" in live["profile_columns"]
    assert live["user_version"] == dbmod.FTS_INDEX_VERSION
    assert live["fts"] != UNFOLDED_MANOS
    assert live["fts"][0] == "μανοσ χατζιδακισ" and live["fts"][1] == "χαλαρωση"
    assert _state(dataset.catalog_path, ids["sleep"])["fts"][6] == "υπνοσ βαθυσ"


# ---- flows 2, 3, 4 ----------------------------------------------------------------------------------

@pytest.mark.parametrize("profile", PROFILES)
def test_dataset_migration_search_adoption_and_noop_second_launch(tmp_path, monkeypatch, profile):
    import app.db as dbmod

    dataset, ids = _old_dataset(tmp_path / "data")
    manos, agapo, sleep = ids["manos"], ids["agapo"], ids["sleep"]

    with _launch(monkeypatch, profile=profile, dataset=dataset) as (client, phase, root):
        assert "fts_rebuild" in phase
        # Flow 2: accentless search over HTTP after the rebuild.
        for q in ("μανος χατζιδακις", "ΜΑΝΟΣ", "χατζιδ", "artist:μάνος"):
            assert _ids(client, q) == {manos}, q
        assert _ids(client, "σ' αγαπω") == {agapo}
        assert _ids(client, "-υπνος") == {manos, agapo}  # notes column was folded by the rebuild
        # Before adoption the legacy tag is plain text, folded whole.
        assert _ids(client, "purpose") == {manos}

        rows = _rows_by_id(client)
        assert set(rows) == {manos, agapo, sleep}
        assert all("valence" in row and row["valence"] is None for row in rows.values())
        r = client.patch(f"/api/tracks/{manos}/profile", json={"valence": 7})
        assert r.status_code == 200, r.text
        assert r.json()["valence"] == 7
        assert _ids(client, "valence:6-8") == {manos}

        r = client.get("/api/facets")
        assert r.status_code == 200 and r.json() == []  # table exists in this profile

        # Flow 3: adopt the legacy tag.
        assert _saved_count(client, SAVED_NAME) == 1
        r = client.post("/api/facets/presets/therapy")
        assert r.is_success, r.text  # the plan pins the body, not 200 vs 201
        assert r.json()["adopted_tags"] == 1
        value = _purpose_value(client, "χαλάρωση")
        assert value["id"] == ids["tag"] and value["count"] == 1
        assert _ids(client, "purpose:χαλαρωση") == {manos}
        # Adoption reindexes the adopted track: FTS holds only the value part now.
        assert _ids(client, "purpose") == set()
        assert _saved_count(client, SAVED_NAME) == 1
        bundles_before = _bundles(root)
    with closing(sqlite3.connect(dataset.catalog_path)) as c:
        version_before = c.execute("PRAGMA user_version").fetchone()[0]
    assert version_before == dbmod.FTS_INDEX_VERSION

    # Flow 4: the second launch is a no-op.
    with _launch(monkeypatch, profile=profile, dataset=dataset) as (client, phase, root):
        assert phase["backup"] == "reused"
        assert "fts_rebuild" not in phase
        assert _bundles(root) == bundles_before
        assert _rows_by_id(client)[manos]["valence"] == 7
        assert _ids(client, "valence:6-8") == {manos}
        value = _purpose_value(client, "χαλάρωση")
        assert value["id"] == ids["tag"] and value["count"] == 1
        assert _ids(client, "purpose:χαλάρωση") == {manos}
        assert _ids(client, "μανος") == {manos}
        assert _ids(client, "σ' αγαπω") == {agapo}
    with closing(sqlite3.connect(dataset.catalog_path)) as c:
        assert c.execute("PRAGMA user_version").fetchone()[0] == version_before


# ---- flow 5 -----------------------------------------------------------------------------------------

def test_web_mode_backs_up_before_the_rebuild(tmp_path, monkeypatch):
    import app.db as dbmod

    db_path, ids = _old_web_db(tmp_path, "web")
    backups = tmp_path / "web-backups"
    with _launch(monkeypatch, profile="web", db_path=db_path, backup_dir=backups) as (client, phase, root):
        assert phase["backup"].startswith("new:")
        assert "fts_rebuild" in phase
        assert _ids(client, "μανος") == {ids["manos"]}

    assert root == backups.resolve()
    bundles = _bundles(root)
    assert len(bundles) == 1
    old = _bundle_state(bundles[0], ids["manos"], tmp_path / "inspect")
    assert "facets" in old["tables"]  # web mode: init_db ran before the backup
    assert old["user_version"] == 0  # ... but the rebuild ran after it
    assert old["fts"] == UNFOLDED_MANOS

    live = _state(db_path, ids["manos"])
    assert live["user_version"] == dbmod.FTS_INDEX_VERSION
    assert live["fts"][0] == "μανοσ χατζιδακισ"


# ---- flow 6 -----------------------------------------------------------------------------------------

def test_restored_bundles_migrate_at_next_startup_only_when_old(tmp_path, monkeypatch):
    import app.db as dbmod
    from app.services.backup import create_backup, restore_backup

    dataset, ids = _old_dataset(tmp_path / "data")
    manos = ids["manos"]
    with _launch(monkeypatch, profile="web", dataset=dataset) as (client, phase, root):
        assert "fts_rebuild" in phase
        assert client.patch(f"/api/tracks/{manos}/profile", json={"valence": 7}).status_code == 200
        assert client.post("/api/facets/presets/therapy").is_success
        (old_bundle,) = _bundles(root)

    # (2) A pre-migration bundle restored into a new directory migrates at its next startup.
    restored = restore_backup(old_bundle, tmp_path / "restored")
    restored_db = Path(restored) / "catalog.sqlite"
    assert _state(restored_db, manos)["user_version"] == 0
    with _launch(monkeypatch, profile="web", db_path=restored_db,
                 backup_dir=tmp_path / "restored-backups") as (client, phase, _root):
        assert "fts_rebuild" in phase
        assert _ids(client, "μανος") == {manos}
        r = client.get("/api/facets")
        assert r.status_code == 200 and r.json() == []
    assert _state(restored_db, manos)["user_version"] == dbmod.FTS_INDEX_VERSION

    # The original dataset catalog was not touched by the restore or its startup.
    with closing(sqlite3.connect(dataset.catalog_path)) as c:
        assert c.execute("SELECT valence FROM track_dj_profile WHERE track_id = ?", (manos,)).fetchone() == (7,)
        assert c.execute("SELECT name, category FROM tags WHERE id = ?", (ids["tag"],)).fetchone() == (LEGACY_TAG, "purpose")
        assert c.execute("SELECT count(*) FROM track_tags WHERE track_id = ? AND tag_id = ?",
                         (manos, ids["tag"])).fetchone() == (1,)
        assert c.execute("SELECT count(*) FROM facets WHERE key = 'purpose'").fetchone() == (1,)

    # (3) A bundle taken after the migration starts without another rebuild.
    migrated_bundle = create_backup(dataset.catalog_path, tmp_path / "manual-backups", identity_path=None)
    restored_after = restore_backup(migrated_bundle, tmp_path / "restored-after")
    with _launch(monkeypatch, profile="web", db_path=Path(restored_after) / "catalog.sqlite",
                 backup_dir=tmp_path / "restored-after-backups") as (client, phase, _root):
        assert "fts_rebuild" not in phase
        assert _ids(client, "μανος") == {manos}
        assert _ids(client, "valence:6-8") == {manos}
        assert _ids(client, "purpose:χαλαρωση") == {manos}
