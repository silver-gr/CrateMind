"""Read-only import of djay Pro beatgrids into CrateMind's own table.

Data safety: djay's files are never written, moved or locked. The YapDatabase
(`MediaLibrary.db`) is only ever read from a private copy (db + `-wal`, never
`-shm`); the live file is never opened because even a read-only WAL reader
writes read-marks into djay's `-shm`. The per-track `.djayMetadata` plists are
read in place with a plain `open(path, "rb")`.
"""
from __future__ import annotations

import json
import logging
import math
import os
import plistlib
import shutil
import sqlite3
import struct
import tempfile
import time
import unicodedata
import zlib
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
from sqlmodel import Session, select

from ..models import Track, TrackBeatgrid

logger = logging.getLogger(__name__)

SOURCE = "djay"
DEFAULT_LIBRARY = Path("~/Music/djay/djay Media Library.djayMediaLibrary/MediaLibrary.db")
DEFAULT_METADATA = Path("~/Library/Group Containers/VJXTL73S8G.com.algoriddim.userdata"
                        "/Library/Application Support/Algoriddim/Metadata")
SUPPORTED_VERSION = 8
SUPPORTED_TIME_SIGNATURE = 4
# Median |beat - grid| for a djay-straight grid. The median, not p95: on real tracks ~18% of beats wander in
# breakdowns without a kick while the typical beat sits ~3 ms off, and djay itself draws those grids straight.
RESIDUAL_GATE_MS = 10.0
MANUAL_BPM_TOLERANCE = 0.002
DURATION_TOLERANCE_S = 1.0
COPY_ATTEMPTS = 3
_RETRY_PAUSE_S = 0.5
SAMPLE_LIMIT = 10

BUSY_MESSAGE = "Το djay γράφει τη βιβλιοθήκη — κλείσε το djay και ξαναδοκίμασε"


class DjayImportError(Exception):
    """Fatal for the whole import; the message is user-facing Greek."""


class TransientSourceError(Exception):
    """A per-track read problem; the stored grid (if any) is kept."""

    def __init__(self, reason: str, *, denied: bool = False):
        super().__init__(reason)
        self.reason, self.denied = reason, denied


