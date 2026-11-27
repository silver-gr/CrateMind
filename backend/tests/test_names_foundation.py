"""«Καθαρά ονόματα», the foundation: the schema an old library gains at its first start, the switch's storage,
the pieces of names_store that are real before the lanes fill in the rest, and the mounted routes."""
from __future__ import annotations

import shutil
import sqlite3
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

import app.db as dbmod
from app.models import Job, NameDecision, Track, TrackDJProfile, TrackName
from app.services import names_store, names_switch
from app.services.schema_contract import EXCLUDED_VALUE_TABLES

RAW = {"raw_artist", "raw_title", "raw_album", "raw_track_no", "raw_state"}
ROUTES = {
    ("get", "/api/names/status"), ("post", "/api/names/switch"), ("post", "/api/names/run"),
    ("get", "/api/names/tracks/{track_id}"), ("get", "/api/names/questions"), ("get", "/api/names/answers"),
    ("post", "/api/names/answers"), ("post", "/api/names/answers/{decision_id}/undo"),
    ("post", "/api/names/tracks/{track_id}/correct"), ("post", "/api/names/accept"),
    ("post", "/api/names/acknowledge"), ("get", "/api/names/review"),
}


def _columns(session, table: str) -> set[str]:
    return {row[1] for row in session.exec(text(f"PRAGMA table_info({table})"))}


def _tables(session) -> set[str]:
    return {row[0] for row in session.exec(text("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')"))}


def test_an_old_library_gains_the_names_schema_and_keeps_its_data(db, tmp_path):
    track = Track(absolute_path="/lib/Zarvo - Tide.mp3", artist="Zarvo", title="Tide", bpm=148.0)
    db.add(track)
    db.commit()
    db.add(TrackDJProfile(track_id=track.id, energy=7))
    db.commit()
    # Take the database back to what a library made before this release holds.
    for column in sorted(RAW):
        db.exec(text(f"ALTER TABLE tracks DROP COLUMN {column}"))
    db.exec(text("DROP TABLE track_names"))
    db.exec(text("DROP TABLE name_decisions"))
    db.commit()
    assert not RAW & _columns(db, "tracks")
    path = db.get_bind().url.database
    old_copy = tmp_path / "old-copy.sqlite"
    db.exec(text("PRAGMA wal_checkpoint(TRUNCATE)"))
    shutil.copy(path, old_copy)
    assert dbmod.schema_pending(old_copy, None) is True  # so the launch takes its backup before the upgrade

    dbmod.init_db()
    dbmod.init_db()  # a second start changes nothing and does not raise

    assert RAW <= _columns(db, "tracks")
    assert {"name_decisions", "track_names", "ux_name_decisions_active_scope",
            "ux_name_decisions_active_track"} <= _tables(db)
    row = db.exec(text("SELECT artist, title, bpm, raw_artist, raw_state FROM tracks")).one()
    assert tuple(row) == ("Zarvo", "Tide", 148.0, None, None)  # nothing filled: only a scan reads raw tags
    assert db.exec(text("SELECT energy FROM track_dj_profile")).one()[0] == 7
    assert db.exec(text("SELECT COUNT(*) FROM name_decisions")).one()[0] == 0
    db.exec(text("PRAGMA wal_checkpoint(TRUNCATE)"))
    shutil.copy(path, old_copy)
    assert dbmod.schema_pending(old_copy, None) is False


def test_raw_columns_are_stored_but_never_serialized(db):
    track = Track(absolute_path="/lib/a.mp3", artist="Kelvaro", raw_artist="[Prog] Kelvaro", raw_title="Arc",
                  raw_album="", raw_track_no="4", raw_state="ok")
    db.add(track)
    db.commit()
    db.refresh(track)
    assert (track.raw_artist, track.raw_track_no, track.raw_state) == ("[Prog] Kelvaro", "4", "ok")
    assert not RAW & set(track.model_dump())
    assert not RAW & set(track.model_dump(mode="json"))


def test_name_rows_follow_their_track(db):
    track = Track(absolute_path="/lib/a.mp3")
    db.add(track)
    db.commit()
    db.add(NameDecision(kind="track", track_id=track.id, value="Kelvaro | Arc"))
    db.add(NameDecision(kind="spelling", scope="act:kelvaro", value="Kelvaro"))
    db.add(TrackName(track_id=track.id, artist="Kelvaro", title="Arc", status="hand"))
    db.commit()
    db.exec(text("DELETE FROM tracks WHERE id = :id").bindparams(id=track.id))
    db.commit()
    assert db.exec(text("SELECT COUNT(*) FROM track_names")).one()[0] == 0
    assert [row[0] for row in db.exec(text("SELECT kind FROM name_decisions"))] == ["spelling"]


def test_one_active_decision_per_scope_and_per_track(db):
    track = Track(absolute_path="/lib/a.mp3")
    db.add(track)
    db.commit()
    first = NameDecision(kind="spelling", scope="act:kelvaro", value="Kelvaro")
    db.add(first)
    db.add(NameDecision(kind="track", track_id=track.id, value="Kelvaro | Arc"))
    db.commit()
    for duplicate in (NameDecision(kind="spelling", scope="act:kelvaro", value="KELVARO"),
                      NameDecision(kind="track", track_id=track.id, value="Kelvaro | Bow")):
        db.add(duplicate)
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()
    first = db.get(NameDecision, first.id)
    first.revoked_at = first.created_at
    db.add(first)
    db.commit()
    db.add(NameDecision(kind="spelling", scope="act:kelvaro", value="KELVARO"))  # a revoked row frees its place
    db.commit()
    assert db.exec(text("SELECT COUNT(*) FROM name_decisions WHERE scope = 'act:kelvaro'")).one()[0] == 2


