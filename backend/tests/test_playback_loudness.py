"""Playback analysis uses temporary sources/caches and never edits the catalog."""
from __future__ import annotations

import json
import math
import os
import shutil
import struct
import subprocess
import threading
import wave
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.tracks import router
from app.db import get_session
from app.models import Track
from app.services import playback_loudness as loudness


@pytest.fixture
def setup(tmp_path, monkeypatch):
    source = tmp_path / "library" / "fixture.wav"
    source.parent.mkdir()
    source.write_bytes(b"fixture source")
    settings = SimpleNamespace(db_file=tmp_path / "catalog.sqlite", ffmpeg="ffmpeg")
    monkeypatch.setattr(loudness, "get_settings", lambda: settings)
    # Each test owns its concurrency slot, even when testing with threads.
    monkeypatch.setattr(loudness, "_MEASUREMENT_SLOT", threading.BoundedSemaphore(1))
    return source, settings


def measurement(integrated="-24", peak="-9"):
    stderr = b"FFmpeg stream diagnostics\n" + json.dumps({
        "input_i": integrated, "input_tp": peak,
    }).encode() + b"\n"
    return subprocess.CompletedProcess([], 0, b"", stderr)


def fake_runner(monkeypatch, result):
    calls = []

    def run(binary, args, timeout_s):
        calls.append((binary, args, timeout_s))
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(loudness.media_tools, "run", run)
    return calls


@pytest.mark.parametrize("integrated,peak,gain", [
    ("-24", "-9", 6), ("-40", "-30", 12), ("12", "-30", -24),
    ("-30", "-0.5", -0.5), ("-24", "2", -3),
])
def test_gain_target_limits_and_true_peak_cap(setup, monkeypatch, integrated, peak, gain):
    source, _ = setup
    before = (source.read_bytes(), source.stat().st_mtime_ns)
    calls = fake_runner(monkeypatch, measurement(integrated, peak))

    result = loudness.get_playback_loudness(1, str(source))

    assert result == {"status": "ready", "gain_db": gain, "integrated_lufs": float(integrated),
                      "true_peak_dbfs": float(peak), "target_lufs": -18}
    assert float(peak) + gain <= -1
    binary, args, timeout = calls[0]
    assert binary == "ffmpeg" and timeout == 180
    assert args == ["-nostdin", "-hide_banner", "-nostats", "-i", str(source),
                    "-map", "0:a:0", "-vn", "-sn", "-dn", "-af",
                    "loudnorm=I=-18:TP=-1:LRA=11:print_format=json", "-f", "null", "-"]
    assert (source.read_bytes(), source.stat().st_mtime_ns) == before


def test_silence_is_finite_unity_and_cacheable(setup, monkeypatch):
    source, _ = setup
    calls = fake_runner(monkeypatch, measurement("-inf", "-inf"))
    result = loudness.get_playback_loudness(2, str(source))
    assert result == {"status": "silent", "gain_db": 0.0, "integrated_lufs": None,
                      "true_peak_dbfs": None, "target_lufs": -18}
    assert loudness.get_playback_loudness(2, str(source)) == result
    assert len(calls) == 1
    json.dumps(result, allow_nan=False)


@pytest.mark.parametrize("result", [
    subprocess.CompletedProcess([], 1, b"", b"private path: /private/source.wav"),
    subprocess.CompletedProcess([], 0, b"", b"not json"),
    subprocess.CompletedProcess([], 0, b"", b"{}"),
    subprocess.CompletedProcess([], 0, b"", b"[]"),
    measurement("nan", "-2"), measurement("-inf", "-2"), measurement("-20", "inf"),
    measurement(True, "-2"), measurement([], "-2"),
    OSError("private source path"), subprocess.TimeoutExpired("ffmpeg", 180),
])
def test_decoder_failure_or_malformed_measurements_use_uncached_unity(setup, monkeypatch, result):
    source, settings = setup
    fake_runner(monkeypatch, result)
    response = loudness.get_playback_loudness(3, str(source))
    assert response == {"status": "unavailable", "gain_db": 0.0, "integrated_lufs": None,
                        "true_peak_dbfs": None, "target_lufs": -18}
    assert not (settings.db_file.parent / "cache").exists()


