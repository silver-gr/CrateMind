"""Whole-track loudness for Auto Gain: served from the track's stored columns, else measured once
(ffmpeg only reads the file) and stored. The source file is never changed."""
from __future__ import annotations

import math
import shutil
import struct
import subprocess
import threading
import wave
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.exc import OperationalError

from app.api.tracks import router
from app.db import get_session
from app.models import Track
from app.services import playback_loudness as loudness

UNAVAILABLE = {"status": "unavailable", "gain_db": 0.0, "integrated_lufs": None,
               "true_peak_dbfs": None, "target_lufs": -18}


@pytest.fixture
def setup(db, tmp_path, monkeypatch):
    source = tmp_path / "library" / "fixture.wav"
    source.parent.mkdir()
    source.write_bytes(b"fixture source")
    settings = SimpleNamespace(ffmpeg="ffmpeg")
    monkeypatch.setattr(loudness, "get_settings", lambda: settings)
    # Each test owns its concurrency slot, even when testing with threads.
    monkeypatch.setattr(loudness, "_MEASUREMENT_SLOT", threading.BoundedSemaphore(1))
    track = Track(absolute_path=str(source), file_name=source.name, extension="wav")
    db.add(track)
    db.commit()
    db.refresh(track)
    return source, settings, track


def summary(integrated="-24.0", peak="-9.0") -> bytes:
    """ebur128's closing summary as ffmpeg prints it (hand-written, from a test tone's output)."""
    return ("Input #0, wav, from 'fixture.wav':\n"
            "[Parsed_ebur128_0 @ 0x600000a1c000] Summary:\n\n"
            "  Integrated loudness:\n"
            f"    I:         {integrated} LUFS\n"
            "    Threshold: -34.0 LUFS\n\n"
            "  Loudness range:\n"
            "    LRA:         4.3 LU\n"
            "    Threshold: -44.0 LUFS\n"
            "    LRA low:   -27.0 LUFS\n"
            "    LRA high:  -22.7 LUFS\n\n"
            "  True peak:\n"
            f"    Peak:       {peak} dBFS\n"
            "[out#0/null @ 0x600000c18000] video:0KiB audio:258KiB\n").encode()


def measurement(integrated="-24.0", peak="-9.0"):
    return subprocess.CompletedProcess([], 0, b"", summary(integrated, peak))


def fake_runner(monkeypatch, result):
    calls = []

    def run(binary, args, timeout_s):
        calls.append((binary, args, timeout_s))
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(loudness.media_tools, "run", run)
    return calls


def stored(db, track):
    db.refresh(track)
    return track.loudness_lufs, track.loudness_peak_db, track.loudness_measured_at is not None


# --- parsing --------------------------------------------------------------------------------------

def test_parse_reads_the_last_summary():
    assert loudness.parse_measurement(summary("-7.4", "1.5")) == (-7.4, 1.5)
    assert loudness.parse_measurement(summary("-30.0", "-20.0") + summary("-7.4", "1.5")) == (-7.4, 1.5)


@pytest.mark.parametrize("integrated,peak", [("-70.0", "-inf"), ("-70.0", "-60.0")])
def test_parse_silence_below_the_gate(integrated, peak):
    assert loudness.parse_measurement(summary(integrated, peak)) is None


@pytest.mark.parametrize("output", [
    b"", b"no summary here", summary("-24.0", "-9.0").replace(b"Peak:", b"Pk:"),
    summary("nan", "-2.0"), summary("-20.0", "inf"), summary("loud", "-2.0"),
])
def test_parse_rejects_missing_or_non_finite(output):
    with pytest.raises(ValueError):
        loudness.parse_measurement(output)


# --- the endpoint's lookup ------------------------------------------------------------------------

@pytest.mark.parametrize("integrated,peak,gain", [
    ("-24", "-9", 6), ("-40", "-30", 12), ("12", "-30", -24),
    ("-30", "-0.5", -0.5), ("-24", "2", -3),
])
def test_gain_target_limits_true_peak_cap_and_stored(db, setup, monkeypatch, integrated, peak, gain):
    source, _, track = setup
    before = (source.read_bytes(), source.stat().st_mtime_ns)
    calls = fake_runner(monkeypatch, measurement(integrated, peak))

    result = loudness.get_playback_loudness(db, track)

    assert result == {"status": "ready", "gain_db": gain, "integrated_lufs": float(integrated),
                      "true_peak_dbfs": float(peak), "target_lufs": -18}
    assert float(peak) + gain <= -1
    binary, args, timeout = calls[0]
    assert binary == "ffmpeg" and timeout == 180
    assert args == ["-nostdin", "-hide_banner", "-nostats", "-i", str(source), "-map", "0:a:0",
                    "-vn", "-sn", "-dn", "-af", "ebur128=peak=true:framelog=quiet", "-f", "null", "-"]
    assert stored(db, track) == (float(integrated), float(peak), True)
    assert (source.read_bytes(), source.stat().st_mtime_ns) == before


