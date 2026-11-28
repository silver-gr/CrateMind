"""«Καθαρά ονόματα», the store lane: the snapshot, the run that writes only differing rows, the input digest,
the «Άλλαξαν» rule, hand corrections from /names and /canonical, and the answers import. Every name is invented."""
from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from sqlmodel import select

from app.models import NameDecision, Track, TrackName
from app.services import names_show, names_store, names_switch


@pytest.fixture(autouse=True)
def quiet_queue(monkeypatch):
    """No test here starts the background queue or needs the show lane's reindex."""
    names_store._reset_queue()
    monkeypatch.setattr(names_store, "_ensure_dispatcher", lambda: None)
    calls: list = []
    monkeypatch.setattr(names_show, "reindex_changed",
                        lambda session, track_ids=None, *, commit=True: calls.append(list(track_ids or [])) or len(track_ids or []))
    yield calls
    names_store._reset_queue()


def add(db, tmp_path, rel: str, artist: str | None, title: str | None, *, state: str | None = "ok", stored=None,
        album: str = "", track_no: str = "", missing: bool = False, **more) -> Track:
    stored_artist, stored_title = stored or (artist, title)
    track = Track(absolute_path=str(tmp_path / "lib" / rel), file_name=rel.rsplit("/", 1)[-1], artist=stored_artist,
                  title=stored_title, missing=missing, raw_artist=artist if state == "ok" else None,
                  raw_title=title if state == "ok" else None, raw_album=album if state == "ok" else None,
                  raw_track_no=track_no if state == "ok" else None, raw_state=state, **more)
    db.add(track)
    db.commit()
    return track


def library(db, tmp_path) -> dict[str, Track]:
    return {
        "a": add(db, tmp_path, "Kelvaro/Tides/Kelvaro - Night Drift.mp3", "Kelvaro", "Night Drift"),
        "b": add(db, tmp_path, "Kelvaro/Tides/02.mp3", "KELVARO", "Slow Ember (Original Mix)"),
        "c": add(db, tmp_path, "Mirel Vant/A/01.mp3", "Mirel Vant", "Open Field"),
        "d": add(db, tmp_path, "glass harbor.mp3", "", "Glass Harbor"),
    }


def rows(db) -> dict[int, TrackName]:
    db.expire_all()
    return {row.track_id: row for row in db.exec(select(TrackName)).all()}


def decide(db, kind: str, value: str, *, scope: str = "", track: Track | None = None, source: str = "owner",
           **more) -> NameDecision:
    row = NameDecision(kind=kind, scope=scope, track_id=track.id if track else None, value=value, source=source, **more)
    db.add(row)
    db.commit()
    return row


# ---------------------------------------------------------------- snapshot
def test_the_snapshot_feeds_raw_tags_the_file_name_and_the_folder_under_the_library_root(db, tmp_path):
    t = library(db, tmp_path)
    b = add(db, tmp_path, "Mirel Vant/A/09.mp3", "Wrong Tag", "Wrong", stored=("Mirel Vant", "Low Sun"), album="A",
            track_no="9/12", bpm_grid=148.0, bpm_analyzed=147.6)
    outside = Track(absolute_path="/elsewhere/Downloads/x.mp3", file_name="x.mp3", raw_artist="Dorn Akesh",
                    raw_title="Far", raw_state="ok")
    db.add(outside)
    db.commit()
    snap = names_store.snapshot(db)
    by_id = {i.id: i for i in snap.inputs}
    assert (by_id[t["a"].id].artist, by_id[t["a"].id].title) == ("Kelvaro", "Night Drift")
    assert by_id[t["a"].id].file_name == "Kelvaro - Night Drift.mp3"
    assert by_id[t["a"].id].folder == "Kelvaro/Tides"
    assert by_id[t["d"].id].folder == ""  # a file at the root itself
    assert (by_id[b.id].artist, by_id[b.id].title, by_id[b.id].album, by_id[b.id].track_no) == ("Wrong Tag", "Wrong", "A", "9/12")
    assert (by_id[b.id].bpm_grid, by_id[b.id].bpm_analyzed) == (148.0, 147.6)
    assert by_id[outside.id].folder == "/elsewhere/Downloads"  # outside every root: its whole parent folder
    assert snap.cold and snap.references.spotify == () and by_id[b.id].links == ()
    # Today's shown name is the "shown before" input and the stored off value.
    assert snap.off[b.id] == ("Mirel Vant", "Low Sun")
    assert (by_id[b.id].previous_artist, by_id[b.id].previous_source_artist) == ("Mirel Vant", "scanner")
    assert snap.digest == names_store.input_digest(snap)


def test_unread_missing_and_unreadable_tracks(db, tmp_path):
    unread = add(db, tmp_path, "Kelvaro/x/1.mp3", None, None, state=None, stored=("Kelvaro", "Unread"))
    gone = add(db, tmp_path, "Kelvaro/x/2.mp3", "Kelvaro", "Gone", missing=True)
    broken = add(db, tmp_path, "Kelvaro/x/3.mp3", None, None, state="unreadable", stored=("Kelvaro", "Stored Title"))
    snap = names_store.snapshot(db)
    assert snap.unread == (unread.id,)
    assert [i.id for i in snap.inputs] == [broken.id]  # the unreadable file is fed its stored columns
    assert (snap.inputs[0].artist, snap.inputs[0].title, snap.inputs[0].track_no) == ("Kelvaro", "Stored Title", "")
    names_store.run(db)
    assert set(rows(db)) == {broken.id} and gone.id not in rows(db)


