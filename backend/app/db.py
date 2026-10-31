"""Database engine, schema init, FTS5 maintenance, and launch backup."""
from __future__ import annotations

import sqlite3
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Iterator

from sqlalchemy import event, text
from sqlmodel import Session, SQLModel, create_engine

from .config import get_settings
from . import models as _models  # noqa: F401 - ensure SQLModel metadata is registered

_settings = get_settings()
_engine = None


def get_engine():
    global _engine
    if _engine is None:
        _settings.ensure_dirs()
        url = f"sqlite:///{_settings.db_file}"
        _engine = create_engine(
            url,
            connect_args={"check_same_thread": False, "timeout": 30.0},
        )

        @event.listens_for(_engine, "connect")
        def _configure_sqlite_connection(dbapi_connection, _connection_record):
            from .services.musical_key import normalized_effective_key
            from .services.tempo import effective_bpm_values

            dbapi_connection.create_function(
                "cratemind_key", 2, normalized_effective_key, deterministic=True,
            )
            dbapi_connection.create_function(
                "cratemind_bpm", -1, effective_bpm_values, deterministic=True,
            )
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA busy_timeout=30000")
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()
    return _engine


def get_session() -> Iterator[Session]:
    # expire_on_commit=False: returned ORM objects stay readable after the
    # commits done inside a request (audit log, FTS reindex), so model_dump()
    # serialises real values instead of an expired empty __dict__.
    with Session(get_engine(), expire_on_commit=False) as session:
        yield session


FTS_SQL = """
CREATE VIRTUAL TABLE IF NOT EXISTS track_search USING fts5(
    artist, title, album, label, genre, comment, notes, tags
);
"""


def _ensure_columns(conn) -> None:
    """Add columns introduced after a DB was first created. SQLite's
    create_all() only creates missing TABLES, never missing columns, so new
    nullable columns on existing tables are added here. Idempotent."""
    existing = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(tracks)").all()}
    for name, ddl in (("created_time", "FLOAT"),):
        if name not in existing:
            conn.exec_driver_sql(f"ALTER TABLE tracks ADD COLUMN {name} {ddl}")


def init_db() -> None:
    """Create tables, FTS index, and pragmas. Idempotent."""
    engine = get_engine()
    SQLModel.metadata.create_all(engine)
    with engine.connect() as conn:
        conn.execute(text("PRAGMA journal_mode=WAL;"))
        conn.execute(text("PRAGMA foreign_keys=ON;"))
        conn.exec_driver_sql(FTS_SQL)
        _ensure_columns(conn)
        conn.commit()
    ensure_track_columns()


def ensure_track_columns() -> None:
    """Idempotently add post-launch Track columns to a pre-existing table.

    The repo has no Alembic; fresh DBs get these columns from metadata, but a
    DB created before a feature lands needs the ALTERs. Safe to call on every
    launch.
    """
    wanted = {
        "artist_normalized": "TEXT",
        "bpm_analyzed": "REAL",
        "bpm_analyzed_raw": "REAL",
        "bpm_analyzed_confidence": "REAL",
        "bpm_analyzed_method": "TEXT",
        "key_analyzed": "TEXT",
        "key_analyzed_confidence": "REAL",
        "analyzed_at": "TIMESTAMP",
        "analysis_error": "TEXT",
        "bpm_essentia": "REAL",
        "bpm_essentia_confidence": "REAL",
        "bpm_essentia_method": "TEXT",
        "essentia_analyzed_at": "TIMESTAMP",
        "essentia_error": "TEXT",
        "bpm_disagreement": "BOOLEAN",
        "bpm_disagreement_percent": "REAL",
        "bpm_reccobeats": "REAL",
        "reccobeats_track_id": "TEXT",
        "key_reccobeats": "TEXT",
        "reccobeats_source": "TEXT",
        "reccobeats_catalog_checked_at": "TIMESTAMP",
        "reccobeats_catalog_error": "TEXT",
        "reccobeats_analyzed_at": "TIMESTAMP",
        "reccobeats_error": "TEXT",
        "getsongbpm_song_id": "TEXT",
        "bpm_getsongbpm": "REAL",
        "key_getsongbpm": "TEXT",
        "getsongbpm_updated_at": "TIMESTAMP",
        "getsongbpm_error": "TEXT",
        "bpm_consensus": "REAL",
        "bpm_consensus_sources": "TEXT",
        "bpm_needs_review": "BOOLEAN",
        "cyanite_track_id": "TEXT",
        "cyanite_status": "TEXT",
        "bpm_cyanite": "REAL",
        "bpm_cyanite_range_adjusted": "REAL",
        "key_cyanite": "TEXT",
        "cyanite_updated_at": "TIMESTAMP",
        "cyanite_error": "TEXT",
    }
    engine = get_engine()
    with engine.connect() as conn:
        existing = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(tracks)")}
        for name, sqltype in wanted.items():
            if name not in existing:
                conn.exec_driver_sql(f"ALTER TABLE tracks ADD COLUMN {name} {sqltype}")
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_tracks_artist_normalized ON tracks (artist_normalized)"
        )
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_tracks_bpm_disagreement ON tracks (bpm_disagreement)"
        )
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_tracks_reccobeats_track_id ON tracks (reccobeats_track_id)"
        )
        conn.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_tracks_bpm_needs_review ON tracks (bpm_needs_review)"
        )
        conn.commit()


# Recorded in every launch-backup manifest. Startup has no data migrations
# today; BUMP THIS with any future startup data migration so the next launch
# takes one fresh backup before it runs.
STARTUP_MIGRATION_REVISION = 1
BACKUP_MAX_AGE = timedelta(hours=24)
# Filled by backup_on_launch, printed once per launch by the app lifespan.
launch_phase: dict = {}


