"""Shared pytest fixtures. Each test gets an isolated temp SQLite DB."""
from __future__ import annotations

import struct
import wave
from pathlib import Path

import pytest
from sqlmodel import Session


@pytest.fixture
def db(tmp_path, monkeypatch):
    monkeypatch.setenv("CRATEMIND_DB_PATH", str(tmp_path / "test.sqlite"))
    monkeypatch.setenv("CRATEMIND_BACKUP_DIR", str(tmp_path / "bk"))
    monkeypatch.setenv("CRATEMIND_OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("CRATEMIND_LIBRARY_ROOTS", str(tmp_path / "lib"))

    import app.config as cfg
    import app.db as dbmod

    cfg.get_settings.cache_clear()
    dbmod._engine = None  # force a fresh engine on the temp DB
    dbmod._settings = cfg.get_settings()
    dbmod.init_db()

    with Session(dbmod.get_engine(), expire_on_commit=False) as session:
        yield session


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("CRATEMIND_DB_PATH", str(tmp_path / "test.sqlite"))
    monkeypatch.setenv("CRATEMIND_BACKUP_DIR", str(tmp_path / "bk"))
    monkeypatch.setenv("CRATEMIND_OUTPUT_DIR", str(tmp_path / "out"))
    monkeypatch.setenv("CRATEMIND_LIBRARY_ROOTS", str(tmp_path / "lib"))

    import app.config as cfg
    import app.db as dbmod

    cfg.get_settings.cache_clear()
    dbmod._engine = None
    dbmod._settings = cfg.get_settings()

    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:  # lifespan creates tables on the temp DB
        yield c


def make_wav(path: Path, seconds: float = 1.0, freq_seed: int = 0) -> Path:
    """Write a tiny valid WAV. freq_seed varies bytes so files can differ."""
    path.parent.mkdir(parents=True, exist_ok=True)
    rate = 8000
    frames = int(rate * seconds)
    with wave.open(str(path), "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", (i * freq_seed) % 256) for i in range(frames)))
    return path