def test_stored_measurement_is_served_without_ffmpeg(db, setup, monkeypatch):
    _, _, track = setup
    track.loudness_lufs, track.loudness_peak_db, track.loudness_measured_at = -7.4, 1.5, datetime.now(UTC)
    db.add(track)
    db.commit()
    calls = fake_runner(monkeypatch, measurement())
    result = loudness.get_playback_loudness(db, track)
    assert result == loudness._result("ready", -7.4, 1.5)
    assert result["gain_db"] == pytest.approx(-10.6)
    assert not calls


def test_silence_is_stored_as_silent_with_unity_gain(db, setup, monkeypatch):
    _, _, track = setup
    calls = fake_runner(monkeypatch, measurement("-70.0", "-inf"))
    result = loudness.get_playback_loudness(db, track)
    assert result == {"status": "silent", "gain_db": 0.0, "integrated_lufs": None,
                      "true_peak_dbfs": None, "target_lufs": -18}
    assert stored(db, track) == (None, None, True)
    assert loudness.get_playback_loudness(db, track) == result
    assert len(calls) == 1


@pytest.mark.parametrize("result", [
    subprocess.CompletedProcess([], 1, b"", b"private path: /private/source.wav"),
    subprocess.CompletedProcess([], 0, b"", b"no summary"),
    measurement("nan", "-2.0"), measurement("-20.0", "inf"),
    OSError("private source path"), subprocess.TimeoutExpired("ffmpeg", 180),
])
def test_failure_is_unity_and_stores_nothing(db, setup, monkeypatch, result):
    _, _, track = setup
    fake_runner(monkeypatch, result)
    assert loudness.get_playback_loudness(db, track) == UNAVAILABLE
    assert stored(db, track) == (None, None, False)


def test_missing_tool_uses_unity_without_starting_a_measurement(db, setup, monkeypatch):
    _, settings, track = setup
    settings.ffmpeg = None
    calls = fake_runner(monkeypatch, measurement())
    assert loudness.get_playback_loudness(db, track) == UNAVAILABLE
    assert not calls


def test_changed_source_during_measurement_is_not_stored(db, setup, monkeypatch):
    source, _, track = setup

    def run(*args, **kwargs):
        source.write_bytes(b"changed source while ffmpeg was reading")
        return measurement()

    monkeypatch.setattr(loudness.media_tools, "run", run)
    assert loudness.get_playback_loudness(db, track) == UNAVAILABLE
    assert stored(db, track) == (None, None, False)


def test_a_busy_catalog_still_returns_the_measurement(db, setup, monkeypatch):
    _, _, track = setup
    fake_runner(monkeypatch, measurement())

    def busy():
        raise OperationalError("UPDATE tracks", {}, Exception("database is locked"))

    monkeypatch.setattr(db, "commit", busy)
    assert loudness.get_playback_loudness(db, track)["status"] == "ready"
    monkeypatch.undo()
    assert stored(db, track) == (None, None, False)


def test_concurrent_request_is_rejected_instead_of_queued_and_slot_released(db, setup, monkeypatch):
    source, _, track = setup
    other = Track(absolute_path=str(source.with_name("other.wav")), file_name="other.wav", extension="wav")
    source.with_name("other.wav").write_bytes(b"other source")
    db.add(other)
    db.commit()
    entered, release = threading.Event(), threading.Event()
    calls = []

    def run(*args, **kwargs):
        calls.append(True)
        entered.set()
        assert release.wait(timeout=5)
        return measurement()

    monkeypatch.setattr(loudness.media_tools, "run", run)
    # The waiting call only measures; storing it (on this test's session) happens after release.
    with ThreadPoolExecutor(max_workers=1) as executor:
        running = executor.submit(loudness.get_playback_loudness, db, track)
        try:
            assert entered.wait(timeout=5)
            with pytest.raises(loudness.MeasurementBusy):
                loudness.get_playback_loudness(db, other)
            assert len(calls) == 1
        finally:
            release.set()
        assert running.result(timeout=5)["status"] == "ready"
    assert loudness.get_playback_loudness(db, other)["status"] == "ready"


def test_slot_released_after_failure(db, setup, monkeypatch):
    _, _, track = setup
    fake_runner(monkeypatch, OSError())
    assert loudness.get_playback_loudness(db, track)["status"] == "unavailable"
    fake_runner(monkeypatch, measurement())
    assert loudness.get_playback_loudness(db, track)["status"] == "ready"


