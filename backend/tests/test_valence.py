"""Valence axis and the facets table."""
from __future__ import annotations

import sqlite3

from sqlalchemy import create_engine, text
from sqlmodel import Session

from app.models import Track


def test_ensure_columns_adds_valence_to_pre_valence_database(tmp_path):
    from app.db import _ensure_columns

    path = tmp_path / "old.sqlite"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE track_dj_profile(track_id integer primary key, energy integer)")
    engine = create_engine(f"sqlite:///{path}")
    for _ in range(2):
        with engine.connect() as conn:
            _ensure_columns(conn, "track_dj_profile", {"valence": "INTEGER"})
            conn.commit()
    with engine.connect() as conn:
        columns = {row[1] for row in conn.exec_driver_sql("PRAGMA table_info(track_dj_profile)")}
    engine.dispose()
    assert "valence" in columns


def test_profile_valence_round_trip(client):
    import app.db as dbmod

    with Session(dbmod.get_engine()) as session:
        tagged, plain = Track(absolute_path="/a.mp3", title="A"), Track(absolute_path="/b.mp3", title="B")
        session.add_all([tagged, plain])
        session.commit()
        tagged_id, plain_id = tagged.id, plain.id

    r = client.patch(f"/api/tracks/{tagged_id}/profile", json={"valence": 7})
    assert r.status_code == 200, r.text
    assert r.json()["valence"] == 7
    assert client.patch(f"/api/tracks/{tagged_id}/profile", json={"valence": 11}).status_code == 422
    rows = {row["id"]: row for row in client.get("/api/tracks").json()}
    assert rows[tagged_id]["valence"] == 7
    assert rows[plain_id]["valence"] is None


def test_init_db_creates_facets_table(db):
    assert db.execute(text("SELECT name FROM sqlite_master WHERE type='table' AND name='facets'")).first()
