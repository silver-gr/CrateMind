"""«Εγγραφή tags στα αρχεία», stage 1a: the one place in CrateMind that writes into an audio file.

Title, artist and genre go into an MP3's existing ID3v2 block (and the same three fields of its ID3v1 block), and
nowhere else. The block keeps its length, so no audio byte moves: every other frame is copied byte for byte in its
place and the padding takes the difference. Every check runs on buffers in memory before a byte reaches the file,
the old bytes are on record first, the write is flushed to the disk and read back, and `undo` puts the old frame
bytes back. mutagen only reads here. Plan and measurements: `.omc/plans/2026-11-26-tag-writing.md`.

Nothing in the app calls this module yet: no route, no job, nothing at startup.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import stat
import subprocess
import tempfile
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from mutagen._constants import GENRES  # type: ignore
from mutagen.id3 import ID3  # type: ignore
from mutagen.mp3 import MP3  # type: ignore
from sqlmodel import Session, select

from ..config import get_settings
from ..db import reindex_track
from ..models import TagWrite, Track
from . import audit, hashing, metadata_reader, scanner
from .library_paths import resolve_media_path

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None

FRAMES = {"title": "TIT2", "artist": "TPE1", "genre": "TCON"}
_V1_RANGE = {"title": (3, 33), "artist": (33, 63), "genre": (127, 128)}
_V1_GENRE = {name.casefold(): index for index, name in enumerate(GENRES)}
_FRAME_ID = re.compile(rb"[A-Z0-9]{4}")
_STUB_AUDIO = (b"\xff\xfb\x90\x00" + bytes(413)) * 4  # four silent MPEG frames, so a reader takes a buffer as an MP3
_DJ_APPS = ("serato", "traktor", "djay")

_REASONS = {
    "not_mp3": "Η μορφή του αρχείου δεν υποστηρίζεται ακόμη· γράφονται μόνο MP3.",
    "not_here": "Η εγγραφή tags δεν υποστηρίζεται ακόμη σε αυτό το σύστημα.",
    "dj_app": "Είναι ανοιχτή άλλη εφαρμογή DJ ({detail}). Κλείσε την και δοκίμασε ξανά.",
    "missing": "Το αρχείο δεν βρέθηκε ή ο δίσκος του δεν είναι συνδεδεμένος.",
    "read_only": "Το αρχείο είναι κλειδωμένο και δεν δέχεται αλλαγές.",
    "changed": "Το αρχείο άλλαξε έξω από το CrateMind από τότε που διαβάστηκε. "
               "Τρέξε «Έλεγχος αλλαγών» και δοκίμασε ξανά.",
    "no_tag": "Το αρχείο δεν έχει χώρο για tags· για να μπουν θα έπρεπε να μετακινηθεί ο ήχος.",
    "no_room": "Τα νέα tags δεν χωράνε στο αρχείο· για να μπουν θα έπρεπε να μετακινηθεί ο ήχος.",
    "unsupported_tag": "Τα tags του αρχείου είναι γραμμένα με τρόπο που το CrateMind δεν αλλάζει με ασφάλεια.",
    "bad_value": "Η τιμή είναι κενή ή έχει χαρακτήρες που δεν γράφονται σε tag.",
    "same": "Το αρχείο έχει ήδη αυτές τις τιμές.",
    "reads_back": "Το CrateMind θα διάβαζε την τιμή διαφορετικά από αυτό που θα γραφόταν.",
    "check_failed": "Ο έλεγχος πριν την εγγραφή δεν πέρασε· δεν γράφτηκε τίποτα.",
    "no_log": "Δεν μπόρεσε να κρατηθεί αντίγραφο των παλιών tags· δεν γράφτηκε τίποτα.",
    "unfinished": "Αυτή η εγγραφή δεν ολοκληρώθηκε· χρειάζεται «Επαναφορά», όχι αναίρεση.",
    "foreign": "Το αρχείο το άλλαξε άλλη εφαρμογή μετά την εγγραφή που δεν ολοκληρώθηκε· δεν το πειράξαμε.",
    "other_file": "Το αρχείο δεν είναι αυτό που γράφτηκε τότε: ο ήχος του είναι άλλος. Δεν το πειράξαμε.",
    "wrong_track": "Το αρχείο δεν είναι το αρχείο αυτού του κομματιού στη βιβλιοθήκη. Δεν το πειράξαμε.",
}
_NOT_AS_WRITTEN = {
    "size": "το μέγεθος του αρχείου άλλαξε",
    "block": "τα tags δεν είναι αυτά που γράφτηκαν",
    "v1": "τα tags στο τέλος του αρχείου δεν είναι αυτά που γράφτηκαν",
    "audio": "ο ήχος δεν είναι ίδιος",
}


class Refused(Exception):
    """The writer declined before writing a byte into the file. `reason` is a key of _REASONS; str() is the Greek
    text for the user."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(_REASONS[reason].format(detail=detail))
        self.reason = reason


