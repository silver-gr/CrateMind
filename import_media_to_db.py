#!/usr/bin/env python3

import argparse
import concurrent.futures
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


DEFAULT_MEDIA_ROOT = Path("/Users/silver/Projects/Music-ReORG/Media")
DEFAULT_DB_PATH = Path("/Users/silver/Projects/Music-ReORG/media_catalog.sqlite")
AUDIO_EXTENSIONS = {"mp3", "m4a", "wav", "flac", "aac", "aiff", "alac", "ogg", "opus"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Index all files under a media directory into a SQLite database."
    )
    parser.add_argument(
        "--media-root",
        type=Path,
        default=DEFAULT_MEDIA_ROOT,
        help=f"Directory to scan (default: {DEFAULT_MEDIA_ROOT})",
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB_PATH,
        help=f"SQLite database path (default: {DEFAULT_DB_PATH})",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=max(4, (os.cpu_count() or 4)),
        help="Number of concurrent ffprobe workers",
    )
    return parser.parse_args()


def create_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;

        CREATE TABLE IF NOT EXISTS media_files (
            id INTEGER PRIMARY KEY,
            relative_path TEXT NOT NULL UNIQUE,
            absolute_path TEXT NOT NULL,
            file_name TEXT NOT NULL,
            parent_dir TEXT NOT NULL,
            extension TEXT,
            size_bytes INTEGER NOT NULL,
            mtime_epoch REAL NOT NULL,
            ctime_epoch REAL NOT NULL,
            imported_at_epoch REAL NOT NULL,
            ffprobe_ok INTEGER NOT NULL DEFAULT 0,
            probe_error TEXT,
            container_format TEXT,
            codec_name TEXT,
            duration_seconds REAL,
            bit_rate INTEGER,
            sample_rate INTEGER,
            channels INTEGER,
            title TEXT,
            artist TEXT,
            album TEXT,
            album_artist TEXT,
            genre TEXT,
            track TEXT,
            date TEXT,
            tags_json TEXT,
            bpm_estimate REAL,
            bpm_confidence REAL,
            bpm_method TEXT,
            bpm_analyzed_at_epoch REAL,
            bpm_error TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_media_files_extension
            ON media_files (extension);
        CREATE INDEX IF NOT EXISTS idx_media_files_artist
            ON media_files (artist);
        CREATE INDEX IF NOT EXISTS idx_media_files_album
            ON media_files (album);
        CREATE INDEX IF NOT EXISTS idx_media_files_duration
            ON media_files (duration_seconds);
        """
    )


def iter_files(media_root: Path) -> list[Path]:
    files: list[Path] = []
    for root, _, filenames in os.walk(media_root, followlinks=True):
        for name in filenames:
            files.append(Path(root) / name)
    files.sort()
    return files


def run_ffprobe(path: Path) -> tuple[bool, dict[str, Any] | None, str | None]:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    try:
        completed = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        return False, None, "ffprobe not found"

    if completed.returncode != 0:
        error = (completed.stderr or completed.stdout or "").strip() or "ffprobe failed"
        return False, None, error

    try:
        return True, json.loads(completed.stdout), None
    except json.JSONDecodeError as exc:
        return False, None, f"invalid ffprobe json: {exc}"


def first_audio_stream(payload: dict[str, Any] | None) -> dict[str, Any] | None:
    if not payload:
        return None
    for stream in payload.get("streams", []):
        if stream.get("codec_type") == "audio":
            return stream
    return None


def normalize_int(value: Any) -> int | None:
    if value in (None, "", "N/A"):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def normalize_float(value: Any) -> float | None:
    if value in (None, "", "N/A"):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def merged_tags(payload: dict[str, Any] | None, audio_stream: dict[str, Any] | None) -> dict[str, Any]:
    tags: dict[str, Any] = {}
    if payload:
        tags.update(payload.get("format", {}).get("tags", {}) or {})
    if audio_stream:
        for key, value in (audio_stream.get("tags", {}) or {}).items():
            tags.setdefault(key, value)
    return tags


def tag_value(tags: dict[str, Any], *names: str) -> str | None:
    lowered = {str(k).lower(): v for k, v in tags.items()}
    for name in names:
        value = lowered.get(name.lower())
        if value not in (None, ""):
            return str(value)
    return None


def inspect_file(media_root: Path, path: Path) -> tuple[Any, ...]:
    stat_result = path.stat()
    ok, payload, error = run_ffprobe(path)
    audio_stream = first_audio_stream(payload)
    tags = merged_tags(payload, audio_stream)
    fmt = (payload or {}).get("format", {})

    return (
        str(path.relative_to(media_root)),
        str(path.resolve()),
        path.name,
        str(path.parent.relative_to(media_root)),
        path.suffix.lower().lstrip(".") or None,
        stat_result.st_size,
        stat_result.st_mtime,
        stat_result.st_ctime,
        time.time(),
        1 if ok else 0,
        error,
        fmt.get("format_name"),
        (audio_stream or {}).get("codec_name"),
        normalize_float(fmt.get("duration") or (audio_stream or {}).get("duration")),
        normalize_int(fmt.get("bit_rate") or (audio_stream or {}).get("bit_rate")),
        normalize_int((audio_stream or {}).get("sample_rate")),
        normalize_int((audio_stream or {}).get("channels")),
        tag_value(tags, "title"),
        tag_value(tags, "artist"),
        tag_value(tags, "album"),
        tag_value(tags, "album_artist", "albumartist"),
        tag_value(tags, "genre"),
        tag_value(tags, "track", "tracknumber"),
        tag_value(tags, "date", "year"),
        json.dumps(tags, ensure_ascii=False, sort_keys=True) if tags else None,
    )


def is_track_file(path: Path) -> bool:
    return path.suffix.lower().lstrip(".") in AUDIO_EXTENSIONS


def import_media(media_root: Path, db_path: Path, workers: int) -> int:
    files = [path for path in iter_files(media_root) if is_track_file(path)]
    if not files:
        return 0

    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        create_schema(conn)
        conn.execute("DELETE FROM media_files")
        insert_sql = """
            INSERT INTO media_files (
                relative_path,
                absolute_path,
                file_name,
                parent_dir,
                extension,
                size_bytes,
                mtime_epoch,
                ctime_epoch,
                imported_at_epoch,
                ffprobe_ok,
                probe_error,
                container_format,
                codec_name,
                duration_seconds,
                bit_rate,
                sample_rate,
                channels,
                title,
                artist,
                album,
                album_artist,
                genre,
                track,
                date,
                tags_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """

        with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
            rows = executor.map(lambda p: inspect_file(media_root, p), files, chunksize=25)
            conn.executemany(insert_sql, rows)
        conn.commit()
    finally:
        conn.close()

    return len(files)


def main() -> int:
    args = parse_args()
    media_root = args.media_root.resolve()
    db_path = args.db.resolve()

    if not media_root.exists():
        print(f"Media root not found: {media_root}", file=sys.stderr)
        return 1

    count = import_media(media_root, db_path, args.workers)
    print(f"Imported {count} files into {db_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
