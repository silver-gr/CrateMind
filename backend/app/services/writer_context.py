"""Stopped CLI writers share the service's active paths and OS ownership lease."""
from __future__ import annotations

import os
from collections.abc import Callable, Iterator
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass
from functools import wraps
from pathlib import Path
from typing import ParamSpec, TypeVar

from .active_dataset import reject_retired_source, resolve_active_dataset
from .dataset_access import DatasetLease, maintenance_coordinator

P = ParamSpec("P")
T = TypeVar("T")


@dataclass(frozen=True)
class ScriptDataset:
    catalog: Path
    identity: Path | None
    dataset_root: Path | None


def script_dataset(explicit_catalog: Path | str | None = None) -> ScriptDataset:
    from ..config import get_settings
    from .identity_library import database_path

    settings = get_settings()
    dataset_root = settings.dataset_root
    if dataset_root:
        overrides = {key: os.environ.get(key) for key in ("CRATEMIND_DB_PATH", "CRATEMIND_IDENTITY_DB_PATH")}
        if explicit_catalog is not None:
            overrides["catalog_path"] = str(explicit_catalog)
        selected = resolve_active_dataset(dataset_root, overrides)
        return ScriptDataset(selected.catalog_path, selected.identity_path, selected.dataset_root)
    catalog = Path(explicit_catalog).expanduser().resolve() if explicit_catalog is not None else settings.db_file
    reject_retired_source(catalog)
    partner = database_path(catalog)
    reject_retired_source(partner)
    return ScriptDataset(catalog, partner if partner.exists() else None, None)


def catalog_path(explicit: Path | str | None = None) -> Path:
    return script_dataset(explicit).catalog


def identity_path() -> Path:
    dataset = script_dataset()
    if dataset.identity is None:
        if dataset.dataset_root is not None:
            raise ValueError("Η ενεργή βιβλιοθήκη δεν διαθέτει βάση identity. Χρησιμοποιήστε χωριστό preview.")
        # Preserve the initial unenrolled builder's ability to create its first
        # sibling, while enrollment's explicit absent partner remains absent.
        return dataset.catalog.with_name("identity.sqlite")
    return dataset.identity


@contextmanager
def writer_context(owner: str = "reconciliation") -> Iterator[ScriptDataset]:
    paths = script_dataset()
    lease = DatasetLease.acquire(paths.dataset_root, owner) if paths.dataset_root else nullcontext()
    with lease, maintenance_coordinator.operation(owner):
        if paths.dataset_root:
            # Recover while stopped and under the same lease before admitting
            # the CLI writer. Scripts never select stale pre-import settings.
            from ..library_exchange.operations import recover_exchange_intent
            recover_exchange_intent(paths.dataset_root)
            paths = script_dataset()
        yield paths


def dataset_writer(function: Callable[P, T]) -> Callable[P, T]:
    @wraps(function)
    def guarded(*args: P.args, **kwargs: P.kwargs) -> T:
        with writer_context(function.__module__):
            return function(*args, **kwargs)
    return guarded


def reject_legacy_script(script_path: Path | str) -> None:
    """Archived, path-bound experiments cannot access an enrolled library.

    These one-off scripts retain their original reviewed data/file algorithms.
    Running them against an enrolled generation requires a separately reviewed
    explicit-path adapter; unsetting an environment variable cannot bypass a
    retirement marker on the old source.
    """
    from ..config import get_settings

    if get_settings().dataset_root:
        raise RuntimeError("Το παλιό βοηθητικό script δεν υποστηρίζει ενεργές βιβλιοθήκες. Χρησιμοποιήστε ιδιωτικό αντίγραφο.")
    repository = next(parent for parent in Path(script_path).resolve().parents if (parent / "backend/app").is_dir())
    for name in ("cratemind.sqlite", "identity.sqlite", "catalog.sqlite"):
        reject_retired_source(repository / "backend/data" / name)
