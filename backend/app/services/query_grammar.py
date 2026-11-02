"""The search query grammar, shared with frontend/src/lib/queryGrammar.ts.

backend/tests/fixtures/query_grammar.json pins both implementations. Only double
quotes quote, there are no escapes, and apostrophes are literal (Greek elision
such as «Σ' αγαπώ» must not break parsing, which shlex did).
"""
from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass

# The union of Python's str.isspace() and JavaScript's \s, plus U+FEFF. Never use
# \s or \S: the two languages disagree on U+0085 and U+FEFF.
WS = r"\t\n\x0b\x0c\r\x1c-\x1f \x85\xa0  -     　﻿"
_TOKEN = re.compile(rf'(-)?(?:([^{WS}:"]+):)?(?:"([^"]*)"|([^{WS}]+))')
_HAS_WS = re.compile(rf"[{WS}]")


@dataclass(frozen=True)
class Token:
    neg: bool
    field: str | None
    value: str
    quoted: bool


def tokenize(query: str | None) -> list[Token]:
    tokens: list[Token] = []
    for match in _TOKEN.finditer(query or ""):
        neg, field, quoted_value, bare_value = match.groups()
        quoted = quoted_value is not None
        tokens.append(Token(neg is not None, field, quoted_value if quoted else bare_value, quoted))
    return tokens


def serialize(tokens: Iterable[Token]) -> str:
    parts = []
    for token in tokens:
        value = token.value
        if token.quoted or value == "" or _HAS_WS.search(value):
            value = f'"{value}"'
        parts.append(f"{'-' if token.neg else ''}{token.field + ':' if token.field else ''}{value}")
    return " ".join(parts)