def test_missing_tool_uses_unity_without_starting_job(setup, monkeypatch):
    source, settings = setup
    settings.ffmpeg = None
    calls = fake_runner(monkeypatch, measurement())
    assert loudness.get_playback_loudness(4, str(source))["status"] == "unavailable"
    assert not calls


def test_cache_reuse_and_source_size_mtime_path_invalidation(setup, monkeypatch):
    source, settings = setup
    calls = fake_runner(monkeypatch, measurement())
    expected = loudness.get_playback_loudness(5, str(source))
    cache = settings.db_file.parent / "cache" / "playback-loudness" / "5-v1.json"
    assert cache.is_file()
    assert list(cache.parent.iterdir()) == [cache]
    assert loudness.get_playback_loudness(5, str(source)) == expected
    assert len(calls) == 1

    source.write_bytes(b"a changed longer source")
    loudness.get_playback_loudness(5, str(source))
    assert len(calls) == 2
    stat = source.stat()
    os.utime(source, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))
    loudness.get_playback_loudness(5, str(source))
    assert len(calls) == 3
    alternate = source.with_name("alternate.wav")
    alternate.write_bytes(source.read_bytes())
    os.utime(alternate, ns=(stat.st_atime_ns, source.stat().st_mtime_ns))
    loudness.get_playback_loudness(5, str(alternate))
    assert len(calls) == 4
    source.unlink()
    with pytest.raises(loudness.SourceUnavailable):
        loudness.get_playback_loudness(5, str(source))


@pytest.mark.parametrize("corrupt", [
    "not json", "[]", "null", '{"source": {}}',
    "bad_gain", "nonfinite", "boolean", "version", "silent_with_gain",
])
def test_malformed_cache_is_replaced(setup, monkeypatch, corrupt):
    source, settings = setup
    calls = fake_runner(monkeypatch, measurement())
    expected = loudness.get_playback_loudness(6, str(source))
    cache = settings.db_file.parent / "cache" / "playback-loudness" / "6-v1.json"
    data = json.loads(cache.read_text())
    if corrupt == "bad_gain":
        data["result"]["gain_db"] = 99
    elif corrupt == "nonfinite":
        data["result"]["integrated_lufs"] = float("nan")
    elif corrupt == "boolean":
        data["result"]["true_peak_dbfs"] = True
    elif corrupt == "version":
        data["version"] = 0
    elif corrupt == "silent_with_gain":
        data["result"]["status"] = "silent"
    else:
        cache.write_text(corrupt)
    if corrupt in {"bad_gain", "nonfinite", "boolean", "version", "silent_with_gain"}:
        cache.write_text(json.dumps(data))
    assert loudness.get_playback_loudness(6, str(source)) == expected
    assert len(calls) == 2
    assert json.loads(cache.read_text())["result"] == expected


def test_changed_source_during_measurement_is_not_cached(setup, monkeypatch):
    source, settings = setup

    def run(*args, **kwargs):
        source.write_bytes(b"changed source while ffmpeg was reading")
        return measurement()

    monkeypatch.setattr(loudness.media_tools, "run", run)
    assert loudness.get_playback_loudness(7, str(source))["status"] == "unavailable"
    assert not (settings.db_file.parent / "cache").exists()


def test_atomic_cache_write_failure_still_returns_measurement(setup, monkeypatch):
    source, settings = setup
    fake_runner(monkeypatch, measurement())

    def fail(*args):
        raise OSError("cache cannot be replaced")

    monkeypatch.setattr(loudness.os, "replace", fail)
    assert loudness.get_playback_loudness(8, str(source))["status"] == "ready"
    assert list((settings.db_file.parent / "cache" / "playback-loudness").iterdir()) == []


