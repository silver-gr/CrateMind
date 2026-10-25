"""Coherent application backups and compatible v2 metadata exports.

A complete backup is a directory containing manifest.json, catalog.sqlite and,
when installed, identity.sqlite. Restore only to an empty isolated directory.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
from contextlib import ExitStack, closing, contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlmodel import Session, create_engine, select

from ..models import (
    ArtistProfile,
    DJSet,
    PlayEvent,
    SetTrack,
    Tag,
    Track,
    TrackDJProfile,
    TrackPairNote,
    TrackTag,
)


def _dump(rows: list[Any]) -> list[dict]:
    return [r.model_dump(mode="json") for r in rows]


def _export_metadata(session: Session) -> dict:
    return {
        "exported_at": datetime.now(UTC).isoformat(),
        "version": 2,
        "tracks": _dump(session.exec(select(Track)).all()),
        "artist_profiles": _dump(session.exec(select(ArtistProfile)).all()),
        "profiles": _dump(session.exec(select(TrackDJProfile)).all()),
        "tags": _dump(session.exec(select(Tag)).all()),
        "track_tags": _dump(session.exec(select(TrackTag)).all()),
        "sets": _dump(session.exec(select(DJSet)).all()),
        "set_tracks": _dump(session.exec(select(SetTrack)).all()),
        "pair_notes": _dump(session.exec(select(TrackPairNote)).all()),
        "play_events": _dump(session.exec(select(PlayEvent)).all()),
    }

_AUTO_IDENTITY = object()
_FILES = {"catalog": "catalog.sqlite", "identity": "identity.sqlite"}


def _connect(path: Path, mode: str = "ro") -> sqlite3.Connection:
    return sqlite3.connect(f"{path.resolve().as_uri()}?mode={mode}", uri=True, timeout=30)


def _sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def _integrity(path: Path) -> None:
    with closing(_connect(path)) as connection:
        result = connection.execute("PRAGMA integrity_check").fetchall()
    if result != [("ok",)]:
        raise ValueError(f"SQLite integrity check failed: {path.name}: {result[:3]}")


def _signature(path: Path) -> dict:
    # Capture WAL metadata as well: committed writes may not touch the main file.
    files = []
    for item in (path, Path(str(path) + "-wal")):
        stat = item.stat() if item.exists() else None
        files.append([stat.st_ino, stat.st_size, stat.st_mtime_ns] if stat else None)
    return {"source_token": hashlib.sha256(str(path).encode()).hexdigest(), "files": files}


def _sources(catalog: Path, identity: Path | None | object) -> dict[str, Path]:
    catalog = catalog.expanduser().resolve(strict=True)
    sources = {"catalog": catalog}
    if identity is _AUTO_IDENTITY:
        from .identity_library import database_path

        identity = database_path(catalog)
        required = bool(os.environ.get("CRATEMIND_IDENTITY_DB_PATH"))
    else:
        required = identity is not None
    if identity is not None:
        identity = Path(identity).expanduser().resolve()
        if identity.exists() or required:
            identity = identity.resolve(strict=True)
            if identity == catalog:
                raise ValueError("Catalog and identity must be distinct databases")
            sources["identity"] = identity
    return sources


@contextmanager
def quiesce_writers(catalog_path: Path, *, identity_path=_AUTO_IDENTITY):
    """Reserve both databases in fixed path order; ordinary readers remain usable.

    Use the same boundary for maintenance that must exclude concurrent writers.
    Snapshot readers MUST use separate connections: backing up a connection in
    its own active write transaction can wait forever in sqlite3.backup().
    """
    sources = _sources(Path(catalog_path), identity_path)
    with ExitStack() as stack:
        for path in sorted(sources.values()):
            connection = _connect(path, "rw")
            stack.callback(connection.close)
            connection.execute("BEGIN IMMEDIATE")
            stack.callback(connection.rollback)
        yield sources


def _check_space(directory: Path, byte_count: int) -> None:
    reserve = max(64 * 1024 * 1024, byte_count // 10)
    if shutil.disk_usage(directory).free < byte_count + reserve:
        raise OSError(f"Insufficient free space: need {byte_count + reserve} bytes for backup/restore")


def _fsync(path: Path) -> None:
    with path.open("rb") as stream:
        os.fsync(stream.fileno())


def _sync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _publish(staging: Path, destination: Path) -> None:
    staging.rename(destination)
    _sync_directory(destination.parent)


def verify_backup(bundle: Path) -> dict:
    """Validate fixed filenames, complete SQLite snapshots and SHA-256 checksums."""
    bundle = Path(bundle)
    manifest = json.loads((bundle / "manifest.json").read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("version") != 1:
        raise ValueError("Unsupported backup manifest")
    databases = manifest.get("databases")
    if not isinstance(databases, dict) or set(databases) not in ({"catalog"}, {"catalog", "identity"}):
        raise ValueError("Backup requires catalog and optional identity")
    for name, record in databases.items():
        if not isinstance(record, dict) or record.get("file") != _FILES[name]:
            raise ValueError("Unsafe or unsupported backup filename")
        path = bundle / _FILES[name]
        if path.is_symlink() or not path.is_file():
            raise ValueError("Backup database must be a regular local file")
        if path.stat().st_size != record.get("size") or _sha256(path) != record.get("sha256"):
            raise ValueError(f"Backup checksum mismatch: {name}")
        # A published snapshot must stand alone, without unaccounted WAL data.
        if any(Path(str(path) + suffix).exists() for suffix in ("-wal", "-journal")):
            raise ValueError("Backup contains unaccounted SQLite sidecar data")
        _integrity(path)
    return manifest


def _prune(root: Path, keep: int) -> None:
    complete = []
    for bundle in sorted(root.glob("cratemind-*")):
        if not bundle.is_dir() or bundle.is_symlink():
            continue
        try:
            verify_backup(bundle)
        except (OSError, ValueError, sqlite3.Error):
            continue
        complete.append(bundle)
    for bundle in complete[:-max(1, keep)]:
        shutil.rmtree(bundle)


def create_backup(
    catalog_path: Path, backup_dir: Path, *, identity_path=_AUTO_IDENTITY,
    keep: int | None = 10, reuse: bool = True,
) -> Path:
    """Publish a verified catalog/identity bundle atomically; reuse unchanged state.

    No prior bundle is pruned before successful publication. Explicit identity
    paths must exist; an absent default sibling is the supported legacy mode.
    """
    root = Path(backup_dir).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    with quiesce_writers(catalog_path, identity_path=identity_path) as sources:
        signatures = {name: _signature(path) for name, path in sources.items()}
        previous_bundles = []
        if reuse:
            for previous in sorted(root.glob("cratemind-*"), reverse=True):
                try:
                    manifest = verify_backup(previous)
                except (OSError, ValueError, sqlite3.Error):
                    continue
                if manifest.get("source_signatures") == signatures:
                    return previous
                previous_bundles.append((previous, manifest))
        sizes = []
        for path in sources.values():
            with closing(_connect(path)) as source:
                sizes.append(source.execute("PRAGMA page_count").fetchone()[0]
                             * source.execute("PRAGMA page_size").fetchone()[0])
        _check_space(root, sum(sizes))
        staging = Path(tempfile.mkdtemp(prefix=".cratemind-pending-", dir=root))
        try:
            databases = {}
            for name, path in sources.items():
                target = staging / _FILES[name]
                with closing(_connect(path)) as source, closing(sqlite3.connect(target)) as destination:
                    source.backup(destination)
                    destination.execute("PRAGMA journal_mode=DELETE")
                _integrity(target)
                _fsync(target)
                databases[name] = {"file": target.name, "size": target.stat().st_size,
                                   "sha256": _sha256(target)}
            manifest = {"version": 1, "created_at": datetime.now(UTC).isoformat(),
                        "databases": databases, "source_signatures": signatures,
                        "identity_installed": "identity" in sources}
            manifest_path = staging / "manifest.json"
            manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
            _fsync(manifest_path)
            verify_backup(staging)
            # WAL close/checkpoint/reopen changes file metadata without changing
            # committed content. Compare the coherent standalone snapshots before
            # publishing another large bundle; the stat signature is only a fast
            # path. Both the old bundle and these new snapshots were verified.
            for previous, previous_manifest in previous_bundles:
                if previous_manifest["databases"] == databases:
                    return previous
            _sync_directory(staging)
            stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
            published = root / f"cratemind-{stamp}"
            _publish(staging, published)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    if keep is not None:
        _prune(root, keep)
    return published


def restore_backup(bundle: Path, destination: Path) -> Path:
    """Restore into an empty/new isolated directory. Never replace active files."""
    bundle = Path(bundle).resolve()
    destination = Path(destination).expanduser().absolute()
    if destination.is_symlink() or (destination.exists() and
                                    (not destination.is_dir() or any(destination.iterdir()))):
        raise FileExistsError("Restore destination must be a new or empty directory")
    manifest = verify_backup(bundle)
    destination.parent.mkdir(parents=True, exist_ok=True)
    _check_space(destination.parent, sum(record["size"] for record in manifest["databases"].values()))
    staging = Path(tempfile.mkdtemp(prefix=".cratemind-restore-", dir=destination.parent))
    try:
        for record in manifest["databases"].values():
            shutil.copyfile(bundle / record["file"], staging / record["file"])
            _fsync(staging / record["file"])
        shutil.copyfile(bundle / "manifest.json", staging / "manifest.json")
        _fsync(staging / "manifest.json")
        verify_backup(staging)
        _sync_directory(staging)
        _publish(staging, destination)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return destination


def export_json(session: Session, dest: Path, overwrite: bool = True) -> Path:
    """Export v2 lists plus a relative companion bundle for full application restore.

    The JSON alone remains a metadata export. Identity decisions are restored
    with restore_backup() from the referenced companion directory.
    """
    dest = Path(dest)
    if dest.exists() and not overwrite:
        raise FileExistsError(f"{dest} exists (pass overwrite=true to replace)")
    database = session.get_bind().url.database
    if not database or database == ":memory:":
        raise ValueError("Complete export requires a file-backed catalog")
    root = dest.with_name(dest.name + ".bundles")
    bundle = create_backup(Path(database), root, keep=None)
    engine = create_engine(f"sqlite:///{bundle / 'catalog.sqlite'}")
    try:
        with Session(engine) as snapshot:
            payload = _export_metadata(snapshot)
    finally:
        engine.dispose()
    payload["application_backup"] = {
        "directory": str(bundle.relative_to(dest.parent.resolve())),
        "format": "cratemind-sqlite-bundle-v1",
        "identity_installed": verify_backup(bundle)["identity_installed"],
        "restore": "restore_backup(companion_directory, empty_destination_directory)",
        "note": "Keep the companion directory with this JSON to restore identity decisions.",
    }
    handle, temporary_name = tempfile.mkstemp(prefix=".export-", dir=dest.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, indent=2, default=str)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, dest)
        _sync_directory(dest.parent)
    finally:
        temporary.unlink(missing_ok=True)
    _prune(root, 2)
    return dest


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create")
    create.add_argument("catalog", type=Path)
    create.add_argument("backup_dir", type=Path)
    create.add_argument("--identity", type=Path, default=_AUTO_IDENTITY)
    restore = commands.add_parser("restore")
    restore.add_argument("bundle", type=Path)
    restore.add_argument("destination", type=Path)
    verify = commands.add_parser("verify")
    verify.add_argument("bundle", type=Path)
    args = parser.parse_args()
    if args.command == "create":
        print(create_backup(args.catalog, args.backup_dir, identity_path=args.identity))
    elif args.command == "restore":
        print(restore_backup(args.bundle, args.destination))
    else:
        print(json.dumps(verify_backup(args.bundle), indent=2))


if __name__ == "__main__":
    main()
