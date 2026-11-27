"""The ruleset id and its digest. A changed rule keeps its id and bumps RULESET; the golden corpus test fails when an
output changes without a bump. The digest covers every regex and word list of the package, KEY_VERSION and the
Unicode database version (the desktop sidecar and the dev Python must match)."""
from __future__ import annotations

import hashlib
import re
import unicodedata

RULESET = "names-5"
KEY_VERSION = 2  # names-4: «ə» and the fancy-text letters fold to Latin


def _tables() -> list[str]:
    from . import album, decide, explain, fields, lexer, readings, registry, spelling, text
    out: list[str] = []
    for mod in (text, fields, lexer, readings, registry, decide, spelling, album, explain):
        for name in sorted(vars(mod)):
            value = getattr(mod, name)
            if isinstance(value, re.Pattern):
                out.append(f"{mod.__name__}.{name}={value.pattern}|{value.flags}")
            elif isinstance(value, (set, frozenset)) and name.isupper():
                out.append(f"{mod.__name__}.{name}={sorted(map(str, value))}")
            elif isinstance(value, dict) and name.isupper():
                out.append(f"{mod.__name__}.{name}={sorted((str(k), str(v)) for k, v in value.items())}")
            elif isinstance(value, str) and name.isupper():
                out.append(f"{mod.__name__}.{name}={value}")
    return out


def digest() -> str:
    h = hashlib.sha256()
    for line in _tables() + [f"KEY_VERSION={KEY_VERSION}", f"unidata={unicodedata.unidata_version}", RULESET]:
        h.update(line.encode("utf-8") + b"\n")
    return h.hexdigest()[:16]