def test_source_resolution_is_used_and_failures_propagate(db, setup, monkeypatch):
    source, _, track = setup
    resolved = []

    def resolve(logical):
        resolved.append(logical)
        if logical == "disconnected":
            raise OSError("private mount path")
        return source

    monkeypatch.setattr(loudness, "resolve_source_path", resolve)
    fake_runner(monkeypatch, measurement())
    track.absolute_path = "logical/source.wav"
    assert loudness.get_playback_loudness(db, track)["status"] == "ready"
    assert resolved == ["logical/source.wav"]
    track.absolute_path = "disconnected"
    with pytest.raises(loudness.SourceUnavailable):
        loudness.get_playback_loudness(db, track)


def test_route_status_shape_missing_source_busy_and_stored_measurement(db, setup, monkeypatch):
    source, _, track = setup
    untouched = {k: v for k, v in track.model_dump().items() if not k.startswith("loudness_")}
    application = FastAPI()
    application.include_router(router, prefix="/api")
    application.dependency_overrides[get_session] = lambda: db
    calls = fake_runner(monkeypatch, measurement())
    with TestClient(application) as client:
        path = f"/api/tracks/{track.id}/playback-loudness"
        response = client.get(path)
        assert response.status_code == 200
        assert response.json() == {"status": "ready", "gain_db": 6.0, "integrated_lufs": -24.0,
                                   "true_peak_dbfs": -9.0, "target_lufs": -18}
        assert client.get("/api/tracks/999999/playback-loudness").status_code == 404
        loudness._MEASUREMENT_SLOT.acquire()
        try:
            assert client.get(path).status_code == 200          # stored: no measurement, so never busy
            other = Track(absolute_path=str(source.with_name("other.wav")), file_name="other.wav", extension="wav")
            source.with_name("other.wav").write_bytes(b"other source")
            db.add(other)
            db.commit()
            response = client.get(f"/api/tracks/{other.id}/playback-loudness")
            assert response.status_code == 503
            assert response.headers["Retry-After"] == "2"
        finally:
            loudness._MEASUREMENT_SLOT.release()
        assert len(calls) == 1
        fake_runner(monkeypatch, OSError("private source path"))
        response = client.get(f"/api/tracks/{other.id}/playback-loudness")
        assert response.status_code == 200 and response.json()["status"] == "unavailable"
        assert str(source) not in response.text and "private" not in response.text
        source.unlink()
        response = client.get(path)
        assert response.status_code == 410 and str(source) not in response.text
    db.refresh(track)
    assert {k: v for k, v in track.model_dump().items() if not k.startswith("loudness_")} == untouched
    assert (track.loudness_lufs, track.loudness_peak_db) == (-24.0, -9.0)


# --- the analysis phase's runner ------------------------------------------------------------------

def test_measure_file_runs_ffmpeg_directly_and_read_only(monkeypatch):
    seen = {}

    def run(cmd, **kwargs):
        seen.update(cmd=cmd, **kwargs)
        return subprocess.CompletedProcess(cmd, 0, b"", summary("-8.0", "0.5"))

    monkeypatch.setattr(loudness, "get_settings", lambda: SimpleNamespace(ffmpeg="ffmpeg"))
    monkeypatch.setattr(loudness.subprocess, "run", run)
    assert loudness.measure_file("/music/a.mp3") == (-8.0, 0.5)
    assert seen["cmd"] == ["ffmpeg", *loudness.ffmpeg_args("/music/a.mp3")]
    assert seen["stdin"] is subprocess.DEVNULL and seen["timeout"] == 180 and seen["check"] is False


def test_measure_file_raises_on_failure_or_missing_tool(monkeypatch):
    monkeypatch.setattr(loudness, "get_settings", lambda: SimpleNamespace(ffmpeg="ffmpeg"))
    monkeypatch.setattr(loudness.subprocess, "run",
                        lambda cmd, **kwargs: subprocess.CompletedProcess(cmd, 1, b"", b"decode error"))
    with pytest.raises(RuntimeError):
        loudness.measure_file("/music/broken.mp3")
    monkeypatch.setattr(loudness, "get_settings", lambda: SimpleNamespace(ffmpeg=None))
    with pytest.raises(RuntimeError):
        loudness.measure_file("/music/a.mp3")


@pytest.mark.parametrize("amplitude", [0, 0.1, 0.5])
def test_real_ffmpeg_generated_fixture(db, setup, amplitude):
    source, settings, track = setup
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

    result = loudness.get_playback_loudness(db, track)

    if amplitude == 0:
        assert result == loudness._result("silent")
    else:
        assert result["status"] == "ready"
        assert result["integrated_lufs"] + result["gain_db"] == pytest.approx(-18)
        assert result["true_peak_dbfs"] + result["gain_db"] <= -1
        assert (result["gain_db"] > 0) == (amplitude == 0.1)
        assert loudness.measure_file(str(source)) == (result["integrated_lufs"], result["true_peak_dbfs"])
    assert (source.read_bytes(), source.stat().st_mtime_ns) == before
