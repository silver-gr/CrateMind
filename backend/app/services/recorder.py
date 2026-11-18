"""Set recording: the master bus as a 24-bit stereo WAV in the export folder.

The router picks the destination through the export guard (outside every library
root); this module only ever creates a new file there (exclusive create, never an
overwrite). The header sizes are patched after every chunk, so a crash or a quit
leaves a valid WAV up to the last chunk written. One recording at a time.
"""
from __future__ import annotations

import os
import re
import shutil
import struct
import subprocess
import threading
import uuid
import wave
from functools import lru_cache
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

import numpy as np

CHANNELS = 2
SAMPLE_BYTES = 3
HEADER_BYTES = 44
# The RIFF size field (data + 36) must fit in 32 bits: about 4 GB, ~4 h at 48 kHz.
MAX_DATA_BYTES = 0xFFFFFFFF - (HEADER_BYTES - 8)
MIN_FREE_TO_START = 2 * 1024**3
MIN_FREE_WHILE_RECORDING = 200 * 1024**2
# The only files this module (and the reveal bridge) will name, convert or delete.
RECORDING_NAME = re.compile(r"CrateMind-recording-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}(-\d+)?\.(wav|m4a)")
AAC_BITRATES = (128, 256)
CONVERT_TIMEOUT_S = 30 * 60
FSYNC_EVERY = 10  # chunks (~10 s): a power loss never leaves a header ahead of the data on disk


class RecordingError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


@dataclass
class _Session:
    id: str
    path: Path
    file: BinaryIO
    sample_rate: int
    next_seq: int = 0
    data_bytes: int = 0
    clipped: int = 0


_lock = threading.Lock()
_session: _Session | None = None


def wav_header(sample_rate: int, data_bytes: int) -> bytes:
    block = CHANNELS * SAMPLE_BYTES
    return struct.pack("<4sI4s4sIHHIIHH4sI", b"RIFF", 36 + data_bytes, b"WAVE", b"fmt ", 16, 1, CHANNELS,
                       sample_rate, sample_rate * block, block, SAMPLE_BYTES * 8, b"data", data_bytes)


def pcm24(raw: bytes) -> tuple[bytes, int]:
    """Interleaved little-endian float32 → 24-bit PCM bytes, and how many samples were beyond ±1 (clipped)."""
    x = np.nan_to_num(np.frombuffer(raw, dtype="<f4"), nan=0.0, posinf=1.0, neginf=-1.0)
    clipped = int(np.count_nonzero(np.abs(x) > 1.0))
    ints = np.round(np.clip(x, -1.0, 1.0) * 8388607.0).astype("<i4")
    return ints.view(np.uint8).reshape(-1, 4)[:, :3].tobytes(), clipped


def _free_bytes(folder: Path) -> int:
    return shutil.disk_usage(folder).free


def _status(s: _Session) -> dict:
    return {"id": s.id, "file": s.path.name, "path": str(s.path),
            "seconds": s.data_bytes / (s.sample_rate * CHANNELS * SAMPLE_BYTES), "clipped": s.clipped}


def _finish(s: _Session) -> dict:
    """Closes the file; a flush error at the end loses nothing that the last patched header claims."""
    try:
        s.file.flush()
        os.fsync(s.file.fileno())
    except OSError:
        pass
    finally:
        s.file.close()
    return _status(s)


def _end(s: _Session) -> dict:
    """Detaches the session before closing, so a failing close never leaves a dead session behind."""
    global _session
    if _session is s:
        _session = None
    return _finish(s)


def start(destinations, sample_rate: int) -> dict:
    """`destinations` yields guarded candidate paths; the first that does not exist yet is created."""
    global _session
    with _lock:
        if _session is not None:  # a reloaded page never strands a file open
            _end(_session)
        for path in destinations:
            if _free_bytes(path.parent) < MIN_FREE_TO_START:
                raise RecordingError(409, "Λιγότερα από 2 GB ελεύθερα στον φάκελο export· η εγγραφή δεν ξεκίνησε.")
            try:
                handle = open(path, "xb")
            except FileExistsError:
                continue
            try:
                handle.write(wav_header(sample_rate, 0))
                handle.flush()
            except OSError as error:
                handle.close()
                raise RecordingError(409, "Δεν γράφτηκε το αρχείο της εγγραφής στον δίσκο.") from error
            _session = _Session(id=uuid.uuid4().hex, path=path, file=handle, sample_rate=sample_rate)
            return _status(_session)
        raise RecordingError(409, "Δεν βρέθηκε ελεύθερο όνομα αρχείου για την εγγραφή.")


def _current(rid: str) -> _Session:
    if _session is None or _session.id != rid:
        raise RecordingError(404, "Η εγγραφή δεν είναι ενεργή.")
    return _session