def test_a_track_whose_tags_were_never_read_gets_no_name_and_loses_an_old_one(db, tmp_path):
    t = library(db, tmp_path)
    names_store.run(db)
    assert t["a"].id in rows(db)
    db.exec(text("UPDATE tracks SET raw_state = NULL WHERE id = :id").bindparams(id=t["a"].id))
    db.commit()
    result = names_store.run(db)
    assert result.state == "done" and t["a"].id not in rows(db) and len(rows(db)) == 3


def test_settings_and_accept_rows_are_never_engine_decisions(db, tmp_path):
    t = library(db, tmp_path)
    names_switch.set_on(db, True)
    names_switch.add_loose_folder(db, "loose")
    decide(db, "accept", "Kelvaro | Night Drift | Kelvaro", track=t["a"])
    decide(db, "spelling", "=KelVaro", scope="act:kelvaro", key_version=names_store.engine_key_version())
    snap = names_store.snapshot(db)
    assert [(d.kind, d.scope, d.value) for d in snap.decisions] == [("spelling", "act:kelvaro", "=KelVaro")]
    assert snap.references.loose_folders == ("loose",)
    assert snap.accepted == {t["a"].id: "Kelvaro | Night Drift | Kelvaro"}


# ---------------------------------------------------------------- the run
def test_a_run_stores_the_engine_result_and_a_second_run_writes_nothing(db, tmp_path, quiet_queue):
    t = library(db, tmp_path)
    first = names_store.run(db, cause="manual")
    stored = rows(db)
    assert first.state == "done" and first.written == 4 and len(stored) == 4
    b = stored[t["b"].id]
    assert (b.artist, b.title, b.folder, b.status, b.ruleset) == ("Kelvaro", "Slow Ember", "Kelvaro", "sure", names_store.engine_ruleset())
    assert b.rules.split() and {w[0] for w in json.loads(b.why_json)} <= set(b.rules.split())
    assert all(len(w) == 3 and w[2] for w in json.loads(b.why_json))
    assert (b.off_artist, b.off_title) and b.prev_artist is None and b.changed_at is None
    facts = json.loads(b.facts_json)
    assert {"tempo", "notes", "remixers", "album_credit", "acts"} <= set(facts)
    assert facts["acts"][0] == {"name": "Kelvaro", "key": "kelvaro", "role": "primary"}
    none = stored[t["d"].id]
    assert (none.status, none.artist, none.title) == ("none", "", "Glass Harbor") and none.folder  # the folder keeps the placeholder
    assert quiet_queue == []  # the switch is off: no reindex

    record = names_store.read_run_record()
    assert record["state"] == "done" and record["written"] == 4 and record["refusal"] is None
    assert record["counts"] == {"sure": 3, "look": 0, "open": 0, "none": 1, "hand": 0} == first.counts
    assert record["ruleset"] == names_store.engine_ruleset() and record["input_digest"] and record["open"] == []
    assert [p["scope"] for p in record["patterns"]] == ["status:none"]  # the one pattern question this library raises
    assert record["cause"] == "manual" and record["reach"] == {}

    before = db.exec(text("SELECT total_changes()")).one()[0]
    second = names_store.run(db, cause="launch")
    assert second.state == "unchanged" and second.written == 0
    assert db.exec(text("SELECT total_changes()")).one()[0] == before
    again = names_store.read_run_record()
    assert again["state"] == "unchanged" and again["cause"] == "launch" and again["written"] == 4
    assert again["input_digest"] == record["input_digest"] and again["started_at"] == record["started_at"]


def test_a_run_without_its_record_compares_and_writes_only_what_differs(db, tmp_path):
    t = library(db, tmp_path)
    names_store.run(db)
    names_store.run_record_path().unlink()
    assert names_store.run(db).written == 0  # the rows are all there and equal
    db.exec(text("DELETE FROM track_names WHERE track_id = :id").bindparams(id=t["c"].id))
    db.commit()
    result = names_store.run(db)  # the record's digest matches, the table does not: a real run
    assert result.state == "done" and result.written == 1 and len(rows(db)) == 4


def test_the_digest_follows_every_input(db, tmp_path):
    t = library(db, tmp_path)
    base = names_store.snapshot(db, with_off=False)
    assert base.off == {} and base.digest == names_store.snapshot(db).digest  # the same with or without the off names

    def digest_after(statement: str, **params) -> str:
        db.exec(text(statement).bindparams(**params))
        db.commit()
        return names_store.snapshot(db, with_off=False).digest

    seen = {base.digest}
    for statement in ("UPDATE tracks SET raw_title = 'Night Drift II' WHERE id = :id",
                      "UPDATE tracks SET raw_track_no = '3' WHERE id = :id",
                      "UPDATE tracks SET title = 'Stored Otherwise' WHERE id = :id",
                      "UPDATE tracks SET bpm_grid = 150.0 WHERE id = :id",
                      "UPDATE tracks SET file_name = 'renamed.mp3' WHERE id = :id"):
        seen.add(digest_after(statement, id=t["a"].id))
    decide(db, "spelling", "=KelVaro", scope="act:kelvaro")
    seen.add(names_store.snapshot(db, with_off=False).digest)
    names_switch.add_loose_folder(db, "loose")
    seen.add(names_store.snapshot(db, with_off=False).digest)
    decide(db, "accept", "x | y | z", track=t["c"])
    seen.add(names_store.snapshot(db, with_off=False).digest)
    assert len(seen) == 9
    # What a run never reads leaves it alone.
    assert digest_after("UPDATE tracks SET genre = 'Forest' WHERE id = :id", id=t["a"].id) == names_store.snapshot(db, with_off=False).digest
    names_switch.set_on(db, True)
    assert names_store.snapshot(db, with_off=False).digest in seen


