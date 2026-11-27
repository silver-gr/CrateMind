"""Library scanner — idempotent folder traversal into the tracks table.

Guarantees:
- Running a scan N times does not duplicate rows or overwrite user work.
- Embedded-file columns (artist/title/duration/...) mirror the file and are
  refreshed only when size+mtime change.
- Human work (track_dj_profile, track_tags) lives in other tables and is never
  touched here.
- Files previously seen under a scanned root but now gone are marked missing,
  never deleted — unless the same bytes now sit at exactly one other path (a
  rename or move): then the stale row merges into that row (see _merge_moved).
"""
from __future__ import annotations

import math
import os
import re
import stat
from datetime import UTC, datetime
from pathlib import Path
from typing import Optional

from sqlalchemy import text
from sqlmodel import Session, select

from ..db import reindex_track
from ..models import Job, Track
from . import audit, ffprobe_reader, hashing, metadata_reader, playback_loudness
from .artist_normalizer import normalize_primary_artist_name
from .identity_matching import CandidateIndex, normalized_item, score_candidate
from .library_paths import (PathResolutionError, logical_root_for_path, logical_source_path,
                            mapping_context, resolve_media_path, resolve_source_path, source_path_key)

AUDIO_EXTS = {".mp3", ".flac", ".wav", ".aif", ".aiff", ".m4a", ".mp4", ".ogg", ".opus"}
_NUMBERED_VERSION = re.compile(
    r"\b(?:part|pt|vol(?:ume)?|chapter)\.?\s*(\d+|[ivxlcdm]+)\b"
    r"|\b(\d{4})\s+(?:remaster(?:ed)?|edit|version)\b"
    r"|\b(?:remaster(?:ed)?|edit|version)\s+(\d{4})\b", re.IGNORECASE,
)


def _is_file(p: Path) -> bool:
    try:
        return p.is_file()
    except OSError:
        return False


def _accessible_audio(path: Path, errors: list):
    """Return the single file stamp used for traversal and change detection."""
    if path.suffix.lower() not in AUDIO_EXTS:
        return None
    try:
        stamp = path.stat()
        if not stat.S_ISREG(stamp.st_mode) or not os.access(path, os.R_OK):
            raise OSError(f"unreadable audio path: {path}")
    except OSError as exc:
        errors.append(exc)
        return None
    return stamp


def _require_mounted_volume(root: Path) -> None:
    volume = _volume_root(root)
    # macOS can leave a readable, empty /Volumes/<name> directory behind after
    # ejecting a disk. Directory existence cannot establish file absence there.
    if volume and volume.startswith("/Volumes/") and not os.path.ismount(volume):
        raise OSError(f"library volume is not mounted: {volume}")


def _walk_audio_root(root: Path, errors: list, seen: set):
    _require_mounted_volume(root)
    if not root.is_dir():
        raise OSError("root unavailable or not a directory")
    for directory, dirs, files in os.walk(root, onerror=errors.append):
        # Do not infer absence beneath symlink directories we don't visit.
        if any((Path(directory) / name).is_symlink() for name in dirs):
            errors.append(OSError("symlink directory not traversed"))
        for name in files:
            path = Path(directory) / name
            if path.is_symlink() and not path.resolve().is_relative_to(root.resolve()):
                errors.append(OSError(f"audio symlink escapes library root: {path}"))
                continue
            if str(path) in seen:
                continue
            stamp = _accessible_audio(path, errors)
            if stamp is None:
                continue
            seen.add(str(path))
            yield root, path, stamp


def _iter_delta_audio(roots: list[Path], complete: list[Path], warnings: list[str]):
    """Only complete, readable traversals may establish that a file is absent."""
    seen = set()
    for root in roots:
        errors = []
        try:
            yield from _walk_audio_root(root, errors, seen)
            _require_mounted_volume(root)
        except OSError as exc:
            errors.append(exc)
        if errors:
            warnings.append(f"{root}: missing-file detection skipped ({errors[0]})")
        else:
            complete.append(root)


