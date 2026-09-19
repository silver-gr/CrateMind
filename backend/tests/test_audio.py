"""Audio streaming endpoint: Range support + safety."""
from __future__ import annotations

from pathlib import Path

from sqlmodel import Session

from tests.conftest import make_wav


def _add_track(absolute_path: str, extension: str) -> int:
    import app.db as dbmod
    from app.models import Track

    with Session(dbmod.get_engine()) as s:
        t = Track(
            absolute_path=absolute_path,
            extension=extension,
            file_name=Path(absolute_path).name,
            missing=False,
        )
        s.add(t)
        s.commit()
        s.refresh(t)
        return t.id


def test_full_file_response(client, tmp_path):
    wav = make_wav(tmp_path / "a.wav", seconds=0.5, freq_seed=1)
    size = wav.stat().st_size
    tid = _add_track(str(wav), "wav")

    r = client.get(f"/api/tracks/{tid}/audio")
    assert r.status_code == 200
    assert r.headers["accept-ranges"] == "bytes"
    assert int(r.headers["content-length"]) == size
    assert r.headers["content-type"].startswith("audio/wav")
    assert len(r.content) == size


def test_valid_range_returns_206(client, tmp_path):
    wav = make_wav(tmp_path / "a.wav", seconds=1.0, freq_seed=2)
    size = wav.stat().st_size
    tid = _add_track(str(wav), "wav")

    r = client.get(f"/api/tracks/{tid}/audio", headers={"Range": "bytes=0-99"})
    assert r.status_code == 206
    assert r.headers["content-range"] == f"bytes 0-99/{size}"
    assert int(r.headers["content-length"]) == 100
    assert len(r.content) == 100

    # suffix range
    r2 = client.get(f"/api/tracks/{tid}/audio", headers={"Range": "bytes=-50"})
    assert r2.status_code == 206
    assert int(r2.headers["content-length"]) == 50


def test_invalid_range_returns_416(client, tmp_path):
    wav = make_wav(tmp_path / "a.wav", seconds=0.2, freq_seed=3)
    size = wav.stat().st_size
    tid = _add_track(str(wav), "wav")

    r = client.get(f"/api/tracks/{tid}/audio", headers={"Range": f"bytes={size + 100}-{size + 200}"})
    assert r.status_code == 416
    assert r.headers["content-range"] == f"bytes */{size}"


def test_missing_track_404(client):
    assert client.get("/api/tracks/999999/audio").status_code == 404


def test_missing_file_410(client, tmp_path):
    tid = _add_track(str(tmp_path / "gone.wav"), "wav")  # never created on disk
    assert client.get(f"/api/tracks/{tid}/audio").status_code == 410


def test_unsupported_format_415(client, tmp_path):
    f = tmp_path / "x.aiff"
    f.write_bytes(b"FORM....AIFF")  # real file, unplayable in browser
    tid = _add_track(str(f), "aiff")
    assert client.get(f"/api/tracks/{tid}/audio").status_code == 415


def test_no_arbitrary_path_access(client):
    # only an integer id is accepted; a path-like id cannot reach the filesystem
    r = client.get("/api/tracks/..%2F..%2F..%2Fetc%2Fpasswd/audio")
    assert r.status_code in (404, 422)
