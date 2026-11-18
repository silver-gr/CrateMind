"""The beat-grid phase of analyze_all (grid and the structure along it) and which grid the deck is
served. Hermetic: detection is stubbed, so no audio is decoded."""
from datetime import UTC, datetime

import numpy as np
import pytest
from sqlmodel import Session, select

from app.models import Track, TrackBeatgrid, TrackStructure
from app.services import audio_analysis as aa
from app.services import beatgrid_detect as bd
from app.services import track_structure as ts

GRID = bd.GridResult(bpm=140.0, anchor_s=0.25, confidence=0.97, residual_ms=0.4, downbeat_confidence=0.6)
STRUCTURE = ts.Structure(quality=0.9, sections=(ts.Section(0.25, 32, False, 0.4), ts.Section(13.964, 96, True, 1.0)),
                         anchors=(13.964,), phrases=(0.25, 13.964, 27.679))


@pytest.fixture(autouse=True)
def no_loudness_phase(monkeypatch):
    """The loudness phase has its own tests (test_loudness_phase.py); here it selects nothing."""
    monkeypatch.setattr(aa, "_loudness_targets", lambda *a, **k: [])


@pytest.fixture
def grid_calls(monkeypatch):
    """Stub the per-file detection; record (path, duration, hint)."""
    calls = []

    def fake(path, duration, hint):
        calls.append((path, duration, hint))
        if "broken" in path:
            raise RuntimeError("decode failed")
        return (None, None) if "ambient" in path else (GRID, STRUCTURE if "phrased" in path else None)

    monkeypatch.setattr(aa, "_grid_for", fake)
    monkeypatch.setattr(aa, "_structure_for", lambda *a: pytest.fail("a track without a current grid gets both at once"))
    monkeypatch.setattr(aa, "analyze_file", lambda path, **_: aa.AnalysisResult(bpm=140.0, key="A minor"))
    return calls


def _own(db, track):
    return db.exec(select(TrackBeatgrid).where(
        TrackBeatgrid.track_id == track.id, TrackBeatgrid.source == bd.SOURCE)).first()


def test_only_new_run_backfills_grids_without_reanalysing(db, grid_calls):
    analysed_at = datetime(2026, 1, 1, tzinfo=UTC)
    old = Track(absolute_path="/old.wav", analyzed_at=analysed_at, bpm_analyzed=128.0, bpm=128.0)
    gone = Track(absolute_path="/gone.wav", missing=True)
    db.add(old); db.add(gone); db.commit()
    db.add(TrackBeatgrid(track_id=old.id, source="djay", bpm=128.0, straight=True, anchor_s=0.1)); db.commit()

    result = aa.analyze_all(db, only_unprocessed=True, local_only=True)   # what «Μόνο νέα» runs

    assert result["analyzed"] == 0 and result["grids"] == 1
    assert grid_calls == [("/old.wav", None, 128.0)]                      # the resolved tempo is the octave hint
    row = _own(db, old)
    assert (row.bpm, row.anchor_s, row.straight, row.confidence, row.source_version) == (140.0, 0.25, True, 0.97, bd.VERSION)
    db.refresh(old)
    assert old.bpm_analyzed == 128.0 and old.analyzed_at.replace(tzinfo=UTC) == analysed_at   # BPM untouched
    djay = db.exec(select(TrackBeatgrid).where(TrackBeatgrid.source == "djay")).one()
    assert (djay.bpm, djay.anchor_s) == (128.0, 0.1)                       # djay's row untouched
    assert _own(db, gone) is None

    grid_calls.clear()
    aa.analyze_all(db, only_unprocessed=True, local_only=True)
    assert grid_calls == []                                                # stored: not detected again
    aa.analyze_all(db, force=True, local_only=True)
    assert [c[0] for c in grid_calls] == ["/old.wav"]                      # force re-runs it
    assert len(db.exec(select(TrackBeatgrid).where(TrackBeatgrid.source == bd.SOURCE)).all()) == 1


def test_a_new_detector_version_refills(db, grid_calls, monkeypatch):
    track = Track(absolute_path="/a.wav", analyzed_at=datetime.now(UTC))
    db.add(track); db.commit()
    aa.analyze_all(db, only_unprocessed=True, local_only=True)
    grid_calls.clear()
    monkeypatch.setattr(bd, "VERSION", bd.VERSION + 1)
    aa.analyze_all(db, only_unprocessed=True, local_only=True)
    assert len(grid_calls) == 1 and _own(db, track).source_version == bd.VERSION