class UnsupportedAnalysis(Exception):
    """djay's analysis exists but is not one this importer understands."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


# ---- sources ---------------------------------------------------------------

def responsible_app() -> str:
    """The app macOS attributes file-access prompts to."""
    from ..runtime_profile import RuntimeProfile, get_runtime_profile

    if get_runtime_profile() is RuntimeProfile.DESKTOP_CORE:
        return "CrateMind Preview"
    term = os.environ.get("TERM_PROGRAM", "")
    return {"Apple_Terminal": "Terminal", "iTerm.app": "iTerm"}.get(term, term or "την εφαρμογή τερματικού")


def denied_message() -> str:
    return (f"Το macOS δεν επιτρέπει στο «{responsible_app()}» να διαβάσει τα αρχεία του djay. "
            "Επίτρεψε την πρόσβαση στις Ρυθμίσεις συστήματος ▸ Απόρρητο και ασφάλεια και ξαναδοκίμασε.")


def resolve_sources(settings) -> tuple[Path, Path]:
    """(library db, metadata root). Desktop reads `desktop-config.json` because
    the supervisor strips CRATEMIND_* env vars; web uses the Settings env."""
    library, metadata = settings.djay_library, settings.djay_metadata
    from ..runtime_profile import RuntimeProfile, get_runtime_profile

    if get_runtime_profile() is RuntimeProfile.DESKTOP_CORE and settings.dataset_root:
        config = Path(settings.dataset_root) / "desktop-config.json"
        try:
            if config.is_file() and config.stat().st_size <= 512 * 1024:
                value = json.loads(config.read_text(encoding="utf-8"))
                if isinstance(value, dict):
                    if isinstance(value.get("djay_library"), str) and value["djay_library"]:
                        library = value["djay_library"]
                    if isinstance(value.get("djay_metadata"), str) and value["djay_metadata"]:
                        metadata = value["djay_metadata"]
        except (OSError, ValueError):
            pass
    return (Path(library or DEFAULT_LIBRARY).expanduser(),
            Path(metadata or DEFAULT_METADATA).expanduser())


# ---- private copy of the library database ----------------------------------

def _signature(path: Path):
    try:
        status = path.stat()
    except FileNotFoundError:
        return None
    return status.st_ino, status.st_size, status.st_mtime_ns


def copy_library(library: Path, workdir: Path) -> Path:
    """Copy db + `-wal` into `workdir`, retrying while the source changes.

    The source is only stat()ed and byte-copied here, never opened by SQLite.
    A WAL that appears, disappears, is truncated or is rewritten counts as a
    change. After the last failed attempt nothing has been imported yet.
    """
    wal = Path(str(library) + "-wal")
    target = workdir / "MediaLibrary.db"
    for attempt in range(COPY_ATTEMPTS):
        try:
            before = (_signature(library), _signature(wal))
            if before[0] is None:
                raise DjayImportError(f"Δεν βρέθηκε η βιβλιοθήκη του djay: {library}")
            shutil.copyfile(library, target)
            if before[1] is not None:
                shutil.copyfile(wal, workdir / "MediaLibrary.db-wal")
            else:
                (workdir / "MediaLibrary.db-wal").unlink(missing_ok=True)
            after = (_signature(library), _signature(wal))
        except PermissionError as error:
            raise DjayImportError(denied_message()) from error
        except FileNotFoundError:
            after = None  # the file vanished mid-copy: treat as a change
        if after == before:
            return target
        if attempt + 1 < COPY_ATTEMPTS:
            time.sleep(_RETRY_PAUSE_S)
    raise DjayImportError(BUSY_MESSAGE)


# ---- parsers -----------------------------------------------------------------

def tsaf_field(blob: bytes, name: str) -> float | None:
    """A float32 field of a TSAF blob. Scalars are stored VALUE-then-NAME: `<f32 LE> 08 <name> 00`.
    The bytes before the value vary in djay's real blobs (often `13 00 00 00`, but not always), so only
    the value is read. A null field has `2e` right before the name."""
    token = b"\x08" + name.encode("ascii") + b"\x00"
    index = blob.find(token)
    if index < 4 or blob[index - 1] == 0x2E:
        return None
    value = struct.unpack("<f", blob[index - 4:index])[0]
    return value if math.isfinite(value) else None


def _tsaf_is_set(blob: bytes, name: str) -> bool:
    """True when a (non-float or float) field is present, non-null and non-zero."""
    index = blob.find(b"\x08" + name.encode("ascii") + b"\x00")
    if index < 5 or blob[index - 1] == 0x2E:
        return False
    return any(blob[index - 4:index])


_OTHER_EDIT_FIELDS = ("nrOfBeatShift", "fractionalBeatShift", "downbeatMarkers",
                      "firstGridSegmentTempoExponent", "lastGridSegmentTempoExponent")


def tsaf_beatgrid_edits(blob: bytes) -> tuple[float | None, bool]:
    """(firstDownbeatPosition or None, any other grid edit present)."""
    if b"ADCBeatGridEdits" not in blob:
        return None, False
    position = tsaf_field(blob, "firstDownbeatPosition")  # None for a null field; 0.0 is a real edit
    return position, any(_tsaf_is_set(blob, name) for name in _OTHER_EDIT_FIELDS)


def bookmark_path(blob: bytes) -> str | None:
    """Absolute path from a macOS bookmark ('book'). Its path components start at the filesystem
    root (an external file is `Volumes/<disk>/...`), so they are joined under `/`, not under the volume path."""
    start = blob.find(b"book")
    while start >= 0:  # "book" can occur earlier, e.g. inside a file name like "Notebook.mp3"
        path = _bookmark_at(blob, start)
        if path is not None:
            return path
        start = blob.find(b"book", start + 1)
    return None


def _bookmark_at(blob: bytes, start: int) -> str | None:
    try:
        magic, size, _version, header = struct.unpack("<4sIII", blob[start:start + 16])
        body = blob[start:start + size][header:]
        toc = struct.unpack("<I", body[:4])[0]
        count = struct.unpack("<I", body[toc + 16:toc + 20])[0]
        entries = {}
        for i in range(count):
            key, offset, _ = struct.unpack("<III", body[toc + 20 + 12 * i:toc + 32 + 12 * i])
            entries[key] = offset

        def item(offset: int):
            length, kind = struct.unpack("<II", body[offset:offset + 8])
            return kind, body[offset + 8:offset + 8 + length]

        def string(offset: int) -> str:
            kind, payload = item(offset)
            if kind != 0x101:
                raise ValueError("not a string")
            return payload.decode("utf-8")

        kind, payload = item(entries[0x1004])
        if kind != 0x601:
            return None
        parts = [string(struct.unpack("<I", payload[i:i + 4])[0]) for i in range(0, len(payload), 4)]
    except (struct.error, KeyError, ValueError, UnicodeDecodeError, IndexError):
        return None
    if not parts:
        return None
    return str(Path("/", *parts))


@dataclass
class Analysis:
    beats: np.ndarray
    first_down: int
    straight_grid: bool
    straight_bpm: float
    bpm: float
    confidence: float | None
    version: int


def read_analysis(path: Path) -> Analysis:
    """Read one `.djayMetadata` in place. Raises TransientSourceError for a
    read problem and UnsupportedAnalysis for a format we do not understand."""
    try:
        with open(path, "rb") as handle:
            plist = plistlib.load(handle)
    except PermissionError as error:
        raise TransientSourceError("denied", denied=True) from error
    except FileNotFoundError as error:
        raise TransientSourceError("missing") from error
    except (OSError, ValueError, plistlib.InvalidFileException) as error:
        raise TransientSourceError("unreadable") from error
    except Exception as error:  # expat / OverflowError from a half-written file
        raise TransientSourceError("unreadable") from error
    info = plist.get("deepBeatTrackerInfo") if isinstance(plist, dict) else None
    if not isinstance(info, dict):
        raise UnsupportedAnalysis("no_beat_info")
    if info.get("version") != SUPPORTED_VERSION:
        raise UnsupportedAnalysis("version")
    if info.get("timeSignatureIndex") != SUPPORTED_TIME_SIGNATURE:
        raise UnsupportedAnalysis("time_signature")
    try:
        raw = zlib.decompress(info["compressedBeats"])
        beats = np.frombuffer(raw[:len(raw) // 4 * 4], dtype=">f4").astype(np.float64)
        first_down = int(info["firstDownBeatIndex"])
        straight_bpm = float(info.get("straightBPM") or info.get("bpm") or 0.0)
        bpm = float(info.get("bpm") or straight_bpm)
        confidence = info.get("bpmConfidence")
        confidence = float(confidence) if isinstance(confidence, (int, float)) else None
    except (KeyError, TypeError, ValueError, zlib.error) as error:
        raise UnsupportedAnalysis("beats") from error
    if (len(beats) < 8 or not np.all(np.isfinite(beats)) or np.any(np.diff(beats) <= 0)
            or not 0 <= first_down < len(beats) or not straight_bpm > 0):
        raise UnsupportedAnalysis("beats")
    return Analysis(beats, first_down, bool(info.get("straightGrid")), straight_bpm,
                    bpm, confidence, SUPPORTED_VERSION)


# ---- grid model ----------------------------------------------------------------

@dataclass
class GridFit:
    straight: bool
    bpm: float | None
    anchor_s: float | None
    first_downbeat_index: int | None
    beats: np.ndarray | None
    residual_ms: float | None
    edited: bool = False


def _manual_factor(native_bpm: float, manual_bpm: float) -> float | None:
    for factor in (1.0, 2.0, 0.5):
        if abs(manual_bpm - native_bpm * factor) <= native_bpm * factor * MANUAL_BPM_TOLERANCE:
            return factor
    return None


def fit_grid(analysis: Analysis, manual_bpm: float | None, first_downbeat: float | None,
             other_edits: bool) -> GridFit:
    """Fit at the native tempo first; apply manual BPM x2/x1/2 afterwards."""
    beats = analysis.beats
    has_manual = manual_bpm is not None and manual_bpm > 0
    if other_edits:
        return GridFit(False, None, None, analysis.first_down, None, None, edited=True)
    if not analysis.straight_grid:
        # djay's own flag wins: dynamic grids keep their raw beats.
        if has_manual and _manual_factor(analysis.bpm, manual_bpm) != 1.0:
            return GridFit(False, None, None, analysis.first_down, None, None, edited=True)
        index = analysis.first_down
        if first_downbeat is not None:
            nearest = int(np.argmin(np.abs(beats - first_downbeat)))
            if abs(beats[nearest] - first_downbeat) <= 30.0 / max(analysis.bpm, 1.0):
                index = nearest
        return GridFit(False, analysis.bpm, float(beats[index]), index, beats, None)
    period = 60.0 / analysis.straight_bpm
    t0 = beats[analysis.first_down]
    numbers = np.round((beats - t0) / period)
    anchor = float(np.median(beats - numbers * period))
    residual = np.abs(beats - (anchor + numbers * period))
    typical_ms = float(np.median(residual) * 1000.0)
    if first_downbeat is not None:
        anchor = first_downbeat
    if typical_ms > RESIDUAL_GATE_MS:
        if has_manual and _manual_factor(analysis.bpm, manual_bpm) != 1.0:
            return GridFit(False, None, None, analysis.first_down, None, typical_ms, edited=True)
        index = analysis.first_down
        if first_downbeat is not None:
            nearest = int(np.argmin(np.abs(beats - first_downbeat)))
            if abs(beats[nearest] - first_downbeat) <= 30.0 / max(analysis.bpm, 1.0):
                index = nearest
        return GridFit(False, analysis.bpm, anchor, index, beats, typical_ms)
    bpm = analysis.straight_bpm
    if has_manual:
        factor = _manual_factor(analysis.straight_bpm, manual_bpm)
        if factor is None:
            return GridFit(False, None, None, analysis.first_down, None, typical_ms, edited=True)
        bpm = analysis.straight_bpm * factor  # keeps the downbeat timestamp (anchor)
    return GridFit(True, bpm, anchor, analysis.first_down, None, typical_ms)


# ---- library database ----------------------------------------------------------

@dataclass
class DjayItem:
    uuid: str
    file_name: str
    duration: float | None
    path: str | None
    bpm: float | None = None
    manual_bpm: float | None = None
    key_index: int | None = None
    first_downbeat: float | None = None
    other_edits: bool = False


def _location_duration(blob: bytes) -> float | None:
    value = tsaf_field(blob, "duration")
    return value if value is not None and value > 0 else None


def read_library(copy: Path) -> dict[str, DjayItem]:
    """Open the PRIVATE copy normally (replaying its WAL) and read the indexes."""
    try:
        connection = sqlite3.connect(str(copy))
    except sqlite3.Error as error:
        raise DjayImportError("Η βιβλιοθήκη του djay δεν διαβάζεται.") from error
    try:
        if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise DjayImportError(BUSY_MESSAGE)
        items: dict[str, DjayItem] = {}
        for key, name, blob in connection.execute(
            "SELECT d.key, l.fileName, d.data FROM secondaryIndex_mediaItemLocationIndex l "
            "JOIN database2 d ON d.rowid = l.rowid WHERE d.collection = 'localMediaItemLocations'"
        ):
            blob = blob or b""
            items[key] = DjayItem(key, name or "", _location_duration(blob), bookmark_path(blob))
        for key, bpm, manual, key_index in connection.execute(
            "SELECT d.key, a.bpm, a.manualBPM, a.keySignatureIndex "
            "FROM secondaryIndex_mediaItemAnalyzedDataIndex a "
            "JOIN database2 d ON d.rowid = a.rowid WHERE d.collection = 'mediaItemAnalyzedData'"
        ):
            if key in items:
                items[key].bpm, items[key].manual_bpm, items[key].key_index = bpm, manual, key_index
        for key, blob in connection.execute(
            "SELECT key, data FROM database2 WHERE collection = 'mediaItemUserData' "
            "AND instr(data, ?) > 0", (b"ADCBeatGridEdits",)
        ):
            if key in items:
                items[key].first_downbeat, items[key].other_edits = tsaf_beatgrid_edits(blob)
        return items
    except sqlite3.Error as error:
        raise DjayImportError("Η βιβλιοθήκη του djay έχει μη αναγνωρίσιμη μορφή.") from error
    finally:
        connection.close()


def index_metadata(root: Path) -> dict[str, Path]:
    """uuid -> `.djayMetadata` path. The shard rule is not relied upon."""
    found: dict[str, Path] = {}
    try:
        with os.scandir(root) as shards:
            for shard in shards:
                if not shard.is_dir():
                    continue
                with os.scandir(shard.path) as files:
                    for entry in files:
                        if entry.name.endswith(".djayMetadata"):
                            found[entry.name[:-len(".djayMetadata")]] = Path(entry.path)
    except PermissionError as error:
        raise DjayImportError(denied_message()) from error
    except FileNotFoundError as error:
        raise DjayImportError(f"Δεν βρέθηκε ο φάκελος ανάλυσης του djay: {root}") from error
    return found


# ---- matching --------------------------------------------------------------------

def _norm_name(name: str) -> str:
    return unicodedata.normalize("NFC", name).casefold()


def match_items(items: dict[str, DjayItem], tracks: list[tuple]) -> tuple[dict[str, int], dict[str, str]]:
    """(uuid -> track id, uuid -> skip reason). `tracks` rows are
    (id, absolute_path, file_name, duration). One uuid maps to at most one track
    and one track to at most one uuid; competing uuids are all skipped."""
    from .library_paths import logical_source_path

    by_path: dict[str, int] = {}
    by_name: dict[str, list[tuple[int, float | None]]] = defaultdict(list)
    for track_id, path, name, duration in tracks:
        if path:
            by_path[unicodedata.normalize("NFC", path)] = track_id
        by_name[_norm_name(name or "")].append((track_id, duration))

    candidate: dict[str, int] = {}
    reasons: dict[str, str] = {}
    bookmarked: set[str] = set()
    for uuid, item in items.items():
        if not item.path:
            continue
        try:
            logical = logical_source_path(item.path)
        except Exception:  # unmapped / invalid: fall through to the name rule
            continue
        track_id = by_path.get(unicodedata.normalize("NFC", logical))
        if track_id is not None:
            candidate[uuid] = track_id
            bookmarked.add(uuid)
    for uuid, item in items.items():
        if uuid in candidate:
            continue
        if item.duration is None:
            reasons[uuid] = "unmatched"
            continue
        options = {track_id for track_id, duration in by_name.get(_norm_name(item.file_name), [])
                   if duration is not None and abs(duration - item.duration) <= DURATION_TOLERANCE_S}
        if len(options) == 1:
            candidate[uuid] = next(iter(options))
        else:
            reasons[uuid] = "ambiguous" if options else "unmatched"
    # Identical files share one uuid: a track claimed by bookmark is not
    # also claimed by name for the same uuid; only the first rule applies.
    owners: dict[int, list[str]] = defaultdict(list)
    for uuid, track_id in candidate.items():
        owners[track_id].append(uuid)
    matched: dict[str, int] = {}
    for track_id, uuids in owners.items():
        if len(uuids) == 1:
            matched[uuids[0]] = track_id
        else:
            for uuid in uuids:
                reasons[uuid] = "ambiguous"
    return matched, reasons


# ---- storage ---------------------------------------------------------------------

_CONTENT_FIELDS = ("source_uuid", "bpm", "straight", "anchor_s", "first_downbeat_index", "beats",
                   "residual_ms", "confidence", "edited", "key_index", "source_version")


def _upsert(session: Session, track_id: int, content: dict) -> str:
    """'added' | 'updated' | 'unchanged'. imported_at moves only on a change."""
    for stale in session.exec(select(TrackBeatgrid).where(
            TrackBeatgrid.source == SOURCE, TrackBeatgrid.source_uuid == content["source_uuid"],
            TrackBeatgrid.track_id != track_id)).all():
        session.delete(stale)  # the uuid's match moved to another track
    row = session.exec(select(TrackBeatgrid).where(
        TrackBeatgrid.track_id == track_id, TrackBeatgrid.source == SOURCE)).first()
    if row is None:
        session.add(TrackBeatgrid(track_id=track_id, source=SOURCE, **content))
        return "added"
    if all(getattr(row, field) == content[field] for field in _CONTENT_FIELDS):
        return "unchanged"
    for field in _CONTENT_FIELDS:
        setattr(row, field, content[field])
    row.imported_at = datetime.now(UTC)
    session.add(row)
    return "updated"


def _delete_row(session: Session, track_id: int) -> bool:
    row = session.exec(select(TrackBeatgrid).where(
        TrackBeatgrid.track_id == track_id, TrackBeatgrid.source == SOURCE)).first()
    if row is not None:
        session.delete(row)
    return row is not None


def remove_djay_beatgrids(session: Session) -> int:
    rows = session.exec(select(TrackBeatgrid).where(TrackBeatgrid.source == SOURCE)).all()
    for row in rows:
        session.delete(row)
    session.commit()
    return len(rows)


# ---- the import ----------------------------------------------------------------------

_COUNTERS = ("matched", "ambiguous", "unmatched", "edited", "non_straight", "unknown_version",
             "denied", "transient", "added", "updated", "unchanged", "removed")


def run_import(session: Session, job=None, *, settings=None, library: Path | None = None,
               metadata: Path | None = None) -> dict:
    """Read, match, upsert; returns the report. Aborts before any upsert when
    the source library cannot be copied consistently."""
    from ..config import get_settings

    settings = settings or get_settings()
    default_library, default_metadata = resolve_sources(settings)
    library, metadata = library or default_library, metadata or default_metadata
    report: dict = {"library": str(library), "metadata": str(metadata), "items": 0,
                    **{name: 0 for name in _COUNTERS}, "samples": defaultdict(list)}

    def note(kind: str, item: DjayItem, reason: str = "") -> None:
        if len(report["samples"][kind]) < SAMPLE_LIMIT:
            report["samples"][kind].append(
                {"uuid": item.uuid, "file_name": item.file_name, "reason": reason})

    with tempfile.TemporaryDirectory(prefix="cratemind-djay-") as directory:
        copy = copy_library(library, Path(directory))
        items = read_library(copy)
    files = index_metadata(metadata)
    tracks = list(session.exec(select(Track.id, Track.absolute_path, Track.file_name, Track.duration)).all())
    matched, reasons = match_items(items, [tuple(row) for row in tracks])
    report["items"] = len(items)
    for uuid, reason in reasons.items():
        report[reason] += 1
        note(reason, items[uuid])
    if job is not None:
        job.total, job.processed = len(matched), 0
        session.add(job)
        session.commit()

    for number, (uuid, track_id) in enumerate(matched.items(), 1):
        item = items[uuid]
        report["matched"] += 1
        try:
            path = files.get(uuid)
            if path is None:
                raise TransientSourceError("missing")
            analysis = read_analysis(path)
        except TransientSourceError as error:
            report["denied" if error.denied else "transient"] += 1
            note("denied" if error.denied else "transient", item, error.reason)
            continue  # transient: the old row (if any) is kept
        except UnsupportedAnalysis as error:
            report["unknown_version"] += 1
            note("unknown_version", item, error.reason)
            report["removed"] += _delete_row(session, track_id)  # authoritative
            continue
        fit = fit_grid(analysis, item.manual_bpm, item.first_downbeat, item.other_edits)
        if fit.edited:
            report["edited"] += 1
            note("edited", item)
        elif not fit.straight:
            report["non_straight"] += 1
            note("non_straight", item, "residual" if analysis.straight_grid else "dynamic")
        content = {
            "source_uuid": uuid, "bpm": fit.bpm, "straight": fit.straight, "anchor_s": fit.anchor_s,
            "first_downbeat_index": fit.first_downbeat_index,
            "beats": fit.beats.astype("<f4").tobytes() if fit.beats is not None else None,
            "residual_ms": fit.residual_ms, "confidence": analysis.confidence, "edited": fit.edited,
            "key_index": item.key_index, "source_version": analysis.version,
        }
        report[_upsert(session, track_id, content)] += 1
        if number % 200 == 0:
            session.commit()
            if job is not None:
                job.processed = number
                session.add(job)
                session.commit()
    if job is not None:
        job.processed = len(matched)
        session.add(job)
    session.commit()
    report["samples"] = dict(report["samples"])
    return report
