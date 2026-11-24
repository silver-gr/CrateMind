"""Metadata reader must never crash on odd input."""
from __future__ import annotations

import struct
from pathlib import Path

import pytest
from mutagen.aiff import AIFF
from mutagen.flac import FLAC
from mutagen.id3 import COMM, ID3, POPM, TALB, TBPM, TCON, TDRC, TIT2, TKEY, TPE1, TPUB, TXXX
from mutagen.mp4 import MP4, MP4FreeForm
from mutagen.wave import WAVE

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


# --- real tagged files, built by hand (no ffmpeg) ---------------------------------------------

# What every format already returned before the key/comment/rating fixes.
_BASE = {"artist": "Astrix", "title": "Song", "album": "Alb", "label": "Lab", "genre": "Psy",
         "bpm": 145.0, "year": 2019}


def _id3_frames(*extra):
    return [TPE1(encoding=3, text="Astrix"), TIT2(encoding=3, text="Song"), TALB(encoding=3, text="Alb"),
            TPUB(encoding=3, text="Lab"), TCON(encoding=3, text="Psy"), TBPM(encoding=3, text="145"),
            TDRC(encoding=3, text="2019"), *extra]


def _dj_frames():
    return _id3_frames(TKEY(encoding=3, text="8A"), TXXX(encoding=3, desc="initialkey", text="1A"),
                       COMM(encoding=3, lang="eng", desc="iTunNORM", text=" 00000A2B 00000A2B"),
                       COMM(encoding=3, lang="eng", desc="", text="hello comment"),
                       POPM(email="someone@example.com", rating=196, count=0))


def _mp3(path: Path, frames) -> Path:
    path.write_bytes((b"\xff\xfb\x90\x64" + b"\x00" * 413) * 10)  # ten silent MPEG-1 Layer III frames
    tags = ID3()
    for frame in frames:
        tags.add(frame)
    tags.save(path)
    return path


def _aiff(path: Path) -> Path:
    common = struct.pack(">hLh", 1, 8, 16) + b"\x40\x0e\xac\x44" + b"\x00" * 6  # mono, 16 bit, 44.1 kHz
    sound = b"\x00" * 24
    body = (b"AIFF" + b"COMM" + struct.pack(">L", len(common)) + common
            + b"SSND" + struct.pack(">L", len(sound)) + sound)
    path.write_bytes(b"FORM" + struct.pack(">L", len(body)) + body)
    return path


def _with_id3_chunk(audio, frames) -> None:
    audio.add_tags()
    for frame in frames:
        audio.tags.add(frame)
    audio.save()


def _flac(path: Path, **tags) -> Path:
    stream_info = (struct.pack(">HH", 4096, 4096) + b"\x00" * 6
                   + bytes([0x0A, 0xC4, 0x42, 0xF0, 0, 0, 0, 0]) + b"\x00" * 16)
    path.write_bytes(b"fLaC" + bytes([0x80, 0, 0, 34]) + stream_info)
    audio = FLAC(path)
    audio.update(tags)
    audio.save()
    return path


def _m4a(path: Path, **freeform) -> Path:
    def atom(name: bytes, payload: bytes) -> bytes:
        return struct.pack(">L", len(payload) + 8) + name + payload

    movie_header = b"\x00" * 12 + struct.pack(">LL", 1000, 1000) + b"\x00" * 80
    path.write_bytes(atom(b"ftyp", b"M4A \x00\x00\x00\x00M4A mp42isom") + atom(b"moov", atom(b"mvhd", movie_header)))
    audio = MP4(path)
    audio.add_tags()
    audio.update({"\xa9ART": "Astrix", "\xa9nam": "Song", "\xa9alb": "Alb", "\xa9gen": "Psy",
                  "\xa9cmt": "hello comment", "\xa9day": "2019-05-01", "tmpo": [145]})
    for name, value in freeform.items():
        audio[f"----:com.apple.iTunes:{name}"] = [MP4FreeForm(value.encode())]
    audio.save()
    return path


def test_mp3_reads_key_comment_and_rating(tmp_path):
    # The easy view lists none of TKEY, COMM and POPM; the fields it does give stay as they were.
    result = metadata_reader.read_tags(_mp3(tmp_path / "t.mp3", _dj_frames()))
    assert result == {**_BASE, "key_text": "8A", "comment": "hello comment", "rating": 4}


def test_mp3_fields_that_worked_before_are_unchanged(tmp_path):
    assert metadata_reader.read_tags(_mp3(tmp_path / "t.mp3", _id3_frames())) == _BASE


@pytest.mark.parametrize("desc", ["initialkey", "INITIALKEY", "KEY"])
def test_mp3_key_falls_back_to_user_text_frame(tmp_path, desc):
    path = _mp3(tmp_path / "t.mp3", _id3_frames(TXXX(encoding=3, desc=desc, text="Fm")))
    assert metadata_reader.read_tags(path)["key_text"] == "Fm"


