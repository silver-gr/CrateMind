"""Hand-built audio files for the «Καθαρά ονόματα» scan tests (invented names only), and the pinned output
`read_tags` gave for them before the raw read was added (test_names_guards compares against it)."""
from __future__ import annotations

import struct
from pathlib import Path

from mutagen.flac import FLAC
from mutagen.id3 import ID3, TALB, TIT2, TPE1, TPUB, TRCK
from mutagen.mp4 import MP4
from mutagen.wave import WAVE

from tests.conftest import make_wav


def mp3(path: Path, *frames) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes((b"\xff\xfb\x90\x64" + b"\x00" * 413) * 10)  # ten silent MPEG-1 Layer III frames
    tags = ID3()
    for frame in frames:
        tags.add(frame)
    tags.save(path)
    return path


def m4a(path: Path, tags: dict) -> Path:
    def atom(name: bytes, payload: bytes) -> bytes:
        return struct.pack(">L", len(payload) + 8) + name + payload

    path.parent.mkdir(parents=True, exist_ok=True)
    movie_header = b"\x00" * 12 + struct.pack(">LL", 1000, 1000) + b"\x00" * 80
    path.write_bytes(atom(b"ftyp", b"M4A \x00\x00\x00\x00M4A mp42isom") + atom(b"moov", atom(b"mvhd", movie_header)))
    audio = MP4(path)
    audio.add_tags()
    audio.update(tags)
    audio.save()
    return path


def wav(path: Path, *frames, seed: int = 1) -> Path:
    make_wav(path, seconds=0.05, freq_seed=seed)
    if frames:
        audio = WAVE(path)
        audio.add_tags()
        for frame in frames:
            audio.tags.add(frame)
        audio.save()
    return path


def flac(path: Path, **tags) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    stream_info = (struct.pack(">HH", 4096, 4096) + b"\x00" * 6
                   + bytes([0x0A, 0xC4, 0x42, 0xF0, 0, 0, 0, 0]) + b"\x00" * 16)
    path.write_bytes(b"fLaC" + bytes([0x80, 0, 0, 34]) + stream_info)
    audio = FLAC(path)
    audio.update(tags)
    audio.save()
    return path


def t(cls, text):
    return cls(encoding=3, text=text)


def pinned_files(folder: Path) -> dict[str, Path]:
    """MP3, MP4 and WAV files with junk titles, title hints and empty artists."""
    return {
        # no artist frame: the title carries "Artist - Title" and a tempo
        "mp3_title_hint": mp3(folder / "03 Velmora - Glass Harbor.mp3",
                              t(TIT2, "Velmora - Glass Harbor (Original Mix) [148 BPM] FREE DOWNLOAD")),
        # two artist values, a remix bracket, a bare tempo, a track number with a total
        "mp3_multi": mp3(folder / "Kestro - Nightfold.mp3", t(TPE1, ["Kestro", "Ommi"]),
                         t(TIT2, "Nightfold (Kestro Remix) 145"), t(TALB, "Tide EP"), t(TRCK, "3/12")),
        # a track-index artist and a junk title: the file name gives both
        "mp3_junk": mp3(folder / "Druvan - Lantern Sky.mp3", t(TPE1, "2 Druvan"), t(TIT2, "MASTER")),
        # an empty artist frame
        "mp3_empty_artist": mp3(folder / "Sulmo - Quiet Ridge 150.mp3", t(TPE1, ""), t(TIT2, "")),
        "mp4_title_hint": m4a(folder / "Orvalo - Deep Current.m4a",
                              {"\xa9nam": "Orvalo - Deep Current [Free DL] 150bpm", "\xa9alb": "V.A. Fernwave Vol 2",
                               "trkn": [(5, 9)]}),
        "mp4_label_artist": m4a(folder / "Brimo - Static.m4a",
                                {"\xa9ART": "Halvex Records", "\xa9nam": "Brimo - Static (2024)"}),
        "wav_label_title": wav(folder / "Mirelo - Sunfall.wav", t(TPE1, "Halvex Records"),
                               t(TIT2, "Halvex Records - Mirelo - Sunfall (2024)"), t(TPUB, "Halvex Records")),
        "wav_no_tags": wav(folder / "Pallor - Ember Rise 142 bpm.wav", seed=2),
    }


# read_tags(path) for each pinned file, measured on main 2a89edb before the raw read was added.
PINNED_OUTPUT = {
    "mp3_title_hint": {"title": "Glass Harbor (Original Mix) [148 BPM]", "artist": "Velmora"},
    "mp3_multi": {"artist": "Kestro", "title": "Nightfold (Kestro Remix)", "album": "Tide EP", "bpm": 145.0},
    "mp3_junk": {"artist": "Druvan", "title": "MASTER"},
    "mp3_empty_artist": {"artist": "Sulmo", "title": "Quiet Ridge", "bpm": 150.0},
    "mp4_title_hint": {"title": "Deep Current [ ]", "album": "V.A. Fernwave Vol 2", "artist": "Orvalo", "bpm": 150.0},
    "mp4_label_artist": {"artist": "Brimo", "title": "Static (2024)"},
    "wav_label_title": {"artist": "Mirelo", "title": "Sunfall (2024)", "label": "Halvex Records"},
    "wav_no_tags": {"artist": "Pallor", "title": "Ember Rise", "bpm": 142.0},
}
