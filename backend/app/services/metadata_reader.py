"""Read embedded tags via Mutagen. Never raises on malformed/odd files."""
from __future__ import annotations

import re
import unicodedata
from pathlib import Path
from typing import Any

from mutagen import File as MutagenFile  # type: ignore
from mutagen.easyid3 import EasyID3  # type: ignore
from mutagen.easymp4 import EasyMP4Tags  # type: ignore
from mutagen.id3 import ID3  # type: ignore
from mutagen.mp4 import MP4Tags  # type: ignore

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
# A comment that is only a site address, the mark of a downloader or shop ("www.mediahuman.com",
# "Visit https://label.bandcamp.com"). A link with a path (a SoundCloud permalink) is kept.
_SITE_ONLY_COMMENT = re.compile(r"(?i)^\s*(?:(?:visit\s+)?(?:https?://)?[\w-]+(?:\.[\w-]+)+/?\s*)+$")
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

# Display annotations are matched as whole chunks or at the end of a title.
_DISPLAY_PROMO = _PROMO_RE.pattern.removeprefix("(?i)")
_DISPLAY_PROMO_CHUNK_RE = re.compile(rf"(?:{_DISPLAY_PROMO})(?!\w)", re.IGNORECASE)
_DISPLAY_STATUS = (
    r"(?:released|out)\s+soon|(?:in|on)\s+bandcamp|unmastered|in\s*process|"
    r"master\s*(?:16|24|32)(?:\s*bits?)?|(?:16|24|32)\s*bits?|"
    + _DISPLAY_PROMO
)
_DISPLAY_STATUS_RE = re.compile(_DISPLAY_STATUS, re.IGNORECASE)
_DISPLAY_SUFFIX_RE = re.compile(
    r"(?i)(?<!\w)(?:(?P<release>(?:released|(?:out\s+)?soon)\s+on)\s+"
    r"[^\s()[\]](?:[^()[\]]|\([^()[\]]+\)|\[[^()[\]]+\])*"
    # Compilation suffixes can directly follow BPM without a separator.
    r"|V\.?\s*A\.?\s+[^()[\]]*?\bVol\.?\s*\d+"
    rf"|{_DISPLAY_STATUS})[\s.!]*$"
)
_DISPLAY_EP_RE = re.compile(r"(?i)\bE\.?P\.?$")
_DISPLAY_VERSION_RE = re.compile(
    r"(?i)\b(?:remix(?:ed)?|rmx|mix|edit|version|vip|live|remaster(?:ed)?|"
    r"extended|acoustic|instrumental|dub|bootleg|rework|flip|mashup|radio)\b"
)
_DISPLAY_RELEASE_BPM_RE = re.compile(r"\s+(\d{3})\+?$")
_DISPLAY_INLINE_BPM = r"(?<!\w)\+?(?P<bpm>\d{2,3})\+?\s*bpm\b"
_DISPLAY_INLINE_BPM_RE = re.compile(_DISPLAY_INLINE_BPM, re.IGNORECASE)
_DISPLAY_TEMPO_RE = re.compile(
    r"(?i)\((?P<parenthetical>[^()]*)\)|\[(?P<square>[^\[\]]*)\]"
    rf"|{_DISPLAY_INLINE_BPM}"
)


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
    return value is not None and 60 <= value <= 400


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


def _strip_title_wrappers(title: str, gentle: bool = False) -> tuple[str, int | None, str | None]:
    """Peel trailing bracket chunks off a title.

    gentle=True (embedded tags): strip only promo junk and explicit "NNN bpm"
    chunks — keep years, label names, bits and every other bracket, because an
    embedded title tag is authoritative. gentle=False (filenames): strip all of
    those aggressively.
    """
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
        if not gentle and _ALBUM_HINT_RE.search(raw_chunk):
            album_hint = album_hint or raw_chunk
            value = base
            continue
        chunk = _clean_noise(raw_chunk)
        if not chunk:  # promo/decoration nuked to empty -> strip in both modes
            value = base
            continue
        if gentle:
            # Keep every remaining bracket (years, labels, bits, remix/version
            # notes) in an embedded title. An explicit inline "NNN bpm" is still
            # handled later by _strip_inline_bpm.
            break
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
            if min_bpm <= bpm <= 400:
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


