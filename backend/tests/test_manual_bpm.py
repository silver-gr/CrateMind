"""Manual «×½ / ×2» BPM fix: stored only in CrateMind's consensus columns."""
from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest
from sqlmodel import Session, select

from app.models import AuditLog, Track


def _make(name: str = "a", **values) -> int:
    from app.db import get_engine

    with Session(get_engine(), expire_on_commit=False) as session:
        track = Track(absolute_path=f"/x/{name}.wav", file_name=f"{name}.wav", **values)
        session.add(track)
        session.commit()
        return track.id


def _row(track_id: int) -> Track:
    from app.db import get_engine

    with Session(get_engine(), expire_on_commit=False) as session:
        return session.get(Track, track_id)


def _audits() -> list[AuditLog]:
    from app.db import get_engine

    with Session(get_engine(), expire_on_commit=False) as session:
        return list(session.exec(select(AuditLog).where(AuditLog.action == "bpm_manual_update")).all())


def test_halve_analysed_bpm(client):
    tid = _make(bpm_analyzed=190.0)
    response = client.post(f"/api/tracks/{tid}/bpm", json={"factor": 0.5})
    assert response.status_code == 200
    assert response.json() == {"track_id": tid, "bpm_consensus": 95.0,
                               "bpm_consensus_sources": "manual:octave", "effective_bpm": 95.0}
    row = _row(tid)
    assert (row.bpm_consensus, row.bpm_consensus_sources, row.bpm_needs_review) == (95.0, "manual:octave", False)
    assert row.bpm_analyzed == 190.0  # the observation itself is untouched
    audits = _audits()
    assert len(audits) == 1
    assert audits[0].entity_id == tid
    assert json.loads(audits[0].after_json) == {"bpm_consensus": 95.0, "bpm_consensus_sources": "manual:octave"}
    assert json.loads(audits[0].before_json) == {"bpm_consensus": None, "bpm_consensus_sources": None}


def test_manual_beats_tag(client):
    tid = _make(bpm=145.0)
    assert client.post(f"/api/tracks/{tid}/bpm", json={"factor": 0.5}).json()["effective_bpm"] == 72.5
    assert client.get(f"/api/tracks/{tid}").status_code == 200
    from app.services.tempo import effective_bpm
    row = _row(tid)
    assert row.bpm == 145.0  # the tag value is never rewritten
    assert effective_bpm(row) == 72.5


def test_exact_round_trip(client):
    tid = _make(bpm_analyzed=147.33)
    assert client.post(f"/api/tracks/{tid}/bpm", json={"factor": 0.5}).json()["bpm_consensus"] == 147.33 / 2
    assert client.post(f"/api/tracks/{tid}/bpm", json={"factor": 2}).json()["bpm_consensus"] == 147.33


def test_double_twice_compounds(client):
    tid = _make(bpm_analyzed=80.0)
    client.post(f"/api/tracks/{tid}/bpm", json={"factor": 2})
    assert client.post(f"/api/tracks/{tid}/bpm", json={"factor": 2}).json()["effective_bpm"] == 320.0
    assert len(_audits()) == 2


def test_no_bpm_422(client):
    tid = _make()
    response = client.post(f"/api/tracks/{tid}/bpm", json={"factor": 2})
    assert response.status_code == 422
    assert response.json()["detail"] == "Δεν υπάρχει BPM για αλλαγή"
    assert _audits() == []


def test_bounds_422(client):
    tid = _make(bpm_analyzed=30.0)
    response = client.post(f"/api/tracks/{tid}/bpm", json={"factor": 0.5})
    assert response.status_code == 422
    assert response.json()["detail"] == "Το BPM βγαίνει εκτός ορίων"
    high = _make("high", bpm=250.0)
    assert client.post(f"/api/tracks/{high}/bpm", json={"factor": 2}).status_code == 422
    row = _row(tid)
    assert (row.bpm_consensus, row.bpm_consensus_sources) == (None, None)
    assert _audits() == []


@pytest.mark.parametrize("body", [{"factor": 3}, {"factor": 1}, {"factor": "x"}, {}])
def test_bad_factor_422(client, body):
    tid = _make(bpm_analyzed=140.0)
    assert client.post(f"/api/tracks/{tid}/bpm", json=body).status_code == 422
    assert _row(tid).bpm_consensus is None


def test_missing_track_404(client):
    for response in (client.post("/api/tracks/9999/bpm", json={"factor": 2}),
                     client.delete("/api/tracks/9999/bpm")):
        assert response.status_code == 404
        assert response.json()["detail"] == "Το track δεν βρέθηκε"


