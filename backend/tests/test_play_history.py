"""Play history: recorded plays, delete and save-as-set touch only CrateMind's
own play_events, play stats, sets and audit rows."""
from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlmodel import Session, select

from app.models import AuditLog, PlayEvent, SetTrack, Track


def _make(name: str = "a", **values) -> int:
    from app.db import get_engine

    with Session(get_engine(), expire_on_commit=False) as session:
        track = Track(absolute_path=f"/x/{name}.wav", file_name=f"{name}.wav", title=name, **values)
        session.add(track)
        session.commit()
        return track.id


def _track(track_id: int) -> Track:
    from app.db import get_engine

    with Session(get_engine(), expire_on_commit=False) as session:
        return session.get(Track, track_id)


def _iso(value: datetime) -> str:
    return value.isoformat()


def _create(client, track_id, start, seconds=40.0, deck="A", end=None):
    return client.post("/api/history/plays", json={
        "track_id": track_id, "deck": deck, "started_at": _iso(start),
        "ended_at": _iso(end or start + timedelta(seconds=seconds)), "played_seconds": seconds})


def _parse(value: str) -> datetime:
    return datetime.fromisoformat(value)


def test_create_logs_play_and_bumps_stats(client):
    tid = _make()
    start = datetime.now(UTC) - timedelta(minutes=5)
    r = _create(client, tid, start)
    assert r.status_code == 200, r.text
    play = r.json()
    assert set(play) == {"id", "track_id", "set_id", "deck", "played_at", "ended_at", "played_seconds", "context"}
    assert (play["track_id"], play["deck"], play["played_seconds"], play["set_id"]) == (tid, "A", 40.0, None)
    assert _parse(play["played_at"]) == start
    assert _parse(play["ended_at"]) == start + timedelta(seconds=40)
    track = _track(tid)
    assert track.play_count == 1
    assert track.last_played_at == start

    # An older play counts but does not move last_played_at back.
    assert _create(client, tid, start - timedelta(days=1), deck="B").status_code == 200
    track = _track(tid)
    assert (track.play_count, track.last_played_at) == (2, start)


def test_create_clamps_times_and_validates(client):
    tid = _make()
    now = datetime.now(UTC)
    # A start in the future becomes now; an end before the start becomes the start.
    future = _create(client, tid, now + timedelta(hours=1), end=now + timedelta(hours=2)).json()
    assert _parse(future["played_at"]) <= datetime.now(UTC)
    assert _parse(future["ended_at"]) == _parse(future["played_at"])
    early = _create(client, tid, now - timedelta(minutes=1), end=now - timedelta(minutes=2)).json()
    assert early["ended_at"] == early["played_at"]

    assert _create(client, 9999, now).status_code == 404
    assert _create(client, tid, now, deck="C").status_code == 422
    assert _create(client, tid, now, seconds=-1).status_code == 422
    naive = {"track_id": tid, "deck": "A", "started_at": "2026-11-17T10:00:00",
             "ended_at": "2026-11-17T10:01:00", "played_seconds": 60}
    assert client.post("/api/history/plays", json=naive).status_code == 422
    # Missing seconds (a browser's JSON.stringify turns Infinity/NaN into null) are rejected.
    assert client.post("/api/history/plays", json={**naive, "started_at": _iso(now), "ended_at": _iso(now),
                                                   "played_seconds": None}).status_code == 422
    assert _track(tid).play_count == 2


def test_update_is_monotonic_and_keeps_counts(client):
    tid = _make()
    start = datetime.now(UTC) - timedelta(minutes=10)
    play = _create(client, tid, start, seconds=30).json()

    r = client.post(f"/api/history/plays/{play['id']}", json={
        "track_id": tid, "ended_at": _iso(start + timedelta(seconds=90)), "played_seconds": 90})
    assert r.status_code == 200, r.text
    assert (r.json()["played_seconds"], _parse(r.json()["ended_at"])) == (90, start + timedelta(seconds=90))
    assert "track" not in r.json()

    # A late, smaller update never shrinks the play.
    stale = client.post(f"/api/history/plays/{play['id']}", json={
        "track_id": tid, "ended_at": _iso(start + timedelta(seconds=60)), "played_seconds": 60}).json()
    assert (stale["played_seconds"], _parse(stale["ended_at"])) == (90, start + timedelta(seconds=90))
    # An end in the future is clamped to now.
    later = client.post(f"/api/history/plays/{play['id']}", json={
        "track_id": tid, "ended_at": _iso(datetime.now(UTC) + timedelta(hours=1)), "played_seconds": 100}).json()
    assert _parse(later["ended_at"]) <= datetime.now(UTC)
    assert _track(tid).play_count == 1

    other = _make("b")
    body = {"track_id": other, "ended_at": _iso(start), "played_seconds": 1}
    assert client.post(f"/api/history/plays/{play['id']}", json=body).status_code == 404
    assert client.post("/api/history/plays/9999", json={**body, "track_id": tid}).status_code == 404