def _sanitize_inferred_title(title: str, gentle: bool = False) -> tuple[str | None, int | None, str | None]:
    value = _clean_filename_token(title)
    if not value:
        return None, None, None
    value, bpm_hint, album_hint = _strip_title_wrappers(value, gentle=gentle)
    value = _clean_noise(value) or ""
    value, bpm_hint = _strip_inline_bpm(value, bpm_hint)
    value = _clean_noise(value)
    return value, bpm_hint, album_hint


def display_title_hints(title: str | None, tidy: bool = True) -> tuple[str, float | None]:
    """Remove explicit metadata wrappers without discarding meaningful title numbers.

    This cleaner operates on the display value. Embedded tags and filename
    provenance stay separate from the inferred title and tempo. tidy=False
    leaves out the display rules (tidy_display_title), for values that are stored.
    """
    value = unicodedata.normalize("NFKC", title or "").strip()
    bpm = None

    def inline_tempo(match: re.Match[str]) -> str:
        nonlocal bpm
        hint = int(match.group("bpm"))
        if not _is_bpm_value(hint):
            return match.group()
        bpm = bpm or float(hint)
        return " "

    def clean_chunk(chunk: str, allow_bare: bool) -> str:
        nonlocal bpm
        if _DISPLAY_VERSION_RE.search(chunk):
            return chunk
        hint = _chunk_bpm(chunk) if allow_bare else None
        if hint is not None:
            bpm = bpm or float(hint)
            return ""
        cleaned = _DISPLAY_INLINE_BPM_RE.sub(inline_tempo, chunk)
        if cleaned != chunk:
            cleaned = _DECORATION_RE.sub(" ", cleaned).strip(" +–—-/~|💀")
            if cleaned.casefold() == "demo":
                return ""
        return "" if _DISPLAY_PROMO_CHUNK_RE.match(cleaned.strip()) else cleaned

    release_suffix = False
    while value:
        suffix = _DISPLAY_SUFFIX_RE.search(value)
        if suffix is not None:
            value = value[:suffix.start()].rstrip(" /~–—-|")
            if suffix.group("release"):
                release_suffix = True
                # A clipped edit can retain only its closing delimiter.
                if value.endswith(")") and "(" not in value:
                    value = value[:-1].rstrip()
            continue
        match = _TRAILING_CHUNK_RE.match(value)
        if match is None:
            break
        chunk = clean_chunk(match.group(2).strip(), allow_bare=True)
        if _DISPLAY_VERSION_RE.search(chunk) or (chunk and not (
            _LABEL_HINT_RE.search(chunk) or _ALBUM_HINT_RE.search(chunk)
            or _DISPLAY_EP_RE.search(chunk) or _BITS_HINT_RE.fullmatch(chunk)
            or _DISPLAY_STATUS_RE.fullmatch(chunk)
        )):
            break
        value = match.group(1).rstrip(" /~–—-|")

    def tempo_or_promo_chunk(match: re.Match[str]) -> str:
        parenthetical, square = match.group("parenthetical", "square")
        chunk = square if square is not None else parenthetical
        if chunk is None:
            return inline_tempo(match)
        cleaned = clean_chunk(chunk, allow_bare=square is not None)
        if cleaned == chunk:
            return match.group()
        return f"{match.group()[0]}{cleaned}{match.group()[-1]}" if cleaned else " "

    # Consume complete chunks so a named version can contain BPM text.
    value = _DISPLAY_TEMPO_RE.sub(tempo_or_promo_chunk, value).rstrip()
    if release_suffix and bpm is None:
        version = _TRAILING_CHUNK_RE.match(value)
        base = version.group(1) if version and _DISPLAY_VERSION_RE.search(version.group(2)) else value
        if (hint := _DISPLAY_RELEASE_BPM_RE.search(base)) and 130 < int(hint.group(1)) <= 400:
            bpm = float(hint.group(1))
            value = base[:hint.start()] + value[len(base):]

    value = _DECORATION_RE.sub(" ", value)
    value = _WHITESPACE.sub(" ", value).strip(" -–—_|*#!+")
    value = value or (title or "").strip()
    # The display rules run after the tempo is read, so they never change the hint.
    return (tidy_display_title(value) if tidy else value), bpm


