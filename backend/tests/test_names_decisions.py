"""«Καθαρά ονόματα», stage 2: the decisions service and its routes. Every row is built by hand with invented
names; the run record is written by hand in the shape of CONTRACT.md section 3, and the store's queue is
replaced by a recorder (the store lane owns it)."""
from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import text
from sqlmodel import select

from app.models import NameDecision, Track, TrackName
from app.services import names_decisions as ND
from app.services import names_store, names_switch

SPELL_Q = {"kind": "spelling", "scope": "act:kelvaro", "tracks": [1, 2], "code": "U7",
           "question": "Πώς γράφεται το όνομα «Kelvaro»;", "options": ["A=Kelvaro", "B=KelVaro"]}
TRACK_Q = {"kind": "track", "scope": "track:3", "tracks": [3], "code": "U1",
           "question": "Ποιο πεδίο είναι ο καλλιτέχνης;", "options": ["A=Zarvo | Tide", "B=Tide | Zarvo"]}
BRACKET_Q = {"kind": "bracket_word", "scope": "token:prog", "tracks": [4], "code": "U6",
             "question": "Τι είναι το «[Prog]» πριν από το όνομα;",
             "options": ["A=κράτα το όπως είναι", "B=είδος μουσικής (αφαίρεσέ το)", "C=δισκογραφική (αφαίρεσέ το)"]}
ALBUM_Q = {"kind": "album_credit", "scope": "album:tidal|dyvel+nobra", "tracks": [5, 6], "code": "U11",
           "question": "Το άλμπουμ «Tidal»: φάκελος με όλη τη σύμπραξη;",
           "options": ["A=κάθε κομμάτι στον δικό του φάκελο", "B=Nobra & Dyvel"]}
PAIR_OPEN_Q = {"kind": "same_act", "scope": "pair:gravode|gravo", "tracks": [7], "code": "N19",
               "question": "Είναι το «Gravo (DE)» ο ίδιος καλλιτέχνης με το «Gravo»;",
               "options": ["A=όχι, διαφορετικοί", "B=ναι, ο ίδιος"]}
PREF_Q = {"kind": "preference", "scope": "pref:year_at_title_end", "question": "Τίτλοι που τελειώνουν σε χρονιά;",
          "options": ["A=ναι, μένει στον τίτλο", "B=όχι, βγαίνει στις σημειώσεις"], "recommended": "A",
          "why": "Τίποτα δεν αφαιρείται", "tracks": [8]}
MUSIC_Q = {"kind": "not_act", "scope": "name:*music", "question": "Ονόματα που τελειώνουν σε «Music»;",
           "options": ["A=δισκογραφική, όπως τώρα", "B=καλλιτέχνης"], "recommended": "A", "why": "",
           "tracks": [9]}
PAIR_Q = {"kind": "same_act", "scope": "pair:mintral|mintrel", "question": "Είναι το «Mintral» ο ίδιος;",
          "options": ["A=όχι, μένουν χωριστά", "B=ναι, ο ίδιος"], "recommended": "A", "why": "", "tracks": [10]}


@pytest.fixture
def runs(monkeypatch):
    """Every run the service asks for, instead of the store's queue."""
    asked: list[str] = []
    monkeypatch.setattr(names_store, "request_run", lambda cause, force=False: asked.append(cause) or True)
    return asked


def _record(**extra) -> dict:
    record = {"state": "done", "ruleset": "names-8", "cause": "manual", "finished_at": "2026-11-28T00:00:00+00:00",
              "counts": {}, "reach": {},
              "open": [SPELL_Q, TRACK_Q, BRACKET_Q, ALBUM_Q, PAIR_OPEN_Q], "patterns": [PREF_Q, MUSIC_Q, PAIR_Q]}
    record.update(extra)
    names_store.write_run_record(record)
    return record


def _tracks(db, n: int = 12, raw: str | None = "ok") -> None:
    for i in range(1, n + 1):
        db.add(Track(id=i, absolute_path=f"/lib/t{i}.mp3", artist=f"Stored {i}", title=f"Song {i}", raw_state=raw))
    db.commit()


