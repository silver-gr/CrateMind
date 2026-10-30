"""Database engine, schema init, FTS5 maintenance, and launch backup."""
from __future__ import annotations

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


def backup_on_launch() -> Path | None:
    """Return a complete verified bundle directory; no-op before catalog exists.

    The Path return contract is retained; the durable path now identifies the
    catalog/identity/manifest unit rather than a main-database-only file.
    """
    if not _settings.db_file.exists():
        return None
    from .services.backup import create_backup

    return create_backup(
        _settings.db_file, _settings.backup_path, keep=_settings.backup_keep,
    )


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
