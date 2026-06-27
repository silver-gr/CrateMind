"""ffmpeg is detected and surfaced on the health/settings endpoints."""
from __future__ import annotations


def test_health_reports_ffmpeg_key(client):
    body = client.get("/api/health").json()
    assert "ffmpeg" in body
    assert isinstance(body["ffmpeg"], bool)


def test_settings_reports_ffmpeg_key(client):
    body = client.get("/api/settings").json()
    assert "ffmpeg" in body
