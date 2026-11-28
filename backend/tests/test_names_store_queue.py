"""«Καθαρά ονόματα», the store lane's queue: one waiting run held in memory, its triggers, what holds it back,
how a scan or an analysis stops it, and the call sites that ask for a run. Every name is invented."""
from __future__ import annotations

import time

import pytest
from sqlmodel import select

from app.jobs import worker
from app.models import Job, Track, TrackName
from app.services import names_show, names_store, names_switch


@pytest.fixture(autouse=True)
def quiet_queue(monkeypatch):
    """The dispatcher thread never starts here: each test turns it by hand with `_step()`."""
    names_store._reset_queue()
    monkeypatch.setattr(names_store, "_ensure_dispatcher", lambda: None)
    monkeypatch.setattr(names_show, "reindex_changed", lambda session, track_ids=None, *, commit=True: 0)
    yield
    names_store._reset_queue()


@pytest.fixture
def requests(monkeypatch):
    """Record what the app's call sites ask for, without queueing anything."""
    seen: list = []
    monkeypatch.setattr(names_store, "request_run", lambda cause, *, force=False: seen.append((cause, force)) or True)
    return seen


def track(db, tmp_path) -> Track:
    row = Track(absolute_path=str(tmp_path / "lib/Kelvaro/Tides/1.mp3"), file_name="1.mp3", artist="Kelvaro",
                title="Night Drift", raw_artist="Kelvaro", raw_title="Night Drift", raw_state="ok")
    db.add(row)
    db.commit()
    return row


def names_jobs(db) -> list[Job]:
    db.expire_all()
    return db.exec(select(Job).where(Job.kind == "names").order_by(Job.id)).all()


def wait_idle(seconds: float = 20.0) -> None:
    deadline = time.monotonic() + seconds
    while names_store.run_state()["state"] == "running":
        assert time.monotonic() < deadline, "the names job did not finish"
        time.sleep(0.02)


def test_nothing_is_queued_while_the_switch_is_off(db):
    for cause in ("launch", "scan", "analysis", "links", "decision:3"):
        assert names_store.request_run(cause) is False
    assert names_store.run_state() == {"state": "idle", "cause": None, "job_id": None}
    assert names_store._step() == "idle" and names_jobs(db) == []


def test_a_forced_request_waits_in_memory_without_a_job_row(db):
    assert names_store.request_run("manual", force=True) is True
    assert names_store.run_state() == {"state": "queued", "cause": "manual", "job_id": None}
    assert db.exec(select(Job)).all() == []
    assert worker.recover_orphan_jobs(db) == 0  # nothing there for orphan recovery to discard


def test_a_burst_of_requests_is_one_waiting_run(db):
    names_switch.set_on(db, True)
    assert names_store.request_run("decision:4") and names_store.request_run("decision:5")
    assert names_store.run_state()["cause"] == "decision:5"  # the latest answer
    names_store.request_run("scan")
    names_store.request_run("links")
    assert names_store.run_state() == {"state": "queued", "cause": "decision:5", "job_id": None}  # an answer keeps its cause
    names_store._reset_queue()
    names_store.request_run("scan")
    names_store.request_run("links")
    assert names_store.run_state()["cause"] == "links"


def test_a_waiting_run_is_dropped_when_the_switch_goes_off_but_a_forced_one_is_not(db, tmp_path):
    track(db, tmp_path)
    names_switch.set_on(db, True)
    names_store.request_run("scan")
    names_switch.set_on(db, False)
    assert names_store._step() == "idle" and names_jobs(db) == []
    assert names_store.run_state()["state"] == "idle"
    names_store.request_run("manual", force=True)
    assert names_store._step() == "started"
    wait_idle()
    assert len(names_jobs(db)) == 1


def test_a_run_waits_for_another_job_and_for_two_playing_decks(db, tmp_path, monkeypatch):
    from app.api import deck_rescue

    track(db, tmp_path)
    names_store.request_run("manual", force=True)
    scan = worker.create_job(db, "scan")  # owned by this process, as a starting scan is
    assert names_store._step() == "wait" and names_jobs(db) == []
    worker._finish(db, scan, "done")
    monkeypatch.setattr(deck_rescue, "deck_playing", lambda: True)
    assert names_store._step() == "wait" and names_jobs(db) == []
    monkeypatch.setattr(deck_rescue, "deck_playing", lambda: False)
    assert names_store._step() == "started"
    wait_idle()