# Display rules D0-D11 (.omc/research/next-ideas-2026-11-27/title-cleaning.md). They tidy the shown value only;
# stored tags and catalog rows keep the original, and a rule never empties a value.
# D0: characters stored without their top plane bit. U+F300-F6FF were the emoji U+1F300-1F6FF; a run of
# U+D400-D7FF was a run of maths letters U+1D400-1D7FF when it maps to one maths style and folds to ASCII.
_LOST_EMOJI_RE = re.compile("[\uf300-\uf6ff]")
_LOST_MATHS_RE = re.compile("[\ud400-\ud7ff]+")
# D1: decorations. A run is removed unless it sits between two letters ("ձռց☢ռε" keeps it); a spaced run between two
# words is a separator ("A • B"). ♭♮♯ and the enclosed letters U+1F100-1F1E5 ("🅰🅲") are left alone.
_DECOR = ("\U0001F000-\U0001F0FF\U0001F1E6-\U0001FFFF\u2600-\u266C\u2670-\u27BF\u2B00-\u2BFF\u2500-\u257F"
          "\u25A0-\u25FF\uFE30-\uFE4F\uFE0F\u200D\u0950\u0AD0•●◉∞")
_DECOR_GAP_RE = re.compile(rf"(?<=\w)\s+[{_DECOR}]+\s+(?=\w)")
_DECOR_RUN_RE = re.compile(rf"(?<!\w)[{_DECOR}]+|[{_DECOR}]+(?!\w)")
_LONE_MARK_RE = re.compile(r"^\s*[@~*]+\s+|\s+[@~*]+\s*$")
# D2: empty brackets anywhere, and separators left over at the end.
_EMPTY_BRACKETS_RE = re.compile(r"\s*[(\[{]\s*[)\]}]")
_ORPHAN_TAIL_RE = re.compile(r"(?:\s+(?:/+|\|+|->|\*+|~+|[-–—]+))+\s*$")
_ORPHAN_PIPE_RE = re.compile(r"\s+\|\s*!?\s*(?=\[|$)")
# D3: misspelt download watermarks, chart positions and "on <store>" at the end. A watermark outside brackets
# goes only before the end or a separator, so "[Free Download Remix]" stays.
_WATERMARK = r"(?:free\s*(?:dow?n?\s*l(?:oa|ao)?d|dl)|#\s*free\s*download|dowload|downlaod)"
_CHART = (r"(?:(?:#|top\s*#?)\s*\d+\s+(?:on\s+)?beatport(?:\s+top\s+\d+)?|beatport\s+top\s*#?\s*\d+"
          r"|#\s*no\.?\s*\d+\s+beatport\s+top\s+\d+)")
