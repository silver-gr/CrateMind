"""Read embedded tags via Mutagen. Never raises on malformed/odd files."""
from __future__ import annotations

import re
import unicodedata
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

_DASH_SPLIT = re.compile(r"\s+[–—-]\s+")
_LEADING_TRACK_NO = re.compile(r"^\s*\d{1,3}(?:\s*[.)_-]\s*|\s+)")
_WHITESPACE = re.compile(r"\s+")
_DECORATION_RE = re.compile(r"[★☆☠♬ॐ❤🧡💛💚💙💜]+")
_PROMO_RE = re.compile(
    r"(?i)(?:free[\s_-]*(?:download|dwnld|downloadlink|dl)|freedownload(?:link)?|out now|preview|fulltrack)"
)
_BY_LABEL_RE = re.compile(
    r"(?i)\s*(?:[-–—]|by)\s+[^-–—()[\]]*"
    r"(?:records?|recs?\.?|music|media|productions?|prod\.?|creation|mpp)\b[^-–—()[\]]*$"
)
_TRAILING_BY_RE = re.compile(r"(?i)\s+by\s+[^-–—()[\]]+$")
_LABEL_HINT_RE = re.compile(
    r"(?i)\b(?:records?|recs?\.?|music|media|productions?|prod\.?|creation|mpp)\b"
)
_ALBUM_HINT_RE = re.compile(r"(?i)\b(?:v\.?\s*a\.?|various artists?)\b")
_YEAR_HINT_RE = re.compile(r"\b(?:19|20)\d{2}\b")
_BITS_HINT_RE = re.compile(r"(?i)^(?:16|24|32)\s*(?:bit|bits)?$")
_TRAILING_CHUNK_RE = re.compile(r"^(.*?)(?:\s*[\[(]([^\])]+)[\])]\s*)$")
# A trailing bracket chunk counts as BPM only when it is *just* a number
# (optionally "bpm"): "[192]" / "128 bpm" -> BPM; "Area 88" -> not BPM, so a
# parenthetical containing a number is never misread as tempo and deleted.
_PURE_BPM_RE = re.compile(r"(?i)^\s*(\d{2,3})\+?\s*(?:bpm)?\s*$")


def _clean_filename_token(value: str | None) -> str | None:
    if not value:
        return None
    text = unicodedata.normalize("NFKC", value)
    text = text.replace("_", " ")
    text = _DECORATION_RE.sub(" ", text)
    text = _LEADING_TRACK_NO.sub("", text)
    text = _WHITESPACE.sub(" ", text).strip(" -–—_")
    return text or None


def _is_bpm_value(value: int | None) -> bool:
    return value is not None and 60 <= value <= 260


def _chunk_bpm(text: str | None) -> int | None:
    """BPM from a trailing bracket chunk — only when the chunk is a pure number
    (optionally "bpm"), never text-with-a-number like "Area 88"."""
    if not text:
        return None
    m = _PURE_BPM_RE.match(text)
    if not m:
        return None
    bpm = int(m.group(1))
    return bpm if _is_bpm_value(bpm) else None


def _clean_noise(text: str | None) -> str | None:
    if not text:
        return None
    value = unicodedata.normalize("NFKC", text)
    value = value.replace("_", " ")
    value = _PROMO_RE.sub(" ", value)
    value = _BY_LABEL_RE.sub(" ", value)
    value = _TRAILING_BY_RE.sub(" ", value)
    value = _DECORATION_RE.sub(" ", value)
    value = value.replace("•", " ")
    value = _WHITESPACE.sub(" ", value)
    value = value.strip(" -–—_*#!+")
    return value or None


def _strip_title_wrappers(title: str) -> tuple[str, int | None, str | None]:
    bpm_hint: int | None = None
    album_hint: str | None = None
    value = title

    while True:
        m = _TRAILING_CHUNK_RE.match(value)
        if not m:
            break
        raw_chunk = _clean_filename_token(m.group(2))
        base = m.group(1)
        if not raw_chunk:
            value = base
            continue
        if _ALBUM_HINT_RE.search(raw_chunk):
            album_hint = album_hint or raw_chunk
            value = base
            continue
        chunk = _clean_noise(raw_chunk)
        if not chunk:
            value = base
            continue
        chunk_bpm = _chunk_bpm(chunk)
        if chunk_bpm is not None:
            bpm_hint = bpm_hint or chunk_bpm
            value = base
            continue
        if _BITS_HINT_RE.fullmatch(chunk):
            value = base
            continue
        if _YEAR_HINT_RE.search(chunk):
            value = base
            continue
        if _LABEL_HINT_RE.search(chunk):
            value = base
            continue
        if _PROMO_RE.search(f" {chunk} "):
            value = base
            continue
        break

    return value, bpm_hint, album_hint


def _strip_inline_bpm(title: str, bpm_hint: int | None) -> tuple[str, int | None]:
    def make_repl(min_bpm: int):
        def repl(match: re.Match[str]) -> str:
            nonlocal bpm_hint
            bpm = int(match.group(1))
            if min_bpm <= bpm <= 260:
                bpm_hint = bpm_hint or bpm
                return " "
            return match.group(0)
        return repl

    # An explicit "bpm" keyword trusts any in-range value. A bare number is
    # ambiguous ("Route 66" is a title, not 66 BPM), so it only counts as BPM
    # when > 130 — below that, leave the number in the title untouched.
    patterns = [
        (re.compile(r"(?i)(?:^|\s)[-–—]?\s*(\d{2,3})(?:\+)?\s*bpm(?=$|\s|[-–—()[\]])"), 60),
        # Bare trailing number only at absolute end — NOT before a bracket, so
        # "Nightcall (Area 88)" keeps its parenthetical instead of losing "88".
        (re.compile(r"(?i)(?:^|\s)[-–—]?\s*(\d{2,3})(?:\+)?(?=$)"), 131),
        (re.compile(r"(?i)^(?:\s*)(\d{2,3})(?:\+)?\s*[-–—]\s*"), 131),
        (re.compile(r"(?i)\s*[-–—]\s*(\d{2,3})(?:\+)?$"), 131),
    ]
    value = title
    for pattern, min_bpm in patterns:
        value = pattern.sub(make_repl(min_bpm), value)
    return value, bpm_hint