def test_changed_rows_keep_the_first_previous_value_until_it_returns(db, tmp_path, quiet_queue):
    t = library(db, tmp_path)
    names_switch.set_on(db, True)
    names_store.run(db)
    quiet_queue.clear()
    first = decide(db, "track", "Kelvaro Prime | Night Drift (Live)", track=t["a"])
    result = names_store.run(db, cause=f"decision:{first.id}")
    a = rows(db)[t["a"].id]
    assert (a.artist, a.title, a.status) == ("Kelvaro Prime", "Night Drift (Live)", "hand")
    assert (a.prev_artist, a.prev_title, a.prev_folder) == ("Kelvaro", "Night Drift", "Kelvaro")
    assert a.changed_cause == f"decision:{first.id}" and a.changed_at is not None
    assert result.reach == {str(first.id): 1} and names_store.read_run_record()["reach"] == {str(first.id): 1}
    assert quiet_queue == [[t["a"].id]]  # the switch is on: only the renamed row is reindexed
    assert rows(db)[t["b"].id].prev_artist is None  # a row that did not change has no previous value
    stamp = a.changed_at

    first.revoked_at = datetime.now(UTC)
    db.add(first)
    db.flush()
    second = decide(db, "track", "Kelvaro Second | Night Drift", track=t["a"])
    names_store.run(db, cause="scan")
    a = rows(db)[t["a"].id]
    assert a.artist == "Kelvaro Second"
    assert (a.prev_artist, a.prev_title, a.changed_cause, a.changed_at) == ("Kelvaro", "Night Drift", f"decision:{first.id}", stamp)
    assert names_store.read_run_record()["reach"] == {str(first.id): 1}  # another cause leaves earlier reach in place

    second.revoked_at = datetime.now(UTC)
    db.add(second)
    db.commit()
    names_store.run(db, cause="links")
    a = rows(db)[t["a"].id]
    assert (a.artist, a.title, a.status) == ("Kelvaro", "Night Drift", "sure")
    assert a.prev_artist is None and a.prev_title is None and a.prev_folder is None
    assert a.changed_at is None and a.changed_cause is None


def test_the_folder_that_follows_an_own_correction_is_not_a_change(db, tmp_path):
    from app.services import names_decisions

    t = library(db, tmp_path)
    names_store.run(db)
    before = rows(db)[t["d"].id].folder
    names_decisions.correct(db, t["d"].id, "Corvo Lent", "Glass Harbor")
    result = names_store.run(db, cause="decision:1")
    row = rows(db)[t["d"].id]
    assert (row.artist, row.status) == ("Corvo Lent", "hand") and row.folder != before
    assert (row.prev_artist, row.prev_title, row.prev_folder, row.changed_at) == (None, None, None, None)
    assert result.reach == {"1": 0}


@pytest.mark.parametrize("cause,stored", [("scan", "scan"), ("links", "links"), ("analysis", "analysis"),
                                           ("launch", "other"), ("manual", "other"), ("switch", "other"),
                                           ("import", "other"), ("decision:7", "decision:7")])
def test_the_cause_of_a_change(cause, stored):
    assert names_store._changed_cause(cause, "names-8", "names-8") == stored
    assert names_store._changed_cause(cause, "names-7", "names-8") == "ruleset:names-7→names-8"
    assert names_store._changed_cause(cause, "", "names-8") == stored


def test_a_new_ruleset_names_itself_as_the_cause(db, tmp_path):
    t = library(db, tmp_path)
    names_store.run(db)
    db.exec(text("UPDATE track_names SET ruleset = 'names-0', artist = 'Old Kelvaro' WHERE track_id = :id").bindparams(id=t["a"].id))
    db.commit()
    names_store.run_record_path().unlink()
    names_store.run(db, cause="launch")
    a = rows(db)[t["a"].id]
    assert a.changed_cause == f"ruleset:names-0→{names_store.engine_ruleset()}" and a.prev_artist == "Old Kelvaro"


def test_a_key_version_mismatch_writes_nothing_and_says_so(db, tmp_path):
    t = library(db, tmp_path)
    names_store.run(db)
    before = names_store.read_run_record()
    stale = decide(db, "spelling", "=KelVaro", scope="act:kelvaro", key_version=names_store.engine_key_version() - 1)
    changes = db.exec(text("SELECT total_changes()")).one()[0]
    result = names_store.run(db, cause="manual")
    assert result.state == "refused" and result.written == 0
    assert db.exec(text("SELECT total_changes()")).one()[0] == changes
    assert rows(db)[t["a"].id].artist == "Kelvaro"
    record = names_store.read_run_record()
    assert (record["state"], record["refusal"]) == ("refused", "key_version")
    assert record["counts"] == before["counts"] and record["input_digest"] == before["input_digest"]
    assert names_store.snapshot(db, with_off=False).stale_key_decisions == (stale.id,)
    # The same answer written with the engine's version applies.
    stale.revoked_at = datetime.now(UTC)
    db.add(stale)
    db.flush()
    decide(db, "spelling", "=KelVaro", scope="act:kelvaro", key_version=names_store.engine_key_version())
    assert names_store.run(db).state == "done" and rows(db)[t["a"].id].artist == "KelVaro"
    assert names_store.read_run_record()["refusal"] is None