class WriteFailed(Exception):
    """Bytes reached the file and the check after them did not pass. `restored` tells whether the old bytes were
    put back and verified. A batch stops here."""

    def __init__(self, message: str, restored: bool):
        super().__init__(message)
        self.restored = restored


@dataclass(frozen=True)
class _Frame:
    id: str
    raw: bytes  # header and body, as in the file


@dataclass(frozen=True)
class _File:
    """One read of a file."""
    size: int
    mtime_ns: int
    block: bytes  # the whole ID3v2 block: header, frames, padding; empty when the file has none
    v1: bytes  # the ID3v1 block; empty when the file has none
    audio_sha256: str  # everything between the two


@dataclass(frozen=True)
class Plan:
    """A write as the dry run saw it. `write` refuses a file that no longer has this size, this `mtime_ns` and
    these old bytes. `pieces`: per field its frame id, the frame's old and new raw bytes (None = no frame), and
    the old and new bytes of its ID3v1 range (None = the file has no ID3v1 block)."""
    path: Path
    values: dict[str, str]
    size: int
    mtime_ns: int
    fields: dict[str, dict]  # {"title": {"before": …, "after": …}}
    pieces: dict[str, dict]


def dj_apps_in(process_list: str) -> list[str]:
    names = {Path(line.strip()).name for line in process_list.splitlines()}
    return sorted(name for name in names if any(app in name.lower() for app in _DJ_APPS))


def running_dj_apps() -> list[str]:
    """Serato, Traktor or djay processes running now. Best effort: an empty list when the process list cannot
    be read (and always on Windows)."""
    try:
        listing = subprocess.run(["ps", "-axo", "comm="], capture_output=True, text=True, timeout=10,
                                 stdin=subprocess.DEVNULL, check=False).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    return dj_apps_in(listing)


# ---- reading ----

def _syncsafe(raw: bytes) -> int | None:
    if len(raw) != 4 or any(byte & 0x80 for byte in raw):
        return None
    return raw[0] << 21 | raw[1] << 14 | raw[2] << 7 | raw[3]


def _to_syncsafe(value: int) -> bytes:
    return bytes((value >> 21 & 127, value >> 14 & 127, value >> 7 & 127, value & 127))


def _plain(raw: bytes) -> int:
    return int.from_bytes(raw, "big")


def _frames(body: bytes, size_of) -> tuple[_Frame, ...] | None:
    """The frames of a tag body; None unless every frame is plain (no flags) and the walk ends in zero padding."""
    frames, pos = [], 0
    while pos + 10 <= len(body) and body[pos]:
        size = size_of(body[pos + 4:pos + 8])
        if (not _FRAME_ID.fullmatch(body[pos:pos + 4]) or size is None or body[pos + 8:pos + 10] != b"\0\0"
                or pos + 10 + size > len(body)):
            return None
        frames.append(_Frame(body[pos:pos + 4].decode("ascii"), body[pos:pos + 10 + size]))
        pos += 10 + size
    return None if body[pos:].strip(b"\0") else tuple(frames)


def _walk(block: bytes) -> tuple[_Frame, ...]:
    """Our own walk of an ID3v2.3 or v2.4 block. Refuses header flags (unsynchronisation, extended header,
    footer), a frame flag and a walk that does not end in zero padding.

    Some writers store v2.4 frame sizes as plain numbers. Read that way, a correct block usually still walks,
    as fewer frames (a large one swallows its neighbours); that reading is dropped, as mutagen does. When it
    gives as many frames or more, nothing tells where the last frame ends and the padding begins: refused."""
    if len(block) < 10 or block[:3] != b"ID3" or block[3] not in (3, 4) or block[5] \
            or _syncsafe(block[6:10]) != len(block) - 10:
        raise Refused("unsupported_tag")
    frames = _frames(block[10:], _plain if block[3] == 3 else _syncsafe)
    other = _frames(block[10:], _plain) if block[3] == 4 else None
    if frames is None or (other is not None and other != frames and len(other) >= len(frames)):
        raise Refused("unsupported_tag")
    return frames