def _volume_root(path: Path) -> Optional[str]:
    parts = path.parts
    if len(parts) >= 3 and parts[1] == "Volumes":
        return f"/{parts[1]}/{parts[2]}"
    return path.anchor or None


def _birthtime(st) -> float:
    """File creation time. macOS/BSD expose st_birthtime; elsewhere fall back to
    st_ctime (inode-change time — not true creation, but the closest available)."""
    bt = getattr(st, "st_birthtime", None)
    return float(bt) if bt else float(st.st_ctime)


def _folder_fallback(path: Path, root: Path, record: dict) -> None:
    try:
        rel_parts = path.relative_to(root).parts
    except ValueError:
        rel_parts = path.parts

    if len(rel_parts) == 3 and not record.get("album"):
        record["album"] = rel_parts[1]

    if not record.get("artist"):
        if len(rel_parts) == 3:
            if not metadata_reader.looks_like_label_name(rel_parts[0]):
                record["artist"] = rel_parts[0]
        elif len(rel_parts) == 2:
            if not metadata_reader.looks_like_label_name(rel_parts[0]):
                record["artist"] = rel_parts[0]


def _read_embedded_record(path: Path, root: Path) -> dict:
    """Only the tag/derived columns that re-cleaning can change — no file stat,
    no quick_hash. Refreshes an unchanged row without re-hashing the file."""
    record: dict = {}
    record.update(metadata_reader.read_tags(path))
    _folder_fallback(path, root, record)
    record["artist_normalized"] = normalize_primary_artist_name(record.get("artist"))
    return record


def _read_metadata_record(path: Path, root: Path, st=None) -> dict:
    st = st if st is not None else path.stat()
    record: dict = {
        "file_name": path.name,
        "extension": path.suffix.lower().lstrip("."),
        "file_size": st.st_size,
        "modified_time": st.st_mtime,
        "created_time": _birthtime(st),
        "normalized_path": logical_source_path(path).casefold(),
        "volume_root": logical_root_for_path(path),
        "quick_hash": hashing.quick_hash(path),
    }
    record.update(_read_embedded_record(path, root))
    return record


def _read_file_record(path: Path, root: Path, ffprobe: Optional[str], st=None) -> dict:
    record = _read_metadata_record(path, root, st)
    record.update(ffprobe_reader.read_stream(path, ffprobe))
    return record


# «Καθαρά ονόματα»: the tag frames as the file holds them (read_tags' raw_* keys; _folder_fallback never sets them).
# Refreshed with the file, but no search or identity input, so writing only these never makes a row "updated".
_RAW_COLUMNS = set(metadata_reader.RAW_KEYS)
# embedded/file-derived columns the scanner is allowed to refresh
_FILE_COLUMNS = {
    "file_name", "extension", "file_size", "modified_time", "created_time", "normalized_path",
    "volume_root", "quick_hash", "artist", "artist_normalized", "title", "album", "label", "year",
    "genre", "comment", "bpm", "key_text", "rating", "duration", "bitrate",
    "sample_rate", "channels", "codec", "container",
} | _RAW_COLUMNS
# tag/derived columns re-cleaning may change on a byte-identical (size+mtime
# unchanged) file — the only columns worth refreshing on the unchanged path.
_EMBEDDED_COLUMNS = {
    "artist", "artist_normalized", "title", "album", "label", "year",
    "genre", "comment", "bpm", "key_text", "rating",
}


def _apply_columns(track: Track, record: dict, columns: set[str]) -> bool:
    changed = False
    for k in columns:
        if k not in record:
            continue
        current = getattr(track, k)
        incoming = record[k]
        if current != incoming:
            setattr(track, k, incoming)
            changed = True
    return changed


def _record_progress(session: Session, job: Job, processed: int) -> None:
    job.processed = processed
    session.add(job)
    session.commit()


