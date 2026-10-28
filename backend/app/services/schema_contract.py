"""Generated SQLite structural compatibility and stable durable-value encoding."""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Any

CONTRACT_PATH = Path(__file__).resolve().parents[1] / "schema_contract.json"
# Enumerated derived/operational state only. All remaining non-NULL row values,
# including provider decisions and scan timestamps, participate in exchange.
EXCLUDED_VALUE_TABLES = frozenset({
    "track_search", "track_search_data", "track_search_idx", "track_search_content",
    "track_search_docsize", "track_search_config", "jobs", "sqlite_sequence",
})


class SchemaCompatibilityError(ValueError):
    pass


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def _connect(path: Path | str) -> sqlite3.Connection:
    return sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True)


def _affinity(declared: str) -> str:
    declared = declared.upper()
    if "INT" in declared:
        return "INTEGER"
    if any(value in declared for value in ("CHAR", "CLOB", "TEXT")):
        return "TEXT"
    if "BLOB" in declared or not declared:
        return "BLOB"
    if any(value in declared for value in ("REAL", "FLOA", "DOUB")):
        return "REAL"
    return "NUMERIC"


def _normalize_sql(sql: str | None) -> str | None:
    if sql is None:
        return None
    # Tokenize quoted literals so whitespace/case changes in actual values are
    # never hidden by SQL normalization.
    tokens = re.findall(r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|`[^`]*`|\[[^]]*\]|\w+|[^\s]", sql)
    return " ".join(token if token[0] in "'\"`[" else token.lower() for token in tokens)


def _checks(sql: str) -> list[str]:
    tokens = re.findall(r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|\w+|[^\s]", sql)
    checks = []
    for index, token in enumerate(tokens[:-1]):
        if token.lower() != "check" or tokens[index + 1] != "(":
            continue
        depth = 0
        end = index + 1
        for end in range(index + 1, len(tokens)):
            depth += (tokens[end] == "(") - (tokens[end] == ")")
            if depth == 0:
                break
        checks.append(_normalize_sql(" ".join(tokens[index + 1:end + 1])))
    return sorted(checks)



def _column_definitions(sql: str) -> dict[str, list[str]]:
    tokens = re.findall(r"'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|`[^`]*`|\[[^]]*\]|\w+|[^\s]", sql)
    parts, part, depth = [], [], 0
    for token in tokens[tokens.index("(") + 1:] if "(" in tokens else []:
        if token == ")" and depth == 0:
            if part:
                parts.append(part)
            break
        if token == "," and depth == 0:
            parts.append(part)
            part = []
            continue
        depth += (token == "(") - (token == ")")
        part.append(token)
    return {part[0].strip('"`[]'): part[1:] for part in parts if part}


def inspect_schema(path: Path | str) -> dict[str, Any]:
    """Describe affinity, keys, supported constraints and other schema objects."""
    with closing(_connect(path)) as db:
        tables = {}
        for name, sql in db.execute(
            "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ):
            columns = {}
            definitions = _column_definitions(sql or "")
            for row in db.execute(f"PRAGMA table_xinfo({_quote(name)})"):
                _cid, column, kind, notnull, default, primary, hidden = row
                definition = definitions.get(column, [])
                keywords = [token.lower() for token in definition]
                collate = keywords.index("collate") if "collate" in keywords else None
                collation = definition[collate + 1].strip('"`[]').lower() if collate is not None else "binary"
                conflicts = [keywords[index + 2] for index in range(len(keywords) - 2)
                             if keywords[index:index + 2] == ["on", "conflict"]]
                columns[column] = {"affinity": _affinity(kind), "not_null": bool(notnull),
                                   "collation": collation, "conflict": conflicts,
                                   "autoincrement": "autoincrement" in keywords,
                                   "generated": _normalize_sql(" ".join(definition)) if hidden in (2, 3) else None,
                                   "default": _normalize_sql(default), "primary_key": primary,
                                   "hidden": hidden}
            indices = []
            for index in db.execute(f"PRAGMA index_list({_quote(name)})"):
                _seq, index_name, unique, origin, partial = index
                parts = [list(row[2:]) for row in db.execute(f"PRAGMA index_xinfo({_quote(index_name)})")]
                index_sql = db.execute("SELECT sql FROM sqlite_master WHERE name=?", (index_name,)).fetchone()
                indices.append({"origin": origin, "unique": bool(unique), "partial": bool(partial), "parts": parts,
                                "sql": _normalize_sql(index_sql[0]) if index_sql and origin == "c" else None})
            foreign = [list(row[1:]) for row in db.execute(f"PRAGMA foreign_key_list({_quote(name)})")]
            tables[name] = {"columns": columns, "indices": sorted(indices, key=_canonical),
                            "foreign_keys": sorted(foreign, key=_canonical),
                            "checks": _checks(sql or ""),
                            "virtual": _normalize_sql(sql) if (sql or "").upper().startswith("CREATE VIRTUAL") else None,
                            "without_rowid": bool(re.search(r"\bWITHOUT\s+ROWID\b", sql or "", re.IGNORECASE)),
                            "strict": bool(re.search(r"\)\s*STRICT\s*$", sql or "", re.IGNORECASE))}
        objects = {f"{kind}:{name}": _normalize_sql(sql) for kind, name, sql in db.execute(
            "SELECT type,name,sql FROM sqlite_master WHERE type IN ('view','trigger') ORDER BY type,name"
        )}
    return {"tables": tables, "objects": objects}


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def make_schema_contract(catalog_path: Path | str, identity_path: Path | str | None) -> dict:
    result = {"version": 1, "normalized_catalog_schema": inspect_schema(catalog_path),
              "normalized_identity_schema": inspect_schema(identity_path) if identity_path else None}
    result["fingerprint"] = hashlib.sha256(_canonical(result).encode()).hexdigest()
    return result


def load_schema_contract(path: Path | str = CONTRACT_PATH) -> dict:
    result = json.loads(Path(path).read_text(encoding="utf-8"))
    unsigned = {key: value for key, value in result.items() if key != "fingerprint"}
    if result.get("version") != 1 or hashlib.sha256(_canonical(unsigned).encode()).hexdigest() != result.get("fingerprint"):
        raise SchemaCompatibilityError("Το συμβόλαιο σχήματος της εφαρμογής δεν είναι έγκυρο.")
    return result


def _validate_schema(incoming: dict, supported: dict, label: str) -> None:
    def reject(detail: str) -> None:
        raise SchemaCompatibilityError(
            f"Απαιτείται ενημέρωση του CrateMind: μη συμβατό σχήμα {label} ({detail})."
        )
    for name, table in incoming["tables"].items():
        target = supported["tables"].get(name)
        if target is None:
            reject(name)
        for column, descriptor in table["columns"].items():
            if target["columns"].get(column) != descriptor:
                reject(f"{name}.{column}")
        # Additive empty tables/NULL columns are safe structurally. Existing
        # tables may not introduce unknown keys, CHECKs or foreign keys.
        for key in ("indices", "foreign_keys", "checks"):
            if any(item not in target[key] for item in table[key]):
                reject(f"{name}.{key}")
        present = set(table["columns"])
        required_unique = [item for item in target["indices"] if item["unique"] and all(
            part[0] in present for part in item["parts"] if part[-1] and part[0] is not None
        )]
        if any(item not in table["indices"] for item in required_unique):
            reject(f"{name}.unique")
        if table["foreign_keys"] != [item for item in target["foreign_keys"] if item[2] in present]:
            reject(f"{name}.foreign_keys")
        for check in target["checks"]:
            referenced = set(re.findall(r"\b\w+\b", check)) & set(target["columns"])
            if referenced <= present and check not in table["checks"]:
                reject(f"{name}.checks")
        for key in ("virtual", "without_rowid", "strict"):
            if table[key] != target[key]:
                reject(f"{name}.{key}")
        incoming_pk = {column: spec["primary_key"] for column, spec in table["columns"].items() if spec["primary_key"]}
        target_pk = {column: spec["primary_key"] for column, spec in target["columns"].items() if spec["primary_key"]}
        if incoming_pk != target_pk:
            reject(f"{name}.primary_key")
    for key, descriptor in incoming["objects"].items():
        if supported["objects"].get(key) != descriptor:
            reject(key)


def validate_schema_compatibility(
    catalog_path: Path | str, identity_path: Path | str | None = None, *, contract: dict | None = None,
) -> None:
    contract = load_schema_contract() if contract is None else contract
    _validate_schema(inspect_schema(catalog_path), contract["normalized_catalog_schema"], "catalog")
    if identity_path is not None:
        if contract["normalized_identity_schema"] is None:
            raise SchemaCompatibilityError("Απαιτείται ενημέρωση για τη βάση identity.")
        _validate_schema(inspect_schema(identity_path), contract["normalized_identity_schema"], "identity")


def initialize_known_identity_schema(connection: sqlite3.Connection) -> None:
    """Materialize lazy schema only, without replaying or rewriting decisions.

    Caller owns the dataset lease and pre-migration paired backup. The existing
    base identity tables must already exist; this never rebuilds identity.
    """
    from . import canonical_library, collection_consolidation, collection_lineage
    from .library_completeness import RECOVERY_SCHEMA

    for schema in (canonical_library.SCHEMA, RECOVERY_SCHEMA):
        for statement in schema.split(";"):
            if statement.strip():
                connection.execute(statement)
    collection_lineage.init(connection)
    collection_consolidation.init(connection)
    from .identity_sync import ensure_local_indexes
    ensure_local_indexes(connection)


def canonical_database_values(path: Path | str) -> dict[str, list[dict]]:
    """Deterministic values; absent tables=empty, absent columns=NULL.

    Type-tag blobs so their bytes cannot collide with a user's string. Preserve
    row multiplicity and all non-NULL values, sorting encoded rows rather than
    relying on SQLite row order or platform-specific collation.
    """
    result = {}
    with closing(_connect(path)) as db:
        db.row_factory = sqlite3.Row
        names = [row[0] for row in db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )]
        for name in names:
            if name in EXCLUDED_VALUE_TABLES:
                continue
            rows = []
            for row in db.execute(f"SELECT * FROM {_quote(name)}"):
                value = {key: ({"$blob": item.hex()} if isinstance(item, bytes) else item)
                         for key in row.keys() if (item := row[key]) is not None}  # noqa: SIM118 - sqlite3.Row iterates values
                rows.append(value)
            if rows:
                result[name] = sorted(rows, key=_canonical)
    return result