def _sanitize_inferred_title(title: str) -> tuple[str | None, int | None, str | None]:
    value = _clean_filename_token(title)
    if not value:
        return None, None, None
    value, bpm_hint, album_hint = _strip_title_wrappers(value)
    value = _clean_noise(value) or ""
    value, bpm_hint = _strip_inline_bpm(value, bpm_hint)
    value = _clean_noise(value)
    return value, bpm_hint, album_hint


def looks_like_label_name(value: str | None) -> bool:
    if not value:
        return False
    text = _clean_filename_token(value)
    if not text:
        return False
    lowered = text.lower()
    if "(official)" in lowered:
        return True
    return _LABEL_HINT_RE.search(text) is not None


def _looks_like_track_index(value: str | None) -> bool:
    if not value:
        return True
    return re.fullmatch(r"\d{1,3}[.-]?", value.strip()) is not None


def _sanitize_existing_artist(artist: str | None) -> str | None:
    value = _clean_filename_token(artist)
    return value or None


def _infer_tags_from_stem(stem: str) -> dict[str, Any]:
    if not stem:
        return {}
    out: dict[str, Any] = {}
    parts = _DASH_SPLIT.split(stem, maxsplit=1)
    if len(parts) == 2:
        artist = _clean_filename_token(parts[0])
        title, bpm_hint, album_hint = _sanitize_inferred_title(parts[1])
        if _looks_like_artist(artist) and title:
            if looks_like_label_name(artist):
                nested = _DASH_SPLIT.split(parts[1], maxsplit=1)
                if len(nested) == 2:
                    nested_artist = _clean_filename_token(nested[0])
                    # Use locals so a BPM/album already parsed from the full
                    # parts[1] survives when the nested title carries none.
                    nested_title, nested_bpm, nested_album = _sanitize_inferred_title(nested[1])
                    if _looks_like_artist(nested_artist) and nested_title:
                        out["artist"] = nested_artist
                        out["title"] = nested_title
                        out["label"] = artist
                        bpm_final = nested_bpm if nested_bpm is not None else bpm_hint
                        if bpm_final is not None:
                            out["bpm"] = float(bpm_final)
                        if nested_album or album_hint:
                            out["album"] = nested_album or album_hint
                        return out
            out["artist"] = artist
            out["title"] = title
            if bpm_hint is not None:
                out["bpm"] = float(bpm_hint)
            if album_hint:
                out["album"] = album_hint
            return out

    title, bpm_hint, album_hint = _sanitize_inferred_title(stem)
    if title:
        out["title"] = title
    if bpm_hint is not None:
        out["bpm"] = float(bpm_hint)
    if album_hint:
        out["album"] = album_hint
    return out


def _looks_like_artist(value: str | None) -> bool:
    if not value:
        return False
    if len(value) < 2:
        return False
    if re.fullmatch(r"[\d\s.-]+", value):
        return False
    return True


def infer_tags_from_filename(path: Path) -> dict[str, Any]:
    """Best-effort fallback from basename.

    Supported:
    - `Artist - Title.ext`
    - `Artist – Title.ext`
    - `Artist — Title.ext`
    - bare `Title.ext`
    """
    stem = _clean_filename_token(path.stem)
    if not stem:
        return {}
    return _infer_tags_from_stem(stem)


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
    out = {k: v for k, v in out.items() if v is not None}
    if "artist" in out:
        out["artist"] = _sanitize_existing_artist(out.get("artist"))
    title_hint = None
    bpm_hint = None
    album_hint = None
    if out.get("title"):
        title_hint, bpm_hint, album_hint = _sanitize_inferred_title(str(out["title"]))
        parsed_title = _infer_tags_from_stem(str(out["title"]))
        if parsed_title.get("title"):
            title_hint = parsed_title["title"]
        if (
            _looks_like_track_index(out.get("artist"))
            or not out.get("artist")
            or looks_like_label_name(out.get("artist"))
        ) and parsed_title.get("artist"):
            out["artist"] = parsed_title["artist"]
        if not out.get("label") and parsed_title.get("label"):
            out["label"] = parsed_title["label"]
        if bpm_hint is None and parsed_title.get("bpm") is not None:
            bpm_hint = int(parsed_title["bpm"])
        if not album_hint and parsed_title.get("album"):
            album_hint = parsed_title["album"]
    if title_hint:
        out["title"] = title_hint
    if not out.get("album") and album_hint:
        out["album"] = album_hint
    if out.get("bpm") is None and bpm_hint is not None:
        out["bpm"] = float(bpm_hint)
    inferred = infer_tags_from_filename(path)
    if (
        _looks_like_track_index(out.get("artist"))
        or not out.get("artist")
        or looks_like_label_name(out.get("artist"))
    ) and inferred.get("artist"):
        out["artist"] = inferred["artist"]
    if not out.get("label") and inferred.get("label"):
        out["label"] = inferred["label"]
    if not out.get("title") and inferred.get("title"):
        out["title"] = inferred["title"]
    if not out.get("album") and inferred.get("album"):
        out["album"] = inferred["album"]
    if out.get("bpm") is None and inferred.get("bpm") is not None:
        out["bpm"] = inferred["bpm"]
    return out