def _scan_identity(record: dict | Track) -> dict:
    if isinstance(record, Track):
        # Access attributes explicitly: model_dump() omits expired ORM fields
        # after the worker's commit-on-progress sessions have committed.
        record = {name: getattr(record, name) for name in (
            "id", "absolute_path", "artist", "title", "file_name", "duration",
            "album", "label", "genre", "year", "bpm",
        )}
    duration = record.get("duration")
    return normalized_item({
        **record, "service": "local", "kind": "track",
        "duration_ms": duration * 1000 if duration and math.isfinite(duration) and duration > 0 else None,
    })


def _numbered_identity_conflict(left: dict, right: dict, title_basis: dict) -> bool:
    def identifiers(item, basis):
        # The best matched title has already had catalogue/BPM noise removed.
        title_numbers = set(re.findall(r"\b\d+\b", basis["text"]))
        raw = f"{item.get('title') or ''} {item.get('file_name') or ''}"
        editions = {value.lower() for groups in _NUMBERED_VERSION.findall(raw) for value in groups if value}
        return title_numbers, editions

    return identifiers(left, title_basis["left"]) != identifiers(right, title_basis["right"])


def _has_available_duplicate(candidate: dict, index: CandidateIndex, tracks: dict[str, Track],
                             candidate_st: os.stat_result) -> bool:
    if candidate["duration_ms"] is None:
        return False
    for track_id in index.retrieve(candidate):
        identity = index.items[track_id]
        if identity["duration_ms"] is None:
            continue
        match = score_candidate(candidate, identity)
        evidence = match["evidence"]
        # Suppressing an incoming local file needs stricter evidence than
        # associating a useful provider link. Keep the original scan guard even
        # when the shared provider policy becomes more permissive.
        if (evidence["conflicts"] or evidence.get("duration_delta_seconds") is None
                or evidence["duration_delta_seconds"] > 6
                or evidence.get("title_similarity", 0) < .9
                or evidence.get("artist_similarity", 0) < .8
                or evidence.get("score_without_neighborhood", 0) < 89):
            continue
        if _numbered_identity_conflict(candidate, identity, match["evidence"]["title_basis"]):
            continue
        track = tracks[identity["absolute_path"]]
        try:
            path = resolve_source_path(track.absolute_path)
            st = path.stat()
        except OSError:
            continue
        if os.path.samestat(st, candidate_st):
            # The same file under another spelling (a case-only rename on a
            # case-insensitive disk) is the old row moving, not a duplicate.
            continue
        # A stale/missing copy must not suppress a usable download. Changed
        # files become candidates again after their metadata has been refreshed.
        if (not track.missing and _is_file(path) and os.access(path, os.R_OK)
                and track.file_size == st.st_size and track.modified_time == st.st_mtime):
            return True
    return False


def _add_track(session: Session, path: Path, record: dict, now: datetime) -> Track:
    track = Track(absolute_path=logical_source_path(path), last_scanned_at=now, missing=False)
    for k, v in record.items():
        setattr(track, k, v)
    session.add(track)
    session.flush()
    reindex_track(session, track.id, commit=False)
    return track