def test_concurrent_request_is_rejected_instead_of_queued_and_slot_released(setup, monkeypatch):
    source, _ = setup
    entered, release = threading.Event(), threading.Event()
    calls = []

    def run(*args, **kwargs):
        calls.append(True)
        entered.set()
        assert release.wait(timeout=5)
        return measurement()

    monkeypatch.setattr(loudness.media_tools, "run", run)
    with ThreadPoolExecutor(max_workers=1) as executor:
        running = executor.submit(loudness.get_playback_loudness, 9, str(source))
        try:
            assert entered.wait(timeout=5)
            with pytest.raises(loudness.MeasurementBusy):
                loudness.get_playback_loudness(10, str(source))
            assert len(calls) == 1
        finally:
            release.set()
        assert running.result(timeout=5)["status"] == "ready"
    assert loudness.get_playback_loudness(10, str(source))["status"] == "ready"


def test_slot_released_after_failure(setup, monkeypatch):
    source, _ = setup
    fake_runner(monkeypatch, OSError())
    assert loudness.get_playback_loudness(11, str(source))["status"] == "unavailable"
    fake_runner(monkeypatch, measurement())
    assert loudness.get_playback_loudness(11, str(source))["status"] == "ready"


def test_source_resolution_is_used_and_failures_propagate(setup, monkeypatch):
    source, _ = setup
    resolved = []

    def resolve(logical):
        resolved.append(logical)
        if logical == "disconnected":
            raise OSError("private mount path")
        return source

    monkeypatch.setattr(loudness, "resolve_source_path", resolve)
    fake_runner(monkeypatch, measurement())
    assert loudness.get_playback_loudness(12, "logical/source.wav")["status"] == "ready"
    assert resolved == ["logical/source.wav"]
    with pytest.raises(loudness.SourceUnavailable):
        loudness.get_playback_loudness(12, "disconnected")


def test_route_status_shape_missing_source_busy_and_catalog_untouched(db, setup, monkeypatch):
    source, _ = setup
    track = Track(absolute_path=str(source), file_name=source.name, extension="wav")
    db.add(track)
    db.commit()
    db.refresh(track)
    before = track.model_dump()
    application = FastAPI()
    application.include_router(router, prefix="/api")
    application.dependency_overrides[get_session] = lambda: db
    fake_runner(monkeypatch, measurement())
    with TestClient(application) as client:
        path = f"/api/tracks/{track.id}/playback-loudness"
        response = client.get(path)
        assert response.status_code == 200
        assert response.json() == {"status": "ready", "gain_db": 6.0, "integrated_lufs": -24.0,
                                   "true_peak_dbfs": -9.0, "target_lufs": -18}
        assert client.get("/api/tracks/999999/playback-loudness").status_code == 404
        source.write_bytes(b"changed to invalidate cache")
        loudness._MEASUREMENT_SLOT.acquire()
        try:
            response = client.get(path)
            assert response.status_code == 503
            assert response.headers["Retry-After"] == "2"
        finally:
            loudness._MEASUREMENT_SLOT.release()
        fake_runner(monkeypatch, OSError("private source path"))
        response = client.get(path)
        assert response.status_code == 200 and response.json()["status"] == "unavailable"
        assert str(source) not in response.text and "private" not in response.text
        source.unlink()
        response = client.get(path)
        assert response.status_code == 410 and str(source) not in response.text
    db.refresh(track)
    assert track.model_dump() == before


@pytest.mark.parametrize("amplitude", [0, 0.1, 0.5])
def test_real_ffmpeg_generated_fixture(setup, amplitude):
    source, settings = setup
    binary = shutil.which("ffmpeg")
    if not binary:
        pytest.skip("FFmpeg unavailable")
    settings.ffmpeg = binary
    rate = 48000
    samples = [round(amplitude * 32767 * math.sin(2 * math.pi * 1000 * i / rate))
               for i in range(rate * 2)]
    with wave.open(str(source), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes(struct.pack(f"<{len(samples)}h", *samples))
    before = (source.read_bytes(), source.stat().st_mtime_ns)

    result = loudness.get_playback_loudness(13, str(source))

    if amplitude == 0:
        assert result == loudness._result("silent")
    else:
        assert result["status"] == "ready"
        assert result["integrated_lufs"] + result["gain_db"] == pytest.approx(-18)
        assert result["true_peak_dbfs"] + result["gain_db"] <= -1
        assert (result["gain_db"] > 0) == (amplitude == 0.1)
    assert (source.read_bytes(), source.stat().st_mtime_ns) == before