def test_no_grid_is_remembered_but_a_failed_decode_is_retried(db, grid_calls):
    ambient = Track(absolute_path="/ambient.wav", analyzed_at=datetime.now(UTC))
    broken = Track(absolute_path="/broken.wav", analyzed_at=datetime.now(UTC))
    db.add(ambient); db.add(broken); db.commit()
    result = aa.analyze_all(db, only_unprocessed=True, local_only=True)
    assert result["grids"] == 0 and result["grids_failed"] == 1
    row = _own(db, ambient)
    assert row.anchor_s is None and row.confidence == 0.0
    assert _own(db, broken) is None
    grid_calls.clear()
    aa.analyze_all(db, only_unprocessed=True, local_only=True)
    assert [c[0] for c in grid_calls] == ["/broken.wav"]


def test_scope_and_job_progress(db, grid_calls):
    from app.models import Job
    a, b = Track(absolute_path="/a.wav"), Track(absolute_path="/b.wav")
    db.add(a); db.add(b); db.commit()
    job = Job(kind="analyze"); db.add(job); db.commit()
    aa.analyze_all(db, only_unprocessed=True, local_only=True, track_ids=[a.id], job=job)   # a scan's new tracks
    assert [c[0] for c in grid_calls] == ["/a.wav"]
    assert (job.total, job.processed) == (2, 2)                            # one analysis + one grid
    assert _own(db, b) is None


def test_files_outside_the_length_limits_are_not_decoded(monkeypatch):
    monkeypatch.setattr(aa, "decode_audio", lambda *a, **k: pytest.fail("decoded"))
    assert aa._grid_for("/mix.mp3", bd.MAX_SECONDS + 60.0, 140.0) == (None, None)
    assert aa._grid_for("/jingle.mp3", 5.0, None) == (None, None)


def test_grid_for_decodes_read_only_and_detects(monkeypatch):
    seen = {}

    def decode(path, *, start=0, seconds=aa.WINDOW_SECONDS):
        seen.update(path=path, seconds=seconds)
        return np.zeros(bd.SAMPLE_RATE * 40, np.float32)

    monkeypatch.setattr(aa, "decode_audio", decode)
    assert aa._grid_for("/silent.wav", 40.0, None) == (None, None)         # silent: nothing to fit
    assert seen == {"path": "/silent.wav", "seconds": bd.MAX_SECONDS + 1}


# --- the structure along the grid ---------------------------------------------------------------

def _structure(db, track):
    return db.exec(select(TrackStructure).where(TrackStructure.track_id == track.id)).first()


def test_a_new_grid_stores_its_structure_with_it(db, grid_calls):
    import json
    phrased, plain = Track(absolute_path="/phrased.wav", analyzed_at=datetime.now(UTC)), Track(absolute_path="/plain.wav", analyzed_at=datetime.now(UTC))
    db.add(phrased); db.add(plain); db.commit()
    result = aa.analyze_all(db, only_unprocessed=True, local_only=True)
    assert result["grids"] == 2 and result["structures"] == 1
    row = _structure(db, phrased)
    assert (row.version, row.quality) == (ts.VERSION, 0.9)
    data = json.loads(row.data)
    assert data["anchors"] == [13.964] and data["phrases"] == [0.25, 13.964, 27.679]
    assert data["sections"][1] == {"start_s": 13.964, "beats": 96, "bass": True, "level": 1.0}
    empty = _structure(db, plain)
    assert empty.version == ts.VERSION and empty.data is None and empty.quality is None      # remembered: not decoded again
    grid_calls.clear()
    aa.analyze_all(db, only_unprocessed=True, local_only=True)
    assert grid_calls == []