def test_the_switch_is_off_until_turned_and_keeps_its_history(db):
    assert names_switch.is_on(db) is False
    assert names_switch.set_on(db, False) is False  # already off: nothing written
    assert names_switch.set_on(db, True) is True
    assert names_switch.is_on(db) is True and names_switch.is_on() is True
    assert names_switch.set_on(db, True) is False
    assert names_switch.set_on(db, False) is True
    assert names_switch.is_on(db) is False
    rows = db.exec(text("SELECT value, revoked_at IS NULL FROM name_decisions WHERE kind = 'setting' ORDER BY id")).all()
    assert [tuple(row) for row in rows] == [("on", 0), ("off", 1)]


def test_the_switch_reads_off_from_a_database_without_the_table(tmp_path):
    from sqlalchemy import create_engine
    from sqlmodel import Session

    sqlite3.connect(tmp_path / "bare.sqlite").close()
    with Session(create_engine(f"sqlite:///{tmp_path / 'bare.sqlite'}")) as session:
        assert names_switch.is_on(session) is False


def test_loose_folder_words_are_settings_never_decisions(db):
    assert names_switch.add_loose_folder(db, " loosebin ") is True
    assert names_switch.add_loose_folder(db, "loosebin") is False
    assert names_switch.loose_folders(db) == ("loosebin",)
    assert names_switch.is_on(db) is False


@pytest.mark.parametrize("kind, options, cell, value", [
    ("spelling", ["A=Kelvaro", "B=KELVARO"], "B", "KELVARO"),
    ("spelling", ["A=Kelvaro"], "=KelVaro", "=KelVaro"),
    ("same_act", ["A=όχι, διαφορετικοί", "B=ναι, ο ίδιος"], "B", "yes"),
    ("same_act", ["A=όχι, διαφορετικοί", "B=ναι, ο ίδιος"], "A", "no"),
    ("bracket_word", ["A=x", "B=y", "C=z"], "C", "label"),
    ("album_credit", ["A=κάθε κομμάτι στον δικό του φάκελο", "B=Nobra & Dyvel"], "A", "none"),
    ("album_credit", ["A=κάθε κομμάτι στον δικό του φάκελο", "B=Nobra & Dyvel"], "B", "Nobra & Dyvel"),
    ("track", ["A=Velkro | Rise"], "=Velkro | Rise Up", "Velkro | Rise Up"),
    ("track", ["A=Velkro | Rise"], "A", "Velkro | Rise"),
])
def test_an_answer_becomes_the_decision_value_the_sheet_importer_gave(kind, options, cell, value):
    assert names_store.cell_value(kind, options, cell) == value


@pytest.mark.parametrize("kind, options, cell", [
    ("spelling", ["A=Kelvaro"], "C"), ("spelling", ["A=Kelvaro"], "="), ("track", ["A=x | y"], "=no bar"),
    ("same_act", ["A=n", "B=y"], "=yes"), ("bracket_word", ["A=x"], "=label"), ("spelling", ["A=Kelvaro"], "AB"),
])
def test_an_answer_outside_the_question_is_refused(kind, options, cell):
    with pytest.raises(names_store.BadAnswer):
        names_store.cell_value(kind, options, cell)


def test_the_run_record_is_one_cache_file_beside_the_catalog(db):
    assert names_store.read_run_record() is None
    names_store.write_run_record({"ruleset": names_store.engine_ruleset(), "open": [], "patterns": []})
    path = names_store.run_record_path()
    assert path == Path(db.get_bind().url.database).parent / "cache" / "names-run.json"
    assert names_store.read_run_record()["ruleset"].startswith("names-")
    path.write_text("{not json", encoding="utf-8")
    assert names_store.read_run_record() is None


def test_with_the_switch_off_nothing_is_queued_and_no_job_is_held_up(db, monkeypatch):
    from app.api import scan
    from app.jobs import worker

    assert names_store.request_run("scan") is False
    assert names_store.run_state()["state"] == "idle"
    seen = []
    monkeypatch.setattr(names_store, "yield_to", lambda kind: seen.append(kind) or False)
    db.add(Job(kind="names", status="running"))
    db.commit()
    monkeypatch.setattr(worker, "recover_orphan_jobs", lambda session: 0)
    assert scan._active_job(db) is None  # a names run never makes a scan or an analysis wait
    job = worker.create_job(db, "scan")
    assert seen == ["scan"] and scan._active_job(db).id == job.id
    worker.create_job(db, "names")
    assert seen == ["scan"]


def test_every_names_route_is_mounted(client):
    paths = client.get("/openapi.json").json()["paths"]
    mounted = {(method, path) for path, item in paths.items() for method in item}
    assert ROUTES <= mounted
    assert {path for _method, path in mounted if path.startswith("/api/names")} == {path for _m, path in ROUTES}


def test_bundles_carry_the_answers_and_leave_the_result_out():
    assert "track_names" in EXCLUDED_VALUE_TABLES
    assert "name_decisions" not in EXCLUDED_VALUE_TABLES
