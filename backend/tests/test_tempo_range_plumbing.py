"""BPM windows travel per request, music folder and scoped job to the analysis child."""
from __future__ import annotations

import json
import pickle
import re
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlmodel import Session, select

import app.config as cfg
from app.db import reindex_track
from app.jobs import worker
from app.models import Job, Track
from app.runtime_profile import RuntimeProfile, runtime_profile

BUSY = "Εκτελείται ήδη άλλη εργασία"
NONE_MATCHED = "Δεν βρέθηκαν tracks για ανάλυση"


@pytest.fixture(autouse=True)
def fresh_settings():
    yield
    cfg.get_settings.cache_clear()  # after monkeypatch restores the environment


@pytest.fixture
def ffmpeg(monkeypatch):
    monkeypatch.setenv("CRATEMIND_FFMPEG_PATH", "/opt/cratemind/ffmpeg")
    cfg.get_settings.cache_clear()


@pytest.fixture
def captured(monkeypatch):
    calls = []

    def start(job_id, force=False, limit=None, plan_path=None):
        calls.append((job_id, force, limit, plan_path))
        return True

    monkeypatch.setattr(worker, "start_analyze", start)
    yield calls
    for call in calls:
        if call[3]:
            Path(call[3]).unlink(missing_ok=True)


def _engine():
    import app.db as dbmod
    return dbmod.get_engine()


def _tracks(*rows: dict) -> list[int]:
    with Session(_engine()) as session:
        tracks = [Track(**row) for row in rows]
        session.add_all(tracks)
        session.commit()
        for track in tracks:
            reindex_track(session, track.id, commit=False)
        session.commit()
        return [track.id for track in tracks]


def _plan(path: str) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _jobs() -> list[Job]:
    with Session(_engine()) as session:
        return list(session.exec(select(Job)).all())


def _record_analyze_all(monkeypatch, result=None) -> dict:
    from app.services import audio_analysis
    received: dict = {}

    def analyze_all(session, **kwargs):
        received.update(kwargs)
        return result or {"analyzed": 0, "failed": 0}

    monkeypatch.setattr(audio_analysis, "analyze_all", analyze_all)
    return received


def _echo_plan(connection, job_id, plan_path):
    """Stands in for the scan child entry: read the plan as the child does."""
    plan = worker.read_analysis_plan(plan_path)
    connection.send({"result": {"job_id": job_id, "plan": plan, "left_behind": Path(plan_path).exists()}})
    connection.close()


def test_request_validation(client):
    for body in ({"tempo_range": "fast"}, {"root_ranges": {"/m": "therapy"}},
                 {"root_ranges": {"/m": "x"}}, {"track_ids": [1], "query": ""},
                 {"track_ids": [1], "query": "artist:Zed", "dry_run": True}, {"dry_run": True}):
        assert client.post("/api/scan/analyze", json=body).status_code == 422, body
    for body in ({"tempo_range": "fast"}, {"root_ranges": {"/m": "therapy"}}):
        assert client.post("/api/scan/start", json=body).status_code == 422, body


def test_scoped_dry_run_counts_without_a_job(client, monkeypatch):
    monkeypatch.setattr(cfg.shutil, "which", lambda name: None)  # a dry run needs no ffmpeg
    cfg.get_settings.cache_clear()
    _tracks(*({"absolute_path": f"/z/{i}.mp3", "artist": "Zed"} for i in range(3)),
            {"absolute_path": "/o/1.mp3", "artist": "Other"})
    response = client.post("/api/scan/analyze", json={"query": "artist:Zed", "dry_run": True, "tempo_range": "slow"})
    assert response.status_code == 200, response.text
    assert response.json() == {"matched": 3}
    assert _jobs() == []


def test_scoped_job_writes_a_plan_file(client, ffmpeg, captured):
    ids = _tracks(*({"absolute_path": f"/z/{i}.mp3"} for i in range(3)))
    response = client.post("/api/scan/analyze", json={
        "track_ids": ids, "tempo_range": "mixed", "root_ranges": {"/z": "slow"}, "limit": 1,
    })
    assert response.status_code == 200, response.text
    job = response.json()
    assert job["kind"] == "analyze"
    ((job_id, force, limit, plan_path),) = captured
    assert (job_id, force, limit) == (job["id"], False, None)
    assert _plan(plan_path) == {"tempo_range": "mixed", "root_ranges": {}, "track_ids": ids, "scoped": True}

    # An unscoped request carries its window and folder windows the same way.
    with Session(_engine()) as session:
        finished = session.get(Job, job["id"])
        finished.status = "done"
        session.add(finished)
        session.commit()
    response = client.post("/api/scan/analyze", json={
        "force": True, "limit": 5, "tempo_range": "therapy", "root_ranges": {"/z": "slow"},
    })
    assert response.status_code == 200, response.text
    job_id, force, limit, plan_path = captured[1]
    assert (job_id, force, limit) == (response.json()["id"], True, 5)
    assert _plan(plan_path) == {"tempo_range": "therapy", "root_ranges": {"/z": "slow"},
                                "track_ids": None, "scoped": False}


