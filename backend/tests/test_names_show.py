"""«Καθαρά ονόματα», what the app shows: the overlay step, the search index and tokens, the status, the switch
and one track's why. Every name here is invented; the names job (store lane) is replaced by hand-written
`track_names` rows and a hand-written run record."""
from __future__ import annotations

import copy
import json
from contextlib import nullcontext
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text

from app.db import reindex_all, reindex_track
from app.models import NameDecision, Track, TrackDJProfile, TrackName
from app.services import canonical_library, identity_library, names_show, names_store, names_switch, search

from .test_stabilization import catalog


def _track(db, artist, title, *, raw_state="ok", missing=False, **extra) -> Track:
    track = Track(absolute_path=f"/lib/{artist} - {title} {len(artist + title)}.mp3",
                  file_name=f"{artist} - {title}.mp3", artist=artist, title=title, missing=missing, **extra)
    track.raw_artist, track.raw_title, track.raw_state = artist, title, raw_state
    db.add(track)
    db.commit()
    return track


def _name(db, track, artist, title, status="sure", **extra) -> TrackName:
    row = TrackName(track_id=track.id, artist=artist, title=title, folder=artist or "Unknown Artist",
                    status=status, off_artist=track.artist or "", off_title=track.title or "",
                    ruleset="names-test", **extra)
    db.add(row)
    db.commit()
    return row


def _dump(track) -> dict:
    return track.model_dump(mode="json")


def _ids(db, query) -> list[int]:
    return sorted(t.id for t in search.search(db, query))


@pytest.fixture
def no_run(monkeypatch):
    """The store lane's queue is not built here: record what was asked for."""
    asked = []
    monkeypatch.setattr(names_store, "request_run", lambda cause, *, force=False: asked.append((cause, force)) or True)
    return asked


# ---------------------------------------------------------------- the overlay
def test_switch_off_overlay_equals_todays_projection(db):
    track = _track(db, "∞ Zarvo ∞", "Tide (Original Mix) //", bpm=148.0)
    _name(db, track, "Zarvo Prime", "Tide Rising", "look")
    rows = [_dump(track), {"track_id": track.id, "artist": "∞ Zarvo ∞", "title": "Tide [150]"}]
    expected = canonical_library.overlay_off(copy.deepcopy(rows), db)
    assert canonical_library.overlay(copy.deepcopy(rows), db) == expected
    assert expected[0]["artist"] == "Zarvo" and "names_status" not in expected[0]


def test_switch_on_shows_the_stored_names_and_keeps_tempo_and_originals(db):
    track = _track(db, "∞ Zarvo ∞", "Tide [150] (Original Mix)")
    other = _track(db, "Kelvaro", "Ember")  # no row: today's value
    _name(db, track, "Zarvo Prime", "Tide Rising", "look")
    off = canonical_library.overlay_off([_dump(track), _dump(other)], db)
    names_switch.set_on(db, True)
    on = canonical_library.overlay([_dump(track), _dump(other)], db)

    assert (on[0]["artist"], on[0]["title"], on[0]["names_status"]) == ("Zarvo Prime", "Tide Rising", "look")
    assert on[0]["names_off"] == {"artist": off[0]["artist"], "title": off[0]["title"]}
    untouched = {k: v for k, v in on[0].items() if k not in {"artist", "title", "names_status", "names_off"}}
    assert untouched == {k: v for k, v in off[0].items() if k not in {"artist", "title"}}
    assert on[0]["display_bpm"] == off[0]["display_bpm"] == 150  # the title's tempo hint, from the original title
    assert on[0]["original_title"] == "Tide [150] (Original Mix)"
    assert on[1] == off[1]
    assert not any(key.startswith("raw_") for row in on for key in row)


def test_status_none_shows_the_greek_placeholder(db):
    track = _track(db, "", "Untitled Dawn")
    _name(db, track, "", "Untitled Dawn", "none")
    names_switch.set_on(db, True)
    row = canonical_library.overlay([{"track_id": track.id, "artist": "", "title": "Untitled Dawn"}], db)[0]
    assert (row["artist"], row["names_status"]) == ("Άγνωστος καλλιτέχνης", "none")
    assert db.get(TrackName, track.id).artist == ""
    # A file with no tags at all has no engine title either: the row keeps today's title, never an empty one.
    bare = _track(db, "", "audio 0412")
    _name(db, bare, "", "", "none")
    row = canonical_library.overlay([{"track_id": bare.id, "artist": "", "title": "audio 0412"}], db)[0]
    assert (row["artist"], row["title"]) == ("Άγνωστος καλλιτέχνης", "audio 0412")