def _name(db, tid: int, **kw) -> TrackName:
    row = TrackName(track_id=tid, artist=kw.pop("artist", f"Act {tid}"), title=kw.pop("title", f"Song {tid}"),
                    folder=kw.pop("folder", f"Act {tid}"), off_artist=f"Stored {tid}", off_title=kw.pop("off_title", f"Song {tid}"), **kw)
    db.add(row)
    db.commit()
    return row


def _active(db, kind: str) -> list[NameDecision]:
    return list(db.exec(select(NameDecision).where(NameDecision.kind == kind, NameDecision.revoked_at.is_(None))))


# ---------------------------------------------------------------- questions
def test_no_run_yet_means_no_questions(db):
    out = ND.questions(db)
    assert out["has_run"] is False and out["open"] == [] and out["patterns"] == []


def test_questions_list_the_records_items_with_counts_examples_and_answers(db, runs):
    _tracks(db)
    for tid in (1, 2):
        _name(db, tid, artist="Kelvaro", status="look")
    _record()
    out = ND.questions(db)
    assert out["has_run"] is True
    assert [q["id"] for q in out["open"]] == ["spelling|act:kelvaro", "track|track:3", "bracket_word|token:prog",
                                              "album_credit|album:tidal|dyvel+nobra", "same_act|pair:gravode|gravo"]
    spell = out["open"][0]
    assert spell["track_count"] == 2 and spell["allows_text"] is True and spell["section"] == "open"
    assert [o["letter"] for o in spell["options"]] == ["A", "B"] and spell["recommended"] is None
    assert [(e["track_id"], e["artist"], e["off_artist"]) for e in spell["examples"]] == [
        (1, "Kelvaro", "Stored 1"), (2, "Kelvaro", "Stored 2")]
    assert out["open"][2]["allows_text"] is False  # a bracket word takes a letter
    pref = out["patterns"][0]
    assert pref["section"] == "pattern" and pref["recommended"] == "A" and pref["answer"] is None
    ND.answer(db, "preference", "pref:year_at_title_end", "B", None)
    assert ND.questions(db)["patterns"][0]["answer"]["value"] == "B"


# ---------------------------------------------------------------- answers: every kind, letter and typed value
@pytest.mark.parametrize("kind,scope,letter,typed,value", [
    ("spelling", "act:kelvaro", "B", None, "KelVaro"),
    ("spelling", "act:kelvaro", None, "KeLvaro", "=KeLvaro"),
    ("bracket_word", "token:prog", "A", None, "keep"),
    ("bracket_word", "token:prog", "B", None, "genre"),
    ("bracket_word", "token:prog", "C", None, "label"),
    ("album_credit", "album:tidal|dyvel+nobra", "A", None, "none"),
    ("album_credit", "album:tidal|dyvel+nobra", "B", None, "Nobra & Dyvel"),
    ("album_credit", "album:tidal|dyvel+nobra", None, "Nobra & Dyvel & Opax", "=Nobra & Dyvel & Opax"),
    ("same_act", "pair:gravode|gravo", "A", None, "no"),
    ("same_act", "pair:gravode|gravo", "B", None, "yes"),
    ("preference", "pref:year_at_title_end", "B", None, "B"),
    ("not_act", "name:*music", "A", None, "label"),
    ("not_act", "name:*music", "B", None, "no"),
    ("same_act", "pair:mintral|mintrel", "B", None, "yes"),
])
def test_every_answer_kind_stores_the_engines_value(db, runs, kind, scope, letter, typed, value):
    _tracks(db)
    _record()
    out = ND.answer(db, kind, scope, letter, typed)
    row = db.get(NameDecision, out["id"])
    assert (row.kind, row.scope, row.track_id, row.value, row.source) == (kind, scope, None, value, "owner")
    assert row.key_version == (names_store.engine_key_version() if scope.startswith(("act:", "pair:")) else None)
    assert runs == [f"decision:{row.id}"]
    assert out["text"] and "|" not in out["text"].split("—")[0][:2]


def test_a_track_question_is_a_hand_correction_written_at_once(db, runs):
    _tracks(db)
    _name(db, 3, artist="Tide", title="Zarvo", status="open", open_code="U1")
    _record()
    out = ND.answer(db, "track", "track:3", "B", None)
    row = db.get(NameDecision, out["id"])
    assert (row.kind, row.scope, row.track_id, row.value) == ("track", "", 3, "Tide | Zarvo")
    name = db.get(TrackName, 3)
    assert (name.artist, name.title, name.status) == ("Tide", "Zarvo", "hand")
    typed = ND.answer(db, "track", "track:3", None, "Zarvo Remixed | Tide")
    assert db.get(NameDecision, typed["id"]).value == "Zarvo Remixed | Tide"
    assert [r.id for r in _active(db, "track")] == [typed["id"]]


