"""Set recording: a 24-bit WAV written only into the export folder, valid after every chunk."""
from __future__ import annotations

import os
import shutil
import struct
import subprocess
import sys
import wave
from collections import namedtuple
from pathlib import Path

import numpy as np
import pytest

from app.services import recorder


@pytest.fixture(autouse=True)
def _no_open_session():
    yield
    if recorder._session is not None:
        recorder._finish(recorder._session)
        recorder._session = None


def _f32(values) -> bytes:
    return np.asarray(values, dtype="<f4").tobytes()


def _read(path: str):
    with wave.open(path, "rb") as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (2, 3, 48000)
        raw = w.readframes(w.getnframes())
    b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
    ints = (b[:, 0].astype(np.int32) | (b[:, 1].astype(np.int32) << 8) | (b[:, 2].astype(np.int32) << 16))
    ints = np.where(ints >= 1 << 23, ints - (1 << 24), ints)
    return ints / 8388607.0


def _start(client):
    r = client.post("/api/recordings/start", json={"sample_rate": 48000})
    assert r.status_code == 200, r.text
    return r.json()


def _chunk(client, rid, seq, values):
    return client.post(f"/api/recordings/{rid}/chunk?seq={seq}", content=_f32(values),
                       headers={"Content-Type": "application/octet-stream"})


def test_round_trip_writes_a_valid_wav_in_the_export_folder(client, tmp_path):
    started = _start(client)
    path = Path(started["path"])
    assert path.parent == (tmp_path / "out").resolve() and path.name.startswith("CrateMind-recording-")
    first = [0.5, -0.5, 0.25, -0.25]
    assert _chunk(client, started["id"], 0, first).status_code == 200
    # Valid mid-recording: the header already covers the first chunk.
    assert np.allclose(_read(str(path)), first, atol=1e-6)
    r = _chunk(client, started["id"], 1, [1.5, -2.0, 0.0, 1.0])
    assert r.status_code == 200 and r.json()["clipped"] == 2
    done = client.post(f"/api/recordings/{started['id']}/stop")
    assert done.status_code == 200, done.text
    assert done.json()["seconds"] == pytest.approx(4 / 48000, abs=1e-3) and done.json()["clipped"] == 2
    assert np.allclose(_read(str(path)), first + [1.0, -1.0, 0.0, 1.0], atol=1e-6)
    assert client.post(f"/api/recordings/{started['id']}/stop").status_code == 404


def test_retry_is_idempotent_and_a_gap_or_bad_length_is_refused(client):
    rid = _start(client)["id"]
    assert _chunk(client, rid, 0, [0.1, 0.1]).status_code == 200
    again = _chunk(client, rid, 0, [0.9, 0.9])
    assert again.status_code == 200 and again.json()["seconds"] == pytest.approx(1 / 48000, abs=1e-6)
    assert _chunk(client, rid, 2, [0.1, 0.1]).status_code == 409
    odd = client.post(f"/api/recordings/{rid}/chunk?seq=1", content=b"\x00" * 12)
    assert odd.status_code == 422
    assert _chunk(client, "nope", 1, [0.1, 0.1]).status_code == 404


def test_new_start_finalises_the_open_file_and_never_overwrites(client):
    a = _start(client)
    assert _chunk(client, a["id"], 0, [0.2, 0.2]).status_code == 200
    b = _start(client)
    assert b["path"] != a["path"]
    assert len(_read(a["path"])) == 2
    assert _chunk(client, a["id"], 1, [0.2, 0.2]).status_code == 404


def test_low_disk_refuses_to_start_and_stops_a_running_recording(client, monkeypatch):
    Usage = namedtuple("Usage", "total used free")
    free = {"bytes": 1024**3}
    monkeypatch.setattr(recorder.shutil, "disk_usage", lambda _p: Usage(0, 0, free["bytes"]))
    assert client.post("/api/recordings/start", json={"sample_rate": 48000}).status_code == 409
    free["bytes"] = 3 * 1024**3
    started = _start(client)
    free["bytes"] = 100 * 1024**2
    r = _chunk(client, started["id"], 0, [0.1, 0.1])
    assert r.status_code == 409 and "γέμισε" in r.json()["detail"]
    assert os.path.exists(started["path"]) and recorder._session is None


def test_size_limit_stops_and_keeps_the_file(client, monkeypatch):
    monkeypatch.setattr(recorder, "MAX_DATA_BYTES", 6)
    started = _start(client)
    assert _chunk(client, started["id"], 0, [0.1, 0.1]).status_code == 200
    r = _chunk(client, started["id"], 1, [0.1, 0.1])
    assert r.status_code == 409 and "4 GB" in r.json()["detail"]
    assert len(_read(started["path"])) == 2


def test_disk_write_error_stops_cleanly_and_keeps_the_good_part(client):
    started = _start(client)
    assert _chunk(client, started["id"], 0, [0.3, 0.3]).status_code == 200

    class Failing:
        def __init__(self, real):
            self.real = real

        def write(self, data):
            if len(data) > 8:
                self.real.write(data[:3])  # a partial write before the error
                raise OSError(28, "No space left on device")
            return self.real.write(data)

        def __getattr__(self, name):
            return getattr(self.real, name)

    recorder._session.file = Failing(recorder._session.file)
    r = _chunk(client, started["id"], 1, [0.5] * 4)
    assert r.status_code == 409 and "δίσκο" in r.json()["detail"]
    assert recorder._session is None
    assert np.allclose(_read(started["path"]), [0.3, 0.3], atol=1e-6)
    assert _start(client)["path"] != started["path"]  # the recorder is not stuck


