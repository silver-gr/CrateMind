"""Job worker — scan vs. post-step (artist rebuild) failure semantics."""
from __future__ import annotations

from app.jobs import worker
from app.models import Job


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
