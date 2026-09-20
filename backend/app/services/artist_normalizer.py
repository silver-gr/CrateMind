"""Artist-name normalization helpers for artist intelligence."""
from __future__ import annotations

import re
import unicodedata

_COLLAB_SEPARATORS = re.compile(
    r"\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|vs|x|&|,|;)\s+",
    re.IGNORECASE,
)
_WHITESPACE = re.compile(r"\s+")



def _nfkc_base(name: str | None) -> str | None:
    """NFKC-normalise, unescape underscores, and trim — the shared prelude of
    both public normalizers. Returns None when the result is empty."""
    if not name:
        return None
    value = unicodedata.normalize("NFKC", name).replace("_", " ").strip()
    return value or None


def normalize_artist_name(name: str | None) -> str | None:
    """Return a stable, lower-cased artist key or None when unusable."""
    value = _nfkc_base(name)
    if value is None:
        return None
    value = _WHITESPACE.sub(" ", value)
    value = "".join(char for char in value if char.isalnum() or unicodedata.category(char).startswith("M") or char in " .'-_/()+&")
    value = value.strip().lower()
    return value or None


def primary_artist_name(name: str | None) -> str | None:
    """Use the first artist chunk for v1 collaboration handling."""
    value = _nfkc_base(name)
    if value is None:
        return None
    parts = _COLLAB_SEPARATORS.split(value, maxsplit=1)
    primary = _WHITESPACE.sub(" ", parts[0]).strip()
    return primary or None


def normalize_primary_artist_name(name: str | None) -> str | None:
    primary = primary_artist_name(name)
    return normalize_artist_name(primary)
