"""HTTP byte-range streaming helpers for the audition player.

Pure, testable functions: content-type lookup, Range header parsing, and a
chunked file iterator that never loads a whole file into memory.

AIFF/AIF are intentionally absent — browsers cannot decode them natively, so the
endpoint returns 415 rather than streaming bytes no <audio> element can play.
Transcoding is left as a future enhancement.
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterator, Literal, Union

CHUNK = 64 * 1024

# extension (no dot, lowercase) -> Content-Type, restricted to browser-playable
CONTENT_TYPES: dict[str, str] = {
    "mp3": "audio/mpeg",
    "m4a": "audio/mp4",
    "mp4": "audio/mp4",
    "aac": "audio/aac",
    "ogg": "audio/ogg",
    "opus": "audio/ogg",
    "wav": "audio/wav",
    "flac": "audio/flac",
}

Range = Union[tuple[int, int], None, Literal["invalid"]]


def content_type_for(extension: str | None) -> str | None:
    if not extension:
        return None
    return CONTENT_TYPES.get(extension.lower().lstrip("."))


def parse_range(header: str | None, size: int) -> Range:
    """Parse a single-range `Range: bytes=...` header.

    Returns:
      None            -> no Range header (serve full file, 200)
      (start, end)    -> inclusive byte range (serve 206)
      "invalid"       -> unsatisfiable / malformed (serve 416)
    """
    if not header:
        return None
    header = header.strip()
    if not header.startswith("bytes="):
        return "invalid"
    spec = header[len("bytes="):].strip()
    if "," in spec or "-" not in spec:  # multi-range unsupported
        return "invalid"
    start_s, _, end_s = spec.partition("-")
    try:
        if start_s == "":
            # suffix form: bytes=-N  -> last N bytes
            n = int(end_s)
            if n <= 0:
                return "invalid"
            start = max(0, size - n)
            end = size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s != "" else size - 1
    except ValueError:
        return "invalid"
    if start < 0 or start > end or start >= size:
        return "invalid"
    return (start, min(end, size - 1))


def iter_file_range(path: Path, start: int, end: int, chunk: int = CHUNK) -> Iterator[bytes]:
    """Yield bytes[start:end+1] in fixed-size chunks. Streams from disk."""
    remaining = end - start + 1
    with open(path, "rb") as f:
        f.seek(start)
        while remaining > 0:
            data = f.read(min(chunk, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data