_WATERMARK_RE = re.compile(
    rf"(?i)\s*[(\[]\s*(?:{_WATERMARK}\s*!*|{_CHART}[^)\]]*)\s*[)\]]"
    rf"|(?<!\S)(?:[-–—]\s+)?{_WATERMARK}\s*!*(?=\s*(?:[/|]|$))"
    rf"|\s+(?:{_CHART}[^()\[\]]*|(?:out\s+now\s+)?on\s+(?:\w+\.)?(?:bandcamp|beatport|youtube|soundcloud)(?:\.com)?)\s*!*$"
)
# D4 and D5: "(Original Mix)" goes; "Title - X Remix" reads "Title (X Remix)".
_ORIGINAL_MIX_RE = re.compile(r"(?i)\s*[(\[]\s*original\s+mix\s*[)\]]|\s+[-–—]\s*original\s+mix\s*$")
_DASH_VERSION_RE = re.compile(r"(?i)^(.*\S)\s+[-–—]\s+([^-–—()\[\]]*\b(?:remix|rmx|edit|version))\s*$")
# D8: an acute accent typed for an apostrophe ("It ́s", "O´Leary"; NFKC turns ´ into a space and U+0301).
_ACUTE_APOSTROPHE_RE = re.compile("(?<=\\w)(?:\u00b4| \u0301)(?=\\w)")
# D10: genre words wrapped round an artist ("[HiTech Darkpsy Psytrance] X", "PSY-TRANCE ◉ X", "X (PSYTRANCE)").
_GENRE = (r"\b(?:(?:dark\s*)?psy[- ]?trance|hi-?tech|dark\s*psy|forest|goa|full\s*on|progressive|psychedelic"
          r"|trance|psycore)\b")
_GENRE_WRAP_RE = re.compile(
    rf"(?i)^[\s{_DECOR}]*\[[^\]]*{_GENRE}[^\]]*\]\s*|^\s*{_GENRE}(?:[\s/&-]+{_GENRE})*\s*[:◉|]\s*"
    rf"|\s*\(\s*{_GENRE}\s*\)\s*$"
)
# D11: a trailing "(… Records)" chunk names the label, not the act.
_ARTIST_LABEL_TAIL_RE = re.compile(r"(?i)\s*[(\[][^()\[\]]*\b(?:records?|recordings|recs?)\.?\s*[)\]]\s*$")


