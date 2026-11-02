"""Accent folding and the query grammar shared with the frontend.

The fixture is read by both this file and frontend/tests/queryGrammar.test.ts,
so the Python and TypeScript tokenizers can never drift apart.
"""
from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import pytest
from sqlalchemy import text

from app.services.query_grammar import serialize, tokenize
from app.services.text_fold import fold_text

CASES = json.loads((Path(__file__).parent / "fixtures" / "query_grammar.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize(("source", "expected"), [
    ("Μάνος Χατζιδάκις", "μανοσ χατζιδακισ"),
    ("ΧΑΛΑΡΩΣΗ", "χαλαρωση"),
    ("ς", "σ"),
    ("Ο ΚΟΣΜΟΣ", "ο κοσμοσ"),
    ("ΐ ΰ Ϊ", "ι υ ι"),
])
def test_fold_text(source, expected):
    assert fold_text(source) == expected


def test_cratemind_fold_sql_function(db):
    assert db.execute(text("SELECT cratemind_fold('Μάνος')")).scalar_one() == "μανοσ"
    assert db.execute(text("SELECT cratemind_fold(NULL)")).scalar_one() is None


@pytest.mark.parametrize("case", CASES, ids=[f"case{i}" for i in range(len(CASES))])
def test_grammar_fixture(case):
    assert [asdict(token) for token in tokenize(case["query"])] == case["tokens"]
    assert serialize(tokenize(case["query"])) == case["serialized"]