def test_sample_rate_is_validated(client):
    assert client.post("/api/recordings/start", json={"sample_rate": 1000}).status_code == 422


def test_export_folder_inside_a_library_root_is_refused(client, monkeypatch, tmp_path):
    import app.config as cfg

    monkeypatch.setenv("CRATEMIND_OUTPUT_DIR", str(tmp_path / "lib" / "exports"))
    cfg.get_settings.cache_clear()
    r = client.post("/api/recordings/start", json={"sample_rate": 48000})
    assert r.status_code == 422
    assert not (tmp_path / "lib" / "exports").exists()


def test_wav_header_layout():
    header = recorder.wav_header(44100, 600)
    assert len(header) == recorder.HEADER_BYTES
    assert struct.unpack_from("<I", header, 4)[0] == 636 and struct.unpack_from("<I", header, 40)[0] == 600
    assert struct.unpack_from("<HHIIHH", header, 20) == (1, 2, 44100, 44100 * 6, 6, 24)


def test_desktop_core_recording_routes(tmp_path):
    script = '''
import numpy as np
from app.config import get_settings, Settings
get_settings.cache_clear()
import app.config
app.config.get_settings = lambda: Settings(_env_file=None)
from fastapi.testclient import TestClient
from app.app_factory import create_app
app = create_app("desktop-core")
with TestClient(app) as client:
    started = client.post("/api/recordings/start", json={"sample_rate": 48000})
    assert started.status_code == 200, started.text
    rid = started.json()["id"]
    chunk = client.post(f"/api/recordings/{rid}/chunk?seq=0", content=np.zeros(4, dtype="<f4").tobytes())
    assert chunk.status_code == 200, chunk.text
    done = client.post(f"/api/recordings/{rid}/stop")
    assert done.status_code == 200 and done.json()["seconds"] > 0, done.text
'''
    env = {k: v for k, v in os.environ.items() if not k.startswith("CRATEMIND_")}
    env.update(CRATEMIND_DB_PATH=str(tmp_path / "catalog.sqlite"),
               CRATEMIND_BACKUP_DIR=str(tmp_path / "backups"),
               CRATEMIND_OUTPUT_DIR=str(tmp_path / "out"),
               CRATEMIND_LIBRARY_ROOTS=str(tmp_path / "lib"),
               CRATEMIND_RUNTIME_PROFILE="desktop-core")
    result = subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr
    assert list((tmp_path / "out").glob("CrateMind-recording-*.wav"))


def _finished_wav(client, seconds=2.0):
    started = _start(client)
    t = np.arange(int(48000 * seconds)) / 48000
    tone = 0.3 * np.sin(2 * np.pi * 440 * t)
    assert _chunk(client, started["id"], 0, np.repeat(tone, 2)).status_code == 200
    assert client.post(f"/api/recordings/{started['id']}/stop").status_code == 200
    return Path(started["path"])


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="needs ffmpeg")
@pytest.mark.parametrize("bitrate", [128, 256])
def test_convert_to_aac_replaces_the_wav_only_after_a_checked_file(client, bitrate):
    wav = _finished_wav(client)
    r = client.post("/api/recordings/convert", json={"file": wav.name, "bitrate": bitrate})
    assert r.status_code == 200, r.text
    m4a = Path(r.json()["path"])
    assert m4a == wav.with_suffix(".m4a") and m4a.is_file() and not wav.exists()
    assert r.json()["seconds"] == pytest.approx(2.0, abs=0.01)
    assert not list(wav.parent.glob("*.part.m4a"))
    # Converting again finds no WAV; an existing AAC is never overwritten.
    assert client.post("/api/recordings/convert", json={"file": wav.name, "bitrate": bitrate}).status_code == 404


def test_convert_failure_keeps_the_wav(client, monkeypatch):
    import app.config as cfg

    wav = _finished_wav(client, seconds=0.5)
    monkeypatch.setenv("CRATEMIND_FFMPEG_PATH", shutil.which("false") or "/usr/bin/false")
    cfg.get_settings.cache_clear()
    r = client.post("/api/recordings/convert", json={"file": wav.name, "bitrate": 256})
    assert r.status_code == 409 and "WAV" in r.json()["detail"]
    assert wav.is_file() and not list(wav.parent.glob("*.m4a"))


def test_convert_refuses_bad_names_bitrates_and_the_running_recording(client):
    for body in ({"file": "other.wav", "bitrate": 256}, {"file": "../CrateMind-recording-2026-11-17_23-40.wav", "bitrate": 256},
                 {"file": "CrateMind-recording-2026-11-17_23-40.m4a", "bitrate": 256},
                 {"file": "CrateMind-recording-2026-11-17_23-40.wav", "bitrate": 192}):
        assert client.post("/api/recordings/convert", json=body).status_code == 422, body
    running = _start(client)
    r = client.post("/api/recordings/convert", json={"file": running["file"], "bitrate": 256})
    assert r.status_code in (409, 404) and Path(running["path"]).is_file()


def test_convert_without_ffmpeg_keeps_the_wav(tmp_path):
    wav = tmp_path / "CrateMind-recording-2026-11-18_10-00.wav"
    wav.write_bytes(recorder.wav_header(48000, 0))
    with pytest.raises(recorder.RecordingError) as error:
        recorder.convert_to_aac(tmp_path, wav.name, 256, None, None)
    assert error.value.status == 409 and wav.is_file()