def test_names_apply_without_an_identity_library_and_on_a_set_or_history_row(client, no_run):
    """A friend's cold library: no identity file at all, and the names still show on every payload."""
    from sqlmodel import Session

    from app.db import get_engine

    with Session(get_engine()) as db:
        track = _track(db, "zarvo", "tide")
        _name(db, track, "Zarvo", "Tide")
        tid = track.id
    before = client.get("/api/tracks", params={"q": ""}).json()
    assert client.post("/api/names/switch", json={"on": True}).status_code == 200
    listed = client.get("/api/tracks", params={"q": ""}).json()
    assert [(t["artist"], t["title"]) for t in before] == [("zarvo", "tide")]
    assert [(t["artist"], t["title"], t["names_status"]) for t in listed] == [("Zarvo", "Tide", "sure")]
    assert client.get(f"/api/tracks/{tid}").json()["track"]["artist"] == "Zarvo"
    dj_set = client.post("/api/sets", json={"title": "night"}).json()
    client.post(f"/api/sets/{dj_set['id']}/tracks", json={"track_id": tid})
    assert client.get(f"/api/sets/{dj_set['id']}").json()["tracks"][0]["track"]["artist"] == "Zarvo"
    assert client.post("/api/names/switch", json={"on": False}).status_code == 200
    assert client.get("/api/tracks", params={"q": ""}).json() == before


def _human_identity(tmp_path, monkeypatch, edited_at: datetime):
    identity = catalog(tmp_path)
    identity.execute("UPDATE canonical_recordings SET state='human', artist='Hand Artist', title='Hand Song', "
                     "updated_at=? WHERE recording_id='local:1'", (edited_at.isoformat(),))
    monkeypatch.setattr(identity_library, "connect", lambda: nullcontext(identity))


def test_a_canonical_edit_newer_than_the_last_run_shows_until_the_run_finishes(db, tmp_path, monkeypatch):
    track = _track(db, "zarvo", "tide")
    assert track.id == 1  # the identity fixture's local track
    _name(db, track, "Zarvo", "Tide")
    names_switch.set_on(db, True)
    run_start = datetime(2026, 11, 20, 12, 0, tzinfo=UTC)
    names_store.write_run_record({"state": "done", "started_at": run_start.isoformat(),
                                  "finished_at": (run_start + timedelta(seconds=4)).isoformat()})

    _human_identity(tmp_path, monkeypatch, run_start + timedelta(minutes=5))
    shown = canonical_library.overlay([_dump(track)], db)[0]
    assert (shown["artist"], shown["title"]) == ("Hand Artist", "Hand Song") and "names_status" not in shown

    # An owner correction made on /names after that edit was written at once and shows.
    db.add(NameDecision(kind="track", track_id=track.id, value="Zarvo | Tide", source="owner",
                        created_at=run_start + timedelta(minutes=6)))
    db.commit()
    assert canonical_library.overlay([_dump(track)], db)[0]["artist"] == "Zarvo"

    # The copy of the /canonical edit itself (source canonical) does not end the wait.
    db.exec(text("UPDATE name_decisions SET source='canonical' WHERE kind='track'"))
    db.commit()
    assert canonical_library.overlay([_dump(track)], db)[0]["artist"] == "Hand Artist"

    # Once a run has started after the edit, the stored name shows again.
    names_store.write_run_record({"state": "done", "started_at": (run_start + timedelta(minutes=7)).isoformat()})
    assert canonical_library.overlay([_dump(track)], db)[0]["artist"] == "Zarvo"


def test_an_older_canonical_edit_does_not_hide_the_stored_name(db, tmp_path, monkeypatch):
    track = _track(db, "zarvo", "tide")
    _name(db, track, "Zarvo", "Tide", "hand")
    names_switch.set_on(db, True)
    run_start = datetime(2026, 11, 20, 12, 0, tzinfo=UTC)
    names_store.write_run_record({"state": "done", "started_at": run_start.isoformat()})
    _human_identity(tmp_path, monkeypatch, run_start - timedelta(days=1))
    shown = canonical_library.overlay([_dump(track)], db)[0]
    assert (shown["artist"], shown["names_status"], shown["canonical_state"]) == ("Zarvo", "hand", "human")
    assert shown["names_off"] == {"artist": "Hand Artist", "title": "Hand Song"}


