"""reconciliation/names_import.py on a synthetic dataset root: the dry run on a copy, the apply with its backup,
the refusal while the app holds the library. Every name is invented."""
from __future__ import annotations

import importlib.util
import json
import sqlite3
from contextlib import closing
from pathlib import Path

import pytest

from app.library_exchange.operations import _pointer
from app.library_exchange.state import atomic_json, initial_state
from app.services.dataset_access import DatasetBusyError, DatasetLease
from app.services.schema_contract import load_schema_contract

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("names_import_command", ROOT / "reconciliation/names_import.py")
cmd = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cmd)

ANSWERS = {"answers": [{"scope": "pref:invented_rule", "answer": "B", "date": "x"},
                       {"scope": "pair:zarvo|zarvoh", "answer": "same", "date": "x"},
                       {"scope": "note:remember", "answer": "A", "date": "x"}]}
SEED = "kind,scope,tracks,code,question,options,απόφαση,source\nspelling,act:kelvaro,,,;,A=Kelvaro,=KelVaro,sheet\n"


@pytest.fixture
def dataset(tmp_path, monkeypatch):
    import app.config as config
    import app.db as database

    root, generation = tmp_path / "data", tmp_path / "data/datasets/g1"
    generation.mkdir(parents=True)
    contract = load_schema_contract()["initialization_sql"]
    for name in ("catalog", "identity"):
        with closing(sqlite3.connect(generation / f"{name}.sqlite")) as db:
            for statement in contract[name]:
                db.execute(statement)
            db.commit()
    with closing(sqlite3.connect(generation / "catalog.sqlite")) as db:
        db.execute("INSERT INTO tracks(id,absolute_path,normalized_path,file_name,extension,play_count,imported_at,"
                   "last_scanned_at,missing) VALUES (1,'/music/1.mp3','/music/1.mp3','1.mp3','.mp3',0,"
                   "'2026-01-01 00:00:00','2026-01-01 00:00:00',0)")
        db.commit()
    _pointer(root, "g1", True)
    atomic_json(generation / "exchange-state.json", initial_state("lineage-before"))
    # Set through monkeypatch first, so whatever the dry run puts into the environment is taken back afterwards.
    monkeypatch.setenv("CRATEMIND_DB_PATH", "")
    monkeypatch.setenv("CRATEMIND_IDENTITY_DB_PATH", "")
    monkeypatch.delenv("CRATEMIND_DB_PATH")
    monkeypatch.delenv("CRATEMIND_IDENTITY_DB_PATH")
    monkeypatch.setenv("CRATEMIND_DATASET_ROOT", str(root))
    config.get_settings.cache_clear()
    (tmp_path / "answers.json").write_text(json.dumps(ANSWERS), encoding="utf-8")
    (tmp_path / "seed.csv").write_text(SEED, encoding="utf-8")
    yield root, generation
    config.get_settings.cache_clear()
    database._engine = None


def decisions(path) -> list[tuple]:
    with closing(sqlite3.connect(path)) as db:
        return db.execute("SELECT kind, scope, value, source FROM name_decisions ORDER BY kind, scope").fetchall()


def run(capsys, argv, code=0) -> dict:
    assert cmd.main(["--json", *argv]) == code
    return json.loads(capsys.readouterr().out)


def inputs(tmp_path) -> list[str]:
    return ["--answers", str(tmp_path / "answers.json"), "--seed", str(tmp_path / "seed.csv"), "--loose", "loose"]


def test_dry_run_writes_only_to_its_copy(dataset, tmp_path, capsys):
    from app.services.backup import create_backup

    root, generation = dataset
    bundle = create_backup(generation / "catalog.sqlite", tmp_path / "bundles", identity_path=generation / "identity.sqlite",
                           keep=None, reuse=False)
    report = run(capsys, ["--dry-run", str(bundle), "--work", str(tmp_path / "work"), *inputs(tmp_path)])
    assert report["ok"] and report["would_add"]["added"] == report["import"]["added"] == 4
    assert report["second_import_adds"] == 0 and report["import"]["rejected"] == []
    assert decisions(generation / "catalog.sqlite") == []  # the library itself is untouched
    assert decisions(tmp_path / "work/catalog.sqlite") == [
        ("preference", "pref:invented_rule", "B", "owner"), ("same_act", "pair:zarvo|zarvoh", "yes", "owner"),
        ("setting", "loose_folder:loose", "loose", "owner"), ("spelling", "act:kelvaro", "=KelVaro", "seed")]
    # A used folder, or a folder inside a library, is refused before anything is copied.
    refused = run(capsys, ["--dry-run", str(bundle), "--work", str(tmp_path / "work"), *inputs(tmp_path)], code=1)
    assert refused["ok"] is False and "άδειος" in refused["error"]
    inside = run(capsys, ["--dry-run", str(bundle), "--work", str(root / "scratch"), *inputs(tmp_path)], code=1)
    assert inside["ok"] is False and not (root / "scratch").exists()


def test_apply_backs_up_first_writes_once_and_status_only_reads(dataset, tmp_path, capsys, monkeypatch):
    import importlib

    root, generation = dataset
    stamps = iter(f"20260101T0000{n:02d}Z" for n in range(60))  # two backups in one second need two names
    monkeypatch.setattr(importlib.import_module("clean_working_library"), "stamp", lambda: next(stamps))
    assert run(capsys, [])["decisions"] == []
    report = run(capsys, ["--apply", *inputs(tmp_path)])
    assert report["ok"] and report["import"] == {"added": 4, "skipped": 0, "rejected": []}
    backup = Path(report["backup"]["bundle"])
    assert backup.is_dir() and decisions(backup / "catalog.sqlite") == []  # taken before the write
    assert len(decisions(generation / "catalog.sqlite")) == 4
    again = run(capsys, ["--apply", *inputs(tmp_path)])
    assert again["import"] == {"added": 0, "skipped": 4, "rejected": []}
    assert {(row["kind"], row["rows"]) for row in run(capsys, [])["decisions"]} == {
        ("preference", 1), ("same_act", 1), ("setting", 1), ("spelling", 1)}


def test_apply_refuses_without_answers_and_while_the_app_holds_the_library(dataset, tmp_path, capsys):
    root, generation = dataset
    assert "answers" in run(capsys, ["--apply"], code=1)["error"]
    with DatasetLease.acquire(root, "fixture-app"), pytest.raises(DatasetBusyError):
        cmd.main(["--apply", *inputs(tmp_path)])
    assert decisions(generation / "catalog.sqlite") == []
    assert not (root / "backups").exists()
