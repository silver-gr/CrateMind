"""Read-only musical-key normalization shared by search, stats and scoring."""
from __future__ import annotations

import re
import unicodedata

from sqlalchemy import func
from sqlmodel import Session, select

from ..models import Track

ALL_CAMELOT = tuple(f"{number}{side}" for number in range(1, 13) for side in "AB")
_PITCH = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}
_MAJOR_NUMBER = (8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1)


def to_camelot(value: str | None) -> str | None:
    """Canonical uppercase Camelot code, without changing the stored source.

    Accept musical names, Unicode accidentals, Camelot and Open Key notation.
    A capital M explicitly means major; a lowercase m means minor.
    """
    if not value:
        return None
    compact = re.sub(r"\s+", "", unicodedata.normalize("NFKC", value))
    compact = compact.replace("♯", "#").replace("♭", "b")
    compact = re.sub(
        r"([a-g])-?(sharp|flat)",
        lambda match: match[1] + ("#" if match[2].lower() == "sharp" else "b"),
        compact, flags=re.IGNORECASE,
    )
    camelot = re.fullmatch(r"(1[0-2]|[1-9])([aAbB])", compact)
    if camelot:
        return camelot[1] + camelot[2].upper()
    open_key = re.fullmatch(r"(1[0-2]|[1-9])([mMdD])", compact)
    if open_key:
        number = (int(open_key[1]) + 6) % 12 + 1
        return f"{number}{'A' if open_key[2].lower() == 'm' else 'B'}"
    musical = re.fullmatch(r"([a-gA-G])([#b]?)(major|minor|maj|min|moll|dur|[mM])?", compact, re.IGNORECASE)
    if musical is None:
        return None
    note, accidental, mode = musical.groups()
    pitch = (_PITCH[note.lower()] + {"#": 1, "b": -1, "": 0}[accidental.lower()]) % 12
    minor = mode is not None and mode != "M" and mode.lower() in {"m", "min", "minor", "moll"}
    number = _MAJOR_NUMBER[(pitch + (3 if minor else 0)) % 12]
    return f"{number}{'A' if minor else 'B'}"


def effective_key(tag: str | None, analyzed: str | None) -> str | None:
    """Nonblank embedded metadata wins, including unrecognized metadata."""
    return next((value.strip() for value in (tag, analyzed) if value and value.strip()), None)


def normalized_effective_key(tag: str | None, analyzed: str | None) -> str | None:
    return to_camelot(effective_key(tag, analyzed))


def key_stats(session: Session) -> dict:
    """One grouped query; preserve the distinction between absent and unknown."""
    result = {
        "total": 0, "keyed": 0, "missing": 0, "unrecognized": 0,
        "metadata": 0, "analyzed": 0, "counts": dict.fromkeys(ALL_CAMELOT, 0),
    }
    groups = session.exec(
        select(Track.key_text, Track.key_analyzed, func.count())
        .group_by(Track.key_text, Track.key_analyzed)
    ).all()
    for tag, analyzed, count in groups:
        result["total"] += count
        raw = effective_key(tag, analyzed)
        code = to_camelot(raw)
        if code is None:
            result["missing" if raw is None else "unrecognized"] += count
            continue
        result["keyed"] += count
        result["counts"][code] += count
        result["metadata" if tag and tag.strip() else "analyzed"] += count
    return result
