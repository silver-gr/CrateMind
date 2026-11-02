"""Membership tests that bind one JSON parameter instead of one variable per id.

SQLite caps bound variables (32,766 by default); `column.in_(ids)` binds one
per id and breaks on large libraries. `json_each` keeps it to a single bind.
"""
from __future__ import annotations

import json
from collections.abc import Iterable

from sqlalchemy import func, select
from sqlalchemy.sql.elements import ColumnElement


def ids_in(column, ids: Iterable[int | str]) -> ColumnElement:
    je = func.json_each(json.dumps(sorted(set(ids)))).table_valued("value")
    return column.in_(select(je.c.value))