@pytest.mark.parametrize("stop_at", [1, 2, 3, 4])
def test_a_cancelled_run_writes_nothing(db, tmp_path, stop_at):
    library(db, tmp_path)
    asked = []

    def cancelled() -> bool:
        asked.append(1)
        return len(asked) >= stop_at

    result = names_store.run(db, cancelled=cancelled)
    assert result.state == "cancelled" and len(asked) == stop_at
    assert rows(db) == {} and names_store.read_run_record() is None


def test_a_failed_run_leaves_the_last_rows(db, tmp_path, monkeypatch):
    t = library(db, tmp_path)
    names_store.run(db)
    decide(db, "track", "Kelvaro Prime | Night Drift", track=t["a"])
    from app.services import names

    monkeypatch.setattr(names, "resolve", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    with pytest.raises(RuntimeError):
        names_store.run(db)
    db.rollback()
    assert rows(db)[t["a"].id].artist == "Kelvaro" and names_store.read_run_record()["state"] == "done"


def test_decisions_are_inputs_a_run_never_changes(db, tmp_path):
    t = library(db, tmp_path)
    decide(db, "track", "Kelvaro Prime | Night Drift", track=t["a"])
    decide(db, "spelling", "=MIREL VANT", scope="act:mirelvant", key_version=names_store.engine_key_version(), provisional=True)
    before = [row.model_dump() for row in db.exec(select(NameDecision).order_by(NameDecision.id)).all()]
    names_store.run(db)
    names_store.run(db, cause="scan")
    db.expire_all()
    assert [row.model_dump() for row in db.exec(select(NameDecision).order_by(NameDecision.id)).all()] == before
    assert rows(db)[t["a"].id].status == "hand"


def test_an_accepted_look_row_stays_accepted_only_while_its_value_stands(db, tmp_path):
    names_switch.add_loose_folder(db, "none-such")
    look = add(db, tmp_path, "loose/glass harbor.mp3", "", "Glass Harbor")  # the folder is the only evidence: «Για ματιά»
    names_store.run(db)
    row = rows(db)[look.id]
    assert row.status == "look" and row.accepted is False
    accept = decide(db, "accept", names_store.accept_value(row.artist, row.title, row.folder), track=look)
    names_store.run(db, cause=f"decision:{accept.id}")
    assert rows(db)[look.id].accepted is True
    assert names_store.read_run_record()["reach"] == {str(accept.id): 0}  # no name changed
    db.exec(text("UPDATE tracks SET raw_title = 'Glass Harbour' WHERE id = :id").bindparams(id=look.id))
    db.commit()
    names_store.run(db, cause="scan")
    row = rows(db)[look.id]
    assert row.title == "Glass Harbour" and row.accepted is False and row.prev_title == "Glass Harbor"
    assert row.changed_cause == "scan"


def test_the_pattern_questions_and_open_items_go_into_the_record(db, tmp_path, monkeypatch):
    library(db, tmp_path)
    from app.services.names import questions

    seen = {}

    def fake(resolution, inputs, decisions):
        seen["args"] = (resolution.ruleset, len(inputs), len(decisions))
        return [{"kind": "preference", "scope": "pref:invented", "question": "Ερώτηση;", "options": ["A=ναι", "B=όχι"],
                 "recommended": "A", "why": "Γιατί", "tracks": [1]}]

    monkeypatch.setattr(questions, "pattern_questions", fake)
    names_store.run(db)
    assert seen["args"] == (names_store.engine_ruleset(), 4, 0)
    assert names_store.read_run_record()["patterns"][0]["scope"] == "pref:invented"


# ---------------------------------------------------------------- the identity library
IDENTITY_SCHEMA = """
CREATE TABLE entities(id TEXT PRIMARY KEY,service TEXT NOT NULL,title TEXT,artist TEXT,duration_ms REAL,
 local_track_id INTEGER,permalink TEXT,recording_id TEXT,status TEXT NOT NULL,
 metadata_json TEXT NOT NULL,normalized_json TEXT NOT NULL);
CREATE TABLE canonical_recordings(recording_id TEXT PRIMARY KEY,title TEXT,artist TEXT,version TEXT,release TEXT,
 state TEXT NOT NULL,proposal_json TEXT NOT NULL,evidence_json TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE canonical_events(id INTEGER PRIMARY KEY,recording_id TEXT,action TEXT NOT NULL,before_json TEXT,
 after_json TEXT,created_at TEXT NOT NULL);
"""


class Identity:
    """A hand-built identity library beside the test catalog."""

    def __init__(self, path):
        self.path = path
        with sqlite3.connect(path) as db:
            db.executescript(IDENTITY_SCHEMA)

    def execute(self, sql: str, args: tuple = ()) -> None:
        with sqlite3.connect(self.path) as db:
            db.execute(sql, args)

    def local(self, track: Track, recording: str) -> None:
        self.execute("INSERT INTO entities VALUES (?,?,?,?,NULL,?,NULL,?,'ACCEPTED',?,'{}')",
                     (f"local:{track.id}", "local", track.title, track.artist, track.id, recording,
                      json.dumps({"catalog_current": 1})))

    def remote(self, entity_id: str, service: str, artist: str, title: str, recording: str, *, normalized=None,
               metadata=None) -> None:
        self.execute("INSERT INTO entities VALUES (?,?,?,?,NULL,NULL,NULL,?,'ACCEPTED',?,?)",
                     (entity_id, service, title, artist, recording, json.dumps(metadata or {}),
                      json.dumps(normalized or {})))

    def state(self, recording: str, state: str, artist: str, title: str) -> None:
        self.execute("INSERT OR REPLACE INTO canonical_recordings VALUES (?,?,?,NULL,NULL,?,'{}','{}','2026-01-01')",
                     (recording, title, artist, state))

    def event(self, recording: str, action: str, at: datetime, artist: str = "", title: str = "") -> int:
        with sqlite3.connect(self.path) as db:
            cursor = db.execute("INSERT INTO canonical_events(recording_id,action,after_json,created_at) VALUES (?,?,?,?)",
                                (recording, action, json.dumps({"artist": artist, "title": title}), at.isoformat()))
            return cursor.lastrowid


@pytest.fixture
def identity(db, tmp_path, monkeypatch):
    path = tmp_path / "identity.sqlite"
    monkeypatch.setenv("CRATEMIND_IDENTITY_DB_PATH", str(path))
    return Identity(path)


def test_links_and_references_come_from_the_identity_library(db, tmp_path, identity):
    t = library(db, tmp_path)
    identity.local(t["a"], "rec:a")
    identity.remote("spotify:track:1", "spotify", "Kelvaro, Dorn Akesh", "Night Drift", "rec:a",
                    metadata={"artist_uris": "u1,u2"})
    identity.remote("soundcloud:tracks:2", "soundcloud", "uploader-account", "Kelvaro - Night Drift", "rec:a",
                    normalized={"artist": "Kelvaro", "uploader": "uploader-account"})
    identity.remote("soundcloud:tracks:3", "soundcloud", "x", "Retired Copy", "rec:a",
                    metadata={"asset_lifecycle": {"state": "retired"}})
    identity.remote("spotify:track:9", "spotify", "Mirel Vant", "Unlinked Song", "rec:z")
    identity.state("rec:a", "derived", "Kelvaro", "Night Drift")
    snap = names_store.snapshot(db)
    assert snap.cold is False
    links = {i.id: i.links for i in snap.inputs}[t["a"].id]
    assert [(l.service, l.artists, l.title, l.uploader) for l in links] == [
        ("soundcloud", ("Kelvaro",), "Kelvaro - Night Drift", "uploader-account"),
        ("spotify", ("Kelvaro", "Dorn Akesh"), "Night Drift", "")]  # the retired record is no link
    assert {i.id: i.links for i in snap.inputs}[t["c"].id] == ()
    assert dict(snap.references.spotify) == {"Kelvaro": 1, "Dorn Akesh": 1, "Mirel Vant": 1}
    assert dict(snap.references.sc_publisher) == {"Kelvaro": 1}
    assert sum(dict(snap.references.titles).values()) == 4 and max(dict(snap.references.titles).values()) == 2
    # A changed remote record changes the digest; an unchanged library does not.
    assert names_store.snapshot(db, with_off=False).digest == snap.digest
    identity.execute("UPDATE entities SET title = 'Night Drift (Edit)' WHERE id = 'spotify:track:1'")
    assert names_store.snapshot(db, with_off=False).digest != snap.digest


def test_a_cold_library_still_gets_names(db, tmp_path, monkeypatch):
    t = library(db, tmp_path)
    monkeypatch.setenv("CRATEMIND_IDENTITY_DB_PATH", str(tmp_path / "absent.sqlite"))
    assert names_store.snapshot(db).cold is True
    assert names_store.run(db).state == "done" and rows(db)[t["a"].id].artist == "Kelvaro"


def test_a_failed_identity_read_fails_the_run_and_keeps_the_last_rows(db, tmp_path, identity, monkeypatch):
    """Only a missing file or entities table is a cold library: any other read error is not stored as names."""
    from app.services import canonical_library

    t = library(db, tmp_path)
    identity.local(t["a"], "rec:a")
    names_store.run(db)
    identity.execute("UPDATE entities SET title = 'Night Drift (Edit)' WHERE id = ?", (f"local:{t['a'].id}",))
    available = canonical_library.available
    monkeypatch.setattr(canonical_library, "available", lambda db: (_ for _ in ()).throw(sqlite3.OperationalError("locked")))
    with pytest.raises(sqlite3.OperationalError):  # the switch-off projection may not answer without the overlay
        names_store.run(db)
    db.rollback()
    monkeypatch.setattr(canonical_library, "available", available)
    identity.path.write_bytes(b"not a database")  # the identity read itself
    with pytest.raises(sqlite3.DatabaseError):
        names_store.run(db)
    db.rollback()
    assert rows(db)[t["a"].id].artist == "Kelvaro" and names_store.read_run_record()["state"] == "done"


def test_a_rejected_or_kept_local_recording_gives_its_track_no_links(db, tmp_path, identity):
    t = library(db, tmp_path)
    for key, state in (("a", "rejected"), ("b", "kept_local"), ("c", "review")):
        identity.local(t[key], f"rec:{key}")
        identity.remote(f"spotify:track:{key}", "spotify", "Other Name", "Other Title", f"rec:{key}")
        identity.state(f"rec:{key}", state, "Other Name", "Other Title")
    links = {i.id: i.links for i in names_store.snapshot(db).inputs}
    assert links[t["a"].id] == () and links[t["b"].id] == () and len(links[t["c"].id]) == 1


def test_a_canonical_accept_is_a_hand_name_built_each_run_and_never_stored(db, tmp_path, identity):
    t = library(db, tmp_path)
    identity.local(t["a"], "rec:a")
    identity.state("rec:a", "human", "Kelvaro & Dorn Akesh", "Night Drift")
    identity.event("rec:a", "accept", datetime.now(UTC))
    names_store.run(db)
    a = rows(db)[t["a"].id]
    assert (a.artist, a.title, a.status) == ("Kelvaro & Dorn Akesh", "Night Drift", "hand")
    assert db.exec(select(NameDecision)).all() == []
    snap = names_store.snapshot(db, with_off=False)
    assert snap.decision_ids[("track", f"track:{t['a'].id}")] is None
    # The state is taken back on /canonical: the next run follows.
    identity.state("rec:a", "review", "Kelvaro", "Night Drift")
    names_store.run(db, cause="links")
    assert rows(db)[t["a"].id].status == "sure" and rows(db)[t["a"].id].artist == "Kelvaro"


def test_the_latest_explicit_action_wins_between_names_and_canonical(db, tmp_path, identity):
    t = library(db, tmp_path)
    now = datetime.now(UTC)
    identity.local(t["a"], "rec:a")
    identity.state("rec:a", "human", "Accepted Name", "Night Drift")
    identity.event("rec:a", "accept", now)
    own = decide(db, "track", "Earlier Correction | Night Drift", track=t["a"], created_at=now - timedelta(hours=1))
    names_store.run(db)
    assert rows(db)[t["a"].id].artist == "Accepted Name"  # the accept is later
    assert db.get(NameDecision, own.id).revoked_at is None  # and the run revoked nothing
    own.revoked_at = now
    db.add(own)
    db.flush()
    decide(db, "track", "Later Correction | Night Drift", track=t["a"], created_at=now + timedelta(hours=1))
    names_store.run(db)
    assert rows(db)[t["a"].id].artist == "Later Correction"


def test_a_canonical_pattern_accept_never_hides_a_hand_correction(db, tmp_path, identity):
    t = library(db, tmp_path)
    now = datetime.now(UTC)
    for key in ("a", "c"):
        identity.local(t[key], f"rec:{key}")
        identity.state(f"rec:{key}", "human", "Pattern Name", t[key].title)
        identity.event(f"rec:{key}", "bulk_accept", now)
    decide(db, "track", "Own Correction | Night Drift", track=t["a"], created_at=now - timedelta(hours=1))
    names_store.run(db)
    assert rows(db)[t["a"].id].artist == "Own Correction"  # the later bulk accept does not outrank it
    assert rows(db)[t["c"].id].artist == "Pattern Name"  # and still names a track without a correction


def test_a_canonical_edit_becomes_a_track_decision_once(db, tmp_path, identity):
    t = library(db, tmp_path)
    twin = add(db, tmp_path, "Kelvaro/Tides/copy.mp3", "Kelvaro", "Night Drift")
    now = datetime.now(UTC)
    own = decide(db, "track", "Own Correction | Night Drift", track=t["a"], created_at=now - timedelta(hours=1))
    identity.local(t["a"], "rec:a")
    identity.local(twin, "rec:a")
    identity.state("rec:a", "human", "Edited Name", "Night Drift (Edit)")
    event = identity.event("rec:a", "edit", now, "Edited Name", "Night Drift (Edit)")
    assert names_store.copy_canonical_edits(db, "rec:a") == 2
    copies = db.exec(select(NameDecision).where(NameDecision.source == "canonical").order_by(NameDecision.track_id)).all()
    assert [(c.kind, c.scope, c.track_id, c.value, c.canonical_event_id, c.revoked_at) for c in copies] == [
        ("track", "", t["a"].id, "Edited Name | Night Drift (Edit)", event, None),
        ("track", "", twin.id, "Edited Name | Night Drift (Edit)", event, None)]
    db.refresh(own)
    assert own.revoked_at is not None  # replaced, kept as a revoked row
    assert names_store.copy_canonical_edits(db) == 0  # once
    names_store.run(db)
    assert {rows(db)[i].artist for i in (t["a"].id, twin.id)} == {"Edited Name"}
    assert rows(db)[t["a"].id].status == "hand" and rows(db)[t["a"].id].title == "Night Drift (Edit)"

    # Undone here (revoked): the run never recreates it, and the track falls back to the engine.
    for copy in copies:
        copy.revoked_at = datetime.now(UTC)
        db.add(copy)
    db.commit()
    names_store.run(db)
    assert db.exec(select(NameDecision).where(NameDecision.revoked_at.is_(None))).all() == []
    assert rows(db)[t["a"].id].artist == "Kelvaro"


def test_a_run_copies_an_edit_whose_catalog_write_was_lost(db, tmp_path, identity):
    t = library(db, tmp_path)
    identity.local(t["a"], "rec:a")
    identity.state("rec:a", "human", "Edited Name", "Night Drift")
    event = identity.event("rec:a", "edit", datetime.now(UTC), "Edited Name", "Night Drift")
    names_store.run(db)  # the route's own copy never happened
    copy = db.exec(select(NameDecision)).one()
    assert (copy.source, copy.canonical_event_id, copy.track_id) == ("canonical", event, t["a"].id)
    assert rows(db)[t["a"].id].artist == "Edited Name"
    assert names_store.snapshot(db, with_off=False).decision_ids[("track", f"track:{t['a'].id}")] == copy.id


def test_an_edit_older_than_the_owners_correction_does_not_replace_it(db, tmp_path, identity):
    t = library(db, tmp_path)
    now = datetime.now(UTC)
    identity.local(t["a"], "rec:a")
    identity.state("rec:a", "human", "Edited Name", "Night Drift")
    identity.event("rec:a", "edit", now - timedelta(hours=2), "Edited Name", "Night Drift")
    own = decide(db, "track", "Own Later | Night Drift", track=t["a"], created_at=now)
    names_store.run(db)
    assert db.get(NameDecision, own.id).revoked_at is None and rows(db)[t["a"].id].artist == "Own Later"


def test_a_stored_edit_copy_stops_counting_when_canonical_moves_on(db, tmp_path, identity):
    t = library(db, tmp_path)
    now = datetime.now(UTC)
    identity.local(t["a"], "rec:a")
    identity.state("rec:a", "human", "Edited Name", "Night Drift")
    identity.event("rec:a", "edit", now - timedelta(hours=1), "Edited Name", "Night Drift")
    names_store.run(db)
    assert rows(db)[t["a"].id].artist == "Edited Name"
    # A later accept of another proposal on /canonical is now the recording's state.
    identity.state("rec:a", "human", "Accepted After", "Night Drift")
    identity.event("rec:a", "accept", now)
    names_store.run(db, cause="links")
    assert rows(db)[t["a"].id].artist == "Accepted After"
    # And when the recording is no longer hand-made at all, the copy is ignored (its row stays, untouched).
    identity.state("rec:a", "derived", "Kelvaro", "Night Drift")
    names_store.run(db, cause="links")
    assert rows(db)[t["a"].id].artist == "Kelvaro"
    assert db.exec(select(NameDecision)).one().revoked_at is None


def test_record_canonical_edit_skips_unknown_tracks_and_repeats(db, tmp_path):
    t = library(db, tmp_path)
    assert names_store.record_canonical_edit(db, 41, [t["a"].id, 999999], "Edited Name", "Title") == 1
    assert names_store.record_canonical_edit(db, 41, [t["a"].id], "Edited Name", "Title") == 0
    assert names_store.record_canonical_edit(db, 42, [t["a"].id], "Edited Again", "Title") == 1
    active = db.exec(select(NameDecision).where(NameDecision.revoked_at.is_(None))).all()
    assert [(d.value, d.canonical_event_id) for d in active] == [("Edited Again | Title", 42)]
    assert len(db.exec(select(NameDecision)).all()) == 2


def test_decisions_follow_their_track_through_a_merge_and_a_rescan(db, tmp_path):
    from app.services import scanner

    t = library(db, tmp_path)
    decide(db, "track", "Kelvaro Prime | Night Drift", track=t["a"])
    # A rescan rewrites the stored and the raw columns; the decision is not the scanner's to touch.
    db.exec(text("UPDATE tracks SET artist = 'Rescanned', raw_artist = 'Rescanned' WHERE id = :id").bindparams(id=t["a"].id))
    db.commit()
    names_store.run(db)
    assert rows(db)[t["a"].id].artist == "Kelvaro Prime"
    # The file moves: its row is merged into the new row, and the correction goes with it.
    new = add(db, tmp_path, "Elsewhere/Kelvaro - Night Drift.mp3", "Kelvaro", "Night Drift")
    db.exec(text("UPDATE tracks SET missing = 1 WHERE id = :id").bindparams(id=t["a"].id))
    db.commit()
    scanner.merge_tracks(db, [(t["a"].id, new.id)], reason="test")
    db.commit()
    names_store.run(db, cause="links")
    assert rows(db)[new.id].artist == "Kelvaro Prime" and rows(db)[new.id].status == "hand"


def test_a_merge_of_two_corrected_rows_revokes_the_old_answer_and_keeps_it(db, tmp_path):
    from app.services import scanner

    t = library(db, tmp_path)
    old = decide(db, "track", "Kelvaro Old | Night Drift", track=t["a"])
    new = add(db, tmp_path, "Elsewhere/Kelvaro - Night Drift.mp3", "Kelvaro", "Night Drift")
    mine = decide(db, "track", "Kelvaro Mine | Night Drift", track=new)
    db.exec(text("UPDATE tracks SET missing = 1 WHERE id = :id").bindparams(id=t["a"].id))
    db.commit()
    scanner.merge_tracks(db, [(t["a"].id, new.id)], reason="test")
    db.commit()
    db.expire_all()
    kept = {d.id: (d.track_id, d.revoked_at is None) for d in db.exec(select(NameDecision)).all()}
    assert kept == {old.id: (new.id, False), mine.id: (new.id, True)}


# ---------------------------------------------------------------- the answers import
ANSWERS = {"answers": [
    {"scope": "status:none", "answer": "A", "date": "x"},
    {"scope": "pref:invented_rule", "answer": "B", "date": "x"},
    {"scope": "pair:similar_names", "answer": "B", "date": "x"},
    {"scope": "pref:skipped", "answer": "pass", "date": "x"},
    {"scope": "note:remember", "answer": "A", "date": "x"},
    {"scope": "pair:zarvo|zarvoh", "answer": "same", "date": "x", "provisional": True},
    {"scope": "pair:mirelvant|mirelvent", "answer": "same", "date": "x", "into": "mirelvant"},
    {"scope": "pair:dornakesh|dornakash", "answer": "different", "date": "x"},
    {"scope": "name:tidal records", "answer": "A", "date": "x"},
    {"scope": "name:glass", "answer": "B", "date": "x"},
]}


def seeds(track: Track) -> list[dict]:
    return [
        {"kind": "spelling", "scope": "act:kelvaro", "options": "A=Kelvaro ‖ B=KELVARO", "απόφαση": "=KelVaro", "source": "sheet"},
        {"kind": "spelling", "scope": "act:mirelvant", "options": "A=Mirel Vant ‖ B=MIREL VANT", "απόφαση": "B", "source": "sheet"},
        {"kind": "bracket_word", "scope": "word:forest", "options": "A=κράτα ‖ B=είδος ‖ C=δισκογραφική", "απόφαση": "B", "source": "sheet"},
        {"kind": "album_credit", "scope": "album:tides", "options": "A=κανένας ‖ B=Kelvaro", "απόφαση": "A", "source": "sheet"},
        {"kind": "track", "scope": f"track:{track.id}", "options": "", "απόφαση": "=Kelvaro Prime | Night Drift", "source": "sheet"},
        {"kind": "spelling", "scope": "act:unanswered", "options": "A=x", "απόφαση": "", "source": "sheet"},
    ]


def test_the_import_maps_answers_and_seeds_as_the_preview_did(db, tmp_path):
    t = library(db, tmp_path)
    version = names_store.engine_key_version()
    preview = names_store.import_answers(db, ANSWERS, seeds(t["a"]), ("loose",), dry_run=True)
    assert preview == {"added": 13, "skipped": 0, "rejected": []} and db.exec(select(NameDecision)).all() == []
    assert names_store.import_answers(db, ANSWERS, seeds(t["a"]), ("loose",)) == preview
    stored = {(d.kind, d.scope, d.track_id): d for d in db.exec(select(NameDecision)).all()}
    values = {key: (d.value, d.source, d.provisional, d.key_version) for key, d in stored.items()}
    assert values[("spelling", "act:kelvaro", None)] == ("=KelVaro", "seed", False, version)
    assert values[("spelling", "act:mirelvant", None)] == ("MIREL VANT", "seed", False, version)
    assert values[("bracket_word", "word:forest", None)] == ("genre", "seed", False, None)
    assert values[("album_credit", "album:tides", None)] == ("none", "seed", False, None)
    assert values[("track", "", t["a"].id)] == ("Kelvaro Prime | Night Drift", "seed", False, None)
    assert values[("preference", "status:none", None)] == ("A", "owner", False, None)
    assert values[("same_act", "pair:zarvo|zarvoh", None)] == ("yes", "owner", True, version)
    assert values[("same_act", "pair:mirelvent|mirelvant", None)] == ("yes", "owner", False, version)
    assert values[("same_act", "pair:dornakesh|dornakash", None)] == ("no", "owner", False, version)
    assert values[("not_act", "name:tidal records", None)] == ("label", "owner", False, None)
    assert values[("not_act", "name:glass", None)] == ("no", "owner", False, None)
    assert values[("setting", "loose_folder:loose", None)] == ("loose", "owner", False, None)
    assert len(values) == 13 and names_switch.loose_folders(db) == ("loose",)
    # The engine receives them: the spelling, the hand correction, the loose-folder word.
    names_store.run(db)
    assert rows(db)[t["a"].id].status == "hand" and rows(db)[t["b"].id].artist == "KelVaro"
    assert rows(db)[t["c"].id].artist == "MIREL VANT"


def test_a_second_import_and_an_undone_answer_are_left_alone(db, tmp_path):
    t = library(db, tmp_path)
    names_store.import_answers(db, ANSWERS, seeds(t["a"]))
    undone = db.exec(select(NameDecision).where(NameDecision.scope == "act:kelvaro")).one()
    undone.revoked_at = datetime.now(UTC)
    db.add(undone)
    db.commit()
    again = names_store.import_answers(db, ANSWERS, seeds(t["a"]), ("loose",))
    assert again == {"added": 1, "skipped": 12, "rejected": []}  # only the new loose-folder word
    assert db.exec(select(NameDecision).where(NameDecision.scope == "act:kelvaro")).one().revoked_at is not None


def test_the_import_lists_what_it_refuses_and_uses_none_of_it(db, tmp_path):
    t = library(db, tmp_path)
    bad = [
        {"kind": "spelling", "scope": "act:kelvaro", "options": "A=Kelvaro", "απόφαση": "Z"},
        {"kind": "track", "scope": f"track:{t['a'].id}", "options": "", "απόφαση": "=No Separator"},
        {"kind": "track", "scope": "track:999999", "options": "", "απόφαση": "=A | B"},
        {"kind": "same_act", "scope": "pair:a|b", "options": "A=όχι ‖ B=ναι", "απόφαση": "=typed"},
        {"kind": "setting", "scope": "switch", "options": "A=on", "απόφαση": "A"},
        {"kind": "spelling", "scope": "act:mirelvant", "options": "A=Mirel Vant", "απόφαση": "A"},
    ]
    result = names_store.import_answers(db, {"answers": [{"scope": "odd:scope", "answer": "A"}]}, bad)
    assert result["added"] == 1 and len(result["rejected"]) == 6
    assert [(d.kind, d.scope) for d in db.exec(select(NameDecision)).all()] == [("spelling", "act:mirelvant")]
    assert names_switch.is_on(db) is False