def test_a_started_run_is_a_names_job_that_stores_the_names(db, tmp_path):
    row = track(db, tmp_path)
    names_store.request_run("manual", force=True)
    assert names_store._step() == "started"
    wait_idle()
    job = names_jobs(db)[0]
    assert (job.status, job.message, job.error) == ("done", "Ονόματα: άλλαξε 1 κομμάτι", None)
    assert db.get(TrackName, row.id).artist == "Kelvaro"
    assert names_store.read_run_record()["cause"] == "manual"
    assert names_store.run_state()["state"] == "idle" and names_store._step() == "idle"
    # The same inputs again: a job that says so and writes nothing.
    names_store.request_run("launch", force=True)
    assert names_store._step() == "started"
    wait_idle()
    assert names_jobs(db)[1].message == "Τα ονόματα είναι ήδη ενημερωμένα"


def test_a_scan_or_analysis_start_stops_a_running_run_and_queues_it_again(db, tmp_path, monkeypatch):
    row = track(db, tmp_path)
    started: list = []
    monkeypatch.setattr(worker, "start_names", lambda job_id, cause, cancelled: started.append((job_id, cause, cancelled)))
    names_store.request_run("decision:9", force=True)
    assert names_store._step() == "started"
    job_id, cause, cancelled = started[0]
    assert names_store.run_state() == {"state": "running", "cause": "decision:9", "job_id": job_id}
    assert names_store._step() == "busy"
    assert names_store.yield_to("fingerprint") is False and names_store.yield_to("duplicate_scan") is False
    assert cancelled() is False
    scan = worker.create_job(db, "scan")  # the scan route's own call: never refused, and it tells the run to stop
    assert scan.kind == "scan" and cancelled() is True
    outcome = names_store.run_job(job_id, cause, cancelled)
    assert outcome.state == "cancelled" and db.get(TrackName, row.id) is None
    assert names_store.read_run_record() is None
    job = db.get(Job, job_id)
    db.refresh(job)
    assert (job.status, job.message) == ("done", "Η ενημέρωση ονομάτων σταμάτησε για άλλη εργασία· θα ξανατρέξει μετά")
    assert names_store.run_state() == {"state": "queued", "cause": "decision:9", "job_id": None}
    assert names_store._step() == "wait"  # the scan is still active
    worker._finish(db, scan, "done")
    assert names_store._step() == "started" and started[1][1] == "decision:9"
    assert names_store.yield_to("analyze") is True and started[1][2]() is True


def test_yield_never_raises_and_changes_nothing_when_no_run_is_running(db, monkeypatch):
    assert names_store.yield_to("scan") is False and names_store.yield_to("analyze") is False
    with monkeypatch.context() as patch:
        patch.setattr(names_store, "_LOCK", None)  # anything going wrong inside must not reach the scan start
        assert names_store.yield_to("scan") is False


def test_a_failed_job_says_so_in_greek_and_frees_the_queue(db, tmp_path, monkeypatch):
    track(db, tmp_path)
    monkeypatch.setattr(names_store, "run", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("internal detail")))
    names_store.request_run("manual", force=True)
    assert names_store._step() == "started"
    wait_idle()
    job = names_jobs(db)[0]
    assert job.status == "error" and job.error == names_store.JOB_ERROR and "internal" not in job.error
    assert names_store.run_state()["state"] == "idle"


def test_a_run_that_cannot_start_waits_and_tries_again(db, tmp_path, monkeypatch):
    track(db, tmp_path)
    monkeypatch.setattr(worker, "start_names", lambda *a: (_ for _ in ()).throw(RuntimeError("maintenance")))
    names_store.request_run("links", force=True)
    assert names_store._step() == "wait"
    assert names_store.run_state() == {"state": "queued", "cause": "links", "job_id": None}
    assert names_jobs(db)[0].status == "error"  # the row it had made is closed, not left pending


# ---------------------------------------------------------------- call sites
def test_a_finished_analysis_asks_for_a_run_in_the_apps_own_process(db, requests):
    class Exited:
        exitcode = 0

        def join(self):
            return None

    job = worker.create_job(db, "analyze")
    worker._finish(db, job, "done", "analyzed 1")
    worker._monitor_analyze_process(Exited(), job.id, db.get_bind())
    assert requests == [("analysis", False)]
    # The child process that analyses never queues: a run queued there would die with it.
    import inspect

    assert "_queue_names" not in inspect.getsource(worker._run_analyze)
    assert '_queue_names("scan")' in inspect.getsource(worker._run_scan)