@pytest.mark.parametrize("kind,scope,letter,typed,status", [
    ("bracket_word", "token:prog", None, "label", 400),  # takes a letter
    ("same_act", "pair:gravode|gravo", None, "yes", 400),
    ("spelling", "act:kelvaro", "Z", None, 400),  # not one of the letters
    ("spelling", "act:kelvaro", "A", "Kelvaro", 400),  # both
    ("spelling", "act:kelvaro", None, "  ", 400),  # neither
    ("track", "track:3", None, "no bar here", 400),
    ("spelling", "act:nobody", "A", None, 404),  # not in the record
    ("setting", "switch", "A", None, 400),
])
def test_refused_answers_say_why_in_greek_and_write_nothing(db, runs, kind, scope, letter, typed, status):
    _tracks(db)
    _record()
    with pytest.raises(ND.DecisionError) as caught:
        ND.answer(db, kind, scope, letter, typed)
    assert caught.value.status == status
    assert any("Ͱ" <= ch <= "Ͽ" for ch in str(caught.value))
    assert db.exec(select(NameDecision)).all() == [] and runs == []


def test_an_answer_without_a_run_record_is_refused(db, runs):
    with pytest.raises(ND.DecisionError) as caught:
        ND.answer(db, "spelling", "act:kelvaro", "A", None)
    assert caught.value.status == 409


def test_a_new_answer_replaces_the_old_and_an_undone_pattern_can_be_answered_again(db, runs):
    _tracks(db)
    _record()
    first = ND.answer(db, "preference", "pref:year_at_title_end", "A", None)
    second = ND.answer(db, "preference", "pref:year_at_title_end", "B", None)
    assert [r.id for r in _active(db, "preference")] == [second["id"]]
    assert db.get(NameDecision, first["id"]).revoked_at is not None  # kept, never deleted
    undone = ND.undo(db, second["id"])
    assert undone["ok"] is True and _active(db, "preference") == []
    with pytest.raises(ND.DecisionError) as caught:
        ND.undo(db, second["id"])
    assert caught.value.status == 409
    again = ND.answer(db, "preference", "pref:year_at_title_end", "A", None)
    assert [r.id for r in _active(db, "preference")] == [again["id"]]
    assert len(db.exec(select(NameDecision)).all()) == 3
    assert runs == [f"decision:{i}" for i in (first["id"], second["id"], second["id"], again["id"])]


def test_canonical_rows_and_settings_cannot_be_undone_here(db, runs):
    _tracks(db)
    db.add(NameDecision(kind="track", track_id=1, value="Kelvaro | Arc", source="canonical", canonical_event_id=7))
    db.commit()
    row = _active(db, "track")[0]
    with pytest.raises(ND.DecisionError) as caught:
        ND.undo(db, row.id)
    assert caught.value.status == 409 and "ταυτότητας" in str(caught.value)
    names_switch.set_on(db, True)
    switch = _active(db, "setting")[0]
    with pytest.raises(ND.DecisionError):
        ND.undo(db, switch.id)
    with pytest.raises(ND.DecisionError) as missing:
        ND.undo(db, 9999)
    assert missing.value.status == 404
    listed = ND.answers(db)["items"]
    assert [(a["id"], a["undoable"]) for a in listed] == [(row.id, False)]  # the switch is not an answer


def test_answers_are_newest_first_with_reach_text_and_track(db, runs):
    _tracks(db)
    _name(db, 3, status="open", open_code="U1")
    _record()
    spell = ND.answer(db, "spelling", "act:kelvaro", "B", None)
    fix = ND.correct(db, 3, "Zarvo", "Tide")
    db.add(NameDecision(kind="accept", track_id=1, value="Act 1 | Song 1 | Act 1"))
    db.commit()
    _record(reach={str(spell["id"]): 3})
    items = ND.answers(db)["items"]
    assert [a["id"] for a in items] == [fix["id"], spell["id"]]  # «Εντάξει» rows are not listed
    assert items[1]["reach"] == 3 and items[0]["reach"] is None
    assert items[1]["text"].endswith("KelVaro")
    assert items[0]["track"]["track_id"] == 3 and items[0]["text"] == "Διόρθωση: Zarvo – Tide"