def _load(path: Path) -> _File:
    """The file as it is on disk now: both tag blocks and a hash of the audio between them."""
    with path.open("rb") as handle:
        st = os.fstat(handle.fileno())
        head = handle.read(10)
        length = _syncsafe(head[6:10]) if head[:3] == b"ID3" else None
        block = head + handle.read(length) if length is not None else b""
        end, v1 = st.st_size, b""
        if st.st_size >= len(block) + 128:
            handle.seek(st.st_size - 128)
            tail = handle.read(128)
            if tail[:3] == b"TAG":
                v1, end = tail, st.st_size - 128
        handle.seek(len(block))
        digest = hashlib.sha256()
        while (left := end - handle.tell()) > 0 and (chunk := handle.read(min(left, 1 << 20))):
            digest.update(chunk)
        after = os.fstat(handle.fileno())
        if handle.tell() < end or (after.st_size, after.st_mtime_ns) != (st.st_size, st.st_mtime_ns):
            raise Refused("changed")
    return _File(st.st_size, st.st_mtime_ns, block, v1, digest.hexdigest())


def _guard(path: Path) -> None:
    """Step 1: the reasons not to open this file for writing at all."""
    if not hasattr(os, "pwrite"):  # Windows: untested, and the write is built on pread and pwrite
        raise Refused("not_here")
    if path.suffix.lower() != ".mp3":
        raise Refused("not_mp3")
    if apps := running_dj_apps():
        raise Refused("dj_app", ", ".join(apps))
    try:
        scanner._require_mounted_volume(path)
        st = path.stat()
    except OSError:
        raise Refused("missing") from None
    if not stat.S_ISREG(st.st_mode):
        raise Refused("missing")
    if not os.access(path, os.W_OK) or getattr(st, "st_flags", 0) & (stat.UF_IMMUTABLE | stat.SF_IMMUTABLE):
        raise Refused("read_only")


def _read(path: Path) -> tuple[_File, tuple[_Frame, ...]]:
    """Steps 1 and 2: the refusals, then the file and the walk of its ID3v2 block."""
    _guard(path)
    try:
        file = _load(path)
    except OSError:
        raise Refused("missing") from None
    if not file.block:
        raise Refused("no_tag")
    frames = _walk(file.block)
    try:
        mpeg = not MP3(path).info.sketchy  # mutagen's verdict on what follows the tag: MPEG frames in a row
    except Exception:
        mpeg = False
    if not mpeg:
        raise Refused("not_mp3")
    return file, frames


# ---- building and checking, in memory ----

def _text_frame(frame_id: str, value: str, version: int) -> bytes:
    """A text frame: Latin-1 when the text fits, else UTF-16 with a byte order mark (both valid in v2.3 and v2.4)."""
    try:
        body = b"\x00" + value.encode("latin-1")
    except UnicodeEncodeError:
        body = b"\x01\xff\xfe" + value.encode("utf-16-le")
    size = len(body).to_bytes(4, "big") if version == 3 else _to_syncsafe(len(body))
    return frame_id.encode("ascii") + size + b"\0\0" + body


def _splice(block: bytes, frames: tuple[_Frame, ...], changes: dict[str, bytes | None]) -> bytes:
    """A block of the same length: every frame copied as it is and in order, the named ones replaced in their
    place (None takes one out), new ones added after the last frame, the padding taking the difference."""
    left = dict(changes)
    kept = [left.pop(frame.id) if frame.id in left else frame.raw for frame in frames]
    body = b"".join(raw for raw in (*kept, *left.values()) if raw)
    if len(body) > len(block) - 10:
        raise Refused("no_room")
    return block[:10] + body.ljust(len(block) - 10, b"\0")


def _v1_text(value: str) -> bytes | None:
    """A title or artist as ID3v1 holds it: 30 Latin-1 bytes. None for text Latin-1 cannot hold; that range
    then stays as it is rather than turn into question marks."""
    try:
        return value.encode("latin-1")[:30].ljust(30, b"\0")
    except UnicodeEncodeError:
        return None


def _mutagen(block: bytes) -> ID3:
    return ID3(io.BytesIO(block + _STUB_AUDIO), translate=False, load_v1=False)


def _alone(version: int, raw: bytes) -> bytes:
    """One frame as a block of its own."""
    return b"ID3" + bytes((version, 0, 0)) + _to_syncsafe(len(raw)) + raw


def _seen(tags: ID3, frame_id: str) -> list | None:
    """What mutagen reads from that frame: its text values, and a genre also as mutagen names it."""
    return [(list(map(str, frame.text)), getattr(frame, "genres", None)) for frame in tags.getall(frame_id)] or None


def _expected(frame_id: str, value: str) -> list:
    return [([value], [value] if frame_id == "TCON" else None)]