def test_scoped_job_is_primary_only_on_web(db, monkeypatch):
    monkeypatch.setenv("CRATEMIND_ESSENTIA_ENABLED", "true")
    monkeypatch.setenv("CRATEMIND_RECCOBEATS_ENABLED", "true")
    monkeypatch.setenv("CRATEMIND_CYANITE_ENABLED", "true")
    monkeypatch.setenv("CRATEMIND_CYANITE_ACCESS_TOKEN", "token")
    cfg.get_settings.cache_clear()
    received = _record_analyze_all(monkeypatch)
    plan_path = worker.write_analysis_plan(
        {"tempo_range": "slow", "root_ranges": {}, "track_ids": [5, 6], "scoped": True})
    job = worker.create_job(db, "analyze")
    with runtime_profile(RuntimeProfile.WEB):
        worker._run_analyze(job.id, False, 3, plan_path)
    assert received["local_only"] is True
    assert received["force"] is True and received["only_unprocessed"] is False
    assert received["limit"] is None
    assert received["track_ids"] == [5, 6]
    assert received["tempo_range"] == "slow" and received["root_ranges"] == {}
    assert not Path(plan_path).exists()

    # An unscoped plan keeps today's rules and carries the folder windows.
    received.clear()
    plan_path = worker.write_analysis_plan(
        {"tempo_range": "mixed", "root_ranges": {"/m": "slow"}, "track_ids": None, "scoped": False})
    job = worker.create_job(db, "analyze")
    with runtime_profile(RuntimeProfile.WEB):
        worker._run_analyze(job.id, False, 3, plan_path)
    assert received["local_only"] is False and received["force"] is False
    assert received["only_unprocessed"] is True and received["limit"] == 3
    assert received["track_ids"] is None
    assert received["tempo_range"] == "mixed" and received["root_ranges"] == {"/m": "slow"}


def test_scan_auto_analysis_carries_window_and_folders(client, monkeypatch):
    real_additions = worker._analyze_scan_additions
    # The route hands the window and folder windows to the scan job.
    started = []
    monkeypatch.setattr(worker, "start_scan", lambda job_id, roots=None, mode="full", tempo_range="psy",
                        root_ranges=None: started.append((roots, mode, tempo_range, root_ranges)))
    response = client.post("/api/scan/start", json={
        "roots": ["/lib"], "tempo_range": "mixed", "root_ranges": {"/lib/down": "slow"},
    })
    assert response.status_code == 200, response.text
    assert started == [(["/lib"], "full", "mixed", {"/lib/down": "slow"})]

    # The scan job forwards them to its post-scan analysis.
    monkeypatch.setattr(worker.scanner, "scan", lambda *a, **k: {
        "added": 1, "updated": 0, "missing": 0, "unchanged": 0, "added_track_ids": [42],
    })
    monkeypatch.setattr(worker, "rebuild_artist_profiles", lambda _s: None)
    forwarded = []

    def additions(job_id, track_ids, tempo_range="psy", root_ranges=None):
        forwarded.append((track_ids, tempo_range, root_ranges))
        return {"analyzed": 1, "failed": 0}

    monkeypatch.setattr(worker, "_analyze_scan_additions", additions)
    with Session(_engine()) as session:
        job = worker.create_job(session, "scan")
        worker._run_scan(job.id, None, "full", "mixed", {"/lib/down": "slow"})
    assert forwarded == [([42], "mixed", {"/lib/down": "slow"})]

    # The spawned child reads (and deletes) a plan holding all three.
    monkeypatch.setattr(worker, "_send_scan_analysis", _echo_plan)
    result = real_additions(7, [1, 2], "mixed", {"/lib/down": "slow"})
    assert result == {"job_id": 7, "left_behind": False, "plan": {
        "tempo_range": "mixed", "root_ranges": {"/lib/down": "slow"}, "track_ids": [1, 2], "scoped": False,
    }}

    # And the child's analysis receives them.
    received = _record_analyze_all(monkeypatch)
    worker._analyze_scan_tracks(7, [1, 2], "mixed", {"/lib/down": "slow"})
    assert received["track_ids"] == [1, 2] and received["local_only"] is True
    assert received["only_unprocessed"] is True
    assert received["tempo_range"] == "mixed" and received["root_ranges"] == {"/lib/down": "slow"}


