"""Read-only musical-key normalization shared by search, stats and scoring."""
from __future__ import annotations

import re
import unicodedata

from sqlalchemy import and_, case, func
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


# CrateMind's own key goes ahead of djay's when it is at least this confident. Measured 2026-11-18
# (docs/KEY_DETECTION.md): where the two differ, ours is right far more often from 0.7 up and djay's
# is right more often below it, on tracks labelled by people and on the library alike.
OWN_KEY_MIN_CONFIDENCE = 0.7
# Key methods whose confidence is a calibrated probability. A new key_detect.METHOD belongs here only
# after its confidence was measured (a test keeps the current one listed).
CALIBRATED_KEY_METHODS = frozenset({"cqt-octave-trained-v2"})


def own_key_first(confidence: float | None, method: str | None) -> bool:
    return method in CALIBRATED_KEY_METHODS and confidence is not None and confidence >= OWN_KEY_MIN_CONFIDENCE


def effective_key(tag: str | None, djay: str | None, analyzed: str | None,
                  confidence: float | None = None, method: str | None = None) -> str | None:
    """Nonblank embedded metadata wins, including unrecognized metadata. Then CrateMind's own key
    when it is confident (`own_key_first`), then djay's key, then CrateMind's own key at any
    confidence. Frontend `fallbackKey` in lib/camelot.ts must stay in step."""
    order = (tag, analyzed, djay) if own_key_first(confidence, method) else (tag, djay, analyzed)
    return next((value.strip() for value in order if value and value.strip()), None)


def normalized_effective_key(tag: str | None, djay: str | None, analyzed: str | None,
                             confidence: float | None = None, method: str | None = None) -> str | None:
    return to_camelot(effective_key(tag, djay, analyzed, confidence, method))


def key_stats(session: Session) -> dict:
    """One grouped query; preserve the distinction between absent and unknown."""
    result = {
        "total": 0, "keyed": 0, "missing": 0, "unrecognized": 0,
        "metadata": 0, "djay": 0, "analyzed": 0, "counts": dict.fromkeys(ALL_CAMELOT, 0),
    }
    own_first = case(
        (and_(Track.key_analyzed_method.in_(CALIBRATED_KEY_METHODS),
              Track.key_analyzed_confidence >= OWN_KEY_MIN_CONFIDENCE), 1), else_=0)
    groups = session.exec(
        select(Track.key_text, Track.key_djay, Track.key_analyzed, own_first, func.count())
        .group_by(Track.key_text, Track.key_djay, Track.key_analyzed, own_first)
    ).all()
    for tag, djay, analyzed, own, count in groups:
        result["total"] += count
        ordered = (("metadata", tag), ("analyzed", analyzed), ("djay", djay)) if own else (
            ("metadata", tag), ("djay", djay), ("analyzed", analyzed))
        source, raw = next(((name, value.strip()) for name, value in ordered if value and value.strip()), (None, None))
        code = to_camelot(raw)
        if code is None:
            result["missing" if raw is None else "unrecognized"] += count
            continue
        result["keyed"] += count
        result["counts"][code] += count
        result[source] += count
    return result