def _check(path: Path, file: _File, frames: tuple[_Frame, ...], block: bytes, v1: bytes,
           changes: dict[str, bytes | None], fields: set[str], expect: dict[str, list | None],
           values: dict[str, str]) -> None:
    """Step 4, on the finished buffers. Our walk: the frames differ from the old ones only in the changed ones,
    byte for byte and in order. The ID3v1 block differs only inside the ranges of `fields`. mutagen reads
    `expect` from the block, and for a write CrateMind's own reader returns `values`."""
    ticked = {index for field in fields for index in range(*_V1_RANGE[field])}
    old_ids = [f.id for f in frames]
    # Each changed frame stays in its own place; only a frame the file did not have goes after the last one.
    ids = [i for i in old_ids if changes.get(i, b"") is not None] + [i for i, raw in changes.items()
                                                                    if raw and i not in old_ids]
    try:
        ours = _walk(block)
    except Refused:
        raise Refused("check_failed") from None
    if (len(block) != len(file.block) or block[:10] != file.block[:10] or [f.id for f in ours] != ids
            or [f.raw for f in ours if f.id not in changes] != [f.raw for f in frames if f.id not in changes]
            or any([f.raw for f in ours if f.id == frame_id] != ([raw] if raw else [])
                   for frame_id, raw in changes.items())
            or len(v1) != len(file.v1)
            or any(new != old and index not in ticked for index, (new, old) in enumerate(zip(v1, file.v1)))):
        raise Refused("check_failed")
    try:
        tags = _mutagen(block)
    except Exception:
        raise Refused("check_failed") from None
    if any(_seen(tags, frame_id) != wanted for frame_id, wanted in expect.items()):
        raise Refused("reads_back")
    if values:
        # read_tags also reads the file name, so the copy it reads carries the file's own name.
        with tempfile.TemporaryDirectory(prefix="cratemind-tag-check-") as folder:
            copy = Path(folder) / path.name
            copy.write_bytes(block + _STUB_AUDIO + v1)
            read = metadata_reader.read_tags(copy)
        if any(read.get(field) != value for field, value in values.items()):
            raise Refused("reads_back")


def _utf16(value: str) -> bool:
    """False for text UTF-16 cannot hold (a lone surrogate, which JSON can carry)."""
    try:
        value.encode("utf-16-le")
    except UnicodeEncodeError:
        return False
    return True


def _prepare(path: Path, values: dict[str, str]) -> tuple[Plan, _File, bytes, bytes]:
    """Steps 1 to 4 for a write. A field the file already holds is left out."""
    if not values or any(field not in FRAMES or not isinstance(value, str) or not value.strip()
                         or any(ord(char) < 32 or ord(char) == 127 for char in value) or not _utf16(value)
                         for field, value in values.items()):
        raise Refused("bad_value")
    file, frames = _read(path)
    try:
        tags = _mutagen(file.block)
    except Exception:
        raise Refused("unsupported_tag") from None
    changes, pieces, fields, v1 = {}, {}, {}, bytearray(file.v1)
    for field, value in values.items():
        frame_id = FRAMES[field]
        old = [frame.raw for frame in frames if frame.id == frame_id]
        before = _seen(tags, frame_id)
        if len(old) > 1:
            raise Refused("unsupported_tag")
        if before == _expected(frame_id, value):
            continue
        changes[frame_id] = _text_frame(frame_id, value, file.block[3])
        start, stop = _V1_RANGE[field]
        if file.v1:
            patch = bytes((_V1_GENRE.get(value.casefold(), 255),)) if field == "genre" else _v1_text(value)
            v1[start:stop] = patch or v1[start:stop]
        pieces[field] = {"frame": frame_id, "old": old[0] if old else None, "new": changes[frame_id],
                         "v1_old": file.v1[start:stop] if file.v1 else None,
                         "v1_new": bytes(v1[start:stop]) if file.v1 else None}
        fields[field] = {"before": "; ".join(before[0][0]) if before else None, "after": value}
    if not changes:
        raise Refused("same")
    block = _splice(file.block, frames, changes)
    written = {field: values[field] for field in pieces}
    _check(path, file, frames, block, bytes(v1), changes, set(pieces),
           {FRAMES[field]: _expected(FRAMES[field], value) for field, value in written.items()}, written)
    return Plan(path, written, file.size, file.mtime_ns, fields, pieces), file, block, bytes(v1)


def plan_write(path: Path, values: dict[str, str]) -> Plan:
    """The whole write as a dry run in memory (steps 1 to 4): reads the file and writes nothing to it. Raises
    Refused for a file that cannot be written, with the reason."""
    return _prepare(Path(path), values)[0]


# ---- the log, kept before any write ----

