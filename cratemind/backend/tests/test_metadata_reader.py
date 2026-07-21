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


def test_parenthetical_with_number_is_not_read_as_bpm():
    # "Area 88" is text-with-a-number, not a tempo tag: keep the parenthetical,
    # do not strip it or invent a BPM (regression for the (Area 88) -> bpm 88 bug).
    result = metadata_reader.infer_tags_from_filename(Path("/tmp/Kavinsky - Nightcall (Area 88).mp3"))
    assert result["artist"] == "Kavinsky"
    assert result["title"] == "Nightcall (Area 88)"
    assert "bpm" not in result


def test_label_prefix_filename_keeps_bpm_from_full_segment():
    # Regression: the nested label branch used to recompute bpm from only the
    # nested title, discarding the BPM parsed from the full second segment.
    result = metadata_reader.infer_tags_from_filename(Path("/tmp/Rec Music - Artist 128bpm - Title.mp3"))
    assert result["label"] == "Rec Music"
    assert result["title"] == "Title"
    assert result["bpm"] == 128.0


def test_bare_trailing_number_is_bpm_only_when_over_130():
    # <= 130 is part of the title, not a tempo tag — leave it untouched.
    low = metadata_reader.infer_tags_from_filename(Path("/tmp/Kavinsky - Route 66.mp3"))
    assert low == {"artist": "Kavinsky", "title": "Route 66"}
    boundary = metadata_reader.infer_tags_from_filename(Path("/tmp/Kavinsky - District 130.mp3"))
    assert boundary == {"artist": "Kavinsky", "title": "District 130"}
    # > 130 is treated as BPM and stripped from the title.
    high = metadata_reader.infer_tags_from_filename(Path("/tmp/Kavinsky - Anthem 150.mp3"))
    assert high["artist"] == "Kavinsky"
    assert high["title"] == "Anthem"
    assert high["bpm"] == 150.0


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


def _fake_tags(monkeypatch, **tags):
    class FakeAudio(dict):
        pass
    fake = FakeAudio({k: [v] for k, v in tags.items()})
    monkeypatch.setattr(metadata_reader, "MutagenFile", lambda *_a, **_k: fake)


def test_embedded_title_keeps_year_and_label_suffix(monkeypatch, tmp_path):
    # #6: an embedded title tag is authoritative — do not strip its year or
    # label-name parentheticals the way we clean messy filenames.
    p = make_wav(tmp_path / "dummy.wav")
    _fake_tags(monkeypatch, artist="Real DJ", title="Anniversary (2019)")
    assert metadata_reader.read_tags(p)["title"] == "Anniversary (2019)"

    p2 = make_wav(tmp_path / "dummy2.wav")
    _fake_tags(monkeypatch, artist="Real DJ", title="Skyline (Sangoma Records Edit)")
    assert metadata_reader.read_tags(p2)["title"] == "Skyline (Sangoma Records Edit)"


def test_embedded_title_still_strips_promo_and_inline_bpm(monkeypatch, tmp_path):
    # gentle still removes obvious junk: promo brackets and an inline "NNN bpm".
    p = make_wav(tmp_path / "dummy.wav")
    _fake_tags(monkeypatch, artist="Real DJ", title="Nebula 174 BPM (FREE DOWNLOAD)")
    result = metadata_reader.read_tags(p)
    assert result["title"] == "Nebula"
    assert result["bpm"] == 174.0


def test_label_like_embedded_artist_is_kept_without_a_better_candidate(monkeypatch, tmp_path):
    # #5: a real act whose name contains a label word must survive.
    p = make_wav(tmp_path / "Cosmic Music - Nebula.wav")
    _fake_tags(monkeypatch, artist="Cosmic Music", title="Nebula")
    assert metadata_reader.read_tags(p)["artist"] == "Cosmic Music"


def test_label_like_embedded_artist_replaced_when_filename_has_real_artist(monkeypatch, tmp_path):
    # #5: a comp that mis-tagged the label as the artist is still corrected.
    p = make_wav(tmp_path / "Zenon Records - RealDJ - Track.wav")
    _fake_tags(monkeypatch, artist="Zenon Records", title="Track")
    result = metadata_reader.read_tags(p)
    assert result["artist"] == "RealDJ"
    assert result["label"] == "Zenon Records"
