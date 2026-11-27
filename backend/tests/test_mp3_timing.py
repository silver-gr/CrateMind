"""An MP3's time zero in the analysis decode follows the deck's (services/mp3_timing.py), and only the
grids measured off it are measured again. The rules: .omc/research/opendj-comparison-2026-11-24/mp3-timeline/COUNT.md."""
import shutil
import subprocess
import wave
from datetime import UTC, datetime

import numpy as np
import pytest
from sqlmodel import select

from app.models import Track, TrackBeatgrid, TrackStructure
from app.services import audio_analysis as aa
from app.services import beatgrid_detect as bd
from app.services import mp3_timing as mt
from app.services import track_structure as ts


# --- hand-built headers -----------------------------------------------------------------------------

def _id3(size: int = 64) -> bytes:
    return b"ID3\x03\x00\x00" + bytes([(size >> s) & 0x7F for s in (21, 14, 7, 0)]) + b"\0" * size


def _frame(name: bytes | None, *, delay: int = 576, crc: str = "valid", xing: bool = True) -> bytes:
    """One MPEG-1 Layer III frame (128 kbps, 44.1 kHz, stereo: 417 bytes), with an Info header and a
    LAME tag named `name` (None: Info header only, no LAME tag), its CRC-16 valid or zero."""
    frame = bytearray(b"\xff\xfb\x90\x00" + b"\0" * 413)
    if xing:
        x = 4 + 32
        frame[x:x + 8] = b"Info" + (0x0F).to_bytes(4, "big")
        v = x + 120
        if name is not None:
            frame[v:v + 9] = name.ljust(9, b"\0")
            frame[v + 21:v + 24] = (delay << 12 | 1000).to_bytes(3, "big")
            if crc == "valid":
                frame[v + 34:v + 36] = mt._crc16(bytes(frame[:v + 34])).to_bytes(2, "big")
    return bytes(frame) + b"\xff\xfb\x90\x00" + b"\0" * 413


@pytest.mark.parametrize("head, expected", [
    (_frame(b"LAME3.100"), 0),                                    # both skip the lead-in
    (_id3() + _frame(b"Lavc61.19"), 0),
    (_id3() + _id3(32) + _frame(b"LAME3.100"), 0),                # two tags back to back
    (_id3() + _frame(b"Lavf54.25", crc="zero"), -576),            # old ffmpeg, blank checksum: analysis early
    (_id3() + _frame(b"Lame3.100"), 529 + 576),                   # a LAME tag ffmpeg does not trust: late
    (_id3() + _frame(None), 529),                                 # Info header without a LAME tag: late
    (_id3() + _frame(b"", crc="zero"), 529),
    (_id3() + _frame(None, xing=False), 529),                     # no header at all: late
    (_id3() + b"\x89PNG" + b"\0" * 900 + _frame(b"Lame3.100"), 0),  # junk before the audio: the deck cannot play it
])
def test_the_shift_follows_the_two_decoders_rules(tmp_path, head, expected):
    path = tmp_path / "t.mp3"
    path.write_bytes(head)
    assert mt.lead_in_shift(path) == expected


def test_only_mp3_files_are_read(tmp_path):
    assert mt.lead_in_shift(tmp_path / "absent.wav") == 0                   # not even opened
    with pytest.raises(OSError):
        mt.lead_in_shift(tmp_path / "absent.mp3")


# --- the decode, on MP3s ffmpeg makes here --------------------------------------------------------

def _lame() -> bool:
    if not shutil.which("ffmpeg"):
        return False
    out = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True).stdout
    return "libmp3lame" in out


def _encode(tmp_path, name: str, *extra: str) -> bytes:
    wav = tmp_path / "click.wav"
    if not wav.exists():
        x = np.zeros(44100 * 3, np.float32); x[44100] = 0.9                # one click at exactly 1.000 s
        with wave.open(str(wav), "wb") as w:
            w.setnchannels(2); w.setsampwidth(2); w.setframerate(44100)
            w.writeframes((np.stack([x, x], 1) * 32767).astype("<i2").tobytes())
    out = tmp_path / name
    subprocess.run(["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(wav), "-c:a", "libmp3lame", "-b:a", "320k",
                    "-id3v2_version", "0", *extra, str(out)], check=True)
    return out.read_bytes()


def _patched(data: bytes, *, name: bytes | None = None, crc: str = "valid") -> bytes:
    """The encoder name and/or the LAME tag checksum of an ffmpeg-made file, as other encoders leave them."""
    b = bytearray(data)
    x = b.find(b"Info", 0, 4096)
    flags = int.from_bytes(b[x + 4:x + 8], "big")
    v = x + 8 + 4 * bool(flags & 1) + 4 * bool(flags & 2) + 100 * bool(flags & 4) + 4 * bool(flags & 8)
    if name is not None:
        b[v:v + 9] = name
    b[v + 34:v + 36] = mt._crc16(bytes(b[:v + 34])).to_bytes(2, "big") if crc == "valid" else b"\0\0"
    return bytes(b)