def _dataset() -> Path:
    return get_settings().db_file.parent


def _copy_path(row_id: int) -> Path:
    return _dataset() / "tag-writes-pending" / f"{row_id}.bin"


def _log(entry: dict) -> None:
    with (_dataset() / "tag-writes.jsonl").open("a", encoding="utf-8") as log:
        log.write(json.dumps(entry, ensure_ascii=False) + "\n")
        log.flush()
        os.fsync(log.fileno())


def _pack(pieces: dict[str, dict]) -> dict[str, dict]:
    return {field: {key: base64.b64encode(value).decode("ascii") if isinstance(value, bytes) else value
                    for key, value in piece.items()} for field, piece in pieces.items()}


def _unpack(pieces: dict[str, dict]) -> dict[str, dict]:
    return {field: {key: base64.b64decode(value) if key != "frame" and value is not None else value
                    for key, value in piece.items()} for field, piece in pieces.items()}


def _entry(row: TagWrite) -> dict:
    """A write as one line of tag-writes.jsonl: all that `undo_logged` needs when the table is gone."""
    return {"event": "write", "id": row.id, "batch_id": row.batch_id, "track_id": row.track_id, "path": row.path,
            "undo_of": row.undo_of, "fields": json.loads(row.fields_json), "pieces": json.loads(row.frames_json),
            "size": row.size, "mtime_ns": row.mtime_ns_before, "quick_hash": row.quick_hash_before,
            "block_sha256": row.block_sha256_before, "v1_sha256": row.v1_sha256_before,
            "audio_sha256": row.audio_sha256, "at": row.created_at.isoformat()}


def _sha256(data: bytes) -> str | None:
    return hashlib.sha256(data).hexdigest() if data else None


def _close(session: Session, row: TagWrite, state: str, error: str | None, *, drop_copy: bool) -> None:
    row.state, row.error = state, error
    session.add(row)
    session.commit()
    _log({"event": state, "id": row.id, "error": error, "mtime_ns": row.mtime_ns_after,
          "quick_hash": row.quick_hash_after, "block_sha256": row.block_sha256_after,
          "v1_sha256": row.v1_sha256_after})
    if drop_copy:
        _copy_path(row.id).unlink(missing_ok=True)


# ---- the write itself ----

def _pwrite(fd: int, data: bytes, offset: int) -> None:
    view = memoryview(data)
    while view:
        written = os.pwrite(fd, view, offset)
        view, offset = view[written:], offset + written


def _put(fd: int, block: bytes, v1: bytes, size: int) -> None:
    """The two buffers at their offsets, then a flush all the way to the disk (the music is on an external
    volume, and a read-back from the page cache proves nothing after a pulled cable)."""
    _pwrite(fd, block, 0)
    if v1:
        _pwrite(fd, v1, size - 128)
    try:
        fcntl.fcntl(fd, fcntl.F_FULLFSYNC)  # macOS
    except (AttributeError, OSError):  # no fcntl (Windows), no F_FULLFSYNC (Linux), or a volume without it
        os.fsync(fd)


def _differs(path: Path, size: int, audio_sha256: str, block: bytes, v1: bytes) -> str | None:
    """Step 7: the file re-read from disk against what it should hold now. None when all four agree."""
    now = _load(path)
    return next((_NOT_AS_WRITTEN[key] for key, same in (
        ("size", now.size == size), ("block", now.block == block), ("v1", now.v1 == v1),
        ("audio", now.audio_sha256 == audio_sha256)) if not same), None)


def _refresh_catalog(session: Session, track_id: int | None, path: Path) -> None:
    """The track's file columns as a scan would set them, so the next scan finds the file unchanged and a later
    move still merges by hash."""
    track = session.get(Track, track_id) if track_id is not None else None
    if track is None:
        return
    root = next((root for root in get_settings().roots if path.is_relative_to(root)), path.parent)
    scanner._apply_columns(track, scanner._read_metadata_record(path, root), scanner._FILE_COLUMNS)
    session.add(track)
    session.flush()
    reindex_track(session, track.id, commit=False)