# ---------------------------------------------------------------- a hand correction
def test_a_correction_writes_the_decision_and_the_row_at_once(db, runs):
    _tracks(db)
    _name(db, 1, status="look", rules="C4")
    out = ND.correct(db, 1, "  Kelvaro ", " Arc ")
    row = db.get(NameDecision, out["id"])
    assert (row.kind, row.track_id, row.value, row.source) == ("track", 1, "Kelvaro | Arc", "owner")
    name = db.get(TrackName, 1)
    assert (name.artist, name.title, name.status) == ("Kelvaro", "Arc", "hand")
    assert runs == [f"decision:{row.id}"]
    second = ND.correct(db, 1, "Kelvaro", "Arc II")
    assert [r.id for r in _active(db, "track")] == [second["id"]]
    assert db.exec(text("SELECT COUNT(*) FROM track_search WHERE rowid = 1")).one()[0] == 1  # reindexed


def test_a_correction_inserts_a_row_only_for_a_track_whose_tags_were_read(db, runs):
    _tracks(db, 2)
    db.add(Track(id=20, absolute_path="/lib/unread.mp3", artist="Stored", title="Unread"))  # raw_state NULL
    db.commit()
    ND.correct(db, 2, "Opax", "Night")
    assert (db.get(TrackName, 2).artist, db.get(TrackName, 2).status) == ("Opax", "hand")
    ND.correct(db, 20, "Opax", "Day")
    assert db.get(TrackName, 20) is None  # an unread track gets no row; its decision waits for the run
    assert [r.track_id for r in _active(db, "track")] == [2, 20]


@pytest.mark.parametrize("artist,title,status", [("", "Arc", 400), ("Kelvaro", "", 400), ("A | B", "Arc", 400)])
def test_a_correction_needs_an_artist_and_a_title(db, runs, artist, title, status):
    _tracks(db, 1)
    with pytest.raises(ND.DecisionError) as caught:
        ND.correct(db, 1, artist, title)
    assert caught.value.status == status and _active(db, "track") == []
    with pytest.raises(ND.DecisionError) as missing:
        ND.correct(db, 99, "A", "B")
    assert missing.value.status == 404


def test_a_correction_survives_a_merge_and_a_rescan_of_the_track(db, runs):
    from app.services import scanner

    _tracks(db, 2)
    ND.correct(db, 1, "Kelvaro", "Arc")
    db.exec(text("UPDATE tracks SET artist = 'Rescanned', raw_artist = 'Rescanned', missing = 1 WHERE id = 1"))
    db.commit()
    scanner.merge_tracks(db, [(1, 2)])
    db.commit()
    rows = _active(db, "track")
    assert [(r.track_id, r.value) for r in rows] == [(2, "Kelvaro | Arc")]  # follows the track through a merge


# ---------------------------------------------------------------- «Εντάξει»
def _looks(db):
    _tracks(db)
    why = json.dumps([["C4", "artist", "Γράφτηκε με κεφαλαίο μόνο το πρώτο γράμμα"]], ensure_ascii=False)
    for tid in (1, 2, 3):
        _name(db, tid, status="look", rules="N24s C4", why_json=why)
    _name(db, 4, status="look", rules="N24s A1k",
          why_json=json.dumps([["A1k", "title", "Ο τίτλος κρατήθηκε όπως είναι"]], ensure_ascii=False))
    for tid in (5, 6, 7):
        _name(db, tid, status="sure", rules="N24s C2")
    _name(db, 8, status="open", open_code="U1")


