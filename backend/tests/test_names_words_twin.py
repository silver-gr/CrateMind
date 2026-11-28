"""The status words of «Καθαρά ονόματα» exist three times (the engine, the show service, the frontend): one
change must fail until the others follow."""
import re
from pathlib import Path

import pytest

from app.services import names_show
from app.services.names import explain

LABELS = Path(__file__).resolve().parents[2] / "frontend" / "src" / "lib" / "namesLabels.ts"


def _frontend() -> tuple[dict, str]:
    if not LABELS.exists():
        pytest.skip("UNKNOWN: frontend/src/lib/namesLabels.ts is not in this checkout")
    source = LABELS.read_text(encoding="utf-8")
    block = re.search(r"NAME_STATUS_LABEL[^=]*=\s*\{(.*?)\};", source, re.S).group(1)
    words = dict(re.findall(r"(\w+):\s*\"([^\"]*)\"", block))
    unknown = re.search(r"UNKNOWN_ARTIST\s*=\s*\"([^\"]*)\"", source).group(1)
    return words, unknown


def test_the_status_words_are_the_same_in_the_engine_the_service_and_the_frontend():
    words, unknown = _frontend()
    assert words == names_show.STATUS_TEXT == explain.STATUS_TEXT
    assert set(words) == set(names_show.STATUSES)
    assert unknown == names_show.UNKNOWN_ARTIST