def _apply(session: Session, path: Path, file: _File, block: bytes, v1: bytes, fields: dict, pieces: dict, *,
           batch_id: str, track_id: int | None, undo_of: int | None = None) -> TagWrite:
    """Steps 5 to 8: record the old bytes, write the two buffers in place, flush, verify from disk."""
    row = TagWrite(batch_id=batch_id, track_id=track_id, path=str(path), undo_of=undo_of,
                   fields_json=json.dumps(fields, ensure_ascii=False), frames_json=json.dumps(_pack(pieces)),
                   size=file.size, mtime_ns_before=file.mtime_ns, quick_hash_before=hashing.quick_hash(path),
                   block_sha256_before=_sha256(file.block), v1_sha256_before=_sha256(file.v1),
                   audio_sha256=file.audio_sha256)
    session.add(row)
    session.commit()
    copy, reason = _copy_path(row.id), "no_log"
    try:
        _log(_entry(row))
        copy.parent.mkdir(parents=True, exist_ok=True)
        with copy.open("wb") as saved:
            saved.write(file.block + file.v1)
            saved.flush()
            os.fsync(saved.fileno())
        reason = "read_only"
        fd = os.open(path, os.O_RDWR)
    except OSError:
        _close(session, row, "failed", _REASONS[reason], drop_copy=True)
        raise Refused(reason) from None
    try:
        st = os.fstat(fd)
        if ((st.st_size, st.st_mtime_ns) != (file.size, file.mtime_ns)
                or os.pread(fd, len(file.block), 0) != file.block
                or (file.v1 and os.pread(fd, 128, file.size - 128) != file.v1)):
            _close(session, row, "failed", _REASONS["changed"], drop_copy=True)
            raise Refused("changed")
        try:
            _put(fd, block, v1, file.size)
            problem = _differs(path, file.size, file.audio_sha256, block, v1)
        except Exception as error:
            problem = str(error) if isinstance(error, Refused) else f"σφάλμα κατά την εγγραφή: {error}"
        if problem:
            _put_back(session, row, fd, path, file, problem)
    finally:
        os.close(fd)
    row.mtime_ns_after = path.stat().st_mtime_ns  # left to change, so other apps and backups notice
    row.quick_hash_after = hashing.quick_hash(path)
    row.block_sha256_after, row.v1_sha256_after = _sha256(block), _sha256(v1)
    _refresh_catalog(session, track_id, path)
    _close(session, row, "done", None, drop_copy=True)
    return row


def _put_back(session: Session, row: TagWrite, fd: int, path: Path, file: _File, problem: str) -> None:
    """After a failed check: the old blocks go back when the file still has its recorded size. A file of
    another size was rewritten by another app and is left alone. Always raises WriteFailed."""
    restored, same_size = False, False
    try:
        same_size = os.fstat(fd).st_size == file.size
        if same_size:
            _put(fd, file.block, file.v1, file.size)
            restored = _differs(path, file.size, file.audio_sha256, file.block, file.v1) is None
    except Exception:
        restored = False
    if restored:
        message = f"Ο έλεγχος μετά την εγγραφή δεν πέρασε ({problem}). Το αρχείο γύρισε όπως ήταν."
    elif not same_size:
        message = (f"Ο έλεγχος μετά την εγγραφή δεν πέρασε ({problem}) και το αρχείο έχει άλλο μέγεθος: "
                   "το έγραψε άλλη εφαρμογή. Δεν το πειράξαμε άλλο.")
    else:
        message = (f"Ο έλεγχος μετά την εγγραφή δεν πέρασε ({problem}) και το αρχείο δεν επιβεβαιώθηκε ότι "
                   "γύρισε όπως ήταν. Περιμένει «Επαναφορά».")
    # A file that may still be torn keeps its row pending and its saved copy, for «Επαναφορά».
    _close(session, row, "pending" if same_size and not restored else "failed", message, drop_copy=restored)
    raise WriteFailed(message, restored)


def write(session: Session, plan: Plan, *, batch_id: str, track_id: int | None = None) -> TagWrite:
    """Write one planned file (steps 1 to 8). The dry run is repeated on the file as it is now and must match
    the plan. Raises Refused when nothing was written into the file, WriteFailed when the check after the write
    did not pass."""
    _belongs(session, track_id, plan.path)
    fresh, file, block, v1 = _prepare(plan.path, plan.values)
    if (fresh.size, fresh.mtime_ns, fresh.pieces) != (plan.size, plan.mtime_ns, plan.pieces):
        raise Refused("changed")
    return _apply(session, plan.path, file, block, v1, fresh.fields, fresh.pieces,
                  batch_id=batch_id, track_id=track_id)


def write_batch(session: Session, items: list[tuple[int | None, Plan]]) -> dict:
    """Write (track id, plan) pairs in order. A refused file is skipped with its reason; a failed check after a
    write stops the batch."""
    batch_id = uuid.uuid4().hex
    done, skipped, failed = [], [], None
    try:
        for track_id, plan in items:
            try:
                done.append(write(session, plan, batch_id=batch_id, track_id=track_id))
            except Refused as refused:
                skipped.append({"path": str(plan.path), "reason": refused.reason, "message": str(refused)})
            except WriteFailed as failure:
                failed = {"path": str(plan.path), "message": str(failure), "restored": failure.restored}
                break
    finally:  # an unexpected error still syncs and audits the files written before it
        _after_batch(session, "tag_write", batch_id, done, skipped, failed)
    return {"batch_id": batch_id, "written": done, "skipped": skipped, "failed": failed}