def test_accept_counts_first_then_accepts_a_whole_group_with_one_run(db, runs):
    _looks(db)
    assert ND.accept(db, track_ids=None, rule="C4", dry_run=True) == {"count": 3, "dry_run": True}
    assert _active(db, "accept") == [] and runs == []
    assert ND.accept(db, track_ids=None, rule="C4", dry_run=False) == {"count": 3, "dry_run": False}
    accepts = _active(db, "accept")
    assert sorted((r.track_id, r.value) for r in accepts) == [
        (t, f"Act {t} | Song {t} | Act {t}") for t in (1, 2, 3)]
    assert all(db.get(TrackName, t).accepted for t in (1, 2, 3)) and not db.get(TrackName, 4).accepted
    assert len(runs) == 1  # a bulk «Εντάξει» asks for one run
    assert ND.accept(db, track_ids=None, rule="C4", dry_run=True)["count"] == 0  # accepted rows are not counted
    assert ND.accept(db, track_ids=[4, 5, 8], rule=None, dry_run=False)["count"] == 1  # only look rows
    undo = ND.undo(db, _active(db, "accept")[0].id)
    assert undo["ok"] and sum(not db.get(TrackName, t).accepted for t in (1, 2, 3, 4)) == 1


def test_review_groups_look_rows_by_their_deciding_rule(db, runs):
    _looks(db)
    out = ND.review(db, "look", group=None, offset=0, limit=100)
    assert out["total"] == 4
    # A group is labelled with its rule's general sentence; each row keeps its own wording.
    assert out["groups"] == [{"key": "C4", "label": names_store.engine_rule_text("C4"), "count": 3},
                             {"key": "A1k", "label": names_store.engine_rule_text("A1k"), "count": 1}]
    assert all(g["label"] for g in out["groups"])
    assert {r["track_id"]: r["reason"] for r in out["items"]} == {
        1: "Γράφτηκε με κεφαλαίο μόνο το πρώτο γράμμα", 2: "Γράφτηκε με κεφαλαίο μόνο το πρώτο γράμμα",
        3: "Γράφτηκε με κεφαλαίο μόνο το πρώτο γράμμα", 4: "Ο τίτλος κρατήθηκε όπως είναι"}
    page = ND.review(db, "look", group="C4", offset=1, limit=1)
    assert page["total"] == 3 and [r["track_id"] for r in page["items"]] == [2]
    ND.accept(db, track_ids=[1], rule=None, dry_run=False)
    assert ND.review(db, "look", group="C4", offset=0, limit=100)["total"] == 2  # a to-do list


def test_review_lists_open_and_none_rows(db, runs):
    _looks(db)
    _name(db, 9, artist="", status="none",
          why_json=json.dumps([["N21b", "pair", "Δεν βρέθηκε καλλιτέχνης πουθενά"]], ensure_ascii=False))
    _record(open=[{**TRACK_Q, "scope": "track:8", "tracks": [8]}])
    none = ND.review(db, "none", group=None, offset=0, limit=10)
    assert [(r["track_id"], r["artist"], r["reason"]) for r in none["items"]] == [
        (9, "", "Δεν βρέθηκε καλλιτέχνης πουθενά")]
    _name(db, 10, artist="", title="", off_title="Quiet Mill", status="none", why_json="[]")
    bare = ND.review(db, "none", group=None, offset=0, limit=10)["items"]
    assert [(r["title"], r["reason"]) for r in bare if r["track_id"] == 10] == [
        ("Quiet Mill", names_store.engine_rule_text("none"))]  # an untagged file: today's title, and why
    opened = ND.review(db, "open", group=None, offset=0, limit=10)
    assert opened["groups"] == [{"key": "U1", "label": "Ποιο πεδίο είναι ο καλλιτέχνης;", "count": 1}]
    with pytest.raises(ND.DecisionError):
        ND.review(db, "everything", group=None, offset=0, limit=10)


# ---------------------------------------------------------------- «Άλλαξαν»
def _changed(db):
    _tracks(db)
    _name(db, 1, artist="Kelvaro", prev_artist="KELVARO", prev_title="Song 1", prev_folder="KELVARO",
          changed_at=datetime(2026, 11, 28, tzinfo=UTC), changed_cause="ruleset:names-7→names-8")
    _name(db, 2, artist="Opax", prev_artist="Opax & Gravo", prev_title=None, prev_folder="Opax & Gravo",
          changed_at=datetime(2026, 11, 28, tzinfo=UTC), changed_cause="scan")
    _name(db, 3, artist="Dyvel", prev_artist="", prev_title="Song 3", prev_folder="Unknown Artist",
          changed_at=datetime(2026, 11, 28, tzinfo=UTC), changed_cause="scan")
    _name(db, 4)


