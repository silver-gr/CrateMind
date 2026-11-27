"""«Διακοπή» on a running BPM/key analysis: the job stops between tracks, keeps what it finished and says so.
Analysis is stubbed, so no audio is read."""
import time

from sqlmodel import Session

from app.jobs import worker
from app.models import Job, Track
from app.runtime_profile import RuntimeProfile, runtime_profile
from app.services import audio_analysis as aa


class FakeProcess:
    def __init__(self, alive: bool = True):
        self.alive = alive
        self.terminated = 0
        self.exitcode = -15

    def is_alive(self):
        return self.alive

    def terminate(self):
        self.terminated += 1
        self.alive = False

    def join(self, timeout=None):
        pass


def test_a_stopped_job_finishes_the_current_track_and_keeps_earlier_results(db, monkeypatch, tmp_path):
    monkeypatch.setattr(aa, "_stop_file", None)
    monkeypatch.setattr(aa, "_workers", lambda: 1)  # one track at a time, in id order
    ids = []
    for name in ("a", "b", "c", "d"):
        track = Track(absolute_path=f"/music/{name}.wav")
        db.add(track)
        db.commit()
        ids.append(track.id)
    plan_path = worker.write_analysis_plan({"tempo_range": "psy", "root_ranges": {}, "track_ids": None, "scoped": False})
    analysed = []

    def analyze_file(path, **_kwargs):
        analysed.append(path)
        if len(analysed) == 2:  # the user presses «Διακοπή» while the second track is analysed
            worker.stop_file(plan_path).touch()
        return aa.AnalysisResult(bpm=145.0, key="8A", key_confidence=0.9)

    def never(*_args, **_kwargs):
        raise AssertionError("a later phase ran after the stop")

    monkeypatch.setattr(aa, "analyze_file", analyze_file)
    monkeypatch.setattr(aa.playback_loudness, "measure_file", never)
    monkeypatch.setattr(aa, "_grid_for", never)
    job = worker.create_job(db, "analyze")
    try:
        with runtime_profile(RuntimeProfile.DESKTOP_CORE):
            worker._run_analyze(job.id, False, None, plan_path)
    finally:
        worker.stop_file(plan_path).unlink(missing_ok=True)

    assert analysed == ["/music/a.wav", "/music/b.wav"]   # the third track never started
    db.expire_all()
    tracks = [db.get(Track, track_id) for track_id in ids]
    assert [t.bpm_analyzed for t in tracks] == [145.0, 145.0, None, None]
    assert [t.analyzed_at is not None for t in tracks] == [True, True, False, False]
    finished = db.get(Job, job.id)
    assert finished.status == "done"
    assert finished.message == f"Διακόπηκε στο βήμα 2 από {finished.total}"
    assert finished.total > 2


def test_waiting_for_the_decks_ends_on_a_stop(db, monkeypatch, tmp_path):
    from app.api import deck_rescue
    stop = tmp_path / "plan.json.stop"
    monkeypatch.setattr(aa, "_stop_file", stop)
    monkeypatch.setattr(aa, "PLAYBACK_POLL_S", 0.01)
    polls = []

    def playing():
        polls.append(1)
        if len(polls) == 3:
            stop.touch()
        return True                                        # a set keeps playing

    monkeypatch.setattr(deck_rescue, "deck_playing", playing)
    aa._wait_for_decks(db.get_bind(), None)                # returns instead of waiting for the set to end
    assert len(polls) == 3


def test_a_child_terminated_after_the_grace_period_still_ends_with_the_stop_message(db, tmp_path):
    job = worker.create_job(db, "analyze")
    job.status, job.processed, job.total = "running", 7, 30
    db.add(job)
    db.commit()
    plan_path = str(tmp_path / "plan.json")
    worker.stop_file(plan_path).touch()
    worker._monitor_analyze_process(FakeProcess(alive=False), job.id, worker.get_engine(), None, plan_path)
    db.expire_all()
    finished = db.get(Job, job.id)
    assert finished.status == "done" and finished.error is None
    assert finished.message == "Διακόπηκε στο βήμα 7 από 30"
    assert not worker.stop_file(plan_path).exists()


def test_a_terminated_child_stays_owned_until_its_monitor_writes_the_stop(db, monkeypatch, tmp_path):
    """A status poll between the forced terminate and the monitor must not mark the job as an error."""
    job = worker.create_job(db, "analyze")
    job.status, job.processed, job.total = "running", 7, 30
    db.add(job)
    db.commit()
    plan_path = str(tmp_path / "plan.json")
    worker.stop_file(plan_path).touch()
    process = FakeProcess(alive=False)                     # terminated after the grace period
    monkeypatch.setattr(worker, "_analysis_process", process)
    monkeypatch.setattr(worker, "_analysis_job_id", job.id)
    monkeypatch.setattr(worker, "_analysis_engine", None)
    monkeypatch.setattr(worker, "_analysis_plan_path", plan_path)

    assert worker.active_analyze_job_id() == job.id
    assert worker.recover_orphan_jobs(db) == 0
    worker._monitor_analyze_process(process, job.id, worker.get_engine(), None, plan_path)
    db.expire_all()
    finished = db.get(Job, job.id)
    assert finished.status == "done" and finished.message == "Διακόπηκε στο βήμα 7 από 30"
    assert worker.active_analyze_job_id() is None


def test_request_stop_asks_the_child_then_terminates_it_after_the_grace_period(db, monkeypatch, tmp_path):
    plan_path = str(tmp_path / "plan.json")
    process = FakeProcess()
    monkeypatch.setattr(worker, "_analysis_process", process)
    monkeypatch.setattr(worker, "_analysis_job_id", 5)
    monkeypatch.setattr(worker, "_analysis_engine", None)
    monkeypatch.setattr(worker, "_analysis_plan_path", plan_path)
    monkeypatch.setattr(worker, "STOP_GRACE_S", 0)

    assert worker.request_analysis_stop(6) is False        # not the running analysis
    assert not worker.stop_file(plan_path).exists()
    assert worker.request_analysis_stop(5) is True
    assert worker.stop_file(plan_path).exists()
    deadline = time.monotonic() + 2
    while not process.terminated and time.monotonic() < deadline:
        time.sleep(0.01)
    assert process.terminated == 1                         # it did not stop by itself within the grace period

    monkeypatch.setattr(worker, "_analysis_plan_path", None)
    assert worker.request_analysis_stop(5) is False        # a job started without a plan cannot be asked


def test_stop_route_asks_only_the_running_analysis_to_stop(client, monkeypatch):
    asked = []

    def request(job_id):
        asked.append(job_id)
        return job_id == analysis_id

    monkeypatch.setattr(worker, "request_analysis_stop", request)
    with Session(worker.get_engine()) as session:
        analysis_id = worker.create_job(session, "analyze").id
        scan_id = worker.create_job(session, "scan").id

    response = client.post(f"/api/scan/analyze/{analysis_id}/stop")
    assert response.status_code == 200 and response.json()["id"] == analysis_id
    response = client.post(f"/api/scan/analyze/{scan_id}/stop")
    assert response.status_code == 409
    assert response.json()["detail"] == "Αυτή η εργασία δεν είναι ανάλυση σε εξέλιξη."
    assert client.post("/api/scan/analyze/999/stop").status_code == 404
    assert asked == [analysis_id]                          # a scan job is never asked