def _refresh_track(
    session: Session, existing: Track, st, path: Path, root: Path,
    ffprobe: Optional[str], now: datetime, unchanged: bool,
) -> str:
    """Refresh an existing row; returns the stats key to bump."""
    existing.last_scanned_at = now
    existing.missing = False
    # Backfill created_time for rows imported before it was tracked
    # (cheap — st is already in hand, no full file re-read).
    if existing.created_time is None:
        existing.created_time = _birthtime(st)
    if not unchanged:
        record = _read_file_record(path, root, ffprobe, st)
        before = existing.duration
        _apply_columns(existing, record, _FILE_COLUMNS)
        # Tag edits change size/mtime but never the duration: a new duration means new audio,
        # so its stored loudness (Auto Gain's gain and peak cap) no longer applies.
        if before is not None and existing.duration is not None and abs(before - existing.duration) > 0.5:
            playback_loudness.clear(existing)
        session.add(existing)
        session.flush()
        reindex_track(session, existing.id, commit=False)
        return "updated"
    # Size/mtime match — only re-derive the tag columns (no
    # re-hash / re-stat) to pick up improved metadata cleaning.
    record = _read_embedded_record(path, root)
    _apply_columns(existing, record, _RAW_COLUMNS)
    changed = _apply_columns(existing, record, _EMBEDDED_COLUMNS)
    session.add(existing)
    if not changed:
        return "unchanged"
    session.flush()
    reindex_track(session, existing.id, commit=False)
    return "updated"


def _backfill_raw(session: Session, existing: Track, path: Path) -> None:
    """A delta scan's unchanged row whose raw tags were never read (raw_state NULL, e.g. scanned before the columns
    existed): read its tags and write only the raw_* columns. No other column, no FTS row, no hash, no identity
    re-derive; the row still counts as unchanged."""
    _apply_columns(existing, metadata_reader.read_tags(path), _RAW_COLUMNS)
    session.add(existing)


# A root that suddenly lost most of its tracks is far more often a wrong, half-mounted or emptied
# folder than a real clean-out, so that needs the user's explicit go-ahead (allow_mass_missing).
MASS_MISSING_MIN_TRACKS = 20
MASS_MISSING_NOTE = "δεν σημειώθηκε κανένα ότι λείπει"  # frontend/src/lib/relink.ts looks for this text


def _mark_missing(session: Session, safe_roots: list[Path], seen_paths: dict[str, Path], warnings: list[str],
                  added_ids: set[int], allow_mass_missing: bool = False) -> int:
    """Only completed readable roots establish absence, including empty roots. A root with at least
    MASS_MISSING_MIN_TRACKS known tracks that would lose more than half of them loses none. A gone
    track whose bytes (quick_hash) came back in this scan was moved: it is marked missing for
    _merge_moved and left out of that count. seen_paths maps each seen row's path to the walked file."""
    if not safe_roots:
        return 0
    known = dict.fromkeys(safe_roots, 0)
    gone: dict[Path, list[Track]] = {root: [] for root in known}
    candidates = session.exec(select(Track).where(Track.missing.is_(False))).all()
    added_hashes = {t.quick_hash for t in candidates if t.id in added_ids and t.quick_hash}
    missing = 0
    for track in candidates:
        if track.id in added_ids:
            continue
        local_path = seen_paths.get(track.absolute_path)
        if local_path is None:
            try:
                local_path = resolve_source_path(track.absolute_path)
            except PathResolutionError:
                continue
        root = next((root for root in known if local_path.is_relative_to(root)), None)
        if root is None:
            continue
        if track.absolute_path in seen_paths:
            known[root] += 1
        elif track.quick_hash in added_hashes:
            track.missing = True
            session.add(track)
            missing += 1
        else:
            known[root] += 1
            gone[root].append(track)
    for root, lost in gone.items():
        if not allow_mass_missing and known[root] >= MASS_MISSING_MIN_TRACKS and len(lost) * 2 > known[root]:
            warnings.append(f"{root}: λείπουν {len(lost)} από τα {known[root]} tracks του φακέλου, {MASS_MISSING_NOTE}"
                            " (έλεγξε ότι ο δίσκος ή ο φάκελος είναι συνδεδεμένος)")
            continue
        for track in lost:
            track.missing = True
            session.add(track)
        missing += len(lost)
    return missing


# Path/file-system columns, and the raw tags (what the surviving row's own file holds; NULL is read on the next
# scan), stay with the surviving row; play stats are combined.
_MERGE_SKIP = {"id", "absolute_path", "normalized_path", "volume_root", "file_name", "extension",
               "modified_time", "created_time", "last_scanned_at", "missing",
               "play_count", "last_played_at", "imported_at"} | _RAW_COLUMNS