def test_reset_recomputes_auto(client):
    tid = _make(bpm=145.0)
    assert client.post(f"/api/tracks/{tid}/bpm", json={"factor": 0.5}).json()["effective_bpm"] == 72.5
    response = client.delete(f"/api/tracks/{tid}/bpm")
    assert response.status_code == 200
    assert response.json() == {"track_id": tid, "bpm_consensus": 145.0,
                               "bpm_consensus_sources": "metadata", "effective_bpm": 145.0}
    row = _row(tid)
    assert (row.bpm_consensus, row.bpm_consensus_sources) == (145.0, "metadata")
    assert len(_audits()) == 2


def test_reset_non_manual_is_noop(client):
    tid = _make(bpm_analyzed=140.0, bpm_consensus=140.0, bpm_consensus_sources="local+essentia",
                bpm_disagreement=True, bpm_disagreement_percent=7.5)
    response = client.delete(f"/api/tracks/{tid}/bpm")
    assert response.status_code == 200
    assert response.json() == {"track_id": tid, "bpm_consensus": 140.0,
                               "bpm_consensus_sources": "local+essentia", "effective_bpm": 140.0}
    row = _row(tid)
    assert (row.bpm_disagreement, row.bpm_disagreement_percent) == (True, 7.5)
    assert _audits() == []


def test_search_follows_manual(client):
    tid = _make(bpm_analyzed=190.0)
    assert client.get("/api/tracks/count", params={"q": "bpm:90-100"}).json() == {"count": 0}
    client.post(f"/api/tracks/{tid}/bpm", json={"factor": 0.5})
    assert [t["id"] for t in client.get("/api/tracks/search", params={"q": "bpm:90-100"}).json()] == [tid]
    assert client.get("/api/tracks/count", params={"q": "bpm:180-200"}).json() == {"count": 0}


@pytest.mark.parametrize("racing", ["manual", "reset"])
def test_analysis_never_overwrites_a_concurrent_manual_value(db, monkeypatch, racing):
    """Analysis loads its rows up front; a manual fix (or its reset) committed by
    another session while a file is analysed must survive the write-back."""
    from app.db import get_engine
    from app.services import audio_analysis as aa
    from app.services.bpm_consensus import _refresh_consensus

    from app.config import get_settings

    track = Track(absolute_path="/x/race.wav", file_name="race.wav", bpm_analyzed=190.0,
                  bpm_analyzed_method=aa.BPM_METHOD, bpm_essentia=190.0,
                  bpm_consensus=190.0, bpm_consensus_sources="local+essentia")
    if racing == "reset":
        track.bpm_consensus, track.bpm_consensus_sources = 95.0, "manual:octave"
    db.add(track)
    db.commit()
    tid = track.id

    def analyze(path, **_):
        with Session(get_engine()) as other:
            row = other.get(Track, tid)
            if racing == "manual":
                row.bpm_consensus, row.bpm_consensus_sources = 95.0, "manual:octave"
            else:
                row.bpm_consensus = row.bpm_consensus_sources = None
                _refresh_consensus(row, get_settings().bpm_disagreement_percent)
            other.add(row)
            other.commit()
        return aa.AnalysisResult(bpm=191.0, bpm_raw=191.0, bpm_confidence=0.9,
                                 bpm_method=aa.BPM_METHOD, key="A minor", key_confidence=0.8)

    monkeypatch.setattr(aa, "analyze_file", analyze)
    aa.analyze_all(db, force=True, local_only=True)

    row = _row(tid)
    assert row.bpm_analyzed == 191.0
    if racing == "manual":
        assert (row.bpm_consensus, row.bpm_consensus_sources) == (95.0, "manual:octave")
    else:  # the reset wins and the new analysis feeds the automatic value
        assert (row.bpm_consensus, row.bpm_consensus_sources) == (190.5, "local+essentia")


def test_desktop_core_routes_without_dsp(tmp_path):
    script = '''
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
    from app.db import get_engine
    with Session(get_engine(), expire_on_commit=False) as session:
        track = Track(absolute_path="/x/d.wav", file_name="d.wav", bpm=145.0)
        session.add(track)
        session.commit()
    up = client.post(f"/api/tracks/{track.id}/bpm", json={"factor": 0.5})
    assert up.status_code == 200, up.text
    assert up.json()["effective_bpm"] == 72.5, up.json()
    down = client.delete(f"/api/tracks/{track.id}/bpm")
    assert down.status_code == 200, down.text
    assert down.json()["bpm_consensus_sources"] == "metadata", down.json()
for name in ("scipy", "librosa", "essentia", "app.services.audio_analysis", "app.api.analysis"):
    assert name not in sys.modules, name
'''
    env = {k: v for k, v in os.environ.items() if not k.startswith("CRATEMIND_")}
    env.update(CRATEMIND_DB_PATH=str(tmp_path / "catalog.sqlite"),
               CRATEMIND_BACKUP_DIR=str(tmp_path / "backups"),
               CRATEMIND_OUTPUT_DIR=str(tmp_path / "out"),
               CRATEMIND_LIBRARY_ROOTS=str(tmp_path / "lib"),
               CRATEMIND_RUNTIME_PROFILE="desktop-core")
    result = subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
