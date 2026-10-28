"""Dataset ownership tests use generated directories and short-lived processes."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from app.services.active_dataset import (
    DatasetConfigurationError,
    reject_retired_source,
    resolve_active_dataset,
    retired_source_marker,
)
from app.services.dataset_access import (
    DatasetBusyError,
    DatasetLease,
    MaintenanceBusyError,
    MaintenanceCoordinator,
)


@pytest.fixture
def dataset(tmp_path):
    generation = tmp_path / "datasets" / "g1"
    generation.mkdir(parents=True)
    (generation / "catalog.sqlite").touch()
    (generation / "identity.sqlite").touch()
    (tmp_path / "active.json").write_text(json.dumps({"version": 1, "generation": "g1", "identity": "identity.sqlite"}))
    return tmp_path


def test_resolver_exact_pair_and_matching_overrides(dataset):
    selected = resolve_active_dataset(dataset)
    assert selected.catalog_path == dataset / "datasets/g1/catalog.sqlite"
    assert selected.identity_path == dataset / "datasets/g1/identity.sqlite"
    assert selected.cache_path == dataset / "datasets/g1/cache"
    assert resolve_active_dataset(dataset, {"db_path": selected.catalog_path}) == selected
    with pytest.raises(DatasetConfigurationError):
        resolve_active_dataset(dataset, {"CRATEMIND_IDENTITY_DB_PATH": dataset / "other.sqlite"})


def test_optional_identity_never_discovers_stale_sibling(dataset):
    (dataset / "active.json").write_text(json.dumps({"generation": "g1", "identity": None}))
    assert resolve_active_dataset(dataset).identity_path is None
    with pytest.raises(DatasetConfigurationError):
        resolve_active_dataset(dataset, {"identity_db_path": dataset / "datasets/g1/identity.sqlite"})


@pytest.mark.parametrize("pointer", [
    {"generation": "../outside"}, {"generation": "/outside"},
    {"generation": "g1", "catalog": "../catalog.sqlite"},
    {"generation": "g1", "identity": "missing.sqlite"},
    {"generation": "g1", "identity": "catalog.sqlite"},
    {"generation": "g1", "catalog": "C:\\catalog.sqlite"},
    {"version": 2, "generation": "g1"}, [],
])
def test_resolver_rejects_invalid_pointers(dataset, pointer):
    (dataset / "active.json").write_text(json.dumps(pointer))
    with pytest.raises(DatasetConfigurationError):
        resolve_active_dataset(dataset)


def test_resolver_rejects_symlink_escape(dataset, tmp_path):
    outside = tmp_path / "outside.sqlite"
    outside.touch()
    catalog = dataset / "datasets/g1/catalog.sqlite"
    catalog.unlink()
    catalog.symlink_to(outside)
    with pytest.raises(DatasetConfigurationError):
        resolve_active_dataset(dataset)


def test_retired_original_refused_without_reading_marker_contents(tmp_path):
    original = tmp_path / "catalog.sqlite"
    reject_retired_source(original)
    retired_source_marker(original).write_text('{"dataset_root":"somewhere"}')
    with pytest.raises(DatasetConfigurationError, match="CRATEMIND_DATASET_ROOT"):
        reject_retired_source(original)


def test_lease_excludes_an_idle_service_and_releases_after_process_death(tmp_path):
    source = """
import sys,time
from app.services.dataset_access import DatasetLease
lease=DatasetLease.acquire(sys.argv[1], 'fixture-service')
print('held',flush=True)
time.sleep(60)
"""
    environment = dict(os.environ, PYTHONPATH=str(Path(__file__).resolve().parents[1]))
    process = subprocess.Popen([sys.executable, "-c", source, str(tmp_path)], stdout=subprocess.PIPE,
                               text=True, env=environment)
    try:
        assert process.stdout.readline().strip() == "held"
        with pytest.raises(DatasetBusyError):
            DatasetLease.acquire(tmp_path, "stopped-cli")
        process.kill()
        process.wait(timeout=5)
        with DatasetLease.acquire(tmp_path, "stopped-cli"), pytest.raises(DatasetBusyError):
            DatasetLease.acquire(tmp_path, "second-cli")
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        process.stdout.close()
    with DatasetLease.acquire(tmp_path, "next-service"):
        pass


def test_maintenance_drains_entire_catalog_identity_scope_and_nested_services():
    coordinator = MaintenanceCoordinator()
    catalog_committed = threading.Event()
    finish_identity = threading.Event()
    identity_finished = threading.Event()
    maintenance_entered = threading.Event()

    def mutate():
        with coordinator.operation("scan"):
            catalog_committed.set()
            assert finish_identity.wait(3)
            with coordinator.operation("identity-sync"):
                identity_finished.set()

    def maintain():
        with coordinator.enter_maintenance(3):
            assert identity_finished.is_set()
            maintenance_entered.set()
            with pytest.raises(MaintenanceBusyError), coordinator.operation("new-cue"):
                pass

    writer = threading.Thread(target=mutate)
    writer.start()
    assert catalog_committed.wait(3)
    maintainer = threading.Thread(target=maintain)
    maintainer.start()
    deadline = time.monotonic() + 3
    while not coordinator.maintenance_active and time.monotonic() < deadline:
        time.sleep(.001)
    assert coordinator.maintenance_active
    assert not maintenance_entered.is_set()
    finish_identity.set()
    writer.join(3)
    maintainer.join(3)
    assert not writer.is_alive() and not maintainer.is_alive()
    assert maintenance_entered.is_set()
    assert coordinator.active_operations == ()


def test_background_reservation_survives_submission_gap_and_allows_nested_sync():
    coordinator = MaintenanceCoordinator()
    with coordinator.operation("request"):
        reservation = coordinator.start_operation("background-scan")
    with pytest.raises(MaintenanceBusyError):
        coordinator.enter_maintenance(0)
    completed = threading.Event()

    def execute():
        with reservation, coordinator.operation("final-identity-sync"):
            completed.set()

    thread = threading.Thread(target=execute)
    thread.start()
    thread.join(3)
    assert completed.is_set()
    with coordinator.enter_maintenance(0):
        assert coordinator.active_operations == ()
    reservation.close()  # idempotent, including cross-thread finalization


def test_timeout_reopens_admission_and_reentrant_maintenance_releases_once():
    coordinator = MaintenanceCoordinator()
    reservation = coordinator.start_operation("paused")
    with pytest.raises(MaintenanceBusyError):
        coordinator.enter_maintenance(.001)
    with coordinator.operation("new-request"):
        pass
    reservation.close()
    with coordinator.enter_maintenance(0):
        with coordinator.enter_maintenance(0):
            assert coordinator.maintenance_active
        assert coordinator.maintenance_active
    assert not coordinator.maintenance_active
    with coordinator.operation("caller"), pytest.raises(MaintenanceBusyError):
        coordinator.enter_maintenance(0)


def test_operation_exception_releases_admission():
    coordinator = MaintenanceCoordinator()
    with pytest.raises(RuntimeError), coordinator.operation("failed"):
        raise RuntimeError("expected")
    with coordinator.enter_maintenance(0):
        pass
