"""Job worker — scan vs. post-step (artist rebuild) failure semantics."""
from __future__ import annotations

import os

import pytest
from sqlmodel import select

from app.jobs import worker
from app.models import Job, Track
from tests.conftest import make_wav


def test_scan_reports_done_when_artist_rebuild_fails(db, monkeypatch):
    # The scan committed all rows; a failing artist-profile rebuild is a derived
    # post-step and must not flip the scan itself to "error".
    job = worker.create_job(db, "scan")
    monkeypatch.setattr(
        worker.scanner, "scan",
        lambda *a, **k: {"added": 1, "updated": 0, "unchanged": 0, "missing": 0},
    )

    def boom(_session):
        raise RuntimeError("rebuild kaboom")

    monkeypatch.setattr(worker, "rebuild_artist_profiles", boom)

    worker._run_scan(job.id, None)

    db.expire_all()
    refreshed = db.get(Job, job.id)
    assert refreshed.status == "done"
    assert "rebuild failed" in (refreshed.message or "")


def test_scan_reports_error_when_scan_fails(db, monkeypatch):
    job = worker.create_job(db, "scan")

    def boom(*_a, **_k):
        raise RuntimeError("scan kaboom")

    monkeypatch.setattr(worker.scanner, "scan", boom)

    def rebuild_must_not_run(_session):
        raise AssertionError("rebuild should not run when the scan failed")

    monkeypatch.setattr(worker, "rebuild_artist_profiles", rebuild_must_not_run)

    worker._run_scan(job.id, None)

    db.expire_all()
    refreshed = db.get(Job, job.id)
    assert refreshed.status == "error"
    assert "scan kaboom" in (refreshed.error or "")


@pytest.mark.parametrize("mode", ["full", "delta"])
def test_scan_analyzes_only_new_tracks_and_reports_duplicate_skips(db, tmp_path, monkeypatch, mode):
    lib = tmp_path / "lib"
    monkeypatch.setattr(worker.scanner.ffprobe_reader, "read_stream", lambda *_: {"duration": 300.0})
    make_wav(lib / "Alpha - Moon Garden.wav", freq_seed=1)
    worker.scanner.scan(db, [lib], mode=mode)
    make_wav(lib / "Alpha - Moon Garden (Original Mix).wav", freq_seed=2)
    make_wav(lib / "Beta - Desert.wav", freq_seed=3)
    calls = []

    def analyze(session, **kwargs):
        calls.append(kwargs)
        return {"analyzed": len(kwargs["track_ids"]), "failed": 0}

    monkeypatch.setattr(worker, "_analyze_scan_additions", worker._analyze_scan_tracks)
    monkeypatch.setattr(worker.audio_analysis, "analyze_all", analyze)
    job = worker.create_job(db, "scan")
    worker._run_scan(job.id, [str(lib)], mode)
    db.expire_all()
    added = db.exec(select(Track).where(Track.artist == "Beta")).one()
    assert len(calls) == 1
    assert calls[0]["track_ids"] == [added.id]
    assert calls[0]["local_only"] is True
    assert calls[0]["only_unprocessed"] is True
    assert calls[0]["job"].id == job.id
    refreshed = db.get(Job, job.id)
    assert refreshed.status == "done"
    assert "skipped duplicates 1" in refreshed.message
    assert "analyzed 1, analysis failed 0" in refreshed.message

    repeat = worker.create_job(db, "scan")
    worker._run_scan(repeat.id, [str(lib)], mode)
    assert len(calls) == 1


def test_analysis_failure_preserves_scan_success_and_added_rows(db, tmp_path, monkeypatch):
    lib = tmp_path / "lib"
    make_wav(lib / "Alpha - Desert.wav")

    def analysis_failure(*_):
        raise RuntimeError("analysis subprocess unavailable")

    def rebuild_failure(_):
        raise RuntimeError("artist rebuild unavailable")

    monkeypatch.setattr(worker, "_analyze_scan_additions", analysis_failure)
    monkeypatch.setattr(worker, "rebuild_artist_profiles", rebuild_failure)
    job = worker.create_job(db, "scan")
    worker._run_scan(job.id, [str(lib)], "delta")

    db.expire_all()
    refreshed = db.get(Job, job.id)
    assert refreshed.status == "done"
    assert "artist rebuild failed" in refreshed.message
    assert "new-track analysis failed" in refreshed.message
    assert db.exec(select(Track)).one().title == "Desert"


@pytest.mark.parametrize("crash", [False, True])
def test_scan_analysis_runs_in_spawned_process_and_records_file_failure(db, tmp_path, monkeypatch, crash):
    lib = tmp_path / "lib"
    lib.mkdir()
    (lib / "broken.mp3").write_bytes(b"not audio")
    job = worker.create_job(db, "scan")
    context = worker.mp.get_context("spawn")
    created = []

    class SpawnContext:
        def Pipe(self, **kwargs):
            return context.Pipe(**kwargs)

        def Process(self, **kwargs):
            assert kwargs["daemon"] is True
            created.append(kwargs)
            if crash:
                return context.Process(target=os._exit, args=(1,), daemon=True)
            return context.Process(**kwargs)

    monkeypatch.setattr(worker.mp, "get_context", lambda method: SpawnContext())

    worker._run_scan(job.id, [str(lib)], "delta")

    db.expire_all()
    track = db.exec(select(Track)).one()
    refreshed = db.get(Job, job.id)
    assert refreshed.status == "done"
    if crash:
        assert track.analyzed_at is None
        assert "new-track analysis failed" in refreshed.message
    else:
        assert track.analyzed_at is not None
        assert track.analysis_error
        assert "analysis failed 1" in refreshed.message
    assert len(created) == 1