def test_delete_recomputes_stats_and_audits(client):
    a, b = _make("a"), _make("b")
    base = datetime.now(UTC) - timedelta(hours=2)
    p1 = _create(client, a, base).json()["id"]
    p2 = _create(client, a, base + timedelta(minutes=10)).json()["id"]
    p3 = _create(client, b, base + timedelta(minutes=20)).json()["id"]

    r = client.post("/api/history/delete", json={"ids": [p2, p2, p3, 9999]})
    assert r.status_code == 200, r.text
    assert r.json() == {"deleted": 2}
    ta, tb = _track(a), _track(b)
    assert (ta.play_count, ta.last_played_at) == (1, base)
    assert (tb.play_count, tb.last_played_at) == (0, None)

    from app.db import get_engine

    with Session(get_engine(), expire_on_commit=False) as session:
        audits = session.exec(select(AuditLog).where(AuditLog.action == "history.delete")).all()
        # A count already below the rows deleted floors at 0.
        track = session.get(Track, a)
        track.play_count = 0
        session.add(track)
        session.commit()
    assert len(audits) == 1 and audits[0].entity_type == "play_event"
    assert sorted(row["id"] for row in json.loads(audits[0].before_json)["deleted"]) == [p2, p3]

    assert client.post("/api/history/delete", json={"ids": [p1]}).json() == {"deleted": 1}
    assert (_track(a).play_count, _track(a).last_played_at) == (0, None)
    # Nothing deleted: no audit row.
    assert client.post("/api/history/delete", json={"ids": [p1]}).json() == {"deleted": 0}
    with Session(get_engine()) as session:
        assert len(session.exec(select(AuditLog).where(AuditLog.action == "history.delete")).all()) == 2
    assert client.post("/api/history/delete", json={"ids": list(range(1001))}).status_code == 422


