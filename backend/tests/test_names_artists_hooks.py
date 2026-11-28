"""Stage 5 of «Καθαρά ονόματα», S2: what rebuilds the artist pages (a names run that finishes `done` with the
switch on, and every switch change), the refusal to turn the switch while artist research runs, and a hand
correction's folder. Plan: .omc/plans/2026-11-28-names-stage5-artist-pages.md. Every name here is invented."""
from __future__ import annotations

import threading

import pytest
from sqlmodel import select

from app.jobs import worker
from app.models import ArtistProfile, Job, Track, TrackName
from app.services import artist_catalog, artist_intelligence, names_decisions, names_show, names_store, names_switch
from app.services.names_store import RunResult


@pytest.fixture(autouse=True)
def quiet(monkeypatch):
    """No dispatcher thread and no real run; every rebuild is counted (and still runs)."""
    names_store._reset_queue()
    monkeypatch.setattr(names_store, "_ensure_dispatcher", lambda: None)
    monkeypatch.setattr(names_store, "request_run", lambda cause, *, force=False: True)
    yield
    names_store._reset_queue()


@pytest.fixture
def rebuilds(monkeypatch):
    seen: list[int] = []
    real = artist_catalog.rebuild_quietly

    def counted(session):
        seen.append(1)
        return real(session)

    monkeypatch.setattr(artist_catalog, "rebuild_quietly", counted)
    return seen


def _names_job(db) -> int:
    job = Job(kind="names", status="pending")
    db.add(job)
    db.commit()
    return job.id


def _research(db, status="running") -> Job:
    job = Job(kind="artist_enrich", status=status)
    db.add(job)
    db.commit()
    return job


# ---------------------------------------------------------------- a names run
@pytest.mark.parametrize("state,on,expected", [
    ("done", True, 1), ("done", False, 0), ("unchanged", True, 0), ("refused", True, 0), ("cancelled", True, 0)])
def test_a_run_rebuilds_only_when_it_finished_done_with_the_switch_on(db, rebuilds, monkeypatch, state, on, expected):
    names_switch.set_on(db, on)
    monkeypatch.setattr(names_store, "run", lambda session, **kw: RunResult(state))
    job_id = _names_job(db)
    assert names_store.run_job(job_id, "manual").state == state
    assert len(rebuilds) == expected
    db.expire_all()
    assert db.get(Job, job_id).status == "done"


def test_a_run_rebuild_that_fails_still_finishes_the_job(db, monkeypatch):
    names_switch.set_on(db, True)
    monkeypatch.setattr(names_store, "run", lambda session, **kw: RunResult("done", written=2))
    monkeypatch.setattr(artist_catalog, "_rebuild", lambda session: (_ for _ in ()).throw(RuntimeError("boom")))
    job_id = _names_job(db)
    assert names_store.run_job(job_id, "manual").state == "done"
    db.expire_all()
    job = db.get(Job, job_id)
    assert (job.status, job.message) == ("done", "Ονόματα: άλλαξαν 2 κομμάτια")


def test_the_run_rebuild_holds_no_queue_lock_so_a_scan_start_goes_through(db, monkeypatch):
    """While the rebuild runs (here: held open), a scan start (submission_lock, then yield_to's _LOCK) and the
    dispatcher's turn both finish."""
    names_switch.set_on(db, True)
    monkeypatch.setattr(names_store, "run", lambda session, **kw: RunResult("done"))
    inside, release = threading.Event(), threading.Event()

    def slow(session):
        inside.set()
        release.wait(5)

    monkeypatch.setattr(artist_catalog, "rebuild_quietly", slow)
    job_id = _names_job(db)
    names_store._running = {"cause": "manual", "force": False, "job_id": job_id, "cancel": threading.Event()}
    runner = threading.Thread(target=names_store.run_job, args=(job_id, "manual"), daemon=True)
    runner.start()
    assert inside.wait(5)
    seen = {}

    def scan_start():
        with worker.submission_lock:
            seen["yield"] = names_store.yield_to("scan")

    starter = threading.Thread(target=scan_start, daemon=True)
    starter.start()
    starter.join(3)
    assert not starter.is_alive(), "a scan start waited on the names run's rebuild"
    assert seen["yield"] is True
    assert names_store._LOCK.acquire(timeout=1)
    names_store._LOCK.release()
    release.set()
    runner.join(5)
    assert not runner.is_alive()


# ---------------------------------------------------------------- the switch
def test_every_switch_change_rebuilds_and_a_repeat_does_not(db, rebuilds, monkeypatch):
    monkeypatch.setattr(names_show, "_unread", lambda session: 0)
    names_show.set_switch(db, True)
    assert len(rebuilds) == 1
    names_show.set_switch(db, True)
    assert len(rebuilds) == 1
    names_show.set_switch(db, False)
    assert len(rebuilds) == 2
    names_show.set_switch(db, False)
    assert len(rebuilds) == 2


