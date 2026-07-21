"""Metadata reader must never crash on odd input."""
from __future__ import annotations

from pathlib import Path

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


def test_filename_artist_title_fallback():
    result = metadata_reader.infer_tags_from_filename(Path("/tmp/01 ATYYA - Desert.wav"))
    assert result == {"artist": "ATYYA", "title": "Desert"}


def test_filename_title_only_fallback():
    result = metadata_reader.infer_tags_from_filename(Path("/tmp/07 Horizons.wav"))
    assert result == {"title": "Horizons"}


def test_filename_cleanup_strips_promo_and_bpm_tokens():
    result = metadata_reader.infer_tags_from_filename(
        Path("/tmp/Lagrima De Amor ★ 180+ BPM ★FREE DOWNLOAD★ by Elemental Mov.mp3")
    )
    assert result["title"] == "Lagrima De Amor"
    assert result["bpm"] == 180.0


def test_filename_cleanup_strips_trailing_bpm_year_and_bits():
    result = metadata_reader.infer_tags_from_filename(
        Path("/tmp/Inner Coma - We are Gods 195 (2017) [24].flac")
    )
    assert result["artist"] == "Inner Coma"
    assert result["title"] == "We are Gods"
    assert result["bpm"] == 195.0


def test_filename_cleanup_captures_va_album_hint():
    result = metadata_reader.infer_tags_from_filename(
        Path("/tmp/XENROX - SEVEN [214] (V.A. Ultra Electricity - Higher Voltage Rec.).mp3")
    )
    assert result["artist"] == "XENROX"
    assert result["title"] == "SEVEN"
    assert result["album"] == "V.A. Ultra Electricity - Higher Voltage Rec."
    assert result["bpm"] == 214.0


def test_filename_cleanup_removes_label_suffix():
    result = metadata_reader.infer_tags_from_filename(
        Path("/tmp/Happy Daze (Sangoma Records).mp3")
    )
    assert result == {"title": "Happy Daze"}


def test_filename_cleanup_uses_second_artist_when_first_chunk_is_label():
    result = metadata_reader.infer_tags_from_filename(
        Path("/tmp/Izuran Records - Black Phillip - Place of Dead Roads.mp3")
    )
    assert result["artist"] == "Black Phillip"
    assert result["title"] == "Place of Dead Roads"
    assert result["label"] == "Izuran Records"


def test_looks_like_label_name_flags_record_companies():
    assert metadata_reader.looks_like_label_name("Izuran Records") is True
    assert metadata_reader.looks_like_label_name("Altar Records (official)") is True
    assert metadata_reader.looks_like_label_name("Technical Hitch") is False


def test_read_tags_sanitizes_existing_embedded_title_and_artist(monkeypatch, tmp_path):
    p = make_wav(tmp_path / "dummy.wav")

    class FakeAudio(dict):
        pass

    fake = FakeAudio({
        "artist": ["02. Crone"],
        "title": ["Brain Rolling (Kopophobia Rmx) - 207 (Preview)"],
    })
    monkeypatch.setattr(metadata_reader, "MutagenFile", lambda *_args, **_kwargs: fake)

    result = metadata_reader.read_tags(p)
    assert result["artist"] == "Crone"
    assert result["title"] == "Brain Rolling (Kopophobia Rmx)"
    assert result["bpm"] == 207.0


def test_read_tags_replaces_track_number_artist_with_filename_artist(monkeypatch, tmp_path):
    p = make_wav(tmp_path / "Virtuanoise & Btoxik - Animaniacs 173 BPM.wav")

    class FakeAudio(dict):
        pass

    fake = FakeAudio({
        "artist": ["02"],
        "title": ["Virtuanoise & Btoxik - Animaniacs 173 BPM"],
    })
    monkeypatch.setattr(metadata_reader, "MutagenFile", lambda *_args, **_kwargs: fake)

    result = metadata_reader.read_tags(p)
    assert result["artist"] == "Virtuanoise & Btoxik"
    assert result["title"] == "Animaniacs"
    assert result["bpm"] == 173.0