def merge_tracks(session: Session, pairs: list[tuple[int, int]], reason: str = "same file",
                 keep_new: frozenset[str] | set[str] = frozenset()) -> int:
    """Merge each (old, new) pair: re-point everything that references the old row (profile, tags,
    sets, cues, beatgrids, SoundCloud links, …) to the new row, fill the new row's empty columns
    from it (except those in `keep_new`), and drop it. Where both rows hold a one-per-track record
    the new row's wins; dropped rows are kept in the audit log. Never touches audio."""
    if not pairs:
        return 0

    def q(sql, params=None):
        return session.execute(text(sql), params or {})

    refs = [(table, fk["from"]) for (table,) in q("SELECT name FROM sqlite_master WHERE type = 'table'").all()
            for fk in q(f'PRAGMA foreign_key_list("{table}")').mappings() if fk["table"] == "tracks"]
    columns = [c for (_, c, *_) in q("PRAGMA table_info(tracks)").all() if c not in _MERGE_SKIP | keep_new]
    for old, new in pairs:
        ids = {"old": old, "new": new}
        row = dict(q("SELECT * FROM tracks WHERE id = :old", ids).mappings().one())
        before = {"track": row}
        for table, col in refs:
            q(f'UPDATE OR IGNORE "{table}" SET "{col}" = :new WHERE "{col}" = :old', ids)
            dropped = q(f'SELECT * FROM "{table}" WHERE "{col}" = :old', ids).mappings().all()
            if dropped:
                before[table] = [dict(r) for r in dropped]
                q(f'DELETE FROM "{table}" WHERE "{col}" = :old', ids)
        q("UPDATE tracks SET " + ", ".join(f'"{c}" = COALESCE("{c}", :{c})' for c in columns)
          + ", play_count = play_count + :play_count"
          + ", last_played_at = MAX(COALESCE(last_played_at, :last_played_at), COALESCE(:last_played_at, last_played_at))"
          + ", imported_at = MIN(imported_at, :imported_at) WHERE id = :new", {**row, "new": new})
        # A manual BPM fix is the user's work: it wins over the new row's analysed consensus
        # (a relink runs after the new file was analysed).
        if (row.get("bpm_consensus_sources") or "").startswith("manual:"):
            q("UPDATE tracks SET bpm_consensus = :bpm_consensus, bpm_consensus_sources = :bpm_consensus_sources,"
              " bpm_needs_review = 0 WHERE id = :new", {**row, "new": new})
        q("DELETE FROM tracks WHERE id = :old", ids)
        reindex_track(session, old, commit=False)  # drops its search row
        reindex_track(session, new, commit=False)  # moved tags/notes
        audit.log(session, "merge_moved_track", "track", old, before,
                  {"merged_into": new, "from_path": row["absolute_path"], "reason": reason}, commit=False)
    return len(pairs)


def _merge_moved(session: Session) -> int:
    """A missing row whose bytes (quick_hash) now sit at exactly one available row
    was renamed or moved: merge it into that row (see merge_tracks). Ambiguous
    hashes (more than one copy) are left alone."""
    session.flush()
    pairs = session.execute(text(
        "SELECT MAX(CASE WHEN missing THEN id END), MAX(CASE WHEN missing THEN NULL ELSE id END) "
        "FROM tracks WHERE quick_hash IS NOT NULL GROUP BY quick_hash "
        "HAVING COUNT(*) = 2 AND SUM(missing) = 1")).all()
    return merge_tracks(session, [(old, new) for old, new in pairs])


