"""Desktop uses the same handlers while deferring only agreed workflows."""
import os
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient

from app.runtime_profile import DEFERRED_ROUTES, RuntimeProfile, runtime_profile


def test_desktop_import_has_no_dsp_or_provider_clients(tmp_path):
    script = '''
import sys
from app.config import get_settings, Settings
get_settings.cache_clear()
import app.config
app.config.get_settings = lambda: Settings(_env_file=None)
from app.app_factory import create_app
app = create_app("desktop-core")
for name in ("scipy", "librosa", "essentia", "app.services.audio_analysis", "app.api.analysis", "app.api.soundcloud"):
    assert name not in sys.modules, name
'''
    env = {k: v for k, v in os.environ.items() if not k.startswith("CRATEMIND_")}
    env.update(CRATEMIND_DB_PATH=str(tmp_path / "catalog.sqlite"),
               CRATEMIND_BACKUP_DIR=str(tmp_path / "backups"),
               CRATEMIND_OUTPUT_DIR=str(tmp_path / "out"), CRATEMIND_RUNTIME_PROFILE="desktop-core")
    result = subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert not (tmp_path / "catalog.sqlite").exists()


@pytest.mark.parametrize("method,path", DEFERRED_ROUTES)
def test_agreed_deferred_routes_are_structured_without_work(db, method, path):
    from app.app_factory import create_app
    path = path.replace("{track_id}", "1").replace("{soundcloud_track_id}", "2")
    with TestClient(create_app(RuntimeProfile.DESKTOP_CORE)) as client:
        response = client.request(method, path, json={})
        assert response.status_code == 501
        assert isinstance(response.json()["detail"], str)
        assert response.json()["code"] == "web_workflow_required"


def test_desktop_scan_preserves_tracks_without_triggering_analysis(db, monkeypatch):
    from app.jobs import worker
    from app.models import Job
    monkeypatch.setattr(worker.scanner, "scan", lambda *a, **k: {
        "added": 1, "updated": 0, "missing": 0, "unchanged": 0, "added_track_ids": [42],
    })
    monkeypatch.setattr(worker, "rebuild_artist_profiles", lambda _s: None)
    def forbidden(*args):
        raise AssertionError("desktop started analysis")
    monkeypatch.setattr(worker, "_analyze_scan_additions", forbidden)
    job = worker.create_job(db, "scan")
    with runtime_profile(RuntimeProfile.DESKTOP_CORE):
        worker._run_scan(job.id, None)
    db.expire_all()
    assert db.get(Job, job.id).status == "done"


@pytest.mark.parametrize("route", ["confirm-identity", "reject-identity", "undo-identity", "canonical/revoke-identity"])
def test_provider_pair_guard_resolves_real_services(db, tmp_path, monkeypatch, route):
    import sqlite3
    from app.app_factory import create_app
    authority = tmp_path / "guard-identity.sqlite"
    with sqlite3.connect(authority) as conn:
        conn.execute("CREATE TABLE entities(id TEXT PRIMARY KEY,service TEXT)")
        # Misleading prefixes deliberately prove we use actual service rows.
        conn.executemany("INSERT INTO entities VALUES (?,?)", [("local:1", "spotify"), ("local:2", "local")])
    monkeypatch.setenv("CRATEMIND_IDENTITY_DB_PATH", str(authority))
    with TestClient(create_app(RuntimeProfile.DESKTOP_CORE)) as client:
        response = client.post("/api/identity/" + route,
                               json={"left_id": "local:1", "right_id": "local:2", "token": "x"})
        assert response.status_code == 501
        assert response.json()["code"] == "web_workflow_required"


def test_core_capabilities_keep_stored_results_and_optional_enrichment(db):
    from app.app_factory import create_app
    with TestClient(create_app(RuntimeProfile.DESKTOP_CORE)) as client:
        caps = client.get("/api/capabilities").json()
        assert caps["analysis"] is False and caps["provider_workflows"] is False
        assert caps["native_dialogs"] is True and caps["artist_enrichment"] is True
        assert client.get("/api/tracks/key-stats").status_code == 200