def _lost_plane(value: str) -> str:
    value = _LOST_EMOJI_RE.sub(lambda m: chr(ord(m.group()) + 0x10000), value)
    if re.search(r"[\uAC00-\uD3FF]", value):
        return value  # other Hangul syllables beside them: the field is Korean

    def maths(match: re.Match[str]) -> str:
        points = [ord(c) + 0x10000 for c in match.group()]
        styles = {(p - 0x1D400) // 52 for p in points if p < 0x1D7CE}
        text = unicodedata.normalize("NFKC", "".join(map(chr, points)))
        # One maths style per word, and one repeated letter is not enough ("하하"): a Korean word mixes the "styles".
        fits = len(styles) <= 1 and (len(set(points)) > 1 or not styles)
        return text if fits and re.fullmatch(r"[A-Za-z0-9]+", text) else match.group()

    return _LOST_MATHS_RE.sub(maths, value)


def _gap(match: re.Match[str], joiner: str) -> str:
    """What replaces a removed chunk: the joiner when words sit on both sides of it, so they stay apart."""
    inside = match.string[:match.start()].strip() and re.match(r"\s*\w", match.string[match.end():])
    return joiner if inside else " "


def _tidy(value: str, joiner: str = " - ") -> str:
    """D1, D2, D8 and D9, shared by titles and artists (joiner ", " for artists)."""
    value = _DECOR_GAP_RE.sub(joiner, value)
    value = _DECOR_RUN_RE.sub("", value)
    value = _LONE_MARK_RE.sub(" ", value)
    value = _EMPTY_BRACKETS_RE.sub(lambda m: _gap(m, joiner), value)
    value = _ORPHAN_PIPE_RE.sub(" ", value)
    value = _ORPHAN_TAIL_RE.sub("", value)
    value = _ACUTE_APOSTROPHE_RE.sub("'", value)
    return _WHITESPACE.sub(" ", value).strip()


def tidy_display_title(title: str | None) -> str:
    """The display rules for a title: D0, D1, D3, D4, D5, then D2, D8 and D9 on what they leave."""
    original = (title or "").strip()
    value = _tidy(_lost_plane(original))
    watermarked = _WATERMARK_RE.sub(" ", value)
    value = watermarked if re.search(r"\w", watermarked) else value
    value = _ORIGINAL_MIX_RE.sub(lambda m: _gap(m, " - "), value)
    value = _DASH_VERSION_RE.sub(r"\1 (\2)", value.strip())
    return _tidy(value) or original


def display_artist_hints(artist: str | None) -> str:
    """The shown artist: D0, D10, D1, D2, D11, D8 and D9 (display only, like display_title_hints)."""
    original = (artist or "").strip()
    value = _lost_plane(original)
    value = _GENRE_WRAP_RE.sub("", value) or value
    value = _tidy(value, ", ")
    unlabelled = _ARTIST_LABEL_TAIL_RE.sub("", value)
    value = unlabelled if re.search(r"\w", unlabelled) else value
    return value or original



def display_title_comments(title: str | None) -> list[dict[str, str]]:
    """Keep useful stripped annotations as comments, not as personal notes."""
    value = unicodedata.normalize("NFKC", title or "").strip()
    if not value or display_title_hints(value)[0] == value:
        return []
    comments = []
    while value:
        suffix = _DISPLAY_SUFFIX_RE.search(value)
        chunk = _TRAILING_CHUNK_RE.match(value) if suffix is None else None
        if suffix:
            annotation = suffix.group().strip(" .!")
            base = value[:suffix.start()].rstrip(" /~–—-|")
        elif chunk and display_title_hints(value)[0] == display_title_hints(chunk.group(1))[0]:
            annotation = chunk.group(2).strip()
            base = chunk.group(1).rstrip()
        else:
            break
        token = re.sub(r"\s+", "", annotation).casefold()
        comment = None
        if token == "unmastered":
            comment = {"kind": "unmastered", "text": "Χωρίς mastering (unmastered)"}
        elif token == "inprocess":
            comment = {"kind": "in_progress", "text": "Σε επεξεργασία"}
        elif bit_depth := re.fullmatch(r"(master)?(16|24|32)(?:bits?)?", token):
            mastered, bits = bit_depth.groups()
            comment = {"kind": "mastering_bit_depth" if mastered else "bit_depth",
                       "text": f"Mastering {bits} bit" if mastered else f"Ένδειξη {bits} bit"}
        if comment and comment not in comments:
            comments.append(comment)
        value = base
    return comments


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
    # A leading 1-3 digit number goes, as on a filename. Measured on the owner's library (2026-11-24): all 18 artist
    # tags it touches carry a track index ("2 Sectio Aurea", "1- Zaaki"), none a name like "220 Volt".
    value = _clean_filename_token(artist)
    return value or None


def _apply_hints(out: dict[str, Any], bpm_hint: int | None, album_hint: str | None) -> dict[str, Any]:
    if bpm_hint is not None:
        out["bpm"] = float(bpm_hint)
    if album_hint:
        out["album"] = album_hint
    return out


def _infer_label_artist_title(
    label: str, rest: str, bpm_hint: int | None, album_hint: str | None, gentle: bool
) -> dict[str, Any] | None:
    """`Label - Artist - Title`: re-split the remainder, or None if it isn't one."""
    nested = _DASH_SPLIT.split(rest, maxsplit=1)
    if len(nested) != 2:
        return None
    nested_artist = _clean_filename_token(nested[0])
    # Use locals so a BPM/album already parsed from the full remainder
    # survives when the nested title carries none.
    nested_title, nested_bpm, nested_album = _sanitize_inferred_title(nested[1], gentle=gentle)
    if not (_looks_like_artist(nested_artist) and nested_title):
        return None
    out: dict[str, Any] = {"artist": nested_artist, "title": nested_title, "label": label}
    bpm_final = nested_bpm if nested_bpm is not None else bpm_hint
    return _apply_hints(out, bpm_final, nested_album or album_hint)


def _infer_artist_title(head: str, rest: str, gentle: bool) -> dict[str, Any] | None:
    """`Artist - Title` (or `Label - Artist - Title`), or None if it isn't one."""
    artist = _clean_filename_token(head)
    title, bpm_hint, album_hint = _sanitize_inferred_title(rest, gentle=gentle)
    if not (_looks_like_artist(artist) and title):
        return None
    if looks_like_label_name(artist):
        labelled = _infer_label_artist_title(artist, rest, bpm_hint, album_hint, gentle)
        if labelled is not None:
            return labelled
    return _apply_hints({"artist": artist, "title": title}, bpm_hint, album_hint)


def _infer_tags_from_stem(stem: str, gentle: bool = False) -> dict[str, Any]:
    if not stem:
        return {}
    parts = _DASH_SPLIT.split(stem, maxsplit=1)
    if len(parts) == 2:
        inferred = _infer_artist_title(parts[0], parts[1], gentle)
        if inferred is not None:
            return inferred

    title, bpm_hint, album_hint = _sanitize_inferred_title(stem, gentle=gentle)
    out: dict[str, Any] = {"title": title} if title else {}
    return _apply_hints(out, bpm_hint, album_hint)


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
    from .tempo import positive_bpm

    if not raw:
        return None
    m = re.search(r"([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)", raw)
    try:
        return positive_bpm(float(m.group(1))) if m else None
    except (ValueError, AttributeError):
        return None


def _should_replace_artist(current: str | None, candidate: str | None) -> bool:
    """Whether a filename/title-derived `candidate` should override the stored
    `current` artist. Empty or track-number artists are always replaced; a
    label-looking artist is replaced only by a genuinely different, non-label
    name, so a real act whose name contains a label word ("Cosmic Music") is
    kept while a comp that mis-tagged the label as artist is still corrected."""
    if not candidate:
        return False
    if not current or _looks_like_track_index(current):
        return True
    if looks_like_label_name(current):
        return (
            candidate.strip().lower() != current.strip().lower()
            and not looks_like_label_name(candidate)
        )
    return False


def _open_audio(path: Path) -> Any:
    """Mutagen handle (easy view first, raw fallback), or None if unreadable."""
    try:
        audio = MutagenFile(path, easy=True)
    except Exception:
        audio = None
    if audio is not None:
        return audio
    try:
        return MutagenFile(path)
    except Exception:
        return None


def _lookup(audio: Any, raw_keys: dict[str, Any], candidates: tuple[str, ...]) -> str | None:
    for cand in candidates:
        key = raw_keys.get(cand.lower())
        if key is None:
            continue
        try:
            return _first(audio[key])
        except Exception:
            continue
    return None


def _raw_tags(audio: Any, path: Path) -> Any:
    """The tag frames themselves. Mutagen's easy view of MP3 and M4A does not list the key,
    comment, rating and label frames, so those files are opened once more without it."""
    tags = getattr(audio, "tags", None)
    if not isinstance(tags, (EasyID3, EasyMP4Tags)):
        return tags
    try:
        return MutagenFile(path).tags
    except Exception:
        return None


def _text_stars(raw: str) -> int | None:
    """A written rating as 1-5 stars: 1-5 as it is, 0-100 in steps of 20, above that as POPM."""
    try:
        value = float(raw)
        if value <= 0:
            return None
        if value <= 5:
            return max(1, int(value + 0.5))
        if value <= 100:
            return max(1, int(value / 20 + 0.5))
        return _popm_stars(int(value))
    except (ValueError, TypeError, OverflowError):
        return None


def _popm_stars(rating: int) -> int | None:
    """ID3 POPM (0-255, 0 = unrated) as 1-5 stars, in the bands Windows writes: 1, 64, 128, 196, 255."""
    return min(5, (rating + 32) // 64 + 1) if rating > 0 else None


def _id3_extras(tags: ID3) -> dict[str, Any]:
    """Key, comment and rating from ID3 frames (MP3, and the ID3 chunk of AIFF and WAV)."""
    user_text = {frame.desc.lower(): frame for frame in tags.getall("TXXX")}
    key_frames = (tags.get("TKEY"), user_text.get("initialkey"), user_text.get("key"))
    comments = tags.getall("COMM")
    return {
        "key_text": next((text for frame in key_frames if frame is not None and (text := _first(frame.text))), None),
        # The comment proper has no description; the others are players' own data (iTunNORM, …).
        "comment": next((text for desc in ("", "ID3v1 Comment") for frame in comments
                         if frame.desc == desc and (text := _first(frame.text))), None),
        "rating": next((stars for frame in tags.getall("POPM") if (stars := _popm_stars(frame.rating))), None),
    }


def _mp4_extras(tags: MP4Tags) -> dict[str, Any]:
    """Key and label from the iTunes freeform atoms of an M4A."""
    prefix = "----:com.apple.itunes:"
    freeform = {str(key).lower().removeprefix(prefix): values
                for key, values in tags.items() if str(key).lower().startswith(prefix)}

    def text(*names: str) -> str | None:
        return next((decoded for name in names for value in freeform.get(name) or ()
                     if (decoded := bytes(value).decode("utf-8", "replace").strip())), None)

    return {"key_text": text("initialkey", "key"), "label": text("label")}


def _read_embedded(audio: Any, path: Path) -> dict[str, Any]:
    # Build a case-insensitive lookup of available tag keys.
    try:
        raw_keys = {str(k).lower(): k for k in audio.keys()}
    except Exception:
        raw_keys = {}

    out: dict[str, Any] = {}
    for field, candidates in _FIELDS.items():
        out[field] = _lookup(audio, raw_keys, candidates)

    out["year"] = _coerce_year(out.pop("date", None))
    out["bpm"] = _coerce_bpm(out.get("bpm"))

    # Track.rating is 1-5 stars whatever scale the file uses — best effort
    rating = _lookup(audio, raw_keys, ("rating",))
    if rating:
        out["rating"] = _text_stars(rating)

    # Frames the lookup above cannot reach fill the fields it left empty.
    try:
        raw = _raw_tags(audio, path)
        extras = _id3_extras(raw) if isinstance(raw, ID3) else _mp4_extras(raw) if isinstance(raw, MP4Tags) else {}
    except Exception:
        extras = {}
    for field, value in extras.items():
        if out.get(field) is None:
            out[field] = value
    if out.get("comment") and _SITE_ONLY_COMMENT.match(out["comment"]):
        out["comment"] = None
    return {k: v for k, v in out.items() if v is not None}


def _apply_title_hints(out: dict[str, Any]) -> None:
    """Parse the embedded title for artist/label/BPM/album hints, in place."""
    if not out.get("title"):
        return
    # gentle: the title is an embedded tag, so keep years/labels/brackets.
    title_hint, bpm_hint, album_hint = _sanitize_inferred_title(str(out["title"]), gentle=True)
    parsed_title = _infer_tags_from_stem(str(out["title"]), gentle=True)
    if parsed_title.get("title"):
        title_hint = parsed_title["title"]
    if _should_replace_artist(out.get("artist"), parsed_title.get("artist")):
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


def _fill_from_filename(out: dict[str, Any], path: Path) -> None:
    """Fill gaps (and a weak artist) from the basename, in place."""
    inferred = infer_tags_from_filename(path)
    if _should_replace_artist(out.get("artist"), inferred.get("artist")):
        out["artist"] = inferred["artist"]
    for field in ("label", "title", "album"):
        if not out.get(field) and inferred.get(field):
            out[field] = inferred[field]
    if out.get("bpm") is None and inferred.get("bpm") is not None:
        out["bpm"] = inferred["bpm"]


def read_tags(path: Path) -> dict[str, Any]:
    """Return a dict of normalised embedded tags. Empty dict on unreadable file."""
    audio = _open_audio(path)
    if audio is None:
        return {}
    out = _read_embedded(audio, path)
    if "artist" in out:
        out["artist"] = _sanitize_existing_artist(out.get("artist"))
    _apply_title_hints(out)
    _fill_from_filename(out, path)
    return out