def test_a_stored_grid_only_gets_its_structure(db, monkeypatch):
    """The backlog: grids from before structures existed are read, not measured again or rewritten."""
    monkeypatch.setattr(aa, "analyze_file", lambda path, **_: aa.AnalysisResult(bpm=140.0, key="A minor"))
    monkeypatch.setattr(aa, "_grid_for", lambda *a: pytest.fail("the grid is current"))
    calls = []

    def structure_for(path, bpm, anchor_s, beats, confidence):
        calls.append((path, bpm, anchor_s, None if beats is None else [round(float(b), 2) for b in beats], confidence))
        if "broken" in path:
            raise RuntimeError("decode failed")
        return STRUCTURE

    monkeypatch.setattr(aa, "_structure_for", structure_for)
    stamp = datetime(2026, 11, 14, tzinfo=UTC)
    tracks = {name: Track(absolute_path=f"/{name}.wav", analyzed_at=stamp) for name in ("steady", "listed", "weak", "none", "broken")}
    for track in tracks.values():
        db.add(track)
    db.commit()
    own = dict(source=bd.SOURCE, source_version=bd.VERSION, imported_at=stamp)
    db.add(TrackBeatgrid(track_id=tracks["steady"].id, bpm=140.0, straight=True, anchor_s=0.25, confidence=0.97, **own))
    db.add(TrackBeatgrid(track_id=tracks["listed"].id, bpm=139.5, straight=False, anchor_s=0.88, confidence=0.9,
                         beats=np.asarray([0.02, 0.45, 0.88], dtype="<f4").tobytes(), first_downbeat_index=2, **own))
    db.add(TrackBeatgrid(track_id=tracks["weak"].id, bpm=140.0, straight=True, anchor_s=0.25, confidence=bd.MIN_CONFIDENCE - 0.01, **own))
    db.add(TrackBeatgrid(track_id=tracks["none"].id, straight=True, confidence=0.0, **own))
    db.add(TrackBeatgrid(track_id=tracks["broken"].id, bpm=140.0, straight=True, anchor_s=0.25, confidence=0.97, **own))
    db.commit()

    from app.models import Job
    job = Job(kind="analyze"); db.add(job); db.commit()
    result = aa.analyze_all(db, only_unprocessed=True, local_only=True, job=job)

    assert (job.total, job.processed) == (5, 5)                                     # each track once, decoded or not
    assert result == {**result, "grids": 0, "grids_failed": 0, "structures": 2, "structures_failed": 1}
    assert sorted(calls) == [("/broken.wav", 140.0, 0.25, None, 0.97), ("/listed.wav", 139.5, 0.88, [0.02, 0.45, 0.88], 0.9),
                             ("/steady.wav", 140.0, 0.25, None, 0.97)]              # an unusable grid is not decoded at all
    assert _structure(db, tracks["steady"]).data is not None and _structure(db, tracks["listed"]).data is not None
    assert _structure(db, tracks["weak"]).data is None and _structure(db, tracks["none"]).data is None
    assert _structure(db, tracks["broken"]) is None                                 # a failed decode is tried again
    for track in tracks.values():
        row = _own(db, track)
        assert row.imported_at.replace(tzinfo=UTC) == stamp and row.source_version == bd.VERSION   # grids untouched

    calls.clear()
    aa.analyze_all(db, only_unprocessed=True, local_only=True)
    assert [c[0] for c in calls] == ["/broken.wav"]
    calls.clear()
    monkeypatch.setattr(ts, "VERSION", ts.VERSION + 1)                               # a new method: every structure again
    aa.analyze_all(db, only_unprocessed=True, local_only=True)
    assert sorted(c[0] for c in calls) == ["/broken.wav", "/listed.wav", "/steady.wav"]
    assert _structure(db, tracks["weak"]).version == ts.VERSION


def test_a_failed_structure_keeps_the_grid_and_is_read_again_next_run(db, monkeypatch):
    monkeypatch.setattr(aa, "analyze_file", lambda path, **_: aa.AnalysisResult(bpm=140.0, key="A minor"))
    monkeypatch.setattr(aa, "decode_audio", lambda *a, **k: np.zeros(bd.SAMPLE_RATE * 40, np.float32))
    monkeypatch.setattr(bd, "detect_with_bands", lambda audio, hint: (GRID, np.zeros((8, 100))))
    monkeypatch.setattr(ts, "detect_structure", lambda bands, times: (_ for _ in ()).throw(RuntimeError("boom")))
    track = Track(absolute_path="/a.wav", duration=40.0, analyzed_at=datetime.now(UTC))
    db.add(track); db.commit()
    result = aa.analyze_all(db, only_unprocessed=True, local_only=True)
    assert (result["grids"], result["grids_failed"], result["structures"], result["structures_failed"]) == (1, 0, 0, 1)
    assert _own(db, track).anchor_s == 0.25 and _structure(db, track) is None
    # A structure left from the grid that was just replaced must not outlive it.
    db.add(TrackStructure(track_id=track.id, version=ts.VERSION, quality=0.9, data='{"sections":[],"anchors":[],"phrases":[1.0]}')); db.commit()
    assert aa.analyze_all(db, force=True, local_only=True)["structures_failed"] == 1
    assert _structure(db, track) is None
    monkeypatch.setattr(bd, "detect_with_bands", lambda *a: pytest.fail("the grid is stored"))
    monkeypatch.setattr(bd, "band_energies", lambda audio: np.zeros((8, 100)))
    monkeypatch.setattr(ts, "detect_structure", lambda bands, times: STRUCTURE)
    assert aa.analyze_all(db, only_unprocessed=True, local_only=True)["structures"] == 1
    assert _structure(db, track).quality == 0.9