def _after_batch(session: Session, action: str, batch_id: str, done: list[TagWrite], skipped: list,
                 failed: dict | None) -> None:
    session.rollback()  # whatever a failed item left unflushed; every finished row is already committed
    track_ids = [row.track_id for row in done if row.track_id is not None]
    if track_ids:
        from .identity_sync import sync_session

        sync_session(session, track_ids=track_ids)
    audit.log(session, action, "tag_write_batch", None, None,
              {"batch_id": batch_id, "rows": [row.id for row in done], "skipped": skipped, "failed": failed})


# ---- undo ----

def _where(session: Session, track_id: int | None, path: str) -> tuple[Path, int | None]:
    """The file through its track, because files move; the stored path when the track is gone."""
    track = session.get(Track, track_id) if track_id is not None else None
    return (resolve_media_path(track.absolute_path), track.id) if track is not None else (Path(path), None)


def _belongs(session: Session, track_id: int | None, path: Path) -> None:
    """Refused unless `path` is the file of track `track_id`: a write copies the file's columns into that row."""
    if track_id is None:
        return
    track = session.get(Track, track_id)
    if track is None or resolve_media_path(track.absolute_path).resolve() != Path(path).resolve():
        raise Refused("wrong_track")


def undo_logged(session: Session, entry: dict, path: Path | None = None) -> dict:
    """The reverse splice, from a write's row or its tag-writes.jsonl line. Each frame and ID3v1 range that
    still holds exactly the bytes we wrote gets its old bytes back in the same place (a frame we added goes
    away); one another app changed since is left alone. `restored` names the fields with something put back,
    `left_alone` those with a frame or ID3v1 range left as found. `exact`: the tag blocks are again, byte for
    byte, what they were before the write. Refused for a file whose audio is not the audio written then
    (a log line can outlive the catalog its track id came from)."""
    found, track_id = _where(session, entry["track_id"], entry["path"])
    if path is not None:
        _belongs(session, track_id, path)
    path = path or found
    file, frames = _read(path)
    if file.audio_sha256 != entry["audio_sha256"]:
        raise Refused("other_file")
    changes, pieces, fields, expect, left_alone = {}, {}, {}, {}, []
    v1 = bytearray(file.v1)
    for field, piece in _unpack(entry["pieces"]).items():
        frame_id, (start, stop) = piece["frame"], _V1_RANGE[field]
        now = [frame.raw for frame in frames if frame.id == frame_id]
        ours = now == ([piece["new"]] if piece["new"] else [])
        v1_ours = bool(file.v1) and piece["v1_new"] is not None and file.v1[start:stop] == piece["v1_new"]
        if not ours or (piece["v1_new"] != piece["v1_old"] and not v1_ours):
            left_alone.append(field)
        if ours and piece["old"] != piece["new"]:
            changes[frame_id] = piece["old"]
            expect[frame_id] = _seen(_mutagen(_alone(file.block[3], piece["old"])), frame_id) if piece["old"] else None
        if v1_ours:
            v1[start:stop] = piece["v1_old"]
        if frame_id in changes or bytes(v1[start:stop]) != file.v1[start:stop]:
            pieces[field] = {"frame": frame_id, "old": now[0] if now else None,
                             "new": piece["old"] if frame_id in changes else (now[0] if now else None),
                             "v1_old": file.v1[start:stop] if file.v1 else None,
                             "v1_new": bytes(v1[start:stop]) if file.v1 else None}
            fields[field] = {"before": entry["fields"][field]["after"], "after": entry["fields"][field]["before"]}
    result = {"path": str(path), "restored": list(pieces), "left_alone": left_alone, "exact": False, "row": None}
    if pieces:
        block = _splice(file.block, frames, changes)
        _check(path, file, frames, block, bytes(v1), changes, set(pieces), expect, {})
        result["row"] = _apply(session, path, file, block, bytes(v1), fields, pieces, batch_id=entry["batch_id"],
                               track_id=track_id, undo_of=entry["id"])
    else:
        block = file.block
    result["exact"] = (_sha256(block), _sha256(bytes(v1))) == (entry["block_sha256"], entry["v1_sha256"])
    return result