def _index_key(index: dict) -> str:
    return repr((index["origin"], index["unique"], index["partial"], index["parts"], index["sql"]))


def _missing_schema(expected: dict, live: dict) -> bool:
    for name, table in expected["tables"].items():
        actual = live["tables"].get(name)
        if actual is None or set(table["columns"]) - set(actual["columns"]):
            return True
        have = {_index_key(index) for index in actual["indices"]}
        if any(_index_key(index) not in have for index in table["indices"]):
            return True
    return bool(set(expected["objects"]) - set(live["objects"]))


def schema_pending(catalog: Path, identity: Path | None) -> bool:
    """True if the live databases lack anything startup migrations would add.

    Compares object names (tables, columns, indices, triggers, views) against
    the schema contract, so column order and DDL spelling do not matter. Any
    failure to inspect counts as pending (the safe direction).
    """
    from .services.schema_contract import inspect_schema, load_schema_contract

    try:
        contract = load_schema_contract()
        if _missing_schema(contract["normalized_catalog_schema"], inspect_schema(catalog)):
            return True
        expected = contract["normalized_identity_schema"]
        return bool(expected and identity is not None
                    and _missing_schema(expected, inspect_schema(identity)))
    except Exception:
        return True


def _launch_skip_reason(root: Path, catalog: Path) -> tuple[str, Path | None]:
    """('reused', bundle) when the newest local bundle may stand in for a new
    one; otherwise (cause, None)."""
    from .services.backup import _AUTO_IDENTITY, _signature, _sources, verify_backup

    bundles = [b for b in sorted(root.glob("cratemind-*")) if b.is_dir() and not b.is_symlink()]
    if not bundles:
        return "no_bundle", None
    newest = bundles[-1]
    try:
        manifest = verify_backup(newest, deep=False)
        created = datetime.fromisoformat(manifest["created_at"])
        if created.tzinfo is None:
            return "unverified", None
        age = datetime.now(UTC) - created
        if not timedelta(0) <= age < BACKUP_MAX_AGE:
            return ("future" if age < timedelta(0) else "stale"), None
        sources = _sources(catalog, _AUTO_IDENTITY)
        if schema_pending(sources["catalog"], sources.get("identity")):
            return "schema_pending", None
        if manifest.get("migration_revision") != STARTUP_MIGRATION_REVISION:
            return "revision", None
        recorded = manifest.get("source_signatures")
        if manifest.get("identity_installed") != ("identity" in sources) \
                or not isinstance(recorded, dict) or set(recorded) != set(sources):
            return "identity", None
        for name, path in sources.items():
            if not isinstance(recorded[name], dict) or \
                    recorded[name].get("source_token") != _signature(path)["source_token"]:
                return "token", None
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
        return "unverified", None
    return "reused", newest


def backup_on_launch() -> Path | None:
    """Return a complete verified bundle directory; no-op before catalog exists.

    The Path return contract is retained; the durable path now identifies the
    catalog/identity/manifest unit rather than a main-database-only file.
    At most one new bundle per 24 h, but always a fresh deep-verified one when a
    schema or data migration could be pending.
    """
    if not _settings.db_file.exists():
        return None
    from .services.backup import backup_root_lock, create_backup, reclaim_backups

    started = time.perf_counter()
    root = Path(_settings.backup_path).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    timings: dict = {}
    with backup_root_lock(root):
        reason, bundle = _launch_skip_reason(root, _settings.db_file)
        launch_phase["decide"] = time.perf_counter() - started
        if bundle is not None:
            mark = time.perf_counter()
            reclaim_backups(root, _settings.backup_keep, bundle)
            timings["prune"] = time.perf_counter() - mark
    if bundle is None:
        bundle = create_backup(
            _settings.db_file, _settings.backup_path, keep=_settings.backup_keep,
            reuse=False, migration_revision=STARTUP_MIGRATION_REVISION, timings=timings,
        )
        reason = f"new:{reason}"
    launch_phase.update(backup=reason, **{k: timings.get(k, 0.0) for k in ("copy", "verify", "prune")})
    return bundle


# ---- FTS maintenance -------------------------------------------------------

def reindex_track(session: Session, track_id: int, *, commit: bool = True) -> None:
    """Rebuild the FTS row for one track from tracks + profile.notes + tags."""
    row = session.execute(
        text(
            """
            SELECT t.artist, t.title, t.album, t.label, t.genre, t.comment,
                   p.notes AS notes,
                   (SELECT group_concat(tg.name, ' ')
                      FROM track_tags tt JOIN tags tg ON tg.id = tt.tag_id
                     WHERE tt.track_id = t.id) AS tags
              FROM tracks t
              LEFT JOIN track_dj_profile p ON p.track_id = t.id
             WHERE t.id = :tid
            """
        ),
        {"tid": track_id},
    ).first()
    session.execute(
        text("DELETE FROM track_search WHERE rowid = :tid"), {"tid": track_id}
    )
    if row is None:
        if commit:
            session.commit()
        return
    session.execute(
        text(
            """
            INSERT INTO track_search
                (rowid, artist, title, album, label, genre, comment, notes, tags)
            VALUES (:tid, :artist, :title, :album, :label, :genre, :comment, :notes, :tags)
            """
        ),
        {
            "tid": track_id,
            "artist": row[0] or "",
            "title": row[1] or "",
            "album": row[2] or "",
            "label": row[3] or "",
            "genre": row[4] or "",
            "comment": row[5] or "",
            "notes": row[6] or "",
            "tags": row[7] or "",
        },
    )
    if commit:
        session.commit()


def reindex_all(session: Session) -> int:
    ids = session.execute(text("SELECT id FROM tracks")).all()
    for (tid,) in ids:
        reindex_track(session, tid)
    return len(ids)