def test_a_stored_grid_gives_the_same_beats_as_the_fresh_one(db):
    """The backlog reads beats back from the row: they must be the beats the grid was stored with."""
    track = Track(absolute_path="/a.wav")
    db.add(track); db.commit()
    listed = bd.GridResult(bpm=139.5, anchor_s=0.88, confidence=0.9, residual_ms=None, downbeat_confidence=0.5,
                           beats=np.round(0.02 + np.arange(400) * 0.43011, 5), first_downbeat_index=2)
    for grid in (bd.GridResult(bpm=139.9996, anchor_s=0.2531, confidence=0.97, residual_ms=0.4, downbeat_confidence=0.6), listed):
        aa._store_grid(db, track.id, grid); db.commit()
        row = _own(db, track)
        stored = aa._beat_times(row.bpm, row.anchor_s, None if row.beats is None else np.frombuffer(row.beats, dtype="<f4").astype(float), 170.0)
        fresh = aa._beat_times(grid.bpm, grid.anchor_s, grid.beats, 170.0)
        assert len(stored) == len(fresh) and np.abs(stored - fresh).max() < 1e-4


def test_phrase_lines_are_served_only_with_cratemind_s_own_grid(client):
    import json

    from app.db import get_engine
    with Session(get_engine(), expire_on_commit=False) as session:
        track = Track(absolute_path="/x/a.mp3", file_name="a.mp3", duration=100.0)
        session.add(track); session.commit()
        session.add(TrackBeatgrid(track_id=track.id, source="djay", bpm=140.0, straight=True, anchor_s=0.1))
        session.add(TrackStructure(track_id=track.id, version=ts.VERSION, quality=0.9, data=json.dumps({"sections": [], "anchors": [13.9], "phrases": [0.25, 13.9]})))
        session.commit()
        url = f"/api/tracks/{track.id}/beatgrid"
        assert client.get(url).json()["phrases"] is None                       # djay's grid: the lines were not measured on it
        session.add(TrackBeatgrid(track_id=track.id, source=bd.SOURCE, source_version=bd.VERSION, bpm=140.0, straight=True, anchor_s=0.25, confidence=0.97))
        session.commit()
        assert client.get(url).json()["phrases"] == [0.25, 13.9]
        row = session.exec(select(TrackStructure)).one(); row.data = None; session.add(row); session.commit()
        assert client.get(url).json()["phrases"] is None


def test_structure_is_read_only_along_a_confident_grid():
    bands = np.zeros((8, 4000))
    assert aa._structure_of(bands, 140.0, 0.25, None, bd.MIN_CONFIDENCE - 0.01, 20.0) is None
    assert aa._structure_of(bands, 140.0, None, None, 0.97, 20.0) is None
    assert aa._structure_of(None, 140.0, 0.25, None, 0.97, 20.0) is None
    times = aa._beat_times(120.0, 0.25, None, 10.0)
    assert times[0] == 0.25 and np.allclose(np.diff(times), 0.5) and times[-1] < 10.0 <= times[-1] + 0.5
    assert list(aa._beat_times(120.0, 0.25, np.array([0.1, 0.6]), 10.0)) == [0.1, 0.6]


# --- which grid the deck is served --------------------------------------------------------------

def _serve(client, rows):
    from app.db import get_engine
    with Session(get_engine()) as session:
        track = Track(absolute_path=f"/t{len(rows)}-{id(rows)}.wav")
        session.add(track); session.commit()
        for row in rows:
            session.add(TrackBeatgrid(track_id=track.id, **row))
        session.commit()
        tid = track.id
    return client.get(f"/api/tracks/{tid}/beatgrid")


OWN = dict(source="cratemind", bpm=140.0, straight=True, anchor_s=0.25, confidence=0.95, first_downbeat_index=0,
           source_version=bd.VERSION)