def _record_windows(monkeypatch) -> dict:
    from app.services import audio_analysis as aa
    seen: dict = {}

    def analyze_file(path, *, run_primary=True, run_essentia=True, tempo_range=aa.TEMPO_RANGES["psy"]):
        seen[path] = tempo_range.key
        return aa.AnalysisResult(bpm=120.0, bpm_raw=120.0, bpm_confidence=0.5, bpm_method=tempo_range.method)

    monkeypatch.setattr(aa, "analyze_file", analyze_file)
    return seen


def test_analyze_all_resolves_window_per_track(db, monkeypatch):
    from app.services import audio_analysis as aa
    seen = _record_windows(monkeypatch)
    paths = ["/Music/Downtempo/a.mp3", "/Music/House/b.mp3", "/Other/c.mp3"]
    db.add_all([Track(absolute_path=path) for path in paths])
    db.commit()
    roots = {"/Music/Downtempo": "slow", "/Music": "mixed"}
    aa.analyze_all(db, force=True, local_only=True, tempo_range="psy", root_ranges=roots)
    assert seen == {paths[0]: "slow", paths[1]: "mixed", paths[2]: "psy"}
    seen.clear()
    aa.analyze_all(db, force=True, local_only=True, tempo_range="therapy", root_ranges=roots)
    assert seen == dict.fromkeys(paths, "therapy")


def test_folder_windows_match_connected_paths(db, tmp_path, monkeypatch):
    from app.services import audio_analysis as aa
    from app.services import library_paths
    music = tmp_path / "Music"
    (music / "Slow").mkdir(parents=True)
    mappings = tmp_path / "mappings.json"
    mappings.write_text(json.dumps({"version": 1, "library_roots": [{
        "root_key": "main", "logical_prefix": "/Volumes/Old/Music", "logical_flavor": "posix",
        "local_prefix": str(music),
    }]}), encoding="utf-8")
    monkeypatch.setenv("CRATEMIND_PATH_MAPPINGS_FILE", str(mappings))
    cfg.get_settings.cache_clear()
    library_paths._read_mappings.cache_clear()
    try:
        seen = _record_windows(monkeypatch)
        db.add_all([Track(absolute_path="/Volumes/Old/Music/Slow/a.mp3"),
                    Track(absolute_path="/Volumes/Old/Music/b.mp3")])
        db.commit()
        aa.analyze_all(db, force=True, local_only=True, root_ranges={str(music / "Slow"): "slow"})
        assert seen == {str(music / "Slow" / "a.mp3"): "slow", str(music / "b.mp3"): "psy"}
    finally:
        library_paths._read_mappings.cache_clear()


def test_scoped_request_refuses_while_busy(client, ffmpeg, captured):
    ids = _tracks({"absolute_path": "/z/1.mp3"})
    with Session(_engine()) as session:
        active = worker.create_job(session, "analyze")
    response = client.post("/api/scan/analyze", json={"track_ids": ids})
    assert response.status_code == 409
    assert response.json()["detail"] == f"{BUSY} (#{active.id}). Περίμενε να ολοκληρωθεί."
    assert captured == []
    response = client.post("/api/scan/analyze", json={"track_ids": ids, "dry_run": True})
    assert response.status_code == 200 and response.json() == {"matched": 1}


def test_scope_excludes_missing_tracks(client, ffmpeg, captured):
    present = _tracks({"absolute_path": "/z/1.mp3", "artist": "Zed"}, {"absolute_path": "/z/2.mp3", "artist": "Zed"})
    (gone,) = _tracks({"absolute_path": "/z/3.mp3", "artist": "Zed", "missing": True})
    for scope in ({"track_ids": [*present, gone]}, {"query": "artist:Zed"}):
        response = client.post("/api/scan/analyze", json={**scope, "dry_run": True})
        assert response.json() == {"matched": 2}, scope
    response = client.post("/api/scan/analyze", json={"track_ids": [gone]})
    assert response.status_code == 400
    assert response.json()["detail"] == NONE_MATCHED
    assert captured == [] and _jobs() == []


def test_empty_query_means_whole_library(client, ffmpeg, captured):
    present = _tracks({"absolute_path": "/a/1.mp3"}, {"absolute_path": "/b/2.mp3"})
    _tracks({"absolute_path": "/c/3.mp3", "missing": True})
    assert client.post("/api/scan/analyze", json={"query": "", "dry_run": True}).json() == {"matched": 2}
    response = client.post("/api/scan/analyze", json={"query": ""})
    assert response.status_code == 200, response.text
    assert _plan(captured[0][3])["track_ids"] == present


