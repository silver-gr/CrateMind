"""Device-local mounts over stable catalog paths; never rewrites shared state."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Literal


class PathResolutionError(OSError):
    def __init__(self, path: str, state: str):
        self.logical_path = str(path)
        self.state = state
        super().__init__(f"Μη διαθέσιμη διαδρομή ({state}): {path}")


@dataclass(frozen=True)
class LibraryRootMapping:
    root_key: str
    logical_prefix: str
    logical_flavor: Literal["posix", "windows"]
    local_prefix: str | None = None
    enabled: bool = True


def _logical(value: str, flavor: str):
    path = (PureWindowsPath if flavor == "windows" else PurePosixPath)(value)
    if not path.is_absolute() or ".." in path.parts or "\x00" in value:
        raise ValueError(f"Μη έγκυρη απόλυτη διαδρομή {flavor}: {value}")
    return path


def _local(value: str | Path) -> Path:
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts or "\x00" in str(value):
        raise ValueError(f"Μη έγκυρη απόλυτη διαδρομή συσκευής: {value}")
    return path


def parse_mappings(data: dict) -> tuple[LibraryRootMapping, ...]:
    """Validate config structure and reject aliases, nested roots and ambiguity."""
    if not isinstance(data, dict) or type(data.get("version", 1)) is not int or data.get("version", 1) != 1:
        raise ValueError("Μη υποστηριζόμενη έκδοση αντιστοίχισης φακέλων.")
    rows = data.get("library_roots", [])
    if not isinstance(rows, list):
        raise ValueError("Το library_roots πρέπει να είναι λίστα.")  # noqa: TRY004
    mappings = []
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Μη έγκυρη αντιστοίχιση φακέλου.")  # noqa: TRY004
        try:
            mapping = LibraryRootMapping(**row)
        except TypeError as error:
            raise ValueError("Λείπουν ή δεν αναγνωρίζονται πεδία αντιστοίχισης φακέλου.") from error
        if not isinstance(mapping.root_key, str) or not mapping.root_key.strip():
            raise ValueError("Απαιτείται σταθερό root_key.")
        if mapping.logical_flavor not in {"posix", "windows"}:
            raise ValueError("Το logical_flavor πρέπει να είναι posix ή windows.")
        if not isinstance(mapping.logical_prefix, str) or type(mapping.enabled) is not bool:
            raise ValueError("Μη έγκυρη τιμή διαδρομής ή enabled.")
        if mapping.local_prefix is not None and not isinstance(mapping.local_prefix, str):
            raise ValueError("Μη έγκυρη τοπική διαδρομή.")
        logical = _logical(mapping.logical_prefix, mapping.logical_flavor)
        local = _local(mapping.local_prefix) if mapping.local_prefix is not None else None
        for other in mappings:
            other_logical = _logical(other.logical_prefix, other.logical_flavor)
            if mapping.root_key == other.root_key:
                raise ValueError("Το root_key χρησιμοποιείται ήδη.")
            if mapping.logical_flavor == other.logical_flavor and (
                logical.is_relative_to(other_logical) or other_logical.is_relative_to(logical)
            ):
                raise ValueError("Οι λογικοί φάκελοι βιβλιοθήκης επικαλύπτονται.")
            if local is not None and other.local_prefix is not None:
                other_local = _local(other.local_prefix)
                a, b = local.resolve(), other_local.resolve()
                if a.is_relative_to(b) or b.is_relative_to(a):
                    raise ValueError("Οι τοπικοί φάκελοι βιβλιοθήκης επικαλύπτονται.")
        mappings.append(mapping)
    return tuple(mappings)


@lru_cache
def _read_mappings(path: str) -> tuple[LibraryRootMapping, ...]:
    source = Path(path).expanduser()
    if not source.is_file():
        return ()
    return parse_mappings(json.loads(source.read_text(encoding="utf-8")))


def load_path_mappings(settings=None) -> tuple[LibraryRootMapping, ...]:
    if settings is None:
        from ..config import get_settings

        settings = get_settings()
    if not settings.path_mappings_file:
        return ()
    mappings = _read_mappings(settings.path_mappings_file)
    if settings.dataset_root:
        from .active_dataset import resolve_active_dataset
        active = resolve_active_dataset(settings.dataset_root)
        state = json.loads(active.exchange_state_path.read_text(encoding="utf-8"))
        return reconcile_mappings(mappings, state["logical_roots"])
    return mappings


def reconcile_mappings(mappings, logical_roots: list[dict]) -> tuple[LibraryRootMapping, ...]:
    """A new generation may reuse path spelling without sharing root identity.

    Only an exact root identity AND logical descriptor retains a device binding.
    Unrelated/stale bindings never control playback or block opening Settings.
    """
    resolved = []
    for descriptor in logical_roots:
        match = next((mapping for mapping in mappings if all(
            getattr(mapping, key) == descriptor[key]
            for key in ("root_key", "logical_prefix", "logical_flavor"))), None)
        resolved.append(match or LibraryRootMapping(**descriptor))
    from dataclasses import asdict
    return parse_mappings({"version": 1, "library_roots": [asdict(item) for item in resolved]})


def mapping_context(mappings=None):
    if mappings is not None:
        return tuple(mappings), True
    from ..config import get_settings

    settings = get_settings()
    return load_path_mappings(settings), bool(settings.path_mappings_file or settings.dataset_root)


def _connected(mapping: LibraryRootMapping) -> Path:
    if not mapping.enabled:
        raise PathResolutionError(mapping.logical_prefix, "disabled")
    if mapping.local_prefix is None:
        raise PathResolutionError(mapping.logical_prefix, "unmapped")
    root = _local(mapping.local_prefix)
    if not root.is_dir():
        raise PathResolutionError(mapping.logical_prefix, "disconnected")
    if len(root.parts) >= 3 and root.parts[1] == "Volumes":
        volume = Path(*root.parts[:3])
        if not os.path.ismount(volume):
            raise PathResolutionError(mapping.logical_prefix, "disconnected")
    return root


def _contained(path: Path, root: Path) -> Path:
    if not path.resolve().is_relative_to(root.resolve()):
        raise PathResolutionError(str(path), "outside_root")
    return path


def resolve_source_path(logical_path: str, mappings=None) -> Path:
    mappings, strict = mapping_context(mappings)
    if not strict:
        # Existing unenrolled web installations retain their native path behavior.
        return Path(logical_path)
    for mapping in mappings:
        try:
            source = _logical(str(logical_path), mapping.logical_flavor)
        except ValueError:
            continue
        prefix = _logical(mapping.logical_prefix, mapping.logical_flavor)
        if source.is_relative_to(prefix):
            root = _connected(mapping)
            target = root
            for part in source.relative_to(prefix).parts:
                candidate = target / part
                # A Windows source remains case-insensitive on a POSIX replica.
                # Only accept a unique component match; never guess among twins.
                if mapping.logical_flavor == "windows" and not candidate.exists() and target.is_dir():
                    matches = [entry for entry in target.iterdir() if entry.name.casefold() == part.casefold()]
                    if len(matches) > 1:
                        raise PathResolutionError(str(logical_path), "ambiguous_case")
                    if matches:
                        candidate = matches[0]
                target = _contained(candidate, root)
            return target
    raise PathResolutionError(str(logical_path), "unmapped")


def source_path_key(logical_path: str, mappings=None) -> tuple[str, str]:
    """Lookup key only; the stored spelling/identity is never rewritten."""
    mappings, _ = mapping_context(mappings)
    for mapping in mappings:
        try:
            path = _logical(logical_path, mapping.logical_flavor)
        except ValueError:
            continue
        if path.is_relative_to(_logical(mapping.logical_prefix, mapping.logical_flavor)):
            return (mapping.logical_flavor, str(path).casefold()
                    if mapping.logical_flavor == "windows" else str(path))
    return "native", logical_path


def logical_source_path(local_path: Path | str, mappings=None) -> str:
    mappings, strict = mapping_context(mappings)
    path = _local(local_path)
    if not strict:
        return str(path)
    for mapping in mappings:
        if mapping.local_prefix is None:
            continue
        root = _local(mapping.local_prefix)
        if path.is_relative_to(root):
            _contained(path, _connected(mapping))
            prefix = _logical(mapping.logical_prefix, mapping.logical_flavor)
            return str(prefix.joinpath(*path.relative_to(root).parts))
    raise PathResolutionError(str(path), "unmapped")


def resolve_media_path(path: Path | str) -> Path:
    """Tool readers accept logical inputs or already-resolved, confined scan paths."""
    mappings, strict = mapping_context()
    if not strict:
        return Path(path)
    try:
        return resolve_source_path(str(path), mappings)
    except PathResolutionError as error:
        if error.state != "unmapped":
            raise
    # A scanner passes native paths to shared metadata/hash/tool readers. Validate
    # them against the same roots before allowing an already-resolved path.
    logical = logical_source_path(path, mappings)
    return resolve_source_path(logical, mappings)


def logical_root_for_path(local_path: Path | str, mappings=None) -> str:
    mappings, strict = mapping_context(mappings)
    path = _local(local_path)
    if strict:
        for mapping in mappings:
            if mapping.local_prefix is not None and path.is_relative_to(_local(mapping.local_prefix)):
                _contained(path, _connected(mapping))
                return mapping.logical_prefix
        raise PathResolutionError(str(path), "unmapped")
    if len(path.parts) >= 3 and path.parts[1] == "Volumes":
        return str(Path(*path.parts[:3]))
    return path.anchor


def connected_library_roots(settings=None) -> list[Path]:
    roots = []
    for mapping in load_path_mappings(settings):
        try:
            roots.append(_connected(mapping))
        except PathResolutionError:
            pass
    return roots
