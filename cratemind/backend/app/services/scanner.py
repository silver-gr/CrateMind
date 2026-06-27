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

from datetime import datetime
from pathlib import Path
from typing import Optional

from sqlalchemy import text
from sqlmodel import Session, select

from ..db import reindex_track
from ..models import Job, Track
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
                yield p


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


def _read_file_record(path: Path, ffprobe: Optional[str]) -> dict:
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
    record.update(metadata_reader.read_tags(path))
    record.update(ffprobe_reader.read_stream(path, ffprobe))
    return record


# embedded/file-derived columns the scanner is allowed to refresh
_FILE_COLUMNS = {
    "file_name", "extension", "file_size", "modified_time", "created_time", "normalized_path",
    "volume_root", "quick_hash", "artist", "title", "album", "label", "year",
    "genre", "comment", "bpm", "key_text", "rating", "duration", "bitrate",
    "sample_rate", "channels", "codec", "container",
}


def scan(
    session: Session,
    roots: list[Path],
    ffprobe: Optional[str] = None,
    job: Optional[Job] = None,
) -> dict:
    stats = {"scanned": 0, "added": 0, "updated": 0, "unchanged": 0, "missing": 0}
    seen_paths: set[str] = set()
    now = datetime.utcnow()

    for path in _iter_audio(roots):
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
            record = _read_file_record(path, ffprobe)
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
                session.add(existing)
                session.commit()
                stats["unchanged"] += 1
            else:
                record = _read_file_record(path, ffprobe)
                for k in _FILE_COLUMNS:
                    if k in record:
                        setattr(existing, k, record[k])
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
