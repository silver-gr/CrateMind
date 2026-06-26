"""Metadata reader must never crash on odd input."""
from __future__ import annotations

from app.services import metadata_reader
from tests.conftest import make_wav


def test_non_audio_returns_empty(tmp_path):
    p = tmp_path / "notes.txt"
    p.write_text("not audio")
    assert metadata_reader.read_tags(p) == {}


def test_unicode_filename_does_not_crash(tmp_path):
    p = make_wav(tmp_path / "Mañana — Ψυτράνς 日本.wav")
    result = metadata_reader.read_tags(p)
    assert isinstance(result, dict)  # no exception, dict returned


def test_missing_file_returns_empty(tmp_path):
    assert metadata_reader.read_tags(tmp_path / "nope.flac") == {}
