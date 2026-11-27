"""A track whose music folder is switched off in Settings is left as it is by every analysis phase, and a
phase that fails drops the tracks still queued. Hermetic: detection is stubbed, so no audio is decoded."""
import time
from datetime import UTC, datetime

import pytest
from sqlmodel import select

from app.models import Track, TrackBeatgrid
from app.services import audio_analysis as aa
from app.services import beatgrid_detect as bd
from app.services import library_paths
from app.services.library_paths import PathResolutionError

GRID = bd.GridResult(bpm=140.0, anchor_s=0.25, confidence=0.97, residual_ms=0.4, downbeat_confidence=0.6)


@pytest.fixture
def folders(monkeypatch):
    """Paths under /off belong to a switched-off folder; paths under /unplugged to a drive that is not connected."""
    def resolve(path, mappings=None):
        if path.startswith("/off/"):
            raise PathResolutionError("/off", "disabled")
        if path.startswith("/unplugged/"):
            raise PathResolutionError("/unplugged", "disconnected")
        return path

    monkeypatch.setattr(library_paths, "resolve_source_path", resolve)
    monkeypatch.setattr(aa, "_loudness_targets", lambda *a, **k: [])


def _track(db, path, **fields):
    db.add(Track(absolute_path=path, file_name=path.rsplit("/", 1)[-1], duration=300.0, **fields))


def test_the_grid_phase_leaves_a_switched_off_folders_track_and_does_the_rest(db, folders, monkeypatch):
    seen = []
    monkeypatch.setattr(aa, "_grid_for", lambda path, duration, hint: seen.append(path) or (GRID, None))
    _track(db, "/music/a.mp3")
    _track(db, "/off/b.mp3")
    _track(db, "/music/c.mp3")
    db.commit()
    ids = [t.id for t in db.exec(select(Track)).all()]

    assert aa.detect_grids(db, ids) == {"grids": 2, "grids_failed": 0, "structures": 0, "structures_failed": 0}
    assert sorted(seen) == ["/music/a.mp3", "/music/c.mp3"]
    gridded = {db.get(Track, row.track_id).absolute_path for row in db.exec(select(TrackBeatgrid)).all()}
    assert gridded == {"/music/a.mp3", "/music/c.mp3"}


def test_the_first_pass_and_the_key_phase_leave_it_too(db, folders, monkeypatch):
    analysed, keyed = [], []
    monkeypatch.setattr(aa, "analyze_file", lambda path, **_: analysed.append(path) or aa.AnalysisResult(bpm=140.0, key="8A"))
    monkeypatch.setattr(aa, "_grid_for", lambda *a: (None, None))
    monkeypatch.setattr(aa, "_key_for", lambda path: keyed.append(path) or ("8A", 0.9))
    _track(db, "/music/new.mp3")
    _track(db, "/off/new.mp3")
    old = dict(analyzed_at=datetime(2026, 9, 1, tzinfo=UTC), bpm_analyzed=140.0, key_analyzed="5A", key_analyzed_method="old-method")
    _track(db, "/music/old-key.mp3", **old)
    _track(db, "/off/old-key.mp3", **old)
    db.commit()

    aa.analyze_all(db, local_only=True, only_unprocessed=True)

    assert analysed == ["/music/new.mp3"]
    assert keyed == ["/music/old-key.mp3"]
    by_path = {t.absolute_path: t for t in db.exec(select(Track)).all()}
    assert by_path["/off/new.mp3"].analyzed_at is None and by_path["/off/new.mp3"].analysis_error is None
    assert by_path["/off/old-key.mp3"].key_analyzed == "5A"
    assert by_path["/music/old-key.mp3"].key_analyzed == "8A"


def test_a_drive_that_is_not_connected_still_stops_the_run_and_drops_the_queued_tracks(db, folders, monkeypatch):
    started = []

    def slow(path, duration, hint):
        started.append(path)
        time.sleep(0.05)
        return (GRID, None)

    monkeypatch.setattr(aa, "_grid_for", slow)
    monkeypatch.setattr(aa, "_workers", lambda: 1)
    for n in range(20):
        _track(db, f"/music/{n:02}.mp3")
    _track(db, "/unplugged/last.mp3")
    db.commit()
    ids = [t.id for t in db.exec(select(Track).order_by(Track.id)).all()]

    with pytest.raises(PathResolutionError):
        aa.detect_grids(db, ids)
    assert len(started) < 10            # the 20 queued tracks were not all worked through after the failure


def test_the_loudness_phase_leaves_a_switched_off_folders_track_and_counts_it_done(db, folders, monkeypatch):
    from app.models import Job
    from app.services import playback_loudness

    measured = []
    monkeypatch.setattr(playback_loudness, "measure_file", lambda path: measured.append(path) or (-9.0, -0.5))
    _track(db, "/music/a.mp3")
    _track(db, "/off/b.mp3")
    job = Job(kind="analyze")
    db.add(job)
    db.commit()
    ids = [t.id for t in db.exec(select(Track).order_by(Track.id)).all()]

    assert aa.detect_loudness(db, ids, job=job) == {"loudness": 1, "loudness_failed": 0}
    assert measured == ["/music/a.mp3"]
    assert job.processed == 2
    by_path = {t.absolute_path: t for t in db.exec(select(Track)).all()}
    assert by_path["/off/b.mp3"].loudness_measured_at is None


def test_the_first_pass_counts_a_switched_off_folders_track_as_done(db, folders, monkeypatch):
    from app.models import Job

    monkeypatch.setattr(aa, "analyze_file", lambda path, **_: aa.AnalysisResult(bpm=140.0, key="8A"))
    monkeypatch.setattr(aa, "_grid_targets", lambda *a, **k: [])
    _track(db, "/music/new.mp3")
    _track(db, "/off/new.mp3")
    job = Job(kind="analyze")
    db.add(job)
    db.commit()

    aa.analyze_all(db, local_only=True, only_unprocessed=True, job=job)

    assert job.total == 2
    assert job.processed == 2
