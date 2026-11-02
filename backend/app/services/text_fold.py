"""Accent- and case-insensitive text keys for search (index side and query side)."""
from __future__ import annotations

import unicodedata


def fold_text(value: str) -> str:
    """NFKD, drop combining marks, casefold: «Μάνος» -> "μανοσ" (final ς folds to σ)."""
    decomposed = unicodedata.normalize("NFKD", value)
    return "".join(char for char in decomposed if not unicodedata.combining(char)).casefold()