def test_mp3_player_data_is_not_a_comment(tmp_path):
    path = _mp3(tmp_path / "t.mp3", _id3_frames(COMM(encoding=3, lang="eng", desc="iTunNORM", text=" 00000A2B")))
    assert "comment" not in metadata_reader.read_tags(path)


def test_aiff_and_wav_id3_chunk_reads_key_comment_and_rating(tmp_path):
    aiff = _aiff(tmp_path / "t.aiff")
    _with_id3_chunk(AIFF(aiff), _dj_frames())
    wav = make_wav(tmp_path / "t.wav")
    _with_id3_chunk(WAVE(wav), _dj_frames())
    for path in (aiff, wav):
        assert metadata_reader.read_tags(path) == {**_BASE, "key_text": "8A", "comment": "hello comment", "rating": 4}


def test_aiff_key_falls_back_to_user_text_frame(tmp_path):
    aiff = _aiff(tmp_path / "t.aiff")
    _with_id3_chunk(AIFF(aiff), _id3_frames(TXXX(encoding=3, desc="INITIALKEY", text="Am")))
    assert metadata_reader.read_tags(aiff) == {**_BASE, "key_text": "Am"}


@pytest.mark.parametrize("name", ["initialkey", "INITIALKEY", "KEY"])
def test_m4a_reads_freeform_key_and_label(tmp_path, name):
    result = metadata_reader.read_tags(_m4a(tmp_path / "t.m4a", **{name: "8A", "LABEL": "Lab"}))
    assert result == {**_BASE, "comment": "hello comment", "key_text": "8A"}


def test_m4a_fields_that_worked_before_are_unchanged(tmp_path):
    expected = {k: v for k, v in _BASE.items() if k != "label"} | {"comment": "hello comment"}
    assert metadata_reader.read_tags(_m4a(tmp_path / "t.m4a")) == expected


def test_flac_fields_are_unchanged_and_rating_is_in_stars(tmp_path):
    path = _flac(tmp_path / "t.flac", artist="Astrix", title="Song", album="Alb", label="Lab", genre="Psy",
                 bpm="145", date="2019", initialkey="8A", comment="hello comment", rating="80")
    assert metadata_reader.read_tags(path) == {**_BASE, "key_text": "8A", "comment": "hello comment", "rating": 4}


@pytest.mark.parametrize("written,stars", [("5", 5), ("3", 3), ("80", 4), ("100", 5), ("20", 1), ("255", 5),
                                           ("50", 3), ("90", 5), ("2.5", 3),
                                           ("0", None), ("junk", None)])
def test_written_rating_becomes_stars(tmp_path, written, stars):
    result = metadata_reader.read_tags(_flac(tmp_path / "t.flac", title="Song", rating=written))
    assert result.get("rating") == stars


@pytest.mark.parametrize("popm,stars", [(0, None), (1, 1), (64, 2), (128, 3), (196, 4), (255, 5)])
def test_popm_rating_becomes_stars(tmp_path, popm, stars):
    path = _mp3(tmp_path / "t.mp3", _id3_frames(POPM(email="someone@example.com", rating=popm, count=0)))
    assert metadata_reader.read_tags(path).get("rating") == stars


@pytest.mark.parametrize("artist", ["1200 Micrograms", "4i20", "3form", "5AM", "10cc"])
def test_artist_tag_keeps_a_name_the_index_rule_does_not_match(monkeypatch, tmp_path, artist):
    p = make_wav(tmp_path / "dummy.wav")
    _fake_tags(monkeypatch, artist=artist, title="Song")
    assert metadata_reader.read_tags(p)["artist"] == artist


@pytest.mark.parametrize("artist", ["01 - Astrix", "01. Astrix", "1.Astrix", "01) Astrix", "01 Astrix", "01_Astrix",
                                    "2 Astrix", "1- Astrix", "3 -Astrix", "21 Astrix"])
def test_artist_tag_loses_a_track_index(monkeypatch, tmp_path, artist):
    # Every numbered artist tag in the owner's library was a track index ("2 Sectio Aurea", "1- Zaaki").
    p = make_wav(tmp_path / "dummy.wav")
    _fake_tags(monkeypatch, artist=artist, title="Song")
    assert metadata_reader.read_tags(p)["artist"] == "Astrix"


@pytest.mark.parametrize("comment,kept", [
    ("www.mediahuman.com", False), ("www.mediahuman.com  www.mediahuman.com", False),
    ("Visit https://zenonrecords.bandcamp.com", False), ("https://label.bandcamp.com/", False),
    ("https://soundcloud.com/artist/track", True), ("C SHARP!!!!!!!", True), ("Mastered by X. More at label.com", True),
])
def test_a_comment_that_is_only_a_site_address_is_dropped(tmp_path, comment, kept):
    result = metadata_reader.read_tags(_flac(tmp_path / "t.flac", title="Song", comment=comment))
    assert result.get("comment") == (comment if kept else None)


def test_filename_inference_still_drops_a_leading_number():
    result = metadata_reader.infer_tags_from_filename(Path("/tmp/03 Astrix - Deep Jungle Walk.mp3"))
    assert result == {"artist": "Astrix", "title": "Deep Jungle Walk"}