def test_changed_rows_are_grouped_by_cause_in_greek(db, runs):
    _changed(db)
    out = ND.review(db, "changed", group=None, offset=0, limit=10)
    assert {g["key"]: (g["label"], g["count"]) for g in out["groups"]} == {
        "scan": ("Μετά από σάρωση", 2), "ruleset:names-7→names-8": ("Νέοι κανόνες ονομάτων (names-7→names-8)", 1)}
    first = next(r for r in out["items"] if r["track_id"] == 1)
    assert (first["prev_artist"], first["artist"], first["changed_at"][:10]) == ("KELVARO", "Kelvaro", "2026-11-28")


def test_acknowledge_ok_clears_one_cause_after_a_dry_run(db, runs):
    _changed(db)
    assert ND.acknowledge(db, track_ids=None, cause="scan", action="ok", dry_run=True) == {"count": 2,
                                                                                         "dry_run": True}
    assert db.get(TrackName, 2).prev_artist == "Opax & Gravo"
    assert ND.acknowledge(db, track_ids=None, cause="scan", action="ok", dry_run=False)["count"] == 2
    for tid in (2, 3):
        row = db.get(TrackName, tid)
        assert (row.prev_artist, row.prev_title, row.prev_folder, row.changed_at, row.changed_cause) == (
            None, None, None, None, None)
    assert db.get(TrackName, 1).prev_artist == "KELVARO"
    assert db.exec(select(NameDecision)).all() == [] and runs == []  # nothing for the engine to read


def test_keep_previous_writes_a_track_decision_with_the_previous_name(db, runs):
    _changed(db)
    out = ND.acknowledge(db, track_ids=[1, 2, 3], cause=None, action="keep_previous", dry_run=False)
    assert out["count"] == 2  # track 3 had no artist before: nothing to keep, it stays listed
    assert sorted((r.track_id, r.value) for r in _active(db, "track")) == [
        (1, "KELVARO | Song 1"), (2, "Opax & Gravo | Song 2")]
    one = db.get(TrackName, 1)
    assert (one.artist, one.status, one.prev_artist) == ("KELVARO", "hand", None)
    assert [r["track_id"] for r in ND.review(db, "changed", group=None, offset=0, limit=10)["items"]] == [3]
    assert len(runs) == 1


def test_a_corrected_track_whose_file_changed_is_listed_until_acknowledged(db, runs):
    _tracks(db, 2)
    _name(db, 1)
    ND.correct(db, 1, "Kelvaro", "Arc")
    later = (datetime.now(UTC) + timedelta(minutes=5)).timestamp()
    db.exec(text("UPDATE tracks SET modified_time = :t WHERE id = 1"), params={"t": later})
    db.commit()
    out = ND.review(db, "changed", group=None, offset=0, limit=10)
    assert out["groups"] == [{"key": "file", "label": "Άλλαξαν τα στοιχεία του αρχείου μετά τη διόρθωσή σου",
                              "count": 1}]
    db.exec(text("UPDATE tracks SET modified_time = :t WHERE id = 1"),
            params={"t": (datetime.now(UTC) - timedelta(minutes=5)).timestamp()})
    db.commit()
    assert ND.review(db, "changed", group=None, offset=0, limit=10)["total"] == 0
    db.exec(text("UPDATE tracks SET modified_time = :t WHERE id = 1"), params={"t": later})
    db.commit()
    before = _active(db, "track")[0]
    assert ND.acknowledge(db, track_ids=None, cause="file", action="ok", dry_run=False)["count"] == 1
    after = _active(db, "track")[0]
    assert after.id != before.id and after.value == before.value == "Kelvaro | Arc"


# ---------------------------------------------------------------- bundles and the JSON export
def test_the_json_export_holds_the_answers_and_not_the_result(db, runs):
    from app.services.backup import _export_metadata

    _tracks(db, 1)
    _name(db, 1)
    ND.correct(db, 1, "Kelvaro", "Arc")
    payload = _export_metadata(db)
    assert [(d["kind"], d["track_id"], d["value"]) for d in payload["name_decisions"]] == [
        ("track", 1, "Kelvaro | Arc")]
    assert "track_names" not in payload