OWN_LIST = {**OWN, "straight": False, "first_downbeat_index": 1, "anchor_s": 0.68,
            "beats": np.array([0.25, 0.68, 1.11, 1.7, 2.13], "<f4").tobytes()}
DJAY = dict(source="djay", bpm=140.0, straight=True, anchor_s=0.31, first_downbeat_index=0)
FLEX = dict(source="djay", bpm=139.0, straight=False, anchor_s=0.3, first_downbeat_index=0,
            beats=np.array([0.3, 0.73, 1.16], "<f4").tobytes())


def test_own_grid_is_served_before_a_steady_djay_grid(client):
    assert _serve(client, [DJAY, OWN]).json()["source"] == "cratemind"
    assert _serve(client, [OWN]).json()["anchor_s"] == 0.25


def test_own_confident_grid_is_served_before_a_flexible_djay_grid(client):
    assert _serve(client, [FLEX, OWN]).json()["source"] == "cratemind"
    body = _serve(client, [FLEX, OWN_LIST]).json()
    assert (body["source"], body["straight"], body["first_downbeat_index"]) == ("cratemind", False, 1)
    assert body["beats"] == pytest.approx([0.25, 0.68, 1.11, 1.7, 2.13]) and body["bpm"] == 140.0
    weak = {**OWN_LIST, "confidence": bd.MIN_CONFIDENCE - 0.01}
    assert _serve(client, [FLEX, weak]).json()["source"] == "djay"


def test_a_row_from_the_steady_only_detector_stays_behind_a_flexible_djay_grid(client):
    old = {**OWN, "source_version": bd.LISTS_SINCE - 1}
    body = _serve(client, [FLEX, old]).json()
    assert body["source"] == "djay" and body["straight"] is False and len(body["beats"]) == 3
    assert _serve(client, [DJAY, old]).json()["source"] == "cratemind"      # as before: ahead of a steady djay grid
    assert _serve(client, [old]).json()["source"] == "cratemind"


def test_a_list_is_stored_and_later_replaced_cleanly(db):
    track = Track(absolute_path="/lib/sections.flac", duration=300.0)
    db.add(track); db.commit()
    db.add(TrackBeatgrid(track_id=track.id, source="djay", bpm=128.0, straight=True, anchor_s=0.1)); db.commit()
    beats = np.array([0.02, 0.45, 0.88, 1.31, 1.9, 2.33])
    listed = bd.GridResult(bpm=139.5, anchor_s=0.88, confidence=0.9, residual_ms=None, downbeat_confidence=0.5,
                           beats=beats, first_downbeat_index=2)
    aa._store_grid(db, track.id, listed); db.commit()
    row = _own(db, track)
    assert (row.straight, row.bpm, row.anchor_s, row.first_downbeat_index, row.source_version) == (False, 139.5, 0.88, 2, bd.VERSION)
    assert np.frombuffer(row.beats, "<f4") == pytest.approx(beats)
    aa._store_grid(db, track.id, GRID); db.commit()
    row = _own(db, track)
    assert (row.straight, row.beats, row.first_downbeat_index, row.anchor_s) == (True, None, 0, 0.25)
    aa._store_grid(db, track.id, listed); aa._store_grid(db, track.id, None); db.commit()
    row = _own(db, track)
    assert (row.straight, row.beats, row.first_downbeat_index, row.anchor_s, row.confidence) == (True, None, None, None, 0.0)
    djay = db.exec(select(TrackBeatgrid).where(TrackBeatgrid.source == "djay")).one()
    assert (djay.bpm, djay.straight, djay.anchor_s) == (128.0, True, 0.1)


def test_a_confident_steady_grid_sets_the_tracks_bpm_and_anything_else_clears_it(db):
    track = Track(absolute_path="/lib/tempo.flac", duration=300.0, bpm_consensus=139.4, bpm_consensus_sources="local+reccobeats")
    db.add(track); db.commit()
    steady = bd.GridResult(bpm=139.9996, anchor_s=0.25, confidence=0.97, residual_ms=0.4, downbeat_confidence=0.6)
    aa._store_grid(db, track.id, steady); db.commit(); db.refresh(track)
    assert track.bpm_grid == 140.0
    listed = bd.GridResult(bpm=139.5, anchor_s=0.88, confidence=0.9, residual_ms=None, downbeat_confidence=0.5,
                           beats=np.array([0.02, 0.45, 0.88, 1.31]), first_downbeat_index=2)
    for other in (listed, bd.GridResult(bpm=140.0, anchor_s=0.25, confidence=0.5, residual_ms=3.0, downbeat_confidence=0.3), None):
        aa._store_grid(db, track.id, steady); aa._store_grid(db, track.id, other); db.commit(); db.refresh(track)
        assert track.bpm_grid is None


