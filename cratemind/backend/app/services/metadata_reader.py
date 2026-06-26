"""Read embedded tags via Mutagen. Never raises on malformed/odd files."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from mutagen import File as MutagenFile  # type: ignore

# Mutagen exposes a normalised "easy" view for common formats; for the rest we
# fall back to scanning raw tag frames by fuzzy key match.
_FIELDS = {
    "artist": ("artist", "tpe1", "©art", "author"),
    "title": ("title", "tit2", "©nam"),
    "album": ("album", "talb", "©alb"),
    "label": ("label", "organization", "publisher", "tpub"),
    "genre": ("genre", "tcon", "©gen"),
    "comment": ("comment", "comm", "©cmt", "description"),
    "date": ("date", "year", "tdrc", "tyer", "©day"),
    "bpm": ("bpm", "tbpm"),
    "key_text": ("initialkey", "key", "tkey"),
}


def _first(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
    if value is None:
        return None
    return str(value).strip() or None


def _coerce_year(raw: str | None) -> int | None:
    if not raw:
        return None
    m = re.search(r"(\d{4})", raw)
    return int(m.group(1)) if m else None


def _coerce_bpm(raw: str | None) -> float | None:
    if not raw:
        return None
    m = re.search(r"(\d+(?:\.\d+)?)", raw)
    try:
        return float(m.group(1)) if m else None
    except (ValueError, AttributeError):
        return None


def read_tags(path: Path) -> dict[str, Any]:
    """Return a dict of normalised embedded tags. Empty dict on unreadable file."""
    try:
        audio = MutagenFile(path, easy=True)
    except Exception:
        audio = None
    if audio is None:
        try:
            audio = MutagenFile(path)
        except Exception:
            return {}
    if audio is None:
        return {}

    # Build a case-insensitive lookup of available tag keys.
    try:
        raw_keys = {str(k).lower(): k for k in audio.keys()}
    except Exception:
        raw_keys = {}

    def lookup(candidates: tuple[str, ...]) -> str | None:
        for cand in candidates:
            key = raw_keys.get(cand.lower())
            if key is not None:
                try:
                    return _first(audio[key])
                except Exception:
                    continue
        return None

    out: dict[str, Any] = {}
    for field, candidates in _FIELDS.items():
        out[field] = lookup(candidates)

    out["year"] = _coerce_year(out.pop("date", None))
    out["bpm"] = _coerce_bpm(out.get("bpm"))

    # rating, if present (POPM etc.) — best effort
    rating = lookup(("rating",))
    if rating:
        try:
            out["rating"] = int(float(rating))
        except (ValueError, TypeError):
            out["rating"] = None
    return {k: v for k, v in out.items() if v is not None}