def append(rid: str, seq: int, raw: bytes) -> dict:
    with _lock:
        s = _current(rid)
        if seq < s.next_seq:  # a retry of a chunk already written
            return _status(s)
        if seq > s.next_seq:
            raise RecordingError(409, "Χάθηκε ένα κομμάτι της εγγραφής.")
        if len(raw) % (4 * CHANNELS):
            raise RecordingError(422, "Μη έγκυρο κομμάτι ήχου.")
        pcm, clipped = pcm24(raw)
        if s.data_bytes + len(pcm) > MAX_DATA_BYTES:
            _end(s)
            raise RecordingError(409, "Η εγγραφή έφτασε το όριο των 4 GB του WAV και σταμάτησε· το αρχείο κρατήθηκε.")
        if _free_bytes(s.path.parent) - len(pcm) < MIN_FREE_WHILE_RECORDING:
            _end(s)
            raise RecordingError(409, "Ο δίσκος σχεδόν γέμισε· η εγγραφή σταμάτησε και το αρχείο κρατήθηκε.")
        size = s.data_bytes + len(pcm)
        # The counters move only once the chunk and its header are written: a failed write is never acknowledged.
        try:
            s.file.seek(HEADER_BYTES + s.data_bytes)
            s.file.write(pcm)
            s.file.seek(4)
            s.file.write(struct.pack("<I", 36 + size))
            s.file.seek(40)
            s.file.write(struct.pack("<I", size))
            s.file.flush()
            if (s.next_seq + 1) % FSYNC_EVERY == 0:
                os.fsync(s.file.fileno())
        except OSError as error:
            try:  # back to the last good header and data
                s.file.seek(4)
                s.file.write(struct.pack("<I", 36 + s.data_bytes))
                s.file.seek(40)
                s.file.write(struct.pack("<I", s.data_bytes))
                s.file.truncate(HEADER_BYTES + s.data_bytes)
            except OSError:
                pass
            _end(s)
            raise RecordingError(409, "Σφάλμα εγγραφής στον δίσκο· η εγγραφή σταμάτησε και το αρχείο κρατήθηκε.") from error
        s.data_bytes = size
        s.clipped += clipped
        s.next_seq += 1
        return _status(s)


def stop(rid: str) -> dict:
    with _lock:
        return _end(_current(rid))


@lru_cache(maxsize=4)
def _aac_encoder(ffmpeg: str) -> str:
    """AudioToolbox's AAC on macOS when this ffmpeg has it (better at 128 kbps), else ffmpeg's own."""
    try:
        listed = subprocess.run([ffmpeg, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return "aac"
    return "aac_at" if re.search(r"\baac_at\b", listed) else "aac"


def _probe_seconds(ffprobe: str | None, path: Path) -> float | None:
    if not ffprobe:
        return None
    try:
        out = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)],
                             capture_output=True, text=True, timeout=60).stdout.strip()
        return float(out)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def convert_to_aac(out_dir: Path, name: str, bitrate: int, ffmpeg: str | None, ffprobe: str | None) -> dict:
    """A finished recording's WAV → `<same name>.m4a` (AAC); the WAV is deleted only after the AAC file checks out."""
    if not RECORDING_NAME.fullmatch(name) or not name.endswith(".wav") or bitrate not in AAC_BITRATES:
        raise RecordingError(422, "Μη έγκυρη εγγραφή ή ποιότητα AAC.")
    if not ffmpeg:
        raise RecordingError(409, "Δεν βρέθηκε το ffmpeg· η εγγραφή κρατήθηκε ως WAV.")
    source = out_dir / name
    if source.is_symlink() or not source.is_file():
        raise RecordingError(404, "Δεν βρέθηκε το αρχείο της εγγραφής.")
    with _lock:
        if _session is not None and _session.path == source:
            raise RecordingError(409, "Η εγγραφή συνεχίζεται ακόμα.")
    target = source.with_suffix(".m4a")
    partial = source.with_name(source.stem + ".part.m4a")
    if target.exists() or partial.exists():
        raise RecordingError(409, "Υπάρχει ήδη αρχείο AAC για αυτή την εγγραφή· η εγγραφή κρατήθηκε ως WAV.")
    try:
        with wave.open(str(source), "rb") as w:
            seconds = w.getnframes() / w.getframerate()
    except (OSError, wave.Error, EOFError) as error:
        raise RecordingError(409, "Το WAV της εγγραφής δεν διαβάζεται· κρατήθηκε όπως είναι.") from error
    command = [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-n", "-i", str(source), "-vn",
               "-c:a", _aac_encoder(ffmpeg), "-b:a", f"{bitrate}k", "-movflags", "+faststart", "-f", "mp4", str(partial)]
    try:
        done = subprocess.run(command, capture_output=True, text=True, timeout=CONVERT_TIMEOUT_S)
        probed = _probe_seconds(ffprobe, partial) if done.returncode == 0 else None
        # Without ffprobe the size is the check: at least half the nominal bitrate's bytes.
        ok = done.returncode == 0 and partial.is_file() and (
            abs(probed - seconds) <= 1.0 if probed is not None else partial.stat().st_size >= seconds * bitrate * 1000 / 16)
    except (OSError, subprocess.SubprocessError):
        ok = False
    if not ok or target.exists():
        partial.unlink(missing_ok=True)
        raise RecordingError(409, "Η μετατροπή σε AAC απέτυχε· η εγγραφή κρατήθηκε ως WAV.")
    partial.rename(target)
    source.unlink()
    return {"file": target.name, "path": str(target), "seconds": seconds, "bytes": target.stat().st_size}