# ---------------------------------------------------------------- search
def test_switch_off_search_is_todays_and_switch_on_finds_both_spellings(db, no_run):
    track = _track(db, "zrv", "tide")
    other = _track(db, "Kelvaro", "Ember")
    _name(db, track, "Zarvo Prime", "Tide Rising")
    reindex_all(db)
    stored = db.exec(text("SELECT rowid, artist, title FROM track_search ORDER BY rowid")).all()
    assert _ids(db, "zarvo") == [] and _ids(db, "artist:zarvo") == [] and _ids(db, "zrv") == [track.id]

    names_show.set_switch(db, True)
    assert _ids(db, "zarvo") == [track.id] and _ids(db, "rising") == [track.id]
    assert _ids(db, "zrv") == [track.id]  # the old spelling is still found
    assert _ids(db, "artist:zarvo") == [track.id] and _ids(db, "artist:zrv") == [track.id]
    assert _ids(db, "artist:kelvaro") == [other.id] and _ids(db, "-artist:zarvo") == [other.id]

    names_show.set_switch(db, False)
    assert db.exec(text("SELECT rowid, artist, title FROM track_search ORDER BY rowid")).all() == stored
    assert _ids(db, "zarvo") == [] and _ids(db, "artist:zarvo") == []
    assert no_run == [("switch", True)]


def test_reindex_changed_follows_a_run_and_a_single_reindex_keeps_the_shown_name(db):
    track = _track(db, "zrv", "tide")
    plain = _track(db, "Kelvaro", "Ember")
    _name(db, plain, "Kelvaro", "Ember")  # equal to the stored name: nothing to add
    names_switch.set_on(db, True)
    row = _name(db, track, "Zarvo", "Tide")
    assert names_show.reindex_changed(db) == 1  # only the row whose shown name differs
    assert _ids(db, "zarvo") == [track.id]
    row.artist = "Zarvon"  # what a run does, then it names the changed tracks
    db.add(row)
    db.commit()
    assert names_show.reindex_changed(db, [track.id]) == 1
    assert _ids(db, "zarvon") == [track.id] and _ids(db, '"zarvo"') == [track.id]  # a prefix of the new one
    db.add(TrackDJProfile(track_id=track.id, notes="warm pad"))
    db.commit()
    reindex_track(db, track.id)  # any later write of the track keeps both spellings
    assert _ids(db, "zarvon") == [track.id] and _ids(db, "zrv") == [track.id] and _ids(db, "warm") == [track.id]
    # A Greek shown name is folded like every other column.
    row.title = "Παλίρροια"
    db.add(row)
    db.commit()
    names_show.reindex_changed(db, [track.id])
    assert _ids(db, "παλιρροια") == [track.id]
    assert db.exec(text(
        "SELECT count(*) FROM track_search WHERE title <> cratemind_fold(title) AND instr(title, char(31)) = 0"
    )).one()[0] == 0  # no row that the launch check would take for an unfolded one


def test_names_tokens(db):
    tracks = {status: _track(db, f"act {status}", f"song {status}") for status in names_show.STATUSES}
    unread = _track(db, "act unread", "song unread", raw_state=None)
    for status, track in tracks.items():
        _name(db, track, "" if status == "none" else track.artist, track.title, status)
    changed = db.get(TrackName, tracks["look"].id)
    changed.title = "Song Look"
    newer = db.get(TrackName, tracks["hand"].id)
    newer.prev_artist, newer.changed_at, newer.changed_cause = "act", datetime.now(UTC), "scan"
    db.add_all([changed, newer])
    db.commit()

    for status, track in tracks.items():  # the tokens read the stored rows, with the switch off too
        assert _ids(db, f"names:{status}") == [track.id]
    assert _ids(db, "names:changed") == sorted([tracks["look"].id, tracks["none"].id])
    assert _ids(db, "names:new") == [tracks["hand"].id]
    assert _ids(db, "names:LOOK") == [tracks["look"].id]
    assert _ids(db, "names:nonsense") == []
    assert _ids(db, "-names:sure") == sorted([t.id for s, t in tracks.items() if s != "sure"] + [unread.id])
    assert _ids(db, "names:look OR names:open") == sorted([tracks["look"].id, tracks["open"].id])
    assert search.count(db, "names:new") == 1