@pytest.mark.skipif(not _lame(), reason="ffmpeg with libmp3lame not on PATH")
def test_the_analysis_decode_hears_the_click_where_the_deck_plays_it(tmp_path):
    """The click sits at 1.000 s; the deck (WebKit) plays it at 1.000 s, or 576 samples later when it
    does not trust the file's LAME tag. At 22,050 Hz: sample 22,050 or 22,338 (RESULTS.md)."""
    plain = _encode(tmp_path, "plain.mp3")
    files = {
        "plain.mp3": (plain, 22050),                                                       # agree already
        "noheader.mp3": (_encode(tmp_path, "noheader.mp3", "-write_xing", "0"), 22338),    # late without correction
        "lowercase.mp3": (_patched(plain, name=b"Lame3.100"), 22050),                      # late without correction
        "blankcrc.mp3": (_patched(plain, crc="zero"), 22338),                              # early without correction
    }
    uncorrected = {}
    for name, (data, deck) in files.items():
        path = tmp_path / name
        path.write_bytes(data)
        shift = mt.lead_in_shift(path)
        audio = aa.decode_audio(str(path), seconds=3, lead_in=shift)
        assert abs(int(np.argmax(np.abs(audio))) - deck) <= 1, name
        uncorrected[name] = int(np.argmax(np.abs(aa.decode_audio(str(path), seconds=3))))
        assert path.read_bytes() == data                                                    # only read
    assert abs(uncorrected["noheader.mp3"] - 22602) <= 1 and abs(uncorrected["lowercase.mp3"] - 22602) <= 1
    assert abs(uncorrected["blankcrc.mp3"] - 22050) <= 1


# --- which grids are measured again -----------------------------------------------------------------

def test_only_grids_off_the_decks_time_zero_are_measured_again(db, tmp_path, monkeypatch):
    monkeypatch.setattr(aa, "_loudness_targets", lambda *a, **k: [])
    monkeypatch.setattr(aa, "analyze_file", lambda path, **_: pytest.fail("BPM and key are not run again"))
    monkeypatch.setattr(aa, "_structure_for", lambda *a: pytest.fail("the structure comes with the new grid"))
    grid = bd.GridResult(bpm=145.0, anchor_s=0.3, confidence=0.97, residual_ms=0.4, downbeat_confidence=0.6)
    calls = []
    monkeypatch.setattr(aa, "_grid_for", lambda path, duration, hint: calls.append(path) or (grid, None))

    files = {"late.mp3": _id3() + _frame(b"Lame3.100"), "early.mp3": _id3() + _frame(b"Lavf54.25", crc="zero"),
             "fine.mp3": _id3() + _frame(b"LAME3.100"), "fine.wav": b"RIFF"}
    stamp = datetime(2026, 11, 20, tzinfo=UTC)
    tracks = {}
    for name in [*files, "gone.mp3"]:
        path = tmp_path / name
        if name in files:
            path.write_bytes(files[name])
        tracks[name] = track = Track(absolute_path=str(path), analyzed_at=stamp, bpm_analyzed=145.0)
        db.add(track); db.commit()
        db.add(TrackBeatgrid(track_id=track.id, source=bd.SOURCE, source_version=bd.VERSION, bpm=145.0, straight=True,
                             anchor_s=0.31, confidence=0.97, imported_at=stamp))
        db.add(TrackStructure(track_id=track.id, version=ts.VERSION, data='{"bpm": 145.0}'))
    db.commit()

    result = aa.analyze_all(db, only_unprocessed=True, local_only=True)          # what «Μόνο νέα» runs

    assert sorted(calls) == [str(tmp_path / "early.mp3"), str(tmp_path / "late.mp3")]
    assert result["grids"] == 2
    rows = {name: db.exec(select(TrackBeatgrid).where(TrackBeatgrid.track_id == t.id)).one() for name, t in tracks.items()}
    for name in ("late.mp3", "early.mp3"):
        assert (rows[name].anchor_s, rows[name].source_uuid) == (0.3, mt.TIMELINE)
    for name in ("fine.mp3", "fine.wav"):                                         # checked once, grid kept
        assert rows[name].source_uuid == mt.TIMELINE and rows[name].anchor_s == 0.31
        assert rows[name].imported_at.replace(tzinfo=UTC) == stamp
    assert rows["gone.mp3"].source_uuid == "" and rows["gone.mp3"].anchor_s == 0.31   # unreadable now: next run

    calls.clear()
    aa.analyze_all(db, only_unprocessed=True, local_only=True)
    assert calls == []
