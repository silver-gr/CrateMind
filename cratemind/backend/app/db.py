"""Database engine, schema init, FTS5 maintenance, and launch backup."""
from __future__ import annotations

import shutil
from datetime import datetime
from pathlib import Path
from typing import Iterator

from sqlalchemy import text
from sqlmodel import Session, SQLModel, create_engine

from .config import get_settings

_settings = get_settings()
_engine = None


def get_engine():
    global _engine
    if _engine is None:
        _settings.ensure_dirs()
        url = f"sqlite:///{_settings.db_file}"
        _engine = create_engine(url, connect_args={"check_same_thread": False})
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
    """Idempotently add audio-analysis columns to a pre-existing tracks table.

    The repo has no Alembic; fresh DBs get these columns from
    SQLModel.metadata.create_all, but a DB created before this feature needs the
    ALTERs. Safe to call on every launch.
    """
    wanted = {
        "bpm_analyzed": "REAL",
        "bpm_analyzed_raw": "REAL",
        "bpm_analyzed_confidence": "REAL",
        "bpm_analyzed_method": "TEXT",
        "key_analyzed": "TEXT",
        "key_analyzed_confidence": "REAL",
        "analyzed_at": "TIMESTAMP",
        "analysis_error": "TEXT",
    }
    engine = get_engine()
    with engine.connect() as conn:
        existing = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(tracks)")}
        for name, sqltype in wanted.items():
            if name not in existing:
                conn.exec_driver_sql(f"ALTER TABLE tracks ADD COLUMN {name} {sqltype}")
        conn.commit()


def backup_on_launch() -> Path | None:
    """Snapshot the DB to backups/ and prune to the last N. No-op if DB absent."""
    db = _settings.db_file
    if not db.exists():
        return None
    stamp = datetime.now().strftime("%Y-%m-%d-%H%M%S")
    dest = _settings.backup_path / f"cratemind-{stamp}.sqlite"
    shutil.copy2(db, dest)
    backups = sorted(_settings.backup_path.glob("cratemind-*.sqlite"))
    keep = max(1, _settings.backup_keep)
    for old in backups[:-keep]:
        try:
            old.unlink()
        except OSError:
            pass
    return dest


# ---- FTS maintenance -------------------------------------------------------

def reindex_track(session: Session, track_id: int) -> None:
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
    session.commit()


def reindex_all(session: Session) -> int:
    ids = session.execute(text("SELECT id FROM tracks")).all()
    for (tid,) in ids:
        reindex_track(session, tid)
    return len(ids)