# ---------------------------------------------------------------- status and the switch
def test_status_counts_and_the_switch_refusal_while_a_track_is_unread(client, no_run):
    from sqlmodel import Session

    from app.db import get_engine

    with Session(get_engine()) as db:
        a, b, c, d = (_track(db, f"act {n}", f"song {n}") for n in "abcd")
        unread = _track(db, "act e", "song e", raw_state=None)
        _track(db, "act f", "song f", raw_state="unreadable")
        gone = _track(db, "act g", "song g", raw_state=None, missing=True)  # a missing track never blocks
        _name(db, a, "Act A", "Song A")
        _name(db, b, "act b", "song b", "look", accepted=True)
        _name(db, c, "act c", "song c", "look", prev_title="old", changed_at=datetime.now(UTC), changed_cause="scan")
        _name(db, d, "", "song d", "none")
        _name(db, gone, "Act G", "Song G", "open")
        # More than one row per count: a sum of a boolean once came back as 1 whatever the number.
        h = _track(db, "act h", "song h")
        _name(db, h, "Act H", "song h", "look", accepted=True)
        _track(db, "act i", "song i", raw_state="unreadable")
        unread_id = unread.id

    status = client.get("/api/names/status").json()
    assert status["on"] is False and status["can_turn_on"] is False
    assert status["blocked_reason"] == "1 κομμάτι δεν έχει διαβαστεί ακόμη: κάνε σάρωση"
    assert (status["present"], status["named"], status["unread"], status["unreadable"]) == (8, 5, 1, 2)
    assert status["counts"] == {"sure": 1, "look": 3, "open": 0, "none": 1, "hand": 0}
    assert (status["accepted"], status["changed"], status["new"]) == (2, 3, 1)
    assert status["run"] == {"state": "idle", "cause": None, "job_id": None}
    assert status["last_run"] is None and status["refusal"] is None
    assert status["ruleset"] == names_store.engine_ruleset()

    refused = client.post("/api/names/switch", json={"on": True})
    assert refused.status_code == 409 and "κάνε σάρωση" in refused.json()["detail"]
    assert client.get("/api/names/status").json()["on"] is False and no_run == []

    with Session(get_engine()) as db:
        db.exec(text("UPDATE tracks SET raw_state='ok' WHERE id=:id").bindparams(id=unread_id))
        db.commit()
    turned = client.post("/api/names/switch", json={"on": True}).json()
    assert turned["on"] is True and turned["can_turn_on"] is True and turned["blocked_reason"] is None
    assert no_run == [("switch", True)]
    assert client.post("/api/names/switch", json={"on": True}).json()["on"] is True
    assert no_run == [("switch", True)]  # already on: nothing reindexed, no second run
    assert client.post("/api/names/switch", json={"on": False}).json()["on"] is False
    assert no_run == [("switch", True)]  # turning it off starts nothing

    assert client.post("/api/names/run").json()["on"] is False  # «Ενημέρωση ονομάτων» works with the switch off
    assert no_run[-1] == ("manual", True)


def test_status_reports_the_last_run_and_a_key_version_refusal(db):
    names_store.write_run_record({"state": "refused", "refusal": "key_version", "ruleset": "names-test",
                                  "cause": "launch", "finished_at": "2026-11-20T12:00:04+00:00", "written": 0,
                                  "seconds": 0.4})
    status = names_show.status(db)
    assert status["refusal"] == "key_version"
    assert status["refusal_text"].startswith("Οι απαντήσεις σου γράφτηκαν με παλαιότερη έκδοση των κανόνων")
    assert status["last_run"] == {"finished_at": "2026-11-20T12:00:04+00:00", "ruleset": "names-test",
                                  "cause": "launch", "written": 0, "seconds": 0.4}
    assert names_show._blocked_reason(3) == "3 κομμάτια δεν έχουν διαβαστεί ακόμη: κάνε σάρωση"


