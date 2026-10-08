"""Library scanner — idempotent folder traversal into the tracks table.

Guarantees:
- Running a scan N times does not duplicate rows or overwrite user work.
- Embedded-file columns (artist/title/duration/...) mirror the file and are
  refreshed only when size+mtime change.
- Human work (track_dj_profile, track_tags) lives in other tables and is never
  touched here.
- Files previously seen under a scanned root but now gone are marked missing,
  never deleted.
"""
from __future__ import annotations

import os

from datetime import UTC, datetime
from pathlib import Path
from typing import Optional

from sqlmodel import Session, select

from ..db import reindex_track
from ..models import Job, Track
from .artist_normalizer import normalize_primary_artist_name
from . import ffprobe_reader, hashing, metadata_reader

AUDIO_EXTS = {".mp3", ".flac", ".wav", ".aif", ".aiff", ".m4a", ".mp4", ".ogg", ".opus"}


def _is_file(p: Path) -> bool:
    try:
        return p.is_file()
    except OSError:
        return False


def _real_path(p: Path) -> str:
    try:
        return str(p.resolve())
    except OSError:
        return str(p)


def _iter_audio(roots: list[Path]):
    seen_dirs: set[str] = set()
    for root in roots:
        if not root.exists():
            continue
        for p in root.rglob("*"):
            if not _is_file(p):
                continue
            # guard against symlink directory loops
            real = _real_path(p)
            if real in seen_dirs:
                continue
            seen_dirs.add(real)
            if p.suffix.lower() in AUDIO_EXTS:
                yield root, p


def _accessible_audio(path: Path, errors: list) -> bool:
    if path.suffix.lower() not in AUDIO_EXTS:
        return False
    try:
        if not path.is_file():
            raise OSError(f"unreadable audio path: {path}")
        path.stat()
    except OSError as exc:
        errors.append(exc)
        return False
    return True


def _walk_audio_root(root: Path, errors: list, seen: set):
    if not root.is_dir():
        raise OSError("root unavailable or not a directory")
    for directory, dirs, files in os.walk(root, onerror=errors.append):
        # Do not infer absence beneath symlink directories we don't visit.
        if any((Path(directory) / name).is_symlink() for name in dirs):
            errors.append(OSError("symlink directory not traversed"))
        for name in files:
            path = Path(directory) / name
            if not _accessible_audio(path, errors) or str(path) in seen:
                continue
            seen.add(str(path))
            yield root, path


def _iter_delta_audio(roots: list[Path], complete: list[Path], warnings: list[str]):
    """Only complete, readable traversals may establish that a file is absent."""
    seen = set()
    for root in roots:
        errors = []
        try:
            yield from _walk_audio_root(root, errors, seen)
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


def _read_metadata_record(path: Path, root: Path) -> dict:
    st = path.stat()
    record: dict = {
        "file_name": path.name,
        "extension": path.suffix.lower().lstrip("."),
        "file_size": st.st_size,
        "modified_time": st.st_mtime,
        "created_time": _birthtime(st),
        "normalized_path": str(path).casefold(),
        "volume_root": _volume_root(path),
        "quick_hash": hashing.quick_hash(path),
    }
    record.update(_read_embedded_record(path, root))
    return record


def _read_file_record(path: Path, root: Path, ffprobe: Optional[str]) -> dict:
    record = _read_metadata_record(path, root)
    record.update(ffprobe_reader.read_stream(path, ffprobe))
    return record


# embedded/file-derived columns the scanner is allowed to refresh
_FILE_COLUMNS = {
    "file_name", "extension", "file_size", "modified_time", "created_time", "normalized_path",
    "volume_root", "quick_hash", "artist", "artist_normalized", "title", "album", "label", "year",
    "genre", "comment", "bpm", "key_text", "rating", "duration", "bitrate",
    "sample_rate", "channels", "codec", "container",
}
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