def test_the_names_job_thread_runs_the_stores_job(db, monkeypatch):
    seen = []
    monkeypatch.setattr(names_store, "run_job", lambda job_id, cause, cancelled: seen.append((job_id, cause, cancelled())))
    worker._run_names(7, "scan", lambda: False)
    assert seen == [(7, "scan", False)]


def test_launch_asks_for_a_run(requests, client):
    assert requests == [("launch", False)]


def test_identity_routes_that_change_links_ask_for_a_run_and_saves_do_not(monkeypatch):
    import inspect

    from app.api import identity

    seen: list = []
    monkeypatch.setattr(identity, "write_canonical", lambda operation, *args: {"ok": True})
    monkeypatch.setattr(names_store, "after_identity_write", lambda recording_id=None, action="": seen.append((recording_id, action)))
    assert identity.canonical_decision(identity.MetadataDecision(recording_id="rec:1", action="edit", payload={})) == {"ok": True}
    assert identity.canonical_revoke.__name__ and seen == [("rec:1", "edit")]
    for route in (identity.canonical_pattern_accept, identity.canonical_revoke, identity.recovery,
                  identity.consolidation_decision, identity.consolidation_undo, identity.consolidation_restore,
                  identity.confirm_identity, identity.reject_identity, identity.undo_identity, identity.retire_asset,
                  identity.undo_automatic_link):
        source = inspect.getsource(route)
        assert "write_links(" in source and "write_canonical(" not in source, route.__name__
    for route in (identity.create_native_collection, identity.append_native_collection, identity.collection_algebra,
                  identity.lineage_decision):
        assert "write_links(" not in inspect.getsource(route), route.__name__


def test_after_an_identity_write_an_edit_is_copied_and_a_run_requested(db, requests, monkeypatch):
    copied: list = []
    monkeypatch.setattr(names_store, "copy_canonical_edits", lambda session, recording_id=None: copied.append(recording_id) or 0)
    names_store.after_identity_write("rec:1", "accept")
    names_store.after_identity_write("rec:2", "edit")
    names_store.after_identity_write()
    assert copied == ["rec:2"] and requests == [("links", False)] * 3
    monkeypatch.setattr(names_store, "request_run", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("x")))
    names_store.after_identity_write("rec:3", "edit")  # the identity write has happened: never an error for the route


def test_the_moved_tracks_merge_and_the_legacy_import_ask_for_a_run():
    import inspect

    from app.api import duplicates, legacy_import

    assert 'names_store.request_run("links")' in inspect.getsource(duplicates.merge_moved)
    assert 'names_store.request_run("links")' in inspect.getsource(legacy_import.import_json_backup)


def test_a_scan_start_during_a_dispatcher_turn_never_deadlocks(db, monkeypatch):
    """The scan route holds submission_lock and then reaches yield_to (which takes _LOCK); a dispatcher turn
    at the same moment must not hold _LOCK while it waits for submission_lock."""
    import threading

    names_store._running = {"cause": "launch", "force": False, "job_id": 999, "cancel": threading.Event()}
    seen: dict = {}

    def scan_route():
        with worker.submission_lock:
            time.sleep(0.3)
            seen["yield"] = names_store.yield_to("scan")

    def dispatcher_turn():
        time.sleep(0.1)
        seen["step"] = names_store._step()

    threads = [threading.Thread(target=scan_route, daemon=True), threading.Thread(target=dispatcher_turn, daemon=True)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(5)
    assert not any(t.is_alive() for t in threads), "the scan start and the dispatcher deadlocked"
    assert seen["yield"] is True and seen["step"] == "idle"  # job 999 has no thread: the turn drops it
    assert names_store._LOCK.acquire(timeout=1)
    names_store._LOCK.release()


def test_a_starting_run_reads_queued_never_idle_while_its_job_row_is_made(db, tmp_path, monkeypatch):
    track(db, tmp_path)
    monkeypatch.setattr(worker, "start_names", lambda job_id, cause, cancelled: None)
    real = worker.create_job
    during: list = []

    def create_job(session, kind):
        during.append(names_store.run_state()["state"])
        return real(session, kind)

    monkeypatch.setattr(worker, "create_job", create_job)
    names_store.request_run("manual", force=True)
    assert names_store._step() == "started"
    assert during == ["queued"]
    assert names_store.run_state()["state"] == "running"