def test_plan_file_removed_when_start_fails(client, ffmpeg, monkeypatch):
    ids = _tracks({"absolute_path": "/z/1.mp3"})
    plans = []

    def refuse(job_id, force=False, limit=None, plan_path=None):
        plans.append(plan_path)
        return False

    monkeypatch.setattr(worker, "start_analyze", refuse)
    response = client.post("/api/scan/analyze", json={"track_ids": ids})
    assert response.status_code == 409
    assert response.json()["detail"] == "Μια ανάλυση BPM/key εκτελείται ήδη."
    response = client.post("/api/scan/analyze", json={"tempo_range": "mixed"})  # unscoped too
    assert response.status_code == 409

    def explode(job_id, force=False, limit=None, plan_path=None):
        plans.append(plan_path)
        raise RuntimeError("spawn failed")

    monkeypatch.setattr(worker, "start_analyze", explode)
    with pytest.raises(RuntimeError, match="spawn failed"):
        client.post("/api/scan/analyze", json={"track_ids": ids})
    assert len(plans) == 3 and all(plans)
    assert not any(Path(path).exists() for path in plans)

    # A child stopped before it read the plan: the monitor removes it.
    plan_path = worker.write_analysis_plan({"tempo_range": "psy", "root_ranges": {}, "track_ids": ids, "scoped": True})
    stopped = SimpleNamespace(exitcode=-15, join=lambda timeout=None: None)
    with Session(_engine()) as session:
        job = worker.create_job(session, "analyze")
    worker._monitor_analyze_process(stopped, job.id, _engine(), None, plan_path)
    assert not Path(plan_path).exists()


def test_spawn_args_stay_constant_size(db, monkeypatch):
    recorded = []

    class Process:
        exitcode = None

        def __init__(self, *, target, args, daemon):
            recorded.append((target, args))

        def start(self):
            pass

        def is_alive(self):
            return True

    for name in ("_analysis_process", "_analysis_job_id", "_analysis_engine", "_analysis_reservation"):
        monkeypatch.setattr(worker, name, None)
    monkeypatch.setattr(worker.mp, "get_context", lambda _method: SimpleNamespace(Process=Process))
    monkeypatch.setattr(worker, "_monitor_analyze_process",
                        lambda process, job_id, engine, reservation=None, plan_path=None: reservation.close())
    ids = list(range(1, 5001))
    plan_path = worker.write_analysis_plan({"tempo_range": "psy", "root_ranges": {}, "track_ids": ids, "scoped": True})
    job = worker.create_job(db, "analyze")
    assert worker.start_analyze(job.id, False, None, plan_path)
    ((target, args),) = recorded
    assert target is worker._run_analyze
    assert not any(isinstance(arg, (list, tuple, dict)) for arg in args)
    assert len(pickle.dumps(args)) < 1024

    # The child reads the ids from the plan and deletes it.
    received = _record_analyze_all(monkeypatch)
    worker._run_analyze(*args)
    assert received["track_ids"] == ids
    assert not Path(plan_path).exists()


def test_job_message_still_translates(db, monkeypatch):
    _record_analyze_all(monkeypatch, {"analyzed": 4, "failed": 1})
    plan_path = worker.write_analysis_plan({"tempo_range": "therapy", "root_ranges": {}, "track_ids": [1], "scoped": True})
    job = worker.create_job(db, "analyze")
    with runtime_profile(RuntimeProfile.WEB):
        worker._run_analyze(job.id, False, None, plan_path)
    db.expire_all()
    finished = db.get(Job, job.id)
    assert finished.status == "done"
    assert re.fullmatch(r"analyzed (\d+), failed (\d+)", finished.message)


def test_scoped_job_ignores_missing_provider_keys(client, ffmpeg, captured, monkeypatch):
    for name in ("GETSONGBPM_ENABLED", "GETSONGBPM_BULK_ENABLED", "CYANITE_ENABLED"):
        monkeypatch.setenv(f"CRATEMIND_{name}", "true")
    monkeypatch.setenv("CRATEMIND_GETSONGBPM_API_KEY", "")
    monkeypatch.setenv("CRATEMIND_CYANITE_ACCESS_TOKEN", "")
    cfg.get_settings.cache_clear()
    ids = _tracks({"absolute_path": "/z/1.mp3"})
    assert client.post("/api/scan/analyze", json={}).status_code == 400  # unscoped still checks keys
    response = client.post("/api/scan/analyze", json={"track_ids": ids, "dry_run": True})
    assert response.status_code == 200 and response.json() == {"matched": 1}
    response = client.post("/api/scan/analyze", json={"track_ids": ids})
    assert response.status_code == 200, response.text
    assert len(captured) == 1