def _add_track(session: Session, path: Path, root: Path, ffprobe: Optional[str], now: datetime) -> None:
    record = _read_file_record(path, root, ffprobe)
    track = Track(absolute_path=str(path), last_scanned_at=now, missing=False)
    for k, v in record.items():
        setattr(track, k, v)
    session.add(track)
    session.commit()
    session.refresh(track)
    reindex_track(session, track.id)


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
        record = _read_file_record(path, root, ffprobe)
        _apply_columns(existing, record, _FILE_COLUMNS)
        session.add(existing)
        session.commit()
        session.refresh(existing)
        reindex_track(session, existing.id)
        return "updated"
    # File is byte-identical — only re-derive the tag columns (no
    # re-hash / re-stat) to pick up improved metadata cleaning.
    record = _read_embedded_record(path, root)
    changed = _apply_columns(existing, record, _EMBEDDED_COLUMNS)
    session.add(existing)
    session.commit()
    if not changed:
        return "unchanged"
    session.refresh(existing)
    reindex_track(session, existing.id)
    return "updated"


def _mark_missing(
    session: Session, mode: str, roots: list[Path], safe_roots: list[Path], seen_paths: set[str],
) -> int:
    """Flag rows under the scanned roots not seen this pass; returns the count."""
    root_prefixes = [str(r) for r in roots]
    if not ((mode == "delta" and safe_roots) or (mode == "full" and root_prefixes and seen_paths)):
        return 0
    missing = 0
    candidates = session.exec(select(Track).where(Track.missing == False)).all()  # noqa: E712
    for tr in candidates:
        if tr.absolute_path in seen_paths:
            continue
        in_scope = any(Path(tr.absolute_path).is_relative_to(r) for r in safe_roots) if mode == "delta" else any(tr.absolute_path.startswith(pref) for pref in root_prefixes)
        if in_scope:
            tr.missing = True
            session.add(tr)
            missing += 1
    session.commit()
    return missing


def scan(
    session: Session,
    roots: list[Path],
    ffprobe: Optional[str] = None,
    job: Optional[Job] = None,
    mode: str = "full",
) -> dict:
    stats = {"scanned": 0, "added": 0, "updated": 0, "unchanged": 0, "missing": 0}
    if mode not in {"full", "delta"}:
        raise ValueError("Unknown scan mode")
    complete: list[Path] = []
    warnings: list[str] = []
    existing_by_path = {t.absolute_path: t for t in session.exec(select(Track)).all()} if mode == "delta" else {}
    iterator = _iter_delta_audio(roots, complete, warnings) if mode == "delta" else _iter_audio(roots)
    seen_paths: set[str] = set()
    failed_roots: set[Path] = set()
    now = datetime.now(UTC)

    for root, path in iterator:
        abspath = str(path)
        seen_paths.add(abspath)
        stats["scanned"] += 1

        existing = existing_by_path.get(abspath) if mode == "delta" else session.exec(
            select(Track).where(Track.absolute_path == abspath)
        ).first()

        try:
            st = path.stat()
        except OSError:
            failed_roots.add(root)
            warnings.append(f"{root}: file access failed; missing-file detection skipped")
            continue

        if existing is None:
            _add_track(session, path, root, ffprobe, now)
            stats["added"] += 1
        else:
            unchanged = (
                existing.file_size == st.st_size
                and existing.modified_time == st.st_mtime
                and not existing.missing
            )
            if unchanged and mode == "delta":
                stats["unchanged"] += 1
                if job is not None and stats["scanned"] % 100 == 0:
                    _record_progress(session, job, stats["scanned"])
                continue
            stats[_refresh_track(session, existing, st, path, root, ffprobe, now, unchanged)] += 1

        if job is not None:
            _record_progress(session, job, stats["scanned"])

    # mark missing: rows under the scanned roots not seen this pass
    safe_roots = [r for r in complete if r not in failed_roots]
    stats["missing"] += _mark_missing(session, mode, roots, safe_roots, seen_paths)

    if job is not None:
        _record_progress(session, job, stats["scanned"])
    if mode == "delta":
        stats["warnings"] = warnings
    return stats
