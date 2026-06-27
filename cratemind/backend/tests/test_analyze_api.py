"""Analyze endpoint: ffmpeg gate + job creation."""
from __future__ import annotations

import app.config as cfg


def test_analyze_requires_ffmpeg(client, monkeypatch):
    monkeypatch.setattr(cfg.shutil, "which", lambda name: None)
    cfg.get_settings.cache_clear()
    r = client.post("/api/scan/analyze", json={})
    assert r.status_code == 400
    assert "ffmpeg" in r.json()["detail"].lower()


def test_analyze_creates_job(client, monkeypatch):
    monkeypatch.setattr(cfg.shutil, "which",
                        lambda name: "/usr/bin/ffmpeg" if name == "ffmpeg" else None)
    cfg.get_settings.cache_clear()
    r = client.post("/api/scan/analyze", json={"force": False})
    assert r.status_code == 200
    job = r.json()
    assert job["kind"] == "analyze"
    assert job["status"] in ("pending", "running", "done")
