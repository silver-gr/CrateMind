#!/usr/bin/env python3
"""Generate/check the shipped contract using isolated production initializers."""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
OUTPUT = BACKEND / "app" / "schema_contract.json"


def _production_identity_schema() -> str:
    # Read the existing builder's schema, without importing its CLI, reports or
    # network/provider imports. No second hand-maintained identity schema.
    tree = ast.parse((ROOT / "reconciliation" / "build_identity.py").read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(
            isinstance(target, ast.Name) and target.id == "SCHEMA" for target in node.targets
        ):
            return ast.literal_eval(node.value)
    raise RuntimeError("Production identity builder has no SCHEMA")


def _generate_fixture_contract(destination: Path) -> None:
    sys.path.insert(0, str(BACKEND))
    with tempfile.TemporaryDirectory(prefix="cratemind-schema-") as directory:
        root = Path(directory)
        from app import config
        # Explicit settings prevent developer .env and catalog discovery. This
        # process is disposable, so no application's cached settings are changed.
        settings = config.Settings(_env_file=None, db_path=str(root / "catalog.sqlite"),
                                   backup_dir=str(root / "backups"), output_dir=str(root / "exports"))
        config.get_settings = lambda: settings
        from app import db
        from app.services.schema_contract import (
            initialize_known_identity_schema,
            make_schema_contract,
        )

        db.init_db()
        identity_path = root / "identity.sqlite"
        with sqlite3.connect(identity_path) as identity:
            identity.executescript(_production_identity_schema())
            initialize_known_identity_schema(identity)
        contract = make_schema_contract(settings.db_file, identity_path)
        contract["initialization_sql"] = {}
        for label, path in (("catalog", settings.db_file), ("identity", identity_path)):
            with sqlite3.connect(path) as connection:
                contract["initialization_sql"][label] = [row[1] for row in connection.execute(
                    "SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL "
                    "AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END,name"
                ) if row[0] not in {"track_search_data", "track_search_idx", "track_search_content",
                                   "track_search_docsize", "track_search_config"}]
        unsigned = {key: value for key, value in contract.items() if key != "fingerprint"}
        contract["fingerprint"] = hashlib.sha256(json.dumps(
            unsigned, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False,
        ).encode()).hexdigest()
        db.get_engine().dispose()
        destination.write_text(json.dumps(contract, ensure_ascii=False, sort_keys=True, indent=2) + "\n")


def generate_schema_contract() -> dict:
    with tempfile.TemporaryDirectory(prefix="cratemind-schema-process-") as directory:
        destination = Path(directory) / "contract.json"
        environment = {key: value for key, value in os.environ.items() if not key.startswith("CRATEMIND_")}
        subprocess.run([sys.executable, str(Path(__file__).resolve()), "--fixture-output", str(destination)],
                       env=environment, check=True, cwd=BACKEND)
        return json.loads(destination.read_text())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--fixture-output", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.fixture_output:
        _generate_fixture_contract(args.fixture_output)
        return 0
    contract = generate_schema_contract()
    content = json.dumps(contract, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    if args.check:
        if not args.output.exists() or args.output.read_text() != content:
            print("Schema contract changed; run scripts/desktop/generate_schema_contract.py", file=sys.stderr)
            return 1
        print(f"Schema contract current: {contract['fingerprint']}")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(content)
        print(f"Generated schema contract: {contract['fingerprint']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