def test_list_orders_pages_and_overlays_tracks(client):
    a, b = _make("a", bpm=145.0), _make("b")
    # Fixed times on one date: raw text order (' ' < 'T') would put the adopted row first.
    base = datetime(2026, 11, 10, 12, 0, tzinfo=UTC)
    early = _create(client, a, base).json()["id"]
    # Set-logged rows share one played_at.
    dj_set = client.post("/api/sets", json={"title": "live"}).json()
    client.post(f"/api/sets/{dj_set['id']}/tracks", json={"track_id": a})
    client.post(f"/api/sets/{dj_set['id']}/tracks", json={"track_id": b})
    client.post(f"/api/sets/{dj_set['id']}/tracks", json={"track_id": b})
    assert client.post(f"/api/sets/{dj_set['id']}/log-play", json={}).status_code == 200
    from app.db import get_engine

    with Session(get_engine()) as session:
        set_rows = session.exec(select(PlayEvent.id).where(PlayEvent.set_id == dj_set["id"])).all()
        # An adopted row stored in the 'T…Z' text form, an hour before `early`, still sorts by its time.
        session.execute(text("INSERT INTO play_events (track_id, played_at) VALUES (:t, :p)"),
                        {"t": b, "p": (base - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")})
        session.commit()
        adopted = session.exec(select(PlayEvent.id).order_by(PlayEvent.id.desc())).first()
    assert len(set_rows) == 3

    full = client.get("/api/history").json()
    ids = [p["id"] for p in full["plays"]]
    assert ids == sorted(set_rows, reverse=True) + [early, adopted]
    assert full["has_more"] is False
    first = full["plays"][-2]
    assert first["deck"] == "A" and first["track"]["id"] == a and first["track"]["bpm"] == 145.0
    assert "original_title" in first["track"]  # canonical overlay ran
    assert full["plays"][0]["deck"] is None and full["plays"][0]["set_id"] == dj_set["id"]

    # Paging one at a time through rows with equal played_at skips and repeats nothing.
    seen, before = [], None
    while True:
        page = client.get("/api/history", params={"limit": 1, **({"before_id": before} if before else {})}).json()
        seen += [p["id"] for p in page["plays"]]
        if not page["has_more"]:
            break
        before = seen[-1]
    assert seen == ids
    assert client.get("/api/history", params={"before_id": 9999}).status_code == 404
    assert client.get("/api/history", params={"limit": 0}).status_code == 422


def test_save_set_orders_and_dedupes(client):
    a, b, c = _make("a"), _make("b"), _make("c")
    base = datetime.now(UTC) - timedelta(hours=1)
    pb = _create(client, b, base + timedelta(minutes=5)).json()["id"]
    pa = _create(client, a, base).json()["id"]
    pa2 = _create(client, a, base + timedelta(minutes=10)).json()["id"]
    pc = _create(client, c, base + timedelta(minutes=15)).json()["id"]

    r = client.post("/api/history/save-set", json={"play_ids": [pc, pa2, pb, pa, 9999], "title": "  Session  "})
    assert r.status_code == 200, r.text
    assert r.json()["track_count"] == 3
    saved = client.get(f"/api/sets/{r.json()['set_id']}").json()
    assert saved["set"]["title"] == "Session"
    assert [row["track"]["id"] for row in saved["tracks"]] == [a, b, c]

    from app.db import get_engine

    with Session(get_engine()) as session:
        before = len(session.exec(select(SetTrack)).all())
    assert client.post("/api/history/save-set", json={"play_ids": [9999], "title": "x"}).status_code == 422
    assert client.post("/api/history/save-set", json={"play_ids": [], "title": "x"}).status_code == 422
    assert client.post("/api/history/save-set", json={"play_ids": [pa], "title": "   "}).status_code == 422
    with Session(get_engine()) as session:
        assert len(session.exec(select(SetTrack)).all()) == before
    assert len(client.get("/api/sets").json()) == 1


def test_init_db_adds_columns_to_old_play_events(tmp_path, monkeypatch):
    path = tmp_path / "old.sqlite"
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE play_events (id INTEGER PRIMARY KEY, track_id INTEGER NOT NULL, set_id INTEGER,"
                     " played_at DATETIME, context VARCHAR, crowd_reaction INTEGER, notes VARCHAR)")
        conn.execute("INSERT INTO play_events (track_id, played_at) VALUES (1, '2026-01-01 10:00:00')")
    monkeypatch.setenv("CRATEMIND_DB_PATH", str(path))
    monkeypatch.setenv("CRATEMIND_BACKUP_DIR", str(tmp_path / "bk"))
    monkeypatch.setenv("CRATEMIND_OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("CRATEMIND_LIBRARY_ROOTS", str(tmp_path / "lib"))
    import app.config as cfg
    import app.db as dbmod

    cfg.get_settings.cache_clear()
    dbmod._engine = None
    dbmod._settings = cfg.get_settings()
    try:
        dbmod.init_db()
        dbmod.init_db()  # idempotent
        with Session(dbmod.get_engine()) as session:
            event = session.exec(select(PlayEvent)).one()
        assert (event.deck, event.ended_at, event.played_seconds) == (None, None, None)
    finally:
        dbmod.get_engine().dispose()
        dbmod._engine = None
    with sqlite3.connect(path) as conn:
        columns = {row[1]: row[2] for row in conn.execute("PRAGMA table_info(play_events)")}
    assert (columns["deck"], columns["ended_at"], columns["played_seconds"]) == ("TEXT", "DATETIME", "FLOAT")


def test_desktop_core_history_routes(tmp_path):
    script = '''
from datetime import UTC, datetime, timedelta
from app.config import get_settings, Settings
get_settings.cache_clear()
import app.config
app.config.get_settings = lambda: Settings(_env_file=None)
from fastapi.testclient import TestClient
from sqlmodel import Session
from app.app_factory import create_app
from app.models import Track
app = create_app("desktop-core")
with TestClient(app) as client:
    from app.db import get_engine
    with Session(get_engine(), expire_on_commit=False) as session:
        track = Track(absolute_path="/x/d.wav", file_name="d.wav")
        session.add(track)
        session.commit()
    start = datetime.now(UTC) - timedelta(minutes=1)
    play = client.post("/api/history/plays", json={"track_id": track.id, "deck": "B",
        "started_at": start.isoformat(), "ended_at": start.isoformat(), "played_seconds": 30})
    assert play.status_code == 200, play.text
    pid = play.json()["id"]
    up = client.post(f"/api/history/plays/{pid}", json={"track_id": track.id,
        "ended_at": datetime.now(UTC).isoformat(), "played_seconds": 45})
    assert up.status_code == 200, up.text
    listed = client.get("/api/history")
    assert listed.status_code == 200 and [p["id"] for p in listed.json()["plays"]] == [pid], listed.text
    saved = client.post("/api/history/save-set", json={"play_ids": [pid], "title": "s"})
    assert saved.status_code == 200 and saved.json()["track_count"] == 1, saved.text
    gone = client.post("/api/history/delete", json={"ids": [pid]})
    assert gone.status_code == 200 and gone.json() == {"deleted": 1}, gone.text
'''
    env = {k: v for k, v in os.environ.items() if not k.startswith("CRATEMIND_")}
    env.update(CRATEMIND_DB_PATH=str(tmp_path / "catalog.sqlite"),
               CRATEMIND_BACKUP_DIR=str(tmp_path / "backups"),
               CRATEMIND_OUTPUT_DIR=str(tmp_path / "out"),
               CRATEMIND_LIBRARY_ROOTS=str(tmp_path / "lib"),
               CRATEMIND_RUNTIME_PROFILE="desktop-core")
    result = subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, text=True,
                            check=False)
    assert result.returncode == 0, result.stderr
