"""Set recording: a 24-bit WAV written only into the export folder, valid after every chunk."""
from __future__ import annotations

import os
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