def test_a_switch_change_moves_the_artist_keys(db, monkeypatch):
    monkeypatch.setattr(names_show, "_unread", lambda session: 0)
    track = Track(absolute_path="/lib/Kelvaro/1.mp3", artist="Kelvaro feat. Opax", title="Arc", raw_state="ok")
    db.add(track)
    db.commit()
    db.add(TrackName(track_id=track.id, artist="Kelvaro feat. Opax", title="Arc", folder="Kelvaro", status="sure"))
    db.commit()
    artist_catalog.rebuild_artist_profiles(db)
    today = db.get(Track, track.id).artist_normalized
    assert today and not today.startswith("act:")
    names_show.set_switch(db, True)
    db.expire_all()
    assert db.get(Track, track.id).artist_normalized == "act:" + names_store.act_key("Kelvaro")
    names_show.set_switch(db, False)
    db.expire_all()
    assert db.get(Track, track.id).artist_normalized == today
    assert {p.normalized_name for p in db.exec(select(ArtistProfile))} == {today, "act:kelvaro"}


@pytest.mark.parametrize("status", ["running", "pending"])
def test_the_switch_does_not_turn_while_artist_research_runs(db, rebuilds, monkeypatch, status):
    monkeypatch.setattr(names_show, "_unread", lambda session: 0)
    _research(db, status)
    with pytest.raises(names_show.SwitchRefused) as refused:
        names_show.set_switch(db, True)
    assert str(refused.value) == artist_intelligence.SWITCH_WAIT_TEXT
    assert names_switch.is_on(db) is False and rebuilds == []
    names_show.set_switch(db, False)  # already off: no change, so no refusal
    assert names_switch.is_on(db) is False and rebuilds == []


def test_a_switch_that_is_on_does_not_turn_off_while_research_runs(db, monkeypatch):
    monkeypatch.setattr(names_show, "_unread", lambda session: 0)
    names_switch.set_on(db, True)
    _research(db)
    with pytest.raises(names_show.SwitchRefused):
        names_show.set_switch(db, False)
    assert names_switch.is_on(db) is True
    names_show.set_switch(db, True)  # no change: allowed


def test_a_finished_research_job_does_not_hold_the_switch(db, rebuilds, monkeypatch):
    monkeypatch.setattr(names_show, "_unread", lambda session: 0)
    _research(db, "done")
    names_show.set_switch(db, True)
    assert names_switch.is_on(db) is True and len(rebuilds) == 1


def test_the_switch_route_answers_409_in_greek_while_research_runs(client, monkeypatch):
    from app.db import get_engine
    from sqlmodel import Session

    monkeypatch.setattr(names_show, "_unread", lambda session: 0)
    with Session(get_engine()) as session:
        _research(session)
    res = client.post("/api/names/switch", json={"on": True})
    assert res.status_code == 409
    assert res.json()["detail"] == artist_intelligence.SWITCH_WAIT_TEXT
    with Session(get_engine()) as session:
        assert names_switch.is_on(session) is False


# ---------------------------------------------------------------- a hand correction's folder
@pytest.mark.parametrize("status,folder,kept", [
    ("open", "Downloads", False), ("none", "Unknown Artist", False), ("sure", "Kelvaro", True),
    ("look", "Kelvaro", True)])
def test_a_hand_correction_of_an_open_or_no_artist_row_takes_its_artist_as_folder(db, status, folder, kept):
    track = Track(absolute_path="/lib/Downloads/1.mp3", artist="kelvaro - arc", title="", raw_state="ok")
    db.add(track)
    db.commit()
    db.add(TrackName(track_id=track.id, artist="Kelvaro", title="Arc", folder=folder, status=status))
    db.commit()
    names_switch.set_on(db, True)
    names_decisions.correct(db, track.id, "Kelvaro Opax", "Arc")
    row = db.get(TrackName, track.id)
    assert (row.status, row.folder) == ("hand", folder if kept else "Kelvaro Opax")
    artist_catalog.rebuild_artist_profiles(db)
    db.expire_all()
    expected = "act:" + names_store.act_key(folder if kept else "Kelvaro Opax")
    assert db.get(Track, track.id).artist_normalized == expected


def test_a_hand_correction_that_makes_a_row_takes_its_artist_as_folder(db):
    track = Track(absolute_path="/lib/Downloads/2.mp3", artist="x", title="y", raw_state="ok")
    db.add(track)
    db.commit()
    names_decisions.correct(db, track.id, "Opax", "Night")
    row = db.get(TrackName, track.id)
    assert (row.status, row.folder, row.artist) == ("hand", "Opax", "Opax")

