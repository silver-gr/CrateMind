from __future__ import annotations

import importlib.util
import json
import sqlite3
from pathlib import Path

import pytest

from app.services.schema_contract import (
    SchemaCompatibilityError,
    canonical_database_values,
    inspect_schema,
    load_schema_contract,
    make_schema_contract,
    validate_schema_compatibility,
)


def database(path, schema):
    with sqlite3.connect(path) as db:
        db.executescript(schema)
    return path


def test_generated_contract_matches_production_schema():
    root = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location("generate_schema_contract", root / "scripts/desktop/generate_schema_contract.py")
    generator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(generator)
    assert generator.generate_schema_contract() == load_schema_contract()


def test_contract_checks_affinity_keys_constraints_and_unknown_values(tmp_path):
    supported = database(tmp_path / "supported.sqlite", """
CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT CHECK(value IN ('yes','no')), added TEXT);
CREATE TABLE notes(id INTEGER PRIMARY KEY, item INTEGER REFERENCES items(id));
""")
    old = database(tmp_path / "old.sqlite", "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT CHECK(value IN ('yes','no')));")
    contract = make_schema_contract(supported, None)
    validate_schema_compatibility(old, contract=contract)
    with sqlite3.connect(old) as db:
        db.execute("ALTER TABLE items ADD COLUMN future TEXT")
    with pytest.raises(SchemaCompatibilityError, match="ενημέρωση"):
        validate_schema_compatibility(old, contract=contract)
    for number, ddl in enumerate((
        "CREATE TABLE items(id TEXT PRIMARY KEY, value TEXT)",
        "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT CHECK(value='YES'))",
        "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT UNIQUE)",
        "CREATE TABLE surprise(value TEXT)",
        "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT); CREATE TRIGGER changed AFTER INSERT ON items BEGIN DELETE FROM items; END;",
    )):
        invalid = database(tmp_path / f"invalid{number}.sqlite", ddl)
        with pytest.raises(SchemaCompatibilityError):
            validate_schema_compatibility(invalid, contract=contract)


def test_schema_fingerprint_changes_for_model_index_changes(tmp_path):
    path = database(tmp_path / "catalog.sqlite", "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT)")
    before = make_schema_contract(path, None)
    with sqlite3.connect(path) as db:
        db.execute("CREATE INDEX values_index ON items(value)")
    assert make_schema_contract(path, None)["fingerprint"] != before["fingerprint"]


def test_value_encoding_additive_empty_null_and_row_order_stable(tmp_path):
    old = database(tmp_path / "old.sqlite", "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO items VALUES(2,'δύο'),(1,'ένα');")
    new = database(tmp_path / "new.sqlite", "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT, optional TEXT); INSERT INTO items VALUES(1,'ένα',NULL),(2,'δύο',NULL); CREATE TABLE empty(value TEXT);")
    assert canonical_database_values(old) == canonical_database_values(new)
    with sqlite3.connect(new) as db:
        db.execute("UPDATE items SET optional='human decision' WHERE id=1")
    assert canonical_database_values(old) != canonical_database_values(new)


def test_values_preserve_scan_times_blobs_duplicates_and_exclude_only_named_jobs(tmp_path):
    path = database(tmp_path / "catalog.sqlite", "CREATE TABLE observations(value BLOB,last_scanned_at TEXT); INSERT INTO observations VALUES(X'ABCD','today'),(X'ABCD','today'); CREATE TABLE jobs(value TEXT); INSERT INTO jobs VALUES('running'); CREATE TABLE human_jobs(value TEXT); INSERT INTO human_jobs VALUES('keep');")
    value = canonical_database_values(path)
    assert value == {"human_jobs": [{"value": "keep"}], "observations": [
        {"value": {"$blob": "abcd"}, "last_scanned_at": "today"},
        {"value": {"$blob": "abcd"}, "last_scanned_at": "today"},
    ]}


def test_load_contract_detects_tampering(tmp_path):
    value = load_schema_contract()
    value["normalized_catalog_schema"]["tables"].clear()
    path = tmp_path / "contract.json"
    path.write_text(json.dumps(value))
    with pytest.raises(SchemaCompatibilityError):
        load_schema_contract(path)


def test_check_literals_are_not_case_or_space_normalized(tmp_path):
    first = database(tmp_path / "a.sqlite", "CREATE TABLE items(value TEXT CHECK(value='Two Words'))")
    second = database(tmp_path / "b.sqlite", "create table items(value text check(value='two  words'))")
    assert inspect_schema(first) != inspect_schema(second)


def test_missing_constraints_and_unknown_collations_are_incompatible(tmp_path):
    supported = database(tmp_path / "supported.sqlite", "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT UNIQUE CHECK(value!='bad'))")
    contract = make_schema_contract(supported, None)
    for number, schema in enumerate((
        "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT CHECK(value!='bad'))",
        "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT UNIQUE)",
        "CREATE TABLE items(id INTEGER PRIMARY KEY, value TEXT COLLATE NOCASE UNIQUE CHECK(value!='bad'))",
    )):
        incoming = database(tmp_path / f"incoming{number}.sqlite", schema)
        with pytest.raises(SchemaCompatibilityError):
            validate_schema_compatibility(incoming, contract=contract)


def test_initialize_lazy_identity_tables_does_not_replay_decisions(tmp_path):
    from app.services.schema_contract import initialize_known_identity_schema

    path = database(tmp_path / "identity.sqlite", "CREATE TABLE entities(id TEXT,recording_id TEXT,status TEXT,local_track_id INTEGER,service TEXT); INSERT INTO entities VALUES('local:1','chosen','ACCEPTED',1,'local');")
    with sqlite3.connect(path) as connection:
        initialize_known_identity_schema(connection)
        initialize_known_identity_schema(connection)
        assert connection.execute("SELECT * FROM entities").fetchall() == [('local:1', 'chosen', 'ACCEPTED', 1, 'local')]
        assert connection.execute("SELECT count(*) FROM canonical_events").fetchone()[0] == 0
        assert connection.execute("SELECT name FROM sqlite_master WHERE name='recording_recovery'").fetchone()
