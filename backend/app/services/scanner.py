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

from datetime import UTC, datetime
from pathlib import Path
from typing import Optional

from sqlmodel import Session, select

from ..db import reindex_track
from ..models import Job, Track
from .artist_normalizer import normalize_primary_artist_name
from . import ffprobe_reader, hashing, metadata_reader

AUDIO_EXTS = {".mp3", ".flac", ".wav", ".aif", ".aiff", ".m4a", ".mp4", ".ogg", ".opus"}


def _iter_audio(roots: list[Path]):
    seen_dirs: set[str] = set()
    for root in roots:
        if not root.exists():
            continue
        for p in root.rglob("*"):
            try:
                if not p.is_file():
                    continue
            except OSError:
                continue
            # guard against symlink directory loops
            try:
                real = str(p.resolve())
            except OSError:
                real = str(p)
            if real in seen_dirs:
                continue
            seen_dirs.add(real)
            if p.suffix.lower() in AUDIO_EXTS:
                yield root, p


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


def scan(
    session: Session,
    roots: list[Path],
    ffprobe: Optional[str] = None,
    job: Optional[Job] = None,
) -> dict:
    stats = {"scanned": 0, "added": 0, "updated": 0, "unchanged": 0, "missing": 0}
    seen_paths: set[str] = set()
    now = datetime.now(UTC)

    for root, path in _iter_audio(roots):
        abspath = str(path)
        seen_paths.add(abspath)
        stats["scanned"] += 1

        existing = session.exec(
            select(Track).where(Track.absolute_path == abspath)
        ).first()

        try:
            st = path.stat()
        except OSError:
            continue

        if existing is None:
            record = _read_file_record(path, root, ffprobe)
            track = Track(absolute_path=abspath, last_scanned_at=now, missing=False)
            for k, v in record.items():
                setattr(track, k, v)
            session.add(track)
            session.commit()
            session.refresh(track)
            reindex_track(session, track.id)
            stats["added"] += 1
        else:
            unchanged = (
                existing.file_size == st.st_size
                and existing.modified_time == st.st_mtime
                and not existing.missing
            )
            existing.last_scanned_at = now
            existing.missing = False
            # Backfill created_time for rows imported before it was tracked
            # (cheap — st is already in hand, no full file re-read).
            if existing.created_time is None:
                existing.created_time = _birthtime(st)
            if unchanged:
                # File is byte-identical — only re-derive the tag columns (no
                # re-hash / re-stat) to pick up improved metadata cleaning.
                record = _read_embedded_record(path, root)
                changed = _apply_columns(existing, record, _EMBEDDED_COLUMNS)
                session.add(existing)
                session.commit()
                if changed:
                    session.refresh(existing)
                    reindex_track(session, existing.id)
                    stats["updated"] += 1
                else:
                    stats["unchanged"] += 1
            else:
                record = _read_file_record(path, root, ffprobe)
                _apply_columns(existing, record, _FILE_COLUMNS)
                session.add(existing)
                session.commit()
                session.refresh(existing)
                reindex_track(session, existing.id)
                stats["updated"] += 1

        if job is not None:
            job.processed = stats["scanned"]
            session.add(job)
            session.commit()

    # mark missing: rows under the scanned roots not seen this pass
    root_prefixes = [str(r) for r in roots]
    if root_prefixes and seen_paths:
        candidates = session.exec(select(Track).where(Track.missing == False)).all()  # noqa: E712
        for tr in candidates:
            if tr.absolute_path in seen_paths:
                continue
            if any(tr.absolute_path.startswith(pref) for pref in root_prefixes):
                tr.missing = True
                session.add(tr)
                stats["missing"] += 1
        session.commit()

    return stats
