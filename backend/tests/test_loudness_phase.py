"""The loudness phase of analyze_all: measures every unmeasured track once (ffmpeg stubbed, so no
audio is read) and stores only the loudness columns."""
from datetime import UTC, datetime

import pytest

from app.models import Job, Track
from app.services import audio_analysis as aa


@pytest.fixture
def measured(monkeypatch):
    """Stub the per-file measurement; record the paths it was asked for."""
    calls = []

    def fake(path):
        calls.append(path)
        if "broken" in path:
            raise RuntimeError("ffmpeg exited 1")
        return None if "silent" in path else (-8.5, 0.7)

    monkeypatch.setattr(aa.playback_loudness, "measure_file", fake)
    monkeypatch.setattr(aa, "_grid_targets", lambda *a, **k: [])        # the grid phase has its own tests
    monkeypatch.setattr(aa, "analyze_file", lambda path, **_: pytest.fail("first pass ran"))
    return calls


def _tracks(db, *paths, **fields):
    rows = [Track(absolute_path=path, analyzed_at=datetime.now(UTC), **fields) for path in paths]
    for row in rows:
        db.add(row)
    db.commit()
    return rows


def test_backlog_is_measured_once_and_counted(db, measured):
    loud, silent, broken = _tracks(db, "/loud.wav", "/silent.wav", "/broken.wav")
    done, gone = _tracks(db, "/done.wav")[0], _tracks(db, "/gone.wav", missing=True)[0]
    done.loudness_lufs, done.loudness_peak_db, done.loudness_measured_at = -12.0, -3.0, datetime.now(UTC)
    db.add(done)
    db.commit()
    job = Job(kind="analyze")
    db.add(job)
    db.commit()

    result = aa.analyze_all(db, only_unprocessed=True, local_only=True, job=job)

    assert sorted(measured) == ["/broken.wav", "/loud.wav", "/silent.wav"]
    assert (result["loudness"], result["loudness_failed"]) == (2, 1)
    assert (job.total, job.processed) == (3, 3)
    for row in (loud, silent, broken, done, gone):
        db.refresh(row)
    assert (loud.loudness_lufs, loud.loudness_peak_db, loud.loudness_measured_at is not None) == (-8.5, 0.7, True)
    assert (silent.loudness_lufs, silent.loudness_measured_at is not None) == (None, True)
    assert broken.loudness_measured_at is None                              # tried again next run
    assert (done.loudness_lufs, gone.loudness_measured_at) == (-12.0, None)

    measured.clear()
    aa.analyze_all(db, only_unprocessed=True, local_only=True)
    assert measured == ["/broken.wav"]


def test_scope_and_force(db, measured):
    a, b = _tracks(db, "/a.wav", "/b.wav")
    a.loudness_lufs, a.loudness_peak_db, a.loudness_measured_at = -20.0, -6.0, datetime.now(UTC)
    db.add(a)
    db.commit()
    assert aa._loudness_targets(db, force=False, track_ids=[a.id], limit=None) == []
    assert aa._loudness_targets(db, force=True, track_ids=[a.id], limit=None) == [a.id]
    assert aa._loudness_targets(db, force=False, track_ids=None, limit=None) == [b.id]
    aa.detect_loudness(db, [a.id])
    db.refresh(a)
    assert (a.loudness_lufs, a.loudness_peak_db) == (-8.5, 0.7)


def test_worker_note_names_the_measurements():
    from app.jobs.worker import _grid_note

    assert _grid_note({"grids": 2, "loudness": 5}) == ", beatgrids 2, loudness 5"
    assert _grid_note({"loudness": 0}) == ""
    # Files the later phases could not read are counted, so a run that only failed never reads as a no-op.
    assert _grid_note({"keys_failed": 9, "loudness_failed": 10, "grids_failed": 0}) == ", phase failures 19"
    assert _grid_note({"keys": 3, "structures_failed": 1}) == ", keys 3, phase failures 1"