def scan(
    session: Session,
    roots: list[Path],
    ffprobe: Optional[str] = None,
    job: Optional[Job] = None,
    mode: str = "full",
    allow_mass_missing: bool = False,
) -> dict:
    stats = {"scanned": 0, "added": 0, "updated": 0, "unchanged": 0, "missing": 0,
             "skipped_duplicates": 0, "merged_moved": 0, "added_track_ids": []}
    if mode not in {"full", "delta"}:
        raise ValueError("Unknown scan mode")
    complete: list[Path] = []
    warnings: list[str] = []
    mappings, strict = mapping_context()
    if strict:
        connected = []
        for requested in roots:
            try:
                local = resolve_media_path(requested)
                # Both logical and native inputs must reverse-map to a declared root.
                logical_source_path(local, mappings)
                if local not in connected:
                    connected.append(local)
            except (OSError, ValueError) as error:
                warnings.append(f"{requested}: missing-file detection skipped ({error})")
        roots = connected
    existing_by_path = {t.absolute_path: t for t in session.exec(select(Track)).all()}
    existing_by_key = {source_path_key(path): track for path, track in existing_by_path.items()}
    if len(existing_by_key) != len(existing_by_path):
        raise ValueError("Η βιβλιοθήκη περιέχει αμφίσημες διαδρομές για την πλατφόρμα προέλευσης.")
    duplicate_index: CandidateIndex | None = None
    iterator = _iter_delta_audio(roots, complete, warnings)
    seen_paths: dict[str, Path] = {}  # row path -> the file walked for it
    now = datetime.now(UTC)

    for root, path, st in iterator:
        abspath = logical_source_path(path)
        stats["scanned"] += 1

        existing = existing_by_key.get(source_path_key(abspath))
        seen_paths[existing.absolute_path if existing is not None else abspath] = path

        if existing is None:
            record = _read_file_record(path, root, ffprobe, st)
            if duplicate_index is None:
                duplicate_index = CandidateIndex([
                    _scan_identity(t) for t in existing_by_path.values() if not t.missing
                ])
            if _has_available_duplicate(_scan_identity(record), duplicate_index, existing_by_path, st):
                stats["skipped_duplicates"] += 1
            else:
                track = _add_track(session, path, record, now)
                existing_by_path[abspath] = track
                existing_by_key[source_path_key(abspath)] = track
                duplicate_index.add(_scan_identity(track))
                stats["added"] += 1
                stats["added_track_ids"].append(track.id)
        else:
            unchanged = (
                existing.file_size == st.st_size
                and existing.modified_time == st.st_mtime
                and not existing.missing
            )
            if unchanged and mode == "delta":
                if existing.raw_state is None:
                    _backfill_raw(session, existing, path)
                stats["unchanged"] += 1
                if job is not None and stats["scanned"] % 100 == 0:
                    _record_progress(session, job, stats["scanned"])
                continue
            stats[_refresh_track(session, existing, st, path, root, ffprobe, now, unchanged)] += 1
            if duplicate_index is not None:
                duplicate_index.add(_scan_identity(existing))

        if stats["scanned"] % 100 == 0:
            if job is not None:
                _record_progress(session, job, stats["scanned"])
            else:
                session.commit()

    # mark missing: rows under the scanned roots not seen this pass
    safe_roots = complete
    stats["missing"] += _mark_missing(session, safe_roots, seen_paths, warnings,
                                      set(stats["added_track_ids"]), allow_mass_missing)
    stats["merged_moved"] = _merge_moved(session)

    if job is not None:
        _record_progress(session, job, stats["scanned"])
    else:
        session.commit()
    stats["warnings"] = warnings

    # The catalog is durable before crossing into the paired identity DB. Even
    # an unchanged delta retries any previously interrupted synchronization.
    from .identity_sync import replay_mirror_intents, sync_session

    try:
        replay_mirror_intents(session)
        stats["identity"] = sync_session(session, rederive_unchanged=mode != "delta")
    except Exception as exc:
        session.rollback()
        raise RuntimeError(f"Catalog scan saved; identity synchronization failed: {exc}") from exc
    return stats
