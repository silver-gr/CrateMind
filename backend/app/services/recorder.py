"""Set recording: the master bus as a 24-bit stereo WAV in the export folder.

The router picks the destination through the export guard (outside every library
root); this module only ever creates a new file there (exclusive create, never an
overwrite). The header sizes are patched after every chunk, so a crash or a quit
leaves a valid WAV up to the last chunk written. One recording at a time.
"""
from __future__ import annotations

import os
import shutil
import struct
import threading
import uuid
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
