"""First-launch rebuild of the FTS index with folded text, in one transaction."""
from __future__ import annotations

import asyncio
import os
import sqlite3
from pathlib import Path

import pytest
from sqlalchemy import event, insert, text

import app.db as dbmod
from app.models import Track


def _unfolded(db, n: int) -> list[int]:
    """n tracks whose FTS rows hold raw, unfolded text, and user_version 0."""
    ids = []
    for i in range(n):
        t = Track(absolute_path=f"/m/{i}.mp3", artist="Μάνος", title="Μάνος" if i == 0 else f"Τίτλος {i}")
        db.add(t)
        db.commit()
        ids.append(t.id)
    db.execute(text("DELETE FROM track_search"))
    for tid in ids:
        db.execute(text("INSERT INTO track_search (rowid, artist, title) VALUES (:id, 'Μάνος', 'Μάνος')"), {"id": tid})
    db.execute(text("PRAGMA user_version = 0"))
    db.commit()
    return ids


def _user_version() -> int:
    with dbmod.get_engine().connect() as c:
        return c.exec_driver_sql("PRAGMA user_version").scalar_one()


def _fts_titles() -> list[str]:
    with dbmod.get_engine().connect() as c:
        return [r[0] for r in c.exec_driver_sql("SELECT title FROM track_search ORDER BY rowid")]


def test_marker_set_and_idempotent(db, monkeypatch):
    ids = _unfolded(db, 3)
    result = dbmod.migrate_fts_index()
    assert result["rebuilt"] is True and result["tracks"] == 3
    assert _user_version() == dbmod.FTS_INDEX_VERSION
    with dbmod.get_engine().connect() as c:
        assert c.exec_driver_sql("SELECT title FROM track_search WHERE rowid = ?", (ids[0],)).scalar_one() == "μανοσ"

    calls = []
    monkeypatch.setattr(dbmod, "reindex_all", lambda *a, **k: calls.append(1) or 0)
    assert dbmod.migrate_fts_index()["rebuilt"] is False
    assert calls == []


def test_rebuild_is_one_transaction(db):
    _unfolded(db, 20)
    commits = []
    engine = dbmod.get_engine()
    listener = lambda _conn: commits.append(1)  # noqa: E731
    event.listen(engine, "commit", listener)
    try:
        assert dbmod.migrate_fts_index()["rebuilt"] is True
    finally:
        event.remove(engine, "commit", listener)
    assert len(commits) == 1


def test_failed_rebuild_rolls_back_rows_and_marker(db, monkeypatch):
    _unfolded(db, 5)
    before = _fts_titles()
    real = dbmod.reindex_track
    calls = []

    def flaky(session, track_id, **kwargs):
        calls.append(track_id)
        if len(calls) == 3:
            raise RuntimeError("boom")
        return real(session, track_id, **kwargs)

    monkeypatch.setattr(dbmod, "reindex_track", flaky)
    with pytest.raises(RuntimeError):
        dbmod.migrate_fts_index()
    assert _user_version() == 0
    assert _fts_titles() == before


def test_revision_bumped():
    assert dbmod.STARTUP_MIGRATION_REVISION >= 2


def _wrap(monkeypatch, events, name, label, call_real=True):
    real = getattr(dbmod, name)

    def wrapper(*args, **kwargs):
        events.append(label)
        return real(*args, **kwargs) if call_real else None

    monkeypatch.setattr(dbmod, name, wrapper)


def _dataset_app(tmp_path, monkeypatch, profile):
    import app.config as cfg
    from app.library_exchange.operations import initialize_empty

    for name in ("CRATEMIND_DB_PATH", "CRATEMIND_IDENTITY_DB_PATH", "CRATEMIND_BACKUP_DIR", "CRATEMIND_OUTPUT_DIR"):
        monkeypatch.delenv(name, raising=False)
    dataset = initialize_empty(tmp_path / "data")
    monkeypatch.setenv("CRATEMIND_DATASET_ROOT", str(dataset.dataset_root))
    monkeypatch.setenv("CRATEMIND_RUNTIME_PROFILE", profile)
    cfg.get_settings.cache_clear()
    monkeypatch.setattr(dbmod, "_engine", None)
    monkeypatch.setattr(dbmod, "_settings", cfg.get_settings())
    return dataset


