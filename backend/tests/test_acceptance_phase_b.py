"""Acceptance: therapy Phase B (B4 tempo windows, scoped analysis, manual ×½ / ×2).

Black-box over the public routes (/api/scan/analyze, /api/tracks/{id}/bpm,
/api/tracks?q=, /api/settings) and the functions the plan's Shared Interfaces
document (analyze_all, resolve_track_range, _refresh_consensus, the registry).
Flows, from the spec's Phase B and the plan's decisions and Review Focus:

1. Scoped analysis dry-run counts: missing tracks excluded, `query: ""` = the library.
2. A scoped start writes a plan file with the window and the ids (process start
   monkeypatched; no real DSP over real files).
3. A scoped request gets 409 while any job runs; its dry run still answers.
4. Manual ×½ / ×2: effective BPM, `bpm:` search, audit, reset recompute, bounds
   422s, and the desktop-core import guard (fresh interpreter).
5. Therapy analyze_all on synthetic audio: ambient stores no BPM, no error, the
   therapy method, and «Μόνο νέα» does not retry it; 60 BPM clicks store ~60.
6. Folder windows resolve on connected paths under a logical/connected mapping.
7. The DJ psy method string and window.
8. The therapy consensus local-vote rule.

Every track is a hand-built row under tmp_path or a fake path; audio is the
synthetic generators in tests/tempo_signals.py, fed through a patched decode_audio.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from sqlmodel import Session, select

import app.config as cfg
import app.db as dbmod
from app.jobs import worker
from app.models import AuditLog, Job, Track
from app.services import audio_analysis as aa
from app.services import bpm_consensus as bc
from app.services import library_paths
from app.services.tempo import effective_bpm
from app.services.tempo_ranges import TEMPO_RANGES, resolve_track_range
from tests import tempo_signals as ts

SR = aa.SAMPLE_RATE
BUSY = "Εκτελείται ήδη άλλη εργασία"
NO_TRACKS = "Δεν βρέθηκαν tracks για ανάλυση"
NO_BPM = "Δεν υπάρχει BPM για αλλαγή"
OUT_OF_BOUNDS = "Το BPM βγαίνει εκτός ορίων"
NOT_FOUND = "Το track δεν βρέθηκε"
PSY_METHOD = "librosa-onset-multilag-v2@133-286"
PSY_FALLBACK = "ffmpeg+onset-autocorr-v1@133-286"
THERAPY_METHOD = "librosa-onset-wide-v1@40-240"
MANUAL = "manual:octave"


# ================================================================ helpers ===

def _ok(resp, status: int = 200):
    assert resp.status_code == status, (resp.status_code, resp.text)
    return resp.json()


def _seed(*rows: dict) -> list[int]:
    with Session(dbmod.get_engine()) as s:
        tracks = [Track(**{"missing": False, **row}) for row in rows]
        s.add_all(tracks)
        s.commit()
        ids = [t.id for t in tracks]
        for tid in ids:
            dbmod.reindex_track(s, tid, commit=False)
        s.commit()
    return ids


def _track(tid: int) -> Track:
    with Session(dbmod.get_engine()) as s:
        return s.get(Track, tid)


def _jobs() -> list[Job]:
    with Session(dbmod.get_engine()) as s:
        return list(s.exec(select(Job)).all())


def _audit(tid: int) -> list[AuditLog]:
    with Session(dbmod.get_engine()) as s:
        return list(s.exec(
            select(AuditLog).where(AuditLog.action == "bpm_manual_update", AuditLog.entity_id == tid)
            .order_by(AuditLog.id)
        ).all())


def _near(value: float | None, expected: float, pct: float = 0.02) -> bool:
    return value is not None and abs(value - expected) <= pct * expected


def _decoder(signal: np.ndarray):
    """A decode_audio stand-in that serves one synthetic signal at any offset."""
    def decode(path, *, start: float = 0, seconds: float = aa.WINDOW_SECONDS):
        a, b = int(start * SR), int((start + seconds) * SR)
        out = signal[a:b]
        if out.size == 0:
            raise RuntimeError("decoded audio was empty")
        return out.astype(np.float32)
    return decode


@pytest.fixture
def ffmpeg(monkeypatch):
    """Report ffmpeg as present; the start itself is patched, so it never runs."""
    monkeypatch.setenv("CRATEMIND_FFMPEG_PATH", "/nonexistent/acceptance-ffmpeg")
    cfg.get_settings.cache_clear()
    yield
    cfg.get_settings.cache_clear()


@pytest.fixture
def started(monkeypatch):
    """Capture worker.start_analyze (args plus the plan it was handed)."""
    calls: list[dict] = []

    def fake(job_id, force=False, limit=None, plan_path=None):
        plan = json.loads(Path(plan_path).read_text(encoding="utf-8")) if plan_path else None
        calls.append({"args": (job_id, force, limit, plan_path), "plan": plan})
        return True

    monkeypatch.setattr(worker, "start_analyze", fake)
    yield calls
    for call in calls:
        if call["args"][3]:
            Path(call["args"][3]).unlink(missing_ok=True)


# ====================================== 1. scoped analysis dry-run counts ===

def test_dry_run_counts_exclude_missing_and_empty_query_means_library(client, monkeypatch):
    # The dry run needs no ffmpeg (plan: the ffmpeg check applies to a start only).
    monkeypatch.setenv("CRATEMIND_FFMPEG_PATH", "")
    monkeypatch.setattr("shutil.which", lambda *_a, **_k: None)
    cfg.get_settings.cache_clear()
    zed = _seed(*({"absolute_path": f"/z/{i}.mp3", "artist": "Zed"} for i in range(3)))
    (gone,) = _seed({"absolute_path": "/z/gone.mp3", "artist": "Zed", "missing": True})
    (other,) = _seed({"absolute_path": "/o/1.mp3", "artist": "Other"})

    dry = lambda scope: _ok(client.post("/api/scan/analyze", json={**scope, "dry_run": True}))
    assert dry({"query": "artist:Zed"}) == {"matched": 3}
    assert dry({"track_ids": [*zed, gone, other]}) == {"matched": 4}
    assert dry({"query": ""}) == {"matched": 4}  # whole library, minus the missing track
    assert dry({"track_ids": [zed[0], 987654]}) == {"matched": 1}  # unknown ids never count
    assert dry({"query": "artist:Nobody"}) == {"matched": 0}
    assert dry({"query": "", "tempo_range": "therapy"}) == {"matched": 4}
    assert _jobs() == []  # a dry run creates no job


def test_analyze_request_validation_422s(client):
    _seed({"absolute_path": "/z/1.mp3"})
    bad = [
        {"query": "", "track_ids": [1], "dry_run": True},       # both scopes
        {"query": "", "tempo_range": "house", "dry_run": True},  # unknown window
        {"root_ranges": {"/Music": "therapy"}},                 # therapy is not a folder window
        {"root_ranges": {"/Music": "fast"}},
        {"dry_run": True},                                       # a dry run needs a scope
    ]
    for body in bad:
        assert client.post("/api/scan/analyze", json=body).status_code == 422, body
    assert client.post("/api/scan/start", json={"tempo_range": "house"}).status_code == 422
    assert client.post("/api/scan/start", json={"root_ranges": {"/M": "therapy"}}).status_code == 422
    assert _jobs() == []


# ========================================== 2. scoped start writes a plan ===

def test_scoped_query_start_writes_plan_with_window_and_ids(client, ffmpeg, started):
    present = _seed({"absolute_path": "/z/1.mp3", "artist": "Zed"}, {"absolute_path": "/z/2.mp3", "artist": "Zed"})
    _seed({"absolute_path": "/z/3.mp3", "artist": "Zed", "missing": True})
    # An explicit scope's window wins over the folder windows: they are dropped.
    job = _ok(client.post("/api/scan/analyze", json={
        "query": "", "tempo_range": "slow", "root_ranges": {"/z": "mixed"}, "force": True, "limit": 1,
    }))
    assert job["kind"] == "analyze"
    (call,) = started
    job_id, force, limit, plan_path = call["args"]
    assert (job_id, force, limit) == (job["id"], False, None)
    assert isinstance(plan_path, str) and Path(plan_path).is_file()
    assert call["plan"] == {"tempo_range": "slow", "root_ranges": {}, "track_ids": sorted(present), "scoped": True}


def test_scoped_ids_start_keeps_spawn_args_constant_size(client, ffmpeg, started):
    ids = _seed(*({"absolute_path": f"/many/{i:04d}.mp3"} for i in range(1200)))
    job = _ok(client.post("/api/scan/analyze", json={"track_ids": ids, "tempo_range": "therapy"}))
    (call,) = started
    assert not any(isinstance(arg, (list, tuple, dict)) for arg in call["args"])
    assert call["plan"]["track_ids"] == sorted(ids)
    assert call["plan"]["tempo_range"] == "therapy" and call["plan"]["scoped"] is True
    assert [j.id for j in _jobs()] == [job["id"]]


def test_scoped_start_ignores_missing_provider_keys(client, ffmpeg, started, monkeypatch):
    monkeypatch.setenv("CRATEMIND_GETSONGBPM_ENABLED", "true")
    monkeypatch.setenv("CRATEMIND_GETSONGBPM_BULK_ENABLED", "true")
    monkeypatch.setenv("CRATEMIND_GETSONGBPM_API_KEY", "")
    monkeypatch.setenv("CRATEMIND_CYANITE_ENABLED", "true")
    monkeypatch.setenv("CRATEMIND_CYANITE_ACCESS_TOKEN", "")
    cfg.get_settings.cache_clear()
    ids = _seed({"absolute_path": "/z/1.mp3"})
    assert _ok(client.post("/api/scan/analyze", json={"track_ids": ids, "dry_run": True})) == {"matched": 1}
    _ok(client.post("/api/scan/analyze", json={"track_ids": ids}))
    assert len(started) == 1
    # The unscoped path still guards its providers.
    assert client.post("/api/scan/analyze", json={}).status_code == 400


def test_scoped_start_with_nothing_to_analyse_is_400(client, ffmpeg, started):
    _seed({"absolute_path": "/z/gone.mp3", "missing": True})
    for scope in ({"query": "artist:Nobody"}, {"track_ids": [987654]}, {"query": ""}):
        r = client.post("/api/scan/analyze", json=scope)
        assert r.status_code == 400, scope
        assert r.json()["detail"] == NO_TRACKS
    assert started == [] and _jobs() == []


def test_plan_file_removed_when_start_refuses_or_raises(client, ffmpeg, monkeypatch):
    ids = _seed({"absolute_path": "/z/1.mp3"})
    paths: list[str] = []

    def refuse(job_id, force=False, limit=None, plan_path=None):
        paths.append(plan_path)
        return False

    monkeypatch.setattr(worker, "start_analyze", refuse)
    r = client.post("/api/scan/analyze", json={"track_ids": ids})
    assert r.status_code == 409
    assert paths and not Path(paths[-1]).exists()
    assert [j.status for j in _jobs()] == ["error"]

    def boom(job_id, force=False, limit=None, plan_path=None):
        paths.append(plan_path)
        raise OSError("spawn failed")

    monkeypatch.setattr(worker, "start_analyze", boom)
    with pytest.raises(OSError):
        client.post("/api/scan/analyze", json={"track_ids": ids})
    assert not Path(paths[-1]).exists()


def test_scoped_scope_stays_under_the_variable_cap(client, low_variable_limit, ffmpeg, started, monkeypatch):
    """150 tracks against a 100-variable cap: no step binds one variable per track."""
    ids = _seed(*({"absolute_path": f"/cap/{i:03d}.mp3", "artist": "Cap"} for i in range(150)))
    assert _ok(client.post("/api/scan/analyze", json={"track_ids": ids, "dry_run": True})) == {"matched": 150}
    assert _ok(client.post("/api/scan/analyze", json={"query": "artist:Cap", "dry_run": True})) == {"matched": 150}
    _ok(client.post("/api/scan/analyze", json={"track_ids": ids}))
    plan = started[0]["plan"]
    assert len(plan["track_ids"]) == 150
    seen: list[str] = []
    monkeypatch.setattr(aa, "analyze_file", lambda path, **kw: seen.append(path) or aa.AnalysisResult())
    with Session(dbmod.get_engine()) as s:
        aa.analyze_all(s, force=True, local_only=True, track_ids=plan["track_ids"], tempo_range=plan["tempo_range"])
    assert len(seen) == 150


# =========================================== 3. 409 while a job is running ===

def test_scoped_request_gets_409_while_a_job_runs(client, ffmpeg, started):
    ids = _seed({"absolute_path": "/z/1.mp3"}, {"absolute_path": "/z/2.mp3"})
    first = _ok(client.post("/api/scan/analyze", json={"track_ids": ids[:1]}))
    for scope in ({"track_ids": ids}, {"query": ""}):
        r = client.post("/api/scan/analyze", json=scope)
        assert r.status_code == 409, scope
        assert r.json()["detail"].startswith(f"{BUSY} (#{first['id']})")
        # The dry run still answers while busy.
        assert _ok(client.post("/api/scan/analyze", json={**scope, "dry_run": True})) == {"matched": 2}
    assert len(started) == 1  # never attached to, never a second start


def test_scoped_request_gets_409_while_a_scan_runs(client, ffmpeg, started):
    ids = _seed({"absolute_path": "/z/1.mp3"})
    with Session(dbmod.get_engine()) as s:
        scan = worker.create_job(s, "scan")
    r = client.post("/api/scan/analyze", json={"track_ids": ids, "tempo_range": "mixed"})
    assert r.status_code == 409
    assert f"(#{scan.id})" in r.json()["detail"]
    assert started == []


# ================================================= 4. manual ×½ / ×2 BPM ===

def test_halve_then_double_round_trips_and_audits(client):
    (tid,) = _seed({"absolute_path": "/m/a.mp3", "bpm_analyzed": 147.33, "bpm_analyzed_method": PSY_METHOD})
    half = _ok(client.post(f"/api/tracks/{tid}/bpm", json={"factor": 0.5}))
    assert half == {"track_id": tid, "bpm_consensus": 147.33 / 2, "bpm_consensus_sources": MANUAL,
                    "effective_bpm": 147.33 / 2}
    back = _ok(client.post(f"/api/tracks/{tid}/bpm", json={"factor": 2}))
    assert back["effective_bpm"] == 147.33 and back["bpm_consensus"] == 147.33  # exact, unrounded
    row = _track(tid)
    assert (row.bpm, row.bpm_analyzed, row.bpm_analyzed_method) == (None, 147.33, PSY_METHOD)
    assert row.bpm_needs_review is False
    audit = _audit(tid)
    assert len(audit) == 2
    assert json.loads(audit[0].before_json) == {"bpm_consensus": None, "bpm_consensus_sources": None}
    assert json.loads(audit[0].after_json) == {"bpm_consensus": 147.33 / 2, "bpm_consensus_sources": MANUAL}
    assert json.loads(audit[1].after_json)["bpm_consensus"] == 147.33


def test_server_is_stateless_so_two_clicks_compound(client):
    (tid,) = _seed({"absolute_path": "/m/a.mp3", "bpm_analyzed": 70.0})
    _ok(client.post(f"/api/tracks/{tid}/bpm", json={"factor": 2}))
    assert _ok(client.post(f"/api/tracks/{tid}/bpm", json={"factor": 2}))["effective_bpm"] == 280.0


def test_manual_value_beats_tag_and_search_follows(client):
    halved, other = _seed({"absolute_path": "/m/a.mp3", "artist": "A", "bpm": 190.0},
                          {"absolute_path": "/m/b.mp3", "artist": "B", "bpm": 96.0})
    assert _ok(client.post(f"/api/tracks/{halved}/bpm", json={"factor": 0.5}))["effective_bpm"] == 95.0
    found = lambda q: sorted(row["id"] for row in _ok(client.get("/api/tracks", params={"q": q})))
    assert found("bpm:90-100") == sorted([halved, other])
    assert found("bpm:94-95.5") == [halved]
    assert found("bpm:185-195") == []
    assert _track(halved).bpm == 190.0  # the tag value is never touched


def test_reset_recomputes_the_automatic_value(client):
    (tid,) = _seed({"absolute_path": "/m/a.mp3", "bpm": 145.0})
    assert _ok(client.post(f"/api/tracks/{tid}/bpm", json={"factor": 0.5}))["effective_bpm"] == 72.5
    reset = _ok(client.delete(f"/api/tracks/{tid}/bpm"))
    assert reset == {"track_id": tid, "bpm_consensus": 145.0, "bpm_consensus_sources": "metadata",
                     "effective_bpm": 145.0}
    audit = _audit(tid)
    assert len(audit) == 2
    assert json.loads(audit[1].before_json) == {"bpm_consensus": 72.5, "bpm_consensus_sources": MANUAL}
    assert json.loads(audit[1].after_json) == {"bpm_consensus": 145.0, "bpm_consensus_sources": "metadata"}
    # A reset on a non-manual value is a 200 no-op.
    assert _ok(client.delete(f"/api/tracks/{tid}/bpm")) == reset
    assert len(_audit(tid)) == 2


def test_bounds_and_errors(client):
    none, low, high, edge_lo, edge_hi = _seed(
        {"absolute_path": "/m/none.mp3"},
        {"absolute_path": "/m/low.mp3", "bpm": 30.0},
        {"absolute_path": "/m/high.mp3", "bpm": 250.0},
        {"absolute_path": "/m/elo.mp3", "bpm": 60.0},
        {"absolute_path": "/m/ehi.mp3", "bpm": 200.0},
    )
    cases = [(none, 0.5, NO_BPM), (low, 0.5, OUT_OF_BOUNDS), (high, 2, OUT_OF_BOUNDS)]
    for tid, factor, message in cases:
        r = client.post(f"/api/tracks/{tid}/bpm", json={"factor": factor})
        assert r.status_code == 422, (tid, r.text)
        assert r.json()["detail"] == message
        assert _audit(tid) == [] and _track(tid).bpm_consensus_sources is None
    for factor in (3, 1, 0.25, -2, None):
        assert client.post(f"/api/tracks/{low}/bpm", json={"factor": factor}).status_code == 422, factor
    assert client.post(f"/api/tracks/{low}/bpm", json={}).status_code == 422
    # The bounds are inclusive: 30 and 400.
    assert _ok(client.post(f"/api/tracks/{edge_lo}/bpm", json={"factor": 0.5}))["effective_bpm"] == 30.0
    assert _ok(client.post(f"/api/tracks/{edge_hi}/bpm", json={"factor": 2}))["effective_bpm"] == 400.0
    for method in ("post", "delete"):
        kwargs = {"json": {"factor": 0.5}} if method == "post" else {}
        r = getattr(client, method)("/api/tracks/987654/bpm", **kwargs)
        assert r.status_code == 404 and r.json()["detail"] == NOT_FOUND


def test_desktop_core_manual_bpm_and_scoped_dry_run_import_no_dsp(tmp_path):
    """A fresh interpreter: once a test imports scipy, an in-process check means nothing."""
    script = r'''
import sys
from app.config import get_settings, Settings
get_settings.cache_clear()
import app.config
app.config.get_settings = lambda: Settings(_env_file=None)
from fastapi.testclient import TestClient
from sqlmodel import Session
from app.app_factory import create_app
from app.models import Track
app = create_app("desktop-core")
with TestClient(app) as client:
    from app.db import get_engine, reindex_track
    with Session(get_engine(), expire_on_commit=False) as session:
        tagged = Track(absolute_path="/x/d.wav", file_name="d.wav", artist="Zed", bpm=145.0)
        analysed = Track(absolute_path="/x/e.wav", file_name="e.wav", artist="Zed", bpm_analyzed=190.0,
                         bpm_analyzed_method="librosa-onset-multilag-v2@133-286")
        session.add_all([tagged, analysed])
        session.commit()
        reindex_track(session, tagged.id)
        reindex_track(session, analysed.id)
    r = client.post(f"/api/tracks/{analysed.id}/bpm", json={"factor": 0.5})
    assert r.status_code == 200 and r.json()["effective_bpm"] == 95.0, r.text
    r = client.get("/api/tracks", params={"q": "bpm:90-100"})
    assert [row["id"] for row in r.json()] == [analysed.id], r.text
    r = client.post(f"/api/tracks/{tagged.id}/bpm", json={"factor": 3})
    assert r.status_code == 422, r.text
    r = client.post(f"/api/tracks/{tagged.id}/bpm", json={"factor": 0.5})
    assert r.status_code == 200 and r.json()["effective_bpm"] == 72.5, r.text
    r = client.delete(f"/api/tracks/{tagged.id}/bpm")
    assert r.status_code == 200 and r.json()["bpm_consensus_sources"] == "metadata", r.text
    r = client.delete(f"/api/tracks/{analysed.id}/bpm")
    assert r.status_code == 200 and r.json()["effective_bpm"] == 190.0, r.text
    r = client.post("/api/scan/analyze", json={"query": "artist:Zed", "dry_run": True,
                                              "tempo_range": "therapy"})
    assert r.status_code == 200 and r.json() == {"matched": 2}, r.text
for name in ("scipy", "librosa", "essentia", "app.services.audio_analysis", "app.api.analysis"):
    assert name not in sys.modules, name
'''
    env = {k: v for k, v in os.environ.items() if not k.startswith("CRATEMIND_")}
    env.update(CRATEMIND_DB_PATH=str(tmp_path / "catalog.sqlite"),
               CRATEMIND_BACKUP_DIR=str(tmp_path / "backups"),
               CRATEMIND_OUTPUT_DIR=str(tmp_path / "out"),
               CRATEMIND_LIBRARY_ROOTS=str(tmp_path / "lib"),
               CRATEMIND_RUNTIME_PROFILE="desktop-core")
    backend = Path(__file__).resolve().parents[1]
    result = subprocess.run([sys.executable, "-c", script], check=False, env=env, capture_output=True, text=True,
                            cwd=backend, stdin=subprocess.DEVNULL, timeout=300)
    assert result.returncode == 0, result.stderr[-4000:]


# ========================================= 5. therapy analyze_all, synthetic ===

def test_therapy_ambient_stores_no_bpm_no_error_and_is_not_retried(db, monkeypatch):
    monkeypatch.setattr(aa, "decode_audio", _decoder(ts.bench_signal("ambient", 270.0)))
    db.add(Track(absolute_path="/t/ambient.wav"))
    db.commit()
    result = aa.analyze_all(db, only_unprocessed=True, local_only=True, tempo_range="therapy")
    t = db.exec(select(Track)).one()
    db.refresh(t)
    assert t.bpm_analyzed is None and t.bpm_analyzed_raw is None
    assert t.analysis_error is None
    assert t.bpm_analyzed_method == THERAPY_METHOD
    assert t.bpm_analyzed_confidence is not None and t.bpm_analyzed_confidence < aa.THERAPY_CONF_GATE
    assert t.analyzed_at is not None
    assert t.key_analyzed is not None  # key analysis still runs
    assert result["failed"] == 0
    assert effective_bpm(t) is None

    calls: list[str] = []
    real = aa.analyze_file
    monkeypatch.setattr(aa, "analyze_file", lambda path, **kw: calls.append(path) or real(path, **kw))
    aa.analyze_all(db, only_unprocessed=True, local_only=True, tempo_range="therapy")  # «Μόνο νέα»
    assert calls == []


def test_therapy_clicks_at_60_store_about_60(db, monkeypatch, tmp_path):
    monkeypatch.setattr(aa, "decode_audio", _decoder(ts.bench_signal("click-60", 270.0)))
    folder = tmp_path / "lib"
    db.add(Track(absolute_path=str(folder / "clicks.wav")))
    db.commit()
    # The therapy profile ignores DJ folder windows.
    aa.analyze_all(db, force=True, local_only=True, tempo_range="therapy", root_ranges={str(folder): "psy"})
    t = db.exec(select(Track)).one()
    db.refresh(t)
    assert t.bpm_analyzed_method == THERAPY_METHOD
    assert _near(t.bpm_analyzed, 60.0) and _near(t.bpm_analyzed_raw, 60.0), (t.bpm_analyzed, t.bpm_analyzed_raw)
    assert t.analysis_error is None
    assert _near(effective_bpm(t), 60.0)


def test_therapy_only_new_never_reanalyses_a_dj_value(db, monkeypatch):
    """Re-analysing a track that already has a DJ value needs an explicit action."""
    from datetime import UTC, datetime
    db.add_all([Track(absolute_path="/t/old.wav", bpm_analyzed=240.0, bpm_analyzed_method=PSY_METHOD,
                      analyzed_at=datetime.now(UTC)),
                Track(absolute_path="/t/new.wav")])
    db.commit()
    seen: dict[str, str] = {}
    monkeypatch.setattr(aa, "analyze_file",
                        lambda path, **kw: seen.setdefault(path, kw["tempo_range"].key) and aa.AnalysisResult())
    aa.analyze_all(db, only_unprocessed=True, local_only=True, tempo_range="therapy")
    assert seen == {"/t/new.wav": "therapy"}
    old = db.exec(select(Track).where(Track.absolute_path == "/t/old.wav")).one()
    assert (old.bpm_analyzed, old.bpm_analyzed_method) == (240.0, PSY_METHOD)


def test_reanalysis_keeps_a_manual_value(client, monkeypatch):
    (tid,) = _seed({"absolute_path": "/m/a.mp3", "bpm_analyzed": 190.0, "bpm_analyzed_method": PSY_METHOD})
    _ok(client.post(f"/api/tracks/{tid}/bpm", json={"factor": 0.5}))
    monkeypatch.setattr(aa, "analyze_file", lambda path, **kw: aa.AnalysisResult(
        bpm=191.0, bpm_raw=191.0, bpm_confidence=0.9, bpm_method=PSY_METHOD, key="8A", key_confidence=0.5))
    with Session(dbmod.get_engine()) as s:
        aa.analyze_all(s, force=True, local_only=True, track_ids=[tid])
    row = _track(tid)
    assert (row.bpm_consensus, row.bpm_consensus_sources, row.bpm_analyzed) == (95.0, MANUAL, 191.0)
    assert _ok(client.delete(f"/api/tracks/{tid}/bpm"))["effective_bpm"] == 191.0


# ======================================== 6. folder windows, connected paths ===

def test_folder_windows_follow_the_listed_connected_roots(client, tmp_path, monkeypatch, ffmpeg, started):
    a, b, ab = tmp_path / "MusicA", tmp_path / "MusicB", tmp_path / "MusicAB"
    for d in (a / "House", b / "Down", ab):
        d.mkdir(parents=True)
    mappings = tmp_path / "mappings.json"
    mappings.write_text(json.dumps({"version": 1, "library_roots": [
        {"root_key": "a", "logical_prefix": "/Volumes/Old/Music", "logical_flavor": "posix", "local_prefix": str(a)},
        {"root_key": "b", "logical_prefix": "C:\\Music", "logical_flavor": "windows", "local_prefix": str(b)},
        {"root_key": "ab", "logical_prefix": "/Volumes/Other", "logical_flavor": "posix", "local_prefix": str(ab)},
    ]}), encoding="utf-8")
    monkeypatch.setenv("CRATEMIND_PATH_MAPPINGS_FILE", str(mappings))
    cfg.get_settings.cache_clear()
    library_paths._read_mappings.cache_clear()
    try:
        roots = _ok(client.get("/api/settings"))["library_roots"]
        assert roots == [str(a), str(b), str(ab)]
        # Settings keys the per-folder select by the listed (connected) root string.
        root_ranges = {roots[0]: "slow", roots[1]: "mixed"}
        _ok(client.post("/api/scan/analyze", json={"tempo_range": "psy", "root_ranges": root_ranges}))
        (call,) = started
        plan = call["plan"]
        assert plan["root_ranges"] == root_ranges and plan["scoped"] is False

        _seed({"absolute_path": "/Volumes/Old/Music/House/a.mp3"},
              {"absolute_path": "C:\\Music\\Down\\b.flac"},
              {"absolute_path": "/Volumes/Other/c.mp3"})  # MusicAB must not match the MusicA prefix
        seen: dict[str, str] = {}

        def record(path, *, run_primary=True, run_essentia=True, tempo_range=TEMPO_RANGES["psy"]):
            seen[path] = tempo_range.key
            return aa.AnalysisResult()

        monkeypatch.setattr(aa, "analyze_file", record)
        with Session(dbmod.get_engine()) as s:
            aa.analyze_all(s, force=True, local_only=True,
                           tempo_range=plan["tempo_range"], root_ranges=plan["root_ranges"])
        assert seen == {
            str(a / "House" / "a.mp3"): "slow",
            str(b / "Down" / "b.flac"): "mixed",
            str(ab / "c.mp3"): "psy",
        }
    finally:
        library_paths._read_mappings.cache_clear()
        cfg.get_settings.cache_clear()


def test_resolve_track_range_longest_prefix_case_and_separators():
    roots = {"/Music": "mixed", "/Music/Downtempo": "slow", "/Music/Down": "psy",
             "c:/music/slow": "slow", "D:\\DJ\\": "mixed"}
    assert resolve_track_range("/Music/Downtempo/a.mp3", "psy", roots) == "slow"
    assert resolve_track_range("/Music/Downtempo/deep/a.mp3", "psy", roots) == "slow"
    assert resolve_track_range("/Music/Down/a.mp3", "slow", roots) == "psy"
    assert resolve_track_range("/Music/House/b.mp3", "psy", roots) == "mixed"
    assert resolve_track_range("/music/house/b.mp3", "psy", roots) == "mixed"
    assert resolve_track_range("/Musical/b.mp3", "psy", roots) == "psy"
    assert resolve_track_range("C:\\Music\\Slow\\x.flac", "psy", roots) == "slow"
    assert resolve_track_range("C:\\Music\\Slowcore\\x.flac", "psy", roots) == "psy"
    assert resolve_track_range("d:/dj/x.flac", "psy", roots) == "mixed"
    assert resolve_track_range("/Other/c.mp3", "slow", roots) == "slow"
    assert resolve_track_range("/Music/Downtempo/a.mp3", "therapy", roots) == "therapy"
    assert resolve_track_range("/Music/a.mp3", "psy", {}) == "psy"


# ===================================================== 7. DJ psy method ===

def test_dj_psy_window_and_method_strings():
    psy = TEMPO_RANGES["psy"]
    assert (psy.lo, psy.hi, psy.method, psy.fallback_method) == (133.0, 286.0, PSY_METHOD, PSY_FALLBACK)
    assert (aa.BPM_METHOD, aa.FALLBACK_METHOD) == (PSY_METHOD, PSY_FALLBACK)
    assert {k: (r.lo, r.hi, r.method) for k, r in TEMPO_RANGES.items()} == {
        "psy": (133.0, 286.0, PSY_METHOD),
        "mixed": (118.0, 250.0, "librosa-onset-multilag-v2@118-250"),
        "slow": (70.0, 125.0, "librosa-onset-multilag-v2@70-125"),
        "therapy": (40.0, 240.0, THERAPY_METHOD),
    }
    assert TEMPO_RANGES["therapy"].fallback_method is None


@pytest.mark.parametrize("bpm", [133, 142])
def test_dj_default_analysis_stores_the_psy_method(db, monkeypatch, bpm):
    monkeypatch.setattr(aa, "decode_audio", _decoder(ts.bench_signal(f"click-{bpm}", 270.0)))
    db.add(Track(absolute_path="/dj/clicks.wav"))
    db.commit()
    aa.analyze_all(db, force=True, local_only=True)  # no window given: the psy default
    t = db.exec(select(Track)).one()
    db.refresh(t)
    assert t.bpm_analyzed_method == PSY_METHOD
    assert _near(t.bpm_analyzed, float(bpm), 0.005), t.bpm_analyzed  # 133 no longer reads 266
    assert t.analysis_error is None


# ============================================ 8. therapy consensus rule ===

def _therapy_track(**kw) -> Track:
    return Track(absolute_path="/t/x.wav", bpm_analyzed_method=THERAPY_METHOD, **kw)


def _refreshed(track: Track) -> Track:
    bc._refresh_consensus(track, 3.0)
    return track


def test_therapy_consensus_requires_the_local_vote():
    masked = _refreshed(_therapy_track(bpm_analyzed=60.0, bpm_essentia=180.0, bpm_reccobeats=180.0))
    assert masked.bpm_consensus is None and effective_bpm(masked) == 60.0

    outvoted = _refreshed(_therapy_track(bpm_analyzed=60.0, bpm_essentia=60.5, bpm_reccobeats=180.0,
                                         bpm_getsongbpm=180.0, bpm_cyanite=180.0))
    assert outvoted.bpm_consensus is None and effective_bpm(outvoted) == 60.0

    agreed = _refreshed(_therapy_track(bpm_analyzed=60.0, bpm_essentia=120.0))
    assert agreed.bpm_consensus == 60.0 and "local" in agreed.bpm_consensus_sources.split("+")
    assert effective_bpm(agreed) == 60.0

    unclear = _refreshed(_therapy_track(bpm_analyzed=None, bpm_essentia=180.0, bpm_reccobeats=180.0))
    assert unclear.bpm_consensus is None and effective_bpm(unclear) is None


def test_therapy_consensus_keeps_tag_and_manual_precedence():
    tagged = _refreshed(_therapy_track(bpm=72.0, bpm_analyzed=60.0, bpm_essentia=180.0, bpm_reccobeats=180.0))
    assert (tagged.bpm_consensus, tagged.bpm_consensus_sources) == (72.0, "metadata")
    assert effective_bpm(tagged) == 72.0

    manual = _refreshed(_therapy_track(bpm=72.0, bpm_analyzed=60.0, bpm_consensus=36.0,
                                       bpm_consensus_sources=MANUAL))
    assert (manual.bpm_consensus, manual.bpm_consensus_sources) == (36.0, MANUAL)
    assert effective_bpm(manual) == 36.0


def test_dj_tracks_keep_todays_consensus_rule():
    dj = _refreshed(Track(absolute_path="/d/x.wav", bpm_analyzed_method=PSY_METHOD, bpm_analyzed=140.0,
                          bpm_essentia=180.0, bpm_reccobeats=180.0))
    assert (dj.bpm_consensus, dj.bpm_consensus_sources) == (180.0, "essentia+reccobeats")
    legacy = _refreshed(Track(absolute_path="/d/y.wav", bpm_analyzed_method="librosa-onset-multilag-v1",
                              bpm_analyzed=140.0, bpm_essentia=180.0, bpm_reccobeats=180.0))
    assert legacy.bpm_consensus == 180.0


def test_reset_on_a_therapy_track_never_lets_stale_providers_win(client):
    (tid,) = _seed({"absolute_path": "/t/a.wav", "bpm_analyzed": 60.0, "bpm_analyzed_method": THERAPY_METHOD,
                    "bpm_essentia": 180.0, "bpm_reccobeats": 180.0})
    assert _ok(client.post(f"/api/tracks/{tid}/bpm", json={"factor": 2}))["effective_bpm"] == 120.0
    reset = _ok(client.delete(f"/api/tracks/{tid}/bpm"))
    assert reset["bpm_consensus"] is None and reset["effective_bpm"] == 60.0
