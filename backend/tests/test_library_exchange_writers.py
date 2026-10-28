"""Writer integration probes run only against generated datasets; legacy scripts are not run."""
from __future__ import annotations

import ast
import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from app.library_exchange.operations import enroll, initialize_empty
from app.services.active_dataset import retired_source_marker
from app.services.dataset_access import DatasetBusyError, DatasetLease
from app.services.schema_contract import canonical_database_values, load_schema_contract
from app.services.writer_context import (
    catalog_path,
    dataset_writer,
    identity_path,
    reject_legacy_script,
    script_dataset,
)

ROOT = Path(__file__).resolve().parents[2]
INVENTORY = ROOT / "backend/app/library_exchange/writer_inventory.json"


def settings(monkeypatch, root):
    from app.config import get_settings

    for name in ("CRATEMIND_DB_PATH", "CRATEMIND_IDENTITY_DB_PATH"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("CRATEMIND_DATASET_ROOT", str(root))
    get_settings.cache_clear()
    return get_settings


def test_script_paths_exact_optional_identity_and_lease_lifetime(tmp_path, monkeypatch):
    dataset = initialize_empty(tmp_path / "data")
    get_settings = settings(monkeypatch, dataset.dataset_root)
    try:
        assert catalog_path() == dataset.catalog_path
        assert script_dataset().identity is None
        with pytest.raises(ValueError):
            identity_path()
        with pytest.raises(ValueError):
            catalog_path(tmp_path / "stale.sqlite")
        observed = []
        @dataset_writer
        def write():
            with pytest.raises(DatasetBusyError):
                DatasetLease.acquire(dataset.dataset_root, "other-writer")
            observed.append("complete")
        write()
        assert observed == ["complete"]
        with DatasetLease.acquire(dataset.dataset_root, "idle-service"), pytest.raises(DatasetBusyError):
            write()
        assert observed == ["complete"]
    finally:
        get_settings.cache_clear()


def test_all_supported_writer_commands_refuse_idle_service_before_main(tmp_path):
    dataset = initialize_empty(tmp_path / "data")
    before = canonical_database_values(dataset.catalog_path)
    environment = {key: value for key, value in os.environ.items() if not key.startswith("CRATEMIND_")}
    environment["CRATEMIND_DATASET_ROOT"] = str(dataset.dataset_root)
    inventory = json.loads(INVENTORY.read_text())
    with DatasetLease.acquire(dataset.dataset_root, "fixture-idle-service"):
        for relative in inventory["supported_writers"]:
            result = subprocess.run([sys.executable, str(ROOT / relative)], cwd=ROOT, env=environment,
                                    capture_output=True, text=True, check=False)
            assert result.returncode != 0, relative
            assert "DatasetBusyError" in result.stderr, (relative, result.stderr)
    assert canonical_database_values(dataset.catalog_path) == before


def test_builder_acceptance_ledger_refusal_preserved_without_running_build(tmp_path):
    path = ROOT / "reconciliation/build_identity.py"
    # Inspect only its guarded entry point: no imports or domain build executed.
    module = ast.parse(path.read_text())
    main = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "main")
    source = ast.get_source_segment(path.read_text(), main)
    assert "identity_acceptances" in source and "never overwrite the acceptance ledger" in source
    assert any(isinstance(node, ast.Name) and node.id == "dataset_writer" for node in main.decorator_list)


def test_inventory_covers_every_script_and_archived_guards_precede_side_effects():
    inventory = json.loads(INVENTORY.read_text())
    listed = set().union(*(set(inventory[name]) for name in (
        "supported_writers", "resolved_readers", "identity_readers", "http_clients",
    )))
    actual = {str(path.relative_to(ROOT)) for path in (ROOT / "reconciliation").glob("*.py") if not path.name.startswith("test_")}
    assert actual == listed
    for pattern in inventory["archived_fail_closed_globs"]:
        for path in ROOT.glob(pattern):
            tree = ast.parse(path.read_text())
            guard = next(index for index, node in enumerate(tree.body) if isinstance(node, ast.Expr)
                         and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Name)
                         and node.value.func.id == "reject_legacy_script")
            # Only docstrings/imports/path bootstrap execute before the guard.
            assert all(isinstance(node, (ast.Import, ast.ImportFrom)) or
                       (isinstance(node, ast.Expr) and (isinstance(node.value, ast.Constant) or
                        (isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Attribute)
                         and node.value.func.attr == "insert"))) for node in tree.body[:guard])


def test_archived_guard_rejects_enrollment_and_original_marker_without_running_script(tmp_path, monkeypatch):
    dataset = initialize_empty(tmp_path / "active")
    get_settings = settings(monkeypatch, dataset.dataset_root)
    try:
        with pytest.raises(RuntimeError, match="παλιό"):
            reject_legacy_script(ROOT / "reconciliation/missing-audit/merge_missing.py")
    finally:
        get_settings.cache_clear()
    # Use a fake repository marker so the test never writes project data.
    fake = tmp_path / "repo"
    (fake / "backend/app").mkdir(parents=True)
    script = fake / "reconciliation/archive.py"
    script.parent.mkdir()
    retired_source_marker(fake / "backend/data/cratemind.sqlite").parent.mkdir(parents=True)
    retired_source_marker(fake / "backend/data/cratemind.sqlite").write_text("{}")
    monkeypatch.delenv("CRATEMIND_DATASET_ROOT")
    get_settings.cache_clear()
    try:
        with pytest.raises(ValueError, match="CRATEMIND_DATASET_ROOT"):
            reject_legacy_script(script)
    finally:
        get_settings.cache_clear()


def test_enrollment_emits_source_only_device_mapping_outside_exchange(tmp_path):
    original = tmp_path / "source.sqlite"
    root = tmp_path / "music"
    root.mkdir()
    with sqlite3.connect(original) as db:
        for statement in load_schema_contract()["initialization_sql"]["catalog"]:
            db.execute(statement)
    descriptor = {"root_key": "source-volume", "logical_prefix": str(root), "logical_flavor": "posix"}
    result = enroll(original, None, tmp_path / "enrolled", logical_roots=[descriptor])
    mappings = json.loads(result.path_mappings_file.read_text())
    assert mappings == {"version": 1, "library_roots": [descriptor | {"local_prefix": str(root), "enabled": True}]}
    assert result.to_dict()["CRATEMIND_PATH_MAPPINGS_FILE"] == str(result.path_mappings_file)
    with __import__("zipfile").ZipFile(result.archive_path) as archive:
        manifest = json.loads(archive.read("exchange.json"))
    assert manifest["logical_roots"] == [descriptor]
    assert "local_prefix" not in json.dumps(manifest)