def undo(session: Session, row_id: int) -> dict:
    """Undo one write. The file's modification time does not go back: it becomes the time of the undo."""
    row = session.get(TagWrite, row_id)
    if row is None:
        raise ValueError(f"no tag write {row_id}")
    if row.state == "pending":
        raise Refused("unfinished")
    result = undo_logged(session, _entry(row))
    if result["restored"]:
        row.undone_at = datetime.now(UTC)
        session.add(row)
        session.commit()
    return result


def undo_batch(session: Session, batch_id: str) -> dict:
    """Undo every finished write of a batch that is not undone yet, newest first. Stops at a failed check."""
    rows = session.exec(select(TagWrite).where(
        TagWrite.batch_id == batch_id, TagWrite.state == "done", TagWrite.undo_of.is_(None),
        TagWrite.undone_at.is_(None)).order_by(TagWrite.id.desc())).all()
    results, skipped, failed = [], [], None
    try:
        for row in rows:
            try:
                results.append(undo(session, row.id))
            except Refused as refused:
                skipped.append({"path": row.path, "reason": refused.reason, "message": str(refused)})
            except WriteFailed as failure:
                failed = {"path": row.path, "message": str(failure), "restored": failure.restored}
                break
    finally:  # as in write_batch
        _after_batch(session, "tag_write_undo", batch_id, [r["row"] for r in results if r["row"] is not None],
                     skipped, failed)
    return {"batch_id": batch_id, "undone": results, "skipped": skipped, "failed": failed}


# ---- a write that never finished ----

def pending(session: Session) -> list[TagWrite]:
    """Writes left unfinished (a crash or a pulled cable in the middle). They are only listed: nothing is
    repaired by itself, at startup or anywhere else. `restore_pending` runs when the owner asks."""
    return list(session.exec(select(TagWrite).where(TagWrite.state == "pending").order_by(TagWrite.id)).all())


def restore_pending(session: Session, row_id: int) -> str:
    """«Επαναφορά» for an unfinished write. It runs only when the file has its recorded size and every byte of
    its tag blocks is the saved old byte or the intended new byte at that position (the old state, the new
    state, or a torn mix of the two); then the old blocks go back. Anything else means another app wrote to the
    file since: Refused("foreign"), file untouched. Returns the Greek outcome."""
    row = session.get(TagWrite, row_id)
    if row is None or row.state != "pending":
        raise ValueError(f"tag write {row_id} is not pending")
    path, copy = _where(session, row.track_id, row.path)[0], _copy_path(row.id)
    if not copy.is_file():
        # No saved copy: the write stopped before the file was opened, or it finished and only this row's last
        # update was lost. Either way the file is whole, and there is nothing to put back from.
        outcome = "Η εγγραφή δεν είχε ολοκληρωθεί. Δεν υπάρχει αντίγραφο για επαναφορά· το αρχείο δεν πειράχτηκε."
        _close(session, row, "failed", outcome, drop_copy=False)
        return outcome
    _guard(path)
    saved = copy.read_bytes()
    length = 10 + (_syncsafe(saved[6:10]) or 0)
    old, old_v1 = saved[:length], saved[length:]
    pieces = _unpack(json.loads(row.frames_json))
    new = _splice(old, _walk(old), {p["frame"]: p["new"] for p in pieces.values() if p["new"] != p["old"]})
    new_v1 = bytearray(old_v1)
    for field, piece in pieces.items():
        if old_v1:
            new_v1[slice(*_V1_RANGE[field])] = piece["v1_new"]
    try:
        fd = os.open(path, os.O_RDWR)
    except OSError:
        raise Refused("read_only") from None
    try:
        if os.fstat(fd).st_size != row.size:
            raise Refused("foreign")
        now = os.pread(fd, len(old), 0) + (os.pread(fd, 128, row.size - 128) if old_v1 else b"")
        if len(now) != len(saved) or any(byte not in pair for byte, pair in zip(now, zip(saved, new + new_v1))):
            raise Refused("foreign")
        if now == saved:
            outcome = "Η εγγραφή δεν είχε ολοκληρωθεί. Το αρχείο ήταν ήδη όπως πριν· δεν χρειάστηκε αλλαγή."
        else:
            _put(fd, old, old_v1, row.size)
            if problem := _differs(path, row.size, row.audio_sha256, old, old_v1):
                raise WriteFailed(f"Η επαναφορά δεν επιβεβαιώθηκε ({problem}).", False)
            outcome = "Η εγγραφή δεν είχε ολοκληρωθεί. Το αρχείο γύρισε όπως ήταν."
    finally:
        os.close(fd)
    _refresh_catalog(session, row.track_id, path)
    _close(session, row, "failed", outcome, drop_copy=True)
    return outcome