def test_an_imported_library_starts_with_an_empty_changed_list(db, runs, tmp_path):
    import shutil
    import sqlite3

    from app.library_exchange import operations
    from app.services.schema_contract import canonical_database_values

    _changed(db)
    ND.correct(db, 4, "Kelvaro", "Arc")
    db.exec(text("PRAGMA wal_checkpoint(TRUNCATE)"))
    copy = tmp_path / "incoming.sqlite"
    shutil.copy(db.get_bind().url.database, copy)
    values = canonical_database_values(copy)
    assert "name_decisions" in values and "track_names" not in values  # answers travel, results are rebuilt
    operations._clear_names_changes(copy)
    with sqlite3.connect(copy) as connection:
        left = connection.execute("SELECT COUNT(*) FROM track_names WHERE prev_artist IS NOT NULL OR prev_title"
                                  " IS NOT NULL OR prev_folder IS NOT NULL OR changed_at IS NOT NULL").fetchone()[0]
        kept = connection.execute("SELECT artist, status FROM track_names WHERE track_id = 4").fetchone()
        answers = connection.execute("SELECT COUNT(*) FROM name_decisions").fetchone()[0]
    assert left == 0 and kept == ("Kelvaro", "hand") and answers == 1
    assert canonical_database_values(copy)["name_decisions"] == values["name_decisions"]
    assert "«Άλλαξαν»" in operations.NAMES_CHANGED_NOTE


def test_the_exchange_summary_names_the_answers_in_greek():
    import inspect

    from app.library_exchange import operations

    assert '"name_decisions": "Αποφάσεις ονομάτων"' in inspect.getsource(operations._change_summary)


# ---------------------------------------------------------------- the routes
def _client_tracks(client):
    from sqlmodel import Session

    import app.db as dbmod

    with Session(dbmod.get_engine()) as session:
        _tracks(session, 3)
        _name(session, 1, status="look", rules="C4")
        _name(session, 2, prev_artist="Old", changed_at=datetime(2026, 11, 28, tzinfo=UTC), changed_cause="scan")
        _name(session, 3, status="open", open_code="U1")


def test_question_and_answer_routes(client, runs):
    _client_tracks(client)
    assert client.get("/api/names/questions").json()["has_run"] is False
    _record()
    body = client.get("/api/names/questions").json()
    assert body["has_run"] is True and body["run"]["state"] == "idle" and len(body["patterns"]) == 3
    given = client.post("/api/names/answers", json={"kind": "spelling", "scope": "act:kelvaro", "letter": "B"})
    assert given.status_code == 200 and given.json()["value"] == "KelVaro"
    refused = client.post("/api/names/answers", json={"kind": "bracket_word", "scope": "token:prog", "text": "x"})
    assert refused.status_code == 400 and refused.json()["detail"]
    assert [a["id"] for a in client.get("/api/names/answers").json()["items"]] == [given.json()["id"]]
    undone = client.post(f"/api/names/answers/{given.json()['id']}/undo")
    assert undone.status_code == 200 and undone.json()["ok"] is True
    assert client.post(f"/api/names/answers/{given.json()['id']}/undo").status_code == 409


def test_correction_accept_acknowledge_and_review_routes(client, runs):
    _client_tracks(client)
    fixed = client.post("/api/names/tracks/3/correct", json={"artist": "Zarvo", "title": "Tide"})
    assert fixed.status_code == 200 and fixed.json()["track"]["artist"] == "Zarvo"
    assert client.post("/api/names/tracks/99/correct", json={"artist": "A", "title": "B"}).status_code == 404
    assert client.post("/api/names/accept", json={"dry_run": True}).json() == {"count": 1, "dry_run": True}
    assert client.post("/api/names/accept", json={"track_ids": [1]}).json() == {"count": 1, "dry_run": False}
    ack = client.post("/api/names/acknowledge", json={"cause": "scan", "action": "ok", "dry_run": True})
    assert ack.json() == {"count": 1, "dry_run": True}
    review = client.get("/api/names/review", params={"section": "changed"}).json()
    assert review["total"] == 1 and review["groups"][0]["label"] == "Μετά από σάρωση"
    assert client.get("/api/names/review", params={"section": "look"}).json()["total"] == 0
    assert client.get("/api/names/review", params={"section": "nope"}).status_code == 422