@pytest.mark.parametrize("mode", ["web", "desktop-core", "no-dataset"])
def test_startup_order(tmp_path, monkeypatch, mode, request):
    events: list[str] = []
    if mode == "no-dataset":
        request.getfixturevalue("db")
        from app import app_factory
        from app.main import app

        monkeypatch.setattr(dbmod, "init_db", lambda: events.append("init"))
        monkeypatch.setattr(dbmod, "backup_on_launch", lambda: events.append("backup"))
        monkeypatch.setattr(dbmod, "migrate_fts_index", lambda: events.append("migrate"))

        async def startup():
            async with app_factory.lifespan(app):
                pass

        asyncio.run(startup())
        assert events == ["init", "backup", "migrate"]
        return

    import app.config as cfg
    from fastapi.testclient import TestClient
    from app.app_factory import create_app

    _dataset_app(tmp_path, monkeypatch, mode)
    _wrap(monkeypatch, events, "backup_on_launch", "backup")
    _wrap(monkeypatch, events, "init_db", "init_db")
    _wrap(monkeypatch, events, "migrate_fts_index", "migrate")
    with TestClient(create_app()) as client:
        assert client.get("/api/health").status_code == 200
    dbmod.get_engine().dispose()
    cfg.get_settings.cache_clear()
    assert events == ["backup", "init_db", "migrate"]


def test_old_db_backed_up_before_reindex(tmp_path, monkeypatch):
    import app.config as cfg
    from fastapi.testclient import TestClient
    from app.app_factory import create_app

    dataset = _dataset_app(tmp_path, monkeypatch, "desktop-core")
    with sqlite3.connect(dataset.catalog_path) as connection:
        connection.execute(
            "INSERT INTO tracks (id, absolute_path, normalized_path, file_name, extension, play_count,"
            " imported_at, last_scanned_at, missing, title) VALUES (1, '/a.mp3', '', '', '', 0,"
            " '2026-01-01', '2026-01-01', 0, 'Μάνος')"
        )
        connection.execute("INSERT INTO track_search (rowid, title) VALUES (1, 'Μάνος')")
        connection.execute("PRAGMA user_version = 0")
        connection.commit()

    bundles = []
    real_backup = dbmod.backup_on_launch

    def backup():
        bundle = real_backup()
        bundles.append(bundle)
        return bundle

    monkeypatch.setattr(dbmod, "backup_on_launch", backup)
    with TestClient(create_app()) as client:
        assert client.get("/api/health").status_code == 200
    dbmod.get_engine().dispose()
    cfg.get_settings.cache_clear()

    assert dbmod.launch_phase["backup"].startswith("new:")
    assert "fts_rebuild" in dbmod.launch_phase
    with sqlite3.connect(Path(bundles[0]) / "catalog.sqlite") as connection:
        assert connection.execute("SELECT title FROM track_search WHERE rowid = 1").fetchone()[0] == "Μάνος"
    with sqlite3.connect(dataset.catalog_path) as connection:
        assert connection.execute("SELECT title FROM track_search WHERE rowid = 1").fetchone()[0] == "μανοσ"


def test_rebuild_timing(db):
    n = int(os.environ.get("CM_FTS_BENCH_TRACKS", "2000"))
    db.execute(insert(Track), [
        {"absolute_path": f"/bench/{i}.mp3", "artist": f"Καλλιτέχνης {i % 500}",
         "title": f"Τραγούδι {i}", "album": "Άλμπουμ", "genre": "Έντεχνο"}
        for i in range(n)
    ])
    db.execute(text("PRAGMA user_version = 0"))
    db.commit()
    result = dbmod.migrate_fts_index()
    s = result["seconds"]
    assert result["tracks"] == n
    print(f"fts_rebuild tracks={n} seconds={s:.1f}")
    assert s < 300