def test_the_octave_hint_ignores_the_stored_grid_tempo(db, grid_calls):
    track = Track(absolute_path="/lib/hint.flac", duration=300.0, bpm_analyzed=176.0, bpm_grid=132.0)
    db.add(track); db.commit()
    aa.detect_grids(db, [track.id])
    assert [hint for _path, _duration, hint in grid_calls] == [176.0]


def test_a_therapy_analysis_drops_the_grid_tempo():
    from app.services.bpm_consensus import _refresh_consensus

    track = Track(absolute_path="/lib/ambient.flac", bpm_grid=90.0, bpm_analyzed=88.0, bpm_analyzed_method="librosa-onset-wide-v1@40-240")
    _refresh_consensus(track, 3.0)
    assert track.bpm_grid is None
    dj = Track(absolute_path="/lib/dj.flac", bpm_grid=146.0, bpm_analyzed=146.0, bpm_analyzed_method="librosa-onset-multilag-v2@133-286")
    _refresh_consensus(dj, 3.0)
    assert dj.bpm_grid == 146.0


def test_low_confidence_falls_back_to_djay_or_nothing(client):
    weak = {**OWN, "confidence": bd.MIN_CONFIDENCE - 0.01}
    assert _serve(client, [DJAY, weak]).json()["source"] == "djay"
    assert _serve(client, [weak]).status_code == 404
    assert _serve(client, [{**OWN, "anchor_s": None, "bpm": None, "confidence": 0.0}]).status_code == 404
    assert _serve(client, [{**DJAY, "edited": True}, OWN]).json()["source"] == "cratemind"


def test_job_message_mentions_grids_only_when_some_were_built():
    from app.jobs import worker
    assert worker._grid_note({"grids": 3}) == ", beatgrids 3"
    assert worker._grid_note({"grids": 0}) == "" and worker._grid_note({}) == ""


def test_end_to_end_on_a_synthetic_file(client, tmp_path):
    """Real ffmpeg decode and real detection, on a kick train written here; then the route serves it."""
    import shutil
    import wave
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg not on PATH")
    from app.db import get_engine
    rate, bpm, first, seconds = 22050, 132.0, 0.2, 90
    rng = np.random.default_rng(3)
    t = np.arange(int(0.15 * rate)) / rate
    click = rng.standard_normal(len(t)) * np.exp(-t * 800) * 0.5
    kick = np.sin(2 * np.pi * 55 * t) * np.exp(-t * 25) + click
    audio = rng.standard_normal(seconds * rate) * 0.002
    for n, beat in enumerate(np.arange(first, seconds - 1, 60 / bpm)):
        i = int(round(beat * rate))
        audio[i:i + len(kick)] += kick if 32 <= n < 160 else click       # the bass comes in at beat 32 and leaves at 160
    path = tmp_path / "lib" / "kicks.wav"
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "w") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes((np.clip(audio / np.abs(audio).max(), -1, 1) * 30000).astype("<i2").tobytes())
    before = path.read_bytes()
    with Session(get_engine()) as session:
        track = Track(absolute_path=str(path), duration=float(seconds), bpm=132.0, analyzed_at=datetime.now(UTC))
        session.add(track); session.commit()
        result = aa.analyze_all(session, only_unprocessed=True, local_only=True)
        tid = track.id
    assert result["grids"] == 1 and result["grids_failed"] == 0 and result["structures"] == 1
    body = client.get(f"/api/tracks/{tid}/beatgrid").json()
    structure = client.get(f"/api/tracks/{tid}/structure").json()
    assert [(s["bass"], s["beats"]) for s in structure["sections"]][:2] == [(False, 32), (True, 128)]
    assert structure["anchors"] == [pytest.approx(first + 32 * 60 / bpm, abs=0.02)]
    assert body["phrases"] == structure["phrases"] and structure["anchors"][0] in body["phrases"]
    assert body["source"] == "cratemind" and body["straight"] is True
    assert body["bpm"] == pytest.approx(132.0, abs=0.05)
    period = 60 / 132.0
    assert abs((body["anchor_s"] - first + period / 2) % period - period / 2) < 0.008
    assert body["confidence"] >= bd.MIN_CONFIDENCE
    assert path.read_bytes() == before          # the source file is only read
