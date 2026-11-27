"""Where an MP3's time zero is for the deck, compared with the analysis decode.

Playback (WebKit) and the analysis decode (ffmpeg) skip an MP3's lead-in by different rules
(measured in .omc/research/opendj-comparison-2026-11-24/mp3-timeline/COUNT.md):
- ffmpeg skips the encoder delay + 529 decoder samples only when the first frame, starting exactly
  where the ID3v2 tags end, holds a Xing/Info header whose encoder name starts with LAME, Lavf or
  Lavc; otherwise it skips nothing.
- WebKit always skips the 529 decoder samples, plus the encoder delay when the LAME tag's CRC-16 is valid.

Read-only: reads the ID3v2 headers and the first frame; never writes."""
from __future__ import annotations

from pathlib import Path

DECODER_DELAY = 529
# On a CrateMind grid row (TrackBeatgrid.source_uuid, unused by that source): the grid was measured
# on a decode whose time zero is the deck's, or its file was checked and needs no correction.
TIMELINE = "playback-zero-v1"
_KNOWN = (b"LAME", b"Lavf", b"Lavc")
_BITRATES = {True: (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320),
             False: (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160)}
_FRAME_BYTES = 4096  # the first frame, and its Xing/LAME header in it, fit well within this


def _crc16(data: bytes) -> int:
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def _frame_header(b: bytes) -> tuple[bool, bool] | None:
    """(MPEG-1, mono) of an MPEG audio Layer III frame header at the start of `b`, else None."""
    if len(b) < 4 or b[0] != 0xFF or b[1] & 0xE0 != 0xE0:
        return None
    version, layer, bitrate, rate = (b[1] >> 3) & 3, (b[1] >> 1) & 3, b[2] >> 4, (b[2] >> 2) & 3
    if version == 1 or layer != 1 or bitrate in (0, 15) or rate == 3:
        return None
    return version == 3, b[3] >> 6 == 3


def lead_in_shift(path: str | Path) -> int:
    """Samples, at the file's own rate, that the analysis decode must drop (positive) or prepend as
    silence (negative) for its time zero to be the deck's. 0 for anything but an MP3 whose first
    frame follows its ID3v2 tags directly (a file with junk bytes before the audio, which the deck
    cannot play at all, is left as it is). Raises OSError when the file cannot be read."""
    if Path(path).suffix.lower() != ".mp3":
        return 0
    with open(path, "rb") as f:
        pos = 0
        while True:                                   # one or more ID3v2 tags, back to back
            f.seek(pos)
            h = f.read(10)
            if len(h) < 10 or h[:3] != b"ID3":
                break
            pos += 10 + ((h[6] & 0x7F) << 21 | (h[7] & 0x7F) << 14 | (h[8] & 0x7F) << 7 | (h[9] & 0x7F)) + (10 if h[5] & 0x10 else 0)
        f.seek(pos)
        b = f.read(_FRAME_BYTES)
    header = _frame_header(b)
    if header is None:
        return 0
    mpeg1, mono = header
    x = 4 + ((17 if mono else 32) if mpeg1 else (9 if mono else 17))
    if b[x:x + 4] not in (b"Xing", b"Info") or len(b) < x + 8:
        return DECODER_DELAY                          # no header: only WebKit skips the decoder delay
    flags = int.from_bytes(b[x + 4:x + 8], "big")
    v = x + 8 + 4 * bool(flags & 1) + 4 * bool(flags & 2) + 100 * bool(flags & 4) + 4 * bool(flags & 8)
    if len(b) < v + 36:
        return DECODER_DELAY
    delay = int.from_bytes(b[v + 21:v + 24], "big") >> 12
    crc_ok = _crc16(b[:v + 34]) == int.from_bytes(b[v + 34:v + 36], "big")
    webkit = DECODER_DELAY + (delay if crc_ok else 0)
    ffmpeg = delay + DECODER_DELAY if b[v:v + 4] in _KNOWN else 0
    return webkit - ffmpeg