# ---------------------------------------------------------------- one track's why
def test_why_tells_the_rules_the_facts_the_question_and_the_decision(client):
    from sqlmodel import Session

    from app.db import get_engine

    with Session(get_engine()) as db:
        track = _track(db, "zrv", "tide [150]", raw_state="ok")
        track.raw_album, track.raw_track_no = "Low Water", "3/9"
        db.add(track)
        _name(db, track, "Zarvo", "Tide", "open", open_code="U4", accepted=False,
              why_json=json.dumps([["N7", "artist", "Η γραφή του καλλιτέχνη έγινε «Zarvo»"], ["bad"]]),
              facts_json=json.dumps({"tempo": "150", "notes": {"label": "Low Water Records", "members": ["A", "B"]},
                                     "remixers": ["Kelvaro", "Kelvaro"], "album_credit": "Zarvo",
                                     "acts": [{"name": "Zarvo", "key": "zarvo", "role": "primary"}]}),
              prev_artist="Zrv", prev_title="Tide", prev_folder="Zrv",
              changed_at=datetime(2026, 11, 20, 12, 0, tzinfo=UTC), changed_cause="ruleset:names-7→names-8")
        db.add(NameDecision(kind="accept", track_id=track.id, value="Zarvo | Tide | Zarvo"))
        db.commit()
        tid = track.id
        plain = _track(db, "Kelvaro", "Ember", raw_state=None).id
        bare = _track(db, "", "Quiet Mill")
        _name(db, bare, "", "", "none", why_json="[]")
        bare_id = bare.id
    names_store.write_run_record({"state": "done", "open": [
        {"kind": "spelling", "scope": "act:zarvo", "tracks": [tid], "code": "U4",
         "question": "Ποια γραφή είναι η σωστή;", "options": ["A=Zarvo", "B=ZARVO"]}]})

    why = client.get(f"/api/names/tracks/{tid}").json()
    assert (why["on"], why["has_row"], why["status"], why["status_text"]) == (False, True, "open", "Για απόφαση")
    assert (why["artist"], why["title"], why["folder"]) == ("Zarvo", "Tide", "Zarvo")
    assert (why["off_artist"], why["off_title"]) == ("zrv", "tide [150]")
    assert why["open_question"] == "Ποια γραφή είναι η σωστή;" and why["open_code"] == "U4"
    assert why["steps"] == [{"rule": "N7", "field": "artist", "text": "Η γραφή του καλλιτέχνη έγινε «Zarvo»"}]
    assert why["facts"] == [
        {"label": "Tempo", "value": "150"}, {"label": "Μέλη", "value": "A, B"},
        {"label": "Δισκογραφική", "value": "Low Water Records"}, {"label": "Remix", "value": "Kelvaro"},
        {"label": "Καλλιτέχνης άλμπουμ", "value": "Zarvo"}]
    assert why["raw"] == {"artist": "zrv", "title": "tide [150]", "album": "Low Water", "track_no": "3/9",
                          "state": "ok"}
    assert why["decision"]["kind"] == "accept" and why["decision"]["undoable"] is True
    assert why["decision"]["source_text"] == "Το δέχτηκες με «Εντάξει»"
    assert why["change"] == {"prev_artist": "Zrv", "prev_title": "Tide", "prev_folder": "Zrv",
                             "changed_at": "2026-11-20T12:00:00+00:00",
                             "cause_text": "Νέα έκδοση των κανόνων (names-7 → names-8)"}
    assert why["note"] is None and why["ruleset"] == "names-test"

    untagged = client.get(f"/api/names/tracks/{bare_id}").json()
    assert untagged["title"] == "Quiet Mill"  # no engine title: today's
    assert untagged["steps"] == [{"rule": "", "field": "artist", "text": names_store.engine_rule_text("none")}]

    empty = client.get(f"/api/names/tracks/{plain}").json()
    assert empty["has_row"] is False and empty["status"] is None and empty["steps"] == []
    assert empty["raw"]["state"] is None
    assert client.get("/api/names/tracks/99999").status_code == 404


def test_why_names_a_canonical_correction_and_refused_links(db, tmp_path, monkeypatch):
    track = _track(db, "zarvo", "tide")
    _name(db, track, "Zarvo", "Tide", "hand")
    db.add(NameDecision(kind="accept", track_id=track.id, value="x | y | z"))
    db.add(NameDecision(kind="track", track_id=track.id, value="Zarvo | Tide", source="canonical",
                        canonical_event_id=7))
    db.commit()
    identity = catalog(tmp_path)
    identity.execute("UPDATE canonical_recordings SET state='kept_local'")
    monkeypatch.setattr(identity_library, "connect", lambda: nullcontext(identity))

    why = names_show.why(db, track.id)
    assert why["status_text"] == "Από τη σελίδα ταυτότητας"
    assert (why["decision"]["kind"], why["decision"]["source"], why["decision"]["undoable"]) == (
        "track", "canonical", False)  # the track row wins over the accept row; undone on /canonical
    assert why["note"] == "χωρίς τα στοιχεία της πηγής, κατ' επιλογή σου"
    assert why["change"] is None and why["open_question"] is None

    for cause, words in (("decision:12", "Μετά από απάντησή σου"), ("scan", "Μετά από σάρωση"),
                         ("links", "Άλλαξαν οι συνδέσεις με τις πηγές"), ("analysis", "Μετά από ανάλυση"),
                         ("other", "Ενημέρωση ονομάτων"), (None, "Ενημέρωση ονομάτων")):
        assert names_show._cause_text(cause) == words
