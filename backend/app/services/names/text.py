"""Layer 0 (characters) and the one-field string rules of layer 1.

D0-D11 are copies of the regexes in metadata_reader.py (that module imports mutagen and must stay byte-identical in
stage 1), changed only where the name-cleaning plan says so: D1 uses Unicode categories on artist fields, and a
decoration between two words of an artist field becomes the neutral separator SEP instead of ", ".
Every function here is pure: a string in, a string (and the steps it took) out.
"""
from __future__ import annotations

import re
import unicodedata

# The neutral separator: a decoration or a wide gap between two words of an artist field. A private-use code point,
# so it cannot survive D1 (which removes category Co from artist fields) and is never a word character.
SEP = "\ue01e"

_WHITESPACE = re.compile(r"\s+")

# ---------------------------------------------------------------- D0 / N0: characters
_LOST_EMOJI_RE = re.compile("[\uf300-\uf6ff]")
_LOST_MATHS_RE = re.compile("[\ud400-\ud7ff]+")
_ZERO_WIDTH_RE = re.compile("[\u200b-\u200d\u2060\ufeff\u00ad]")
_STYLED_RE = re.compile("[\U0001D400-\U0001D7FF\uFF01-\uFF5E\u2100-\u214F]+")
_TICK_RE = re.compile("(?<=\\w)[`\u00b4\u2019](?=\\w)")
# Latin small capital letters («ʀᴇsᴏɴ ᴍᴜsɪᴄ»): styled lower-case letters, folded like the maths letters of D0
SMALL_CAPS = str.maketrans({"ᴀ": "a", "ʙ": "b", "ᴄ": "c", "ᴅ": "d", "ᴇ": "e", "ꜰ": "f", "ɢ": "g", "ʜ": "h", "ɪ": "i",
                            "ᴊ": "j", "ᴋ": "k", "ʟ": "l", "ᴍ": "m", "ɴ": "n", "ᴏ": "o", "ᴘ": "p", "ǫ": "q", "ʀ": "r",
                            "ꜱ": "s", "ᴛ": "t", "ᴜ": "u", "ᴠ": "v", "ᴡ": "w", "ʏ": "y", "ᴢ": "z"})
_ACUTE_APOSTROPHE_RE = re.compile("(?<=\\w)(?:\u00b4| \u0301)(?=\\w)")


def _lost_plane(value: str) -> str:
    """D0: characters stored without their top plane bit (copied from metadata_reader._lost_plane)."""
    value = _LOST_EMOJI_RE.sub(lambda m: chr(ord(m.group()) + 0x10000), value)
    if re.search(r"[\uAC00-\uD3FF]", value):
        return value

    def maths(match: re.Match[str]) -> str:
        points = [ord(c) + 0x10000 for c in match.group()]
        styles = {(p - 0x1D400) // 52 for p in points if p < 0x1D7CE}
        text = unicodedata.normalize("NFKC", "".join(map(chr, points)))
        fits = len(styles) <= 1 and (len(set(points)) > 1 or not styles)
        return text if fits and re.fullmatch(r"[A-Za-z0-9]+", text) else match.group()

    return _LOST_MATHS_RE.sub(maths, value)


def _styled(match: re.Match[str]) -> str:
    """Maths, fullwidth and letterlike forms that fold to one ASCII character under NFKC («ℭ», «𝘿», «Ａ»)."""
    out = []
    for c in match.group():
        n = unicodedata.normalize("NFKC", c)
        out.append(n if len(n) == 1 and "!" <= n <= "~" else c)
    return "".join(out)


def chars(value: str | None) -> str:
    """D0 and N0: NFC, lost-plane characters, styled and fullwidth letters, zero-width marks, ticks as apostrophes."""
    v = unicodedata.normalize("NFC", value or "")
    v = _lost_plane(v)
    v = _STYLED_RE.sub(_styled, v)
    v = v.translate(SMALL_CAPS)
    v = _ZERO_WIDTH_RE.sub("", v)
    v = _ACUTE_APOSTROPHE_RE.sub("'", v)
    v = _TICK_RE.sub("'", v)
    v = v.replace("\t", " ")
    return v.strip()


# ---------------------------------------------------------------- D1: decorations
# Titles keep today's code-point list (plus «·», «๑», «▱»): the category rule would delete «°» and whole words of
# other scripts from a title.
_DECOR = ("\U0001F000-\U0001F0FF\U0001F1E6-\U0001FFFF\u2600-\u266C\u2670-\u27BF\u2B00-\u2BFF\u2500-\u257F"
          "\u25A0-\u25FF\uFE30-\uFE4F\uFE0F\u200D\u0950\u0AD0•●◉∞·๑▱▰")
_DECOR_GAP_RE = re.compile(rf"(?<=\w)\s+[{_DECOR}]+\s+(?=\w)")
_DECOR_RUN_RE = re.compile(rf"(?<!\w)[{_DECOR}]+|[{_DECOR}]+(?!\w)")
_LONE_MARK_RE = re.compile(r"^\s*[@~*]+\s+|\s+[@~*]+\s*$")
_ARTIST_KEEP_SYMBOLS = set("+~<>=|×&$!")
_DECOR_CATEGORIES = {"So", "Sk", "Co", "Cn", "Cf", "Sm"}


def _is_artist_decoration(c: str) -> bool:
    if c in _ARTIST_KEEP_SYMBOLS:
        return False
    return unicodedata.category(c) in _DECOR_CATEGORIES or c in "•●◉∞·๑▱▰★☆"


def _script(c: str) -> str:
    name = unicodedata.name(c, "")
    return name.split(" ")[0] if name else "?"


def decorations_artist(value: str) -> tuple[str, list[str]]:
    """D1 for an artist field: every symbol of a decoration category goes; one between two words becomes SEP; a
    lone 1-2 letter token in a script no other token uses («ॐ») goes too. Returns the value and what was removed."""
    removed: list[str] = []
    out: list[str] = []
    i = 0
    n = len(value)
    while i < n:
        if not _is_artist_decoration(value[i]):
            out.append(value[i])
            i += 1
            continue
        j = i
        while j < n and _is_artist_decoration(value[j]):
            j += 1
        run = value[i:j]
        left = value[i - 1] if i else ""
        right = value[j] if j < n else ""
        removed.append(run)
        if left.isalnum() and right.isalnum():
            out += [" ", SEP, " "]  # names-4: glued between two words, a decoration is a separator too
            i = j
            continue
        before = "".join(out).rstrip()
        rest = value[j:].lstrip()
        spaced = left.isspace() or right.isspace() or not left or not right
        if before and rest and (before[-1].isalnum() or before[-1] in ")]") \
                and (rest[0].isalnum() or rest[0] in "([") and spaced:
            out = list(before) + [" ", SEP, " "]
            i = j
            while i < n and value[i].isspace():
                i += 1
            continue
        out.append(" ")
        i = j
    v = "".join(out)
    # a lone short token in a script that no other token of the field uses («ॐ Neutra», «PeePeace (ૐ)»)
    tokens = [t for t in re.split(rf"[\s(){{}}\[\]{SEP}]+", v) if t]
    scripts = [{_script(c) for c in t if c.isalpha()} for t in tokens]
    for t, s in zip(tokens, scripts):
        letters = [c for c in t if c.isalpha()]
        if 1 <= len(letters) <= 2 and len(s) == 1:
            others = set().union(*[x for tt, x in zip(tokens, scripts) if tt is not t]) if len(tokens) > 1 else set()
            if others and not (s & others) and s != {"LATIN"}:
                v = re.sub(rf"(?<![\w]){re.escape(t)}(?![\w])", " ", v, count=1)
                removed.append(t)
    v = _WHITESPACE.sub(" ", v).strip()
    v = re.sub(rf"^(?:{SEP}\s*)+|(?:\s*{SEP})+$", "", v).strip()
    v = re.sub(rf"\s*{SEP}\s*(?:{SEP}\s*)*", f" {SEP} ", v)
    return v, [r for r in removed if r]


def decorations_title(value: str) -> tuple[str, bool]:
    """D1 for a title (today's list plus «·», «๑», «▱»): a spaced run between two words becomes « - »."""
    v = _DECOR_GAP_RE.sub(" - ", value)
    v = _DECOR_RUN_RE.sub("", v)
    v = _LONE_MARK_RE.sub(" ", v)
    v = _WHITESPACE.sub(" ", v).strip()
    return v, v != _WHITESPACE.sub(" ", value).strip()


# ---------------------------------------------------------------- D2, D9: empty brackets, orphan tails
_EMPTY_BRACKETS_RE = re.compile(r"\s*[(\[{][^\w()\[\]{}]*[)\]}]|\s*\"[^\w\"]*\"")
_ORPHAN_TAIL_RE = re.compile(rf"(?:\s*(?:/+|\|+|->|\*+|~+|[-–—:]+|{SEP})|\s+[.·]+)+\s*$")
_ORPHAN_HEAD_RE = re.compile(rf"^\s*(?:(?:/+|\|+|\*+|~+|[-–—:.]+|{SEP})\s*)+")
_ORPHAN_PIPE_RE = re.compile(r"\s+\|\s*!?\s*(?=\[|$)")


_DASH_WRAP_TAIL_RE = re.compile(r"(?:^|\s)[-–][^\W_]+[-–]\s*$")
_DASH_WRAP_HEAD_RE = re.compile(r"^\s*[-–][^\W_]+[-–](?:\s|$)")


def tidy(value: str) -> str:
    """D2 and D9: empty brackets, orphan separators at either end, spaces. A name wrapped in dashes («-Z-») keeps
    them."""
    v = _EMPTY_BRACKETS_RE.sub(" ", value)
    v = _ORPHAN_PIPE_RE.sub(" ", v)
    prev = None
    while prev != v:
        prev = v
        if not _DASH_WRAP_TAIL_RE.search(v):
            v = _ORPHAN_TAIL_RE.sub("", v).strip()
        if not _DASH_WRAP_HEAD_RE.match(v):
            v = _ORPHAN_HEAD_RE.sub("", v).strip()
    return _WHITESPACE.sub(" ", v).strip()


# ---------------------------------------------------------------- D3: promo text
_WATERMARK = r"(?:free[\s-]*(?:dow?n?\s*l(?:oa|ao)?d|dl|donwload)|#\s*free\s*download|dowload|downlaod|freedownload)"
_CHART = (r"(?:(?:#|top\s*#?)\s*\d+\s+(?:on\s+)?beatport(?:\s+top\s+\d+)?|beatport\s+top\s*#?\s*\d+"
          r"|#\s*no\.?\s*\d+\s+beatport\s+top\s+\d+)")
WATERMARK_RE = re.compile(
    rf"(?i)\s*[(\[]\s*(?:{_WATERMARK}\s*!*|{_CHART}[^)\]]*)\s*[)\]]"
    rf"|(?<!\S)(?:[-–—]\s*)?{_WATERMARK}\s*!*(?=\s*(?:[/|]|$))"
    rf"|\s+(?:{_CHART}[^()\[\]]*|(?:out\s+now\s+)?on\s+(?:\w+\.)?(?:bandcamp|beatport|youtube|soundcloud)(?:\.com)?)\s*!*$"
)
_PROMO_WORDS = (r"free\s*(?:download|dl)|freedl|out\s*now|premiere|preview|teaser|official\s*(?:music\s*)?"
                r"(?:video|audio)|buy\s*=?\s*free\s*download|click\s*buy|#?\s*freedownload|full\s*track")
PROMO_BRACKET_RE = re.compile(rf"(?i)\s*[(\[]\s*(?:{_PROMO_WORDS})[^)\]]{{0,30}}[)\]]")
PROMO_LEAD_RE = re.compile(r"(?i)^\s*(?:(?:[\w.]+\s+)?premiere|out\s*now|free\s*download|preview|new)\s*[:|\-–]\s*(?=\S)")
SYMBOL_RUN_RE = re.compile(r"\s*(?:[*<>=~_]{2,}|-{3,})\s*")
PROMO_TAIL_RE = re.compile(r"(?i)\s*(?:[-–|]\s*)?(?:free\s*(?:download|dl)|out\s*now|#?freedownload)\s*!*\s*$")
URL_RE = re.compile(r"(?i)\s*(?:[-–|]\s*)?\b(?:https?://\S+|www\.\S+|[\w-]+\.(?:com|net|org|ru|de|io|fm)\b\S*)")
YOUTUBE_TAIL_RE = re.compile(r"(?i)\s+[-–]\s+youtube\s*$")


# technical notes in brackets: bit depth, mastering, file format
TECH_RE = re.compile(r"(?i)\s*[(\[]\s*(?:(?:16|24|32)\s*-?\s*bits?|(?:un)?master(?:ed|ing)?(?:\s+(?:by\s+[^)\]]+|\d{2}(?:\s+\d{2,3})?))?"
                     r"|wav|320\s*kbps|in\s*progress)\s*[)\]}]")
# promo words anywhere outside a version bracket (today's scanner removes them anywhere): «FREE DOWNLOAD NOW»,
# «*fulltrck», «**Preview**», «Out now (on …)»; and a «by <label>» or «- <label> Records» tail
PROMO_ANY_RE = re.compile(r"(?i)[\s\-–|/*★>]*(?<![\w'])(?:free\s*(?:download|dl|dowload|donwload)(?:\s+(?:now|in\s+description|link))?"
                          r"|freedownload|full\s*tr(?:ac)?c?k|fulltrck|preview|coming\s+soon|ep\s+trailer|teaser)\b[\s!*★]*")
OUT_NOW_RE = re.compile(r"(?i)[\s\-–|>*★.]*(?<!\w)(?:out\s*now\b(?:\s+on\b.*)?|now\s+out\b)[\s!*★]*")
BY_LABEL_RE = re.compile(r"(?i)\s*(?:[-–—]\s*)?\bby\s+[^-–—()\[\]]*\b(?:records?|recs?\.?|music|media|productions?|mov)\b[^()\[\]]*$")
DASH_LABEL_RE = re.compile(r"(?i)\s+[-–—]\s+[^-–—()\[\]]*\b(?:records?|recordings|recs?)\b[!.]*\s*$")
VA_TAIL_RE = re.compile(r"(?i)\s+(?:v\.?\s*/?\s*a\.?|various artists)\s*[-–:]\s+.+$|\s+(?:out\s+)?on\s+v\s*\.?\s*/?\s*a\b.*$"
                        r"|\s*[-–]\s*[^-–—()\[\]]*\bV\.?A\.?\s*Vol\.?\s*\d+.*$|\s+v\s*/\s*a\b[^()\[\]]+$"
                        r"|\s+[-–]\s+v\.\s*/?\s*a\.?\s+[^()\[\]]+$")

# ---------------------------------------------------------------- D3 additions (names-3): release notes in titles
# a tail after the last closing bracket that names a label, a compilation, a volume or an EP («(Minimix) Sangoma Recs»,
# «(Original Mix) Hightechnological Therapy VA», «[Yatzee Rmx 2016] 207 Bpm - IN TIME (EP)»)
RELEASE_TAIL_RE = re.compile(
    r"(?i)(?<=[)\]])(?P<tail>\s*[^()\[\]]*?(?:\b(?:records?|recordings|recs?)\.?|\bV\.?\s*/?\s*A\.?|\bvol\.?\s*\d+\.?"
    r"|\bcompiled\s+by\s+[^()\[\]]+|\(\s*E\.?P\.?\s*\)|\bE\.?P\.?(?:\s+(?:19|20)\d\d)?)[\s.!,*]*)$")
# a label wrapped in decorations at the end («Final Round ★AstroFonik Records★»)
WRAPPED_LABEL_RE = re.compile(r"(?i)\s*([★☆•●◉✦✧]+)\s*[^★☆•●◉✦✧]*?\b(?:records?|recordings|recs?|music)\s*[★☆•●◉✦✧]+\s*$")
# a bracket that is a compilation note («(V/A VINAYAKA BonusTrack)», «(VA Modern Witches Vol.3)», «(VA-Dance of shadows)»)
VA_BRACKET_RE = re.compile(r"(?i)\s*[(\[]\s*(?:v\s*/\s*a\.?|v\.a\.?|va\b|various artists)[^()\[\]]*[)\]]"
                           r"|\s*[(\[][^()\[\]]*\b(?:v\s*/\s*a|v\.a\.?|va)\s*[)\]]")
# a bracket that is a release note («(soon out on horrordelic)», «(ReRelease on Major7's Album 17/10)», «(Out Now)»)
RELEASE_BRACKET_RE = re.compile(r"(?i)\s*[(\[]\s*(?:(?:re-?)?re-?release[sd]?|out|soon|coming)\b[^()\[\]]*?\b(?:on|soon|out|now)\b"
                                r"[^()\[\]]*[)\]]")
# «Out on … Label / Album / V.A / Records / EP» to the end («Out on Peyotech Crew Label Album "Coming Soon"»)
OUT_ON_RE = re.compile(r"(?i)\s+(?:out|released|soon\s+out)\s+on\s+[^()\[\]]*?\b(?:label|album|v\.?\s*/?\s*a|va|records?"
                       r"|recs?|ep|lp|bandcamp|beatport|compilation)\b.*$")
# a release date: «Out 9 july», «out July 9th 2024»
_MONTH = r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?"
OUT_DATE_RE = re.compile(rf"(?i)\s+out\s+(?:\d{{1,2}}(?:st|nd|rd|th)?\s+{_MONTH}|{_MONTH}\s+\d{{1,2}}(?:st|nd|rd|th)?)"
                         r"(?:\s+\d{4})?[\s!.]*$")
FULL_ALBUM_RE = re.compile(r"(?i)\s*[-–|]?\s*\bfull\s+album\b[\s!.]*$")
# mastering notes: «(Spiral Master )», «[HyperAdmin MASTER]», «Master By Papa Legba», «] Master», «MasterFinal»,
# «SEMIMASTER», «AlpscoreMASTER», «Ritual IMARAKA MASTER» (a capitals credit after a title in mixed case)
MASTER_BRACKET_RE = re.compile(r"(?i)\s*[(\[][^()\[\]]*\bmaster(?:ed|ing)?\b[^()\[\]]*[)\]]")
MASTER_TAIL_RE = re.compile(r"(?i)\s+master(?:ed)?\s+by\s*:?\s*[^()\[\]]+$|(?<=[)\]])\s*master(?:ed)?\s*$|\s+master\s*final\s*$"
                            r"|\s+(?:semi|pre|no)[\s-]?master(?:ed)?\s*$|(?-i:\s+\w+MASTER)\)?\s*$")
CAPS_MASTER_RE = re.compile(r"(?:\s+|(?<=[)\]]))[A-Z][A-Z0-9]+\s+MASTER\s*$")
# «… by <the chosen artist>» at the end of a title («DMT by JaguarTree»)
BY_TAIL_RE = re.compile(r"(?i)\s+by\s+(?P<who>[^()\[\]]+?)\s*$")
# preview and promo markers as a whole bracket or the last word («(prv)», «200 PRV», «… SAMPLE»)
MARKER_BRACKET_RE = re.compile(r"(?i)\s*[(\[]\s*(?:prv|preview|snippet|sample|teaser|trailer)\s*[)\]]")
MARKER_TAIL_RE = re.compile(r"(?i)\s+(?:prv|preview|snippet)[\s!.]*$|(?-i:\s+SAMPLE)\s*$|\s+[-–]\s*(?:ep\s+)?trailer[\s!.]*$")
HASHTAG_TAIL_RE = re.compile(r"\s+#[^\W\d_][\w']*(?:\s+[\w']+)*\s*$")
SINGLE_BRACKET_RE = re.compile(r"(?i)\s*[(\[]\s*(?:single|e\.?p\.?|lp|album)(?:\s+(?:19|20)\d\d)?\s*[)\]]\s*$")
# a title left with only a release word («Out» from «Out on V.A …»): it held no title
RELEASE_WORD_ONLY_RE = re.compile(r"(?i)^\s*(?:out|released?|soon|coming\s+soon|out\s+now|new|release)\s*[!.]*\s*$")
CATALOGUE_RE = re.compile(r"\s*\[\s*[A-Z]{2,6}\s?-?\d{2,5}\s*\]\s*$")
FILE_EXT_RE = re.compile(r"(?i)\s*\.(?:mp3|wav|flac|aiff?|m4a|ogg|opus)\s*$")
_GENRE_STRONG = (r"(?:psy|goa|hi-?\s?tech|forest|full\s*-?\s*on|prog|twilight|suomi|darkpsy|downtempo|ambient|psybient"
                 r"|chill\s*-?\s*out|techno|trance|reggae|funk|electronica?)")
GENRE_TITLE_BRACKET_RE = re.compile(rf"(?i)\s*[(\[]\s*(?=[^()\[\]]*{_GENRE_STRONG})(?:{{0}})\s*[)\]]\s*$".replace("{0}", "GENRE"))
GENRE_TITLE_DASH_RE = re.compile(rf"(?i)\s+[-–]\s+(?=[^-–]*{_GENRE_STRONG})(?:GENRE)(?<=\b(?:19|20)\d\d)\s*$")
TECH_TAIL_RE = re.compile(r"(?i)\s*[-–]?\s*(?:key[-\s]*[A-G][#b]?m?[-\s]+)?(?:master[-\s]*)?(?:16|24|32)[-\s]*bits?\s*$"
                          r"|\s*[-–]?\s*\(?\s*(?:master|mastered|mastering)\s+by\s*:?\s*[^()\[\]]+\)?\s*$|(?<=\d)\s+master(?:ed)?\s*$"
                          r"|\s*/?\s*\(?\s*no\s*master\s*\)?[\s/|]*$"
                          r"|\s+[-–]\s*(?:official(?:\s+(?:audio|video))?|yt|hq|hd)\s*$")
ALBUM_TRACK_RE = re.compile(r"^(?P<album>[^-–—()\[\]]{3,}?)\s+[-–—]\s*(?P<no>0\d|\d{1,2}\.)\s*(?=\S)")

# ---------------------------------------------------------------- D3r (names-4): release notes as segments of a title
# A title is cut into parts at its outer separators (« - », « | », « / », « ~ », a spaced «!!», a glued «-» after a
# space, an «@handle», a quoted phrase at the end, «for … Records» at the end) and at its top-level brackets. A part
# is a release note when it is a label name, a compilation or release name, or made only of release, promo and
# technical words; trailing notes (and one leading release name) move to the notes.
REL_SEP_RE = re.compile(r"\s+[-–—|/~]+\s+|\s+[-–—](?=[^\W\d_])|\s+!{2,}\s+|\s+(?=(?:\||//)\s*@)"
                        r"|(?<![\w@])\s*(?=@[^\W\d_][\w.]{2,}(?:\s+\w+){0,3}\s*$)"
                        r"|\s+(?=for\s+[^()\[\]]*\b(?:rec|recs|records?|recordings)\b\.?\s*$)"
                        r"|\s*(?=[\"“”][^\"“”]{2,}[\"“”]\s*$)", re.I)
REL_RELEASE = {"ep", "lp", "album", "single", "va", "various", "compilation", "compiled", "vol", "volume", "release",
               "released", "unreleased", "unrelease", "rerelease", "debut", "edition", "bonus", "out", "now", "soon",
               "coming", "available", "new", "premiere", "exclusive", "promo"}
REL_NAME = {"va", "various", "vol", "volume", "compilation", "ep", "lp", "album", "single"}
REL_PROMO = {"free", "download", "downloads", "dl", "freedl", "freedownload", "preview", "prv", "sample", "teaser",
             "trailer", "snippet", "mv", "video", "clip", "youtube", "yt", "lyrics", "description", "link", "below",
             "buy", "bandcamp", "beatport", "soundcloud", "spotify", "visit", "subscribe", "channel", "official",
             "audio", "hq", "hd", "fulltrack", "full", "tracks"}
REL_MASTER = {"master", "mastered", "masterd", "mastering", "remastered"}
REL_WEAK = {"out", "now", "new", "soon", "coming", "available", "full", "bonus", "edition", "tracks", "audio", "official",
            "free", "promo"}
REL_PROMO_STRONG = {"visit", "subscribe", "youtube", "channel", "description", "instagram", "facebook"}
REL_LABEL = {"records", "record", "recordings", "recs", "rec", "label", "productions", "prod"}
REL_TECH = {"bit", "bits", "kbps", "kb", "wav", "mp3", "flac", "aiff", "master", "mastered", "mastering", "masterfinal",
            "semimaster", "premaster", "nomaster", "unmastered"}
REL_FUNC = {"on", "in", "by", "the", "of", "for", "at", "to", "with", "and", "a", "from", "here", "my", "our", "all",
            "is", "&", "+"}
REL_GENRE = {"psy", "psytrance", "psychedelic", "trance", "goa", "hitech", "hi", "tech", "dark", "darkpsy", "forest",
             "fullon", "full-on", "prog", "progressive", "twilight", "night", "psycore", "suomi", "swamp", "downtempo",
             "ambient", "psybient", "chill", "chillout", "electronic", "electronica", "techno", "house", "reggae",
             "funk", "breaks", "glitch", "hybrid", "minimal", "dnb", "psystep", "dubstep", "hi-tech", "darkpsytrance"}
REL_GENRE_WEAK = {"hybrid", "minimal", "dark", "night", "hi", "tech"}
REL_TOKEN_RE = re.compile(r"@\w+|\d+\s?(?:kbps|kb|bits?)\b|[^\W_]+(?:[-.'][^\W_]+)*\.?")
# a bit depth and up to four words after it, at the end («24bit ready to play»)
BIT_TAIL_RE = re.compile(r"(?i)\s+(?:16|24|32)\s?-?bits?\b(?:\s+[\w']+){0,4}[\s!.;:)(]*$")
# a run of capitals that ends with a volume, after a title in mixed case («Funk Master HITECH HARMONY VOL-1»)
CAPS_VOLUME_RE = re.compile(r"(?:\s+[A-Z0-9][A-Z0-9'&]*)+\s+VOL(?:UME)?[\s.\-]*\d+\s*$")
# a final promo word in capitals after a title in mixed case («Soul Shredder FREE»)
CAPS_PROMO_RE = re.compile(r"\s+(?:FREE|PREVIEW|PRV|TEASER|TRAILER|SNIPPET|DL)[\s!.]*$")
# «Label VA - Title»: a label name before a compilation note («Insomnia Rec. VA - Phantom Tune»)
LABEL_VA_HEAD_RE = re.compile(r"(?i)^(?P<label>[^-–—()\[\]]*\b(?:rec|recs|records?|recordings)\b\.?)\s+"
                              r"(?:v\.?\s*/?\s*a\.?|various artists)\s*[-–:]\s+(?P<title>\S.*)$")
ARTIST_LABEL_BRACKET_RE = re.compile(r"(?i)\s*[(\[][^()\[\]]*\b(?:records?|recordings|recs?|music|label|productions?)\.?\s*[)\]]\s*$")

# ---------------------------------------------------------------- D4, D5
# a credit cut at the front: the field starts with a join word («and Apollyon», «vs. Vertstep», «w/Atropp»)
FRAGMENT_RE = re.compile(r"(?i)^\s*(?:(?:&|and|vs\.?|v/s|x|feat\.?|ft\.?|featuring|with)\s+|w/\s*)(?=[^\W\d_])")
# a trailing word wrapped in the same decoration on both sides («Plankton •anomalistic•»)
WRAPPED_WORD_RE = re.compile(r"^(?P<head>.*\w.*?)\s+(?P<d>[•●◉★☆∞·๑▱▰✦✧]+)\s*(?P<word>[^\s•●◉★☆∞·๑▱▰✦✧](?:[^•●◉★☆∞·๑▱▰✦✧]{0,30}"
                             r"[^\s•●◉★☆∞·๑▱▰✦✧])?)\s*(?P=d)\s*$")
# D5 for «X - Y - Rmx»: a bare version word as the last segment takes the segment before it as its credit
DASH_ROLE_ONLY_RE = re.compile(r"(?i)^(.*\S)\s+[-–—]\s+([^-–—()\[\]]+?)\s+[-–—]\s+(remix|rmx|edit|bootleg|vip|rework)\s*$")
ORIGINAL_MIX_RE = re.compile(r"(?i)\s*[(\[]\s*original[\s-]+mix\s*[)\]]|\s+[-–—]\s*original\s+mix\s*$")
DASH_VERSION_RE = re.compile(r"(?i)^(.*\S)\s+[-–—]\s+([^-–—()\[\]]*\b(?:remix|rmx|edit|version|bootleg(?:\s+live)?\s+mix)(?:\s+'?\d{2,4})?)\s*$")


# ---------------------------------------------------------------- N7 / D10: genre words
_GENRE_WORD = (r"(?:(?:dark\s*)?psy(?:[- ]?trance|core|chedelic(?:\s+trance)?)?|hi-?\s?tech|dark\s*psy|darkpsy|forest|goa"
               r"|full\s*-?\s*on|prog(?:ressive)?|trance|twilight|night\s*psy|psycore|dark|ovni|suomi|swamp|music"
               r"|downtempo|ambient|psybient|chill\s*-?\s*out|chill|electronica?|techno|reggae|funk|breaks|glitch|hybrid"
               r"|minimal|new\s+age)")
GENRE_WORDS = rf"{_GENRE_WORD}(?:[\s/&,+-]+{_GENRE_WORD})*(?:\s+(?:19|20)\d\d)?"
GENRE_LEAD_RE = re.compile(rf"(?i)^\s*[\[(]\s*{GENRE_WORDS}\s*[\])]\s*[:|\-–]?\s*(?=\S)")
GENRE_PREFIX_RE = re.compile(rf"(?i)^\s*{GENRE_WORDS}\s*(?:[:|◉]|{SEP})\s*(?=\S)")
GENRE_TAIL_RE = re.compile(rf"(?i)\s*[(\[]\s*{GENRE_WORDS}\s*[)\]]\s*$")
GENRE_ONLY_RE = re.compile(rf"(?i)^\s*{GENRE_WORDS}\s*$")
GENRE_TITLE_BRACKET_RE = re.compile(GENRE_TITLE_BRACKET_RE.pattern.replace("GENRE", GENRE_WORDS))
GENRE_TITLE_DASH_RE = re.compile(GENRE_TITLE_DASH_RE.pattern.replace("GENRE", GENRE_WORDS))
LEAD_BRACKET_RE = re.compile(r"^\s*[\[(]([^\[\]()]{1,30})[\])]\s*[:|\-–]?\s*(?=\S)")

# ---------------------------------------------------------------- N9 / D11: labels, official, Discogs
LABEL_TAIL_RE = re.compile(r"(?i)\s*[(\[][^()\[\]]*\b(?:records?|recordings|recs?)\.?\s*[)\]]\s*$")
OFFICIAL_BRACKET_RE = re.compile(r"(?i)\s*[(\[]\s*official\s*[)\]]\s*$")
OFFICIAL_TAIL_RE = re.compile(r"(?i)\s+official\s*$")
DISCOGS_RE = re.compile(r"\s*\(\d{1,2}\)\s*$|\s*\*+\s*$")
LABEL_WORD_RE = re.compile(r"(?i)\b(?:records?|recordings|recs)\.?\s*$|\b(?:official)\s*$|\bmusic\s*$")

# ---------------------------------------------------------------- N11: tempo and key
TEMPO_RANGE_RE = re.compile(r"(?i)\s*(?<![\w.])(\d{2,3})\s?[-–]\s?\d{2,3}\s?bpm\b\.?")
TEMPO_GENRE_TAIL_RE = re.compile(rf"(?i)\s*(?<![\w.])(\d{{2,3}})\s?-?\s?bpm\b\.?\s*(?:[-–|:]\s*)?{GENRE_WORDS}\s*$")
TEMPO_WORD_RE = re.compile(r"(?i)\s*(?<![\w.])\+?(\d{2,3}(?:[.,]\d+)?)\s?-?\s?\+?bpm\b\.?|\s*\bbpm\s?:?\s?(\d{2,3})\b"
                           r"|\s*(?<![\w.])(\d{2,3})\s?[(\[]\s?bpm\s?[)\]]")
# a bracketed tempo, a range or a list («[201-270-???]»), with «bpm» and genre words after it («(145 - 160BPM Prog
# Trance)»), or a tempo in angle brackets («<180>»)
TEMPO_BRACKET_RE = re.compile(r"(?i)\s*[(\[{]\s*(\d{2,3}(?:[.,]\d+)?)(?:\s*[-–/]\s*(?:\d{2,3}|\?+))*\s*\+?\s*(?:-?\s*bpm)?"
                              rf"(?:\s+{GENRE_WORDS})?\s*[)\]}}]|\s*<\s*(\d{{2,3}})\s*>")
# a tempo and a key together (names-4): «(205D#)», «/ 205A», «146A» after a bracket, «150 A», «B 146»
_KEY = r"[A-G](?:#|b|♯|♭)?(?:m|min|maj)?"
TEMPO_KEY_BRACKET_RE = re.compile(rf"\s*[(\[]\s*(\d{{2,3}})\s?({_KEY})\s*[)\]]")
TEMPO_KEY_TAIL_RE = re.compile(rf"(?:\s*/\s*|\s+|(?<=[)\]]))(\d{{2,3}})\s?({_KEY})(?![\w#♯♭])\s*$|^\s*(\d{{2,3}})\s?({_KEY})\s*$")
KEY_TEMPO_TAIL_RE = re.compile(rf"(?:\s+|^)({_KEY})\s+(\d{{2,3}})\s*$")
# a range or list of tempos at the end, outside brackets («Silence & Pain 173-200», «200/230/170/???»)
TRAILING_RANGE_RE = re.compile(r"(?:\s+|(?<=[)\]]))\+?(\d{2,3})\s?[-–/]\s?(?:\d{2,3}|\?+)(?:\s?[-–/]\s?(?:\d{2,3}|\?+))*\+?"
                               r"(?=\s*(?:[(\[][^()\[\]]*[)\]]\s*)?$)")
# a number glued after a closing bracket at the end («(DER SANDMANN REMIX)220»)
GLUED_NUMBER_RE = re.compile(r"(?<=[)\]])\s*(\d{2,3})\s*$")
# a tempo at the end of a version bracket («(Ferratek & Hypnotherapie Remix 180)»)
VERSION_TEMPO_RE = re.compile(r"\s+(\d{2,3})\s*(?=[)\]]\s*$)")
# a variable-tempo note («(VARI BPM)»)
VARI_BPM_RE = re.compile(r"(?i)\s*[(\[]\s*vari(?:able|ous)?[\s_-]*bpm\s*[)\]]")
# a bare trailing number after a preposition belongs to the title's words («Believe In 200»)
PREPOSITION_NUMBER_RE = re.compile(r"(?i)\b(?:in|of|to|at|on|for|from|by|with|till|until)"
                                   r"\s+\+?\d{2,3}(?:\.\d)?\+?\s*$")
KEY_RE = re.compile(r"(?i)\s*[(\[]\s*(?:(?:1[0-2]|[1-9])[AB]|[A-G][#b♯♭]?\s?(?:m|min|minor|maj|major))\s*[)\]]"
                    r"|\s+[-–]\s+(?:1[0-2]|[1-9])[AB]\s*$")
HZ_RE = re.compile(r"(?i)\s*[(\[]\s*\d{3}\s?hz\s*[)\]]")
TRAILING_NUMBER_RE = re.compile(r"(?:\s+[-–—]\s*|\s+)\+?(\d{2,3}(?:\.\d)?)\+?\s*$|\s+[-–—]\s*\+?(\d{2,3})\+?(?=\s*[(\[][^()\[\]]*[)\]]\s*$)")
MIDDLE_NUMBER_RE = re.compile(r"\s+[-–—]\s+\+?(\d{2,3})\+?\s+(?=[-–—]\s)")
WHOLE_NUMBER_RE = re.compile(r"^\s*\+?(\d{2,3})\+?\s*$")
LEADING_NUMBER_RE = re.compile(r"^\s*(\d{1,3})\s+(?=\S)")
# a bare number right before the final bracket («Going Home 234 (2019 Edit)»), or before a key («Sunny 140 Cmin»):
# a tempo only when the audio agrees (N11)
NUMBER_BEFORE_BRACKET_RE = re.compile(r"(?:\s+[-–—])?\s+\+?(\d{2,3})\+?(?=\s*[(\[][^()\[\]]*[)\]]\s*$)")
LEADING_TEMPO_DASH_RE = re.compile(r"^\s*(\d{2,3})\s*[-–]\s+(?=\S)")
NUMBER_KEY_TAIL_RE = re.compile(r"\s+\+?(\d{2,3})\+?\s+[A-G][#b♯♭]?\s?(?:m|min|minor|maj|major)\s*$")

# ---------------------------------------------------------------- A3: leading track number (raw title tag only)
TRACK_NUMBER_RE = re.compile(r"^\s*(?:0\d{1,2}\s+|\d{1,3}\s*[.)]\s*(?!\d)|\d{1,2}\s*[-–_]\s+(?!\d)|[A-D]\d{1,2}\s*[.)]\s*"
                             r"|track\s*[a-z]?\d{0,3}\s*[-–_:.]\s*)(?=\S)", re.I)

# ---------------------------------------------------------------- title annotations (copied from display_title_hints)
_PROMO_RE = re.compile(
    r"(?i)(?:free[\s_-]*(?:download|dwnld|downloadlink|dl)|freedownload(?:link)?|out now|preview|fulltrack)"
)
_LABEL_HINT_RE = re.compile(r"(?i)\b(?:records?|recs?\.?|music|media|productions?|prod\.?|creation|mpp)\b")
_ALBUM_HINT_RE = re.compile(r"(?i)\b(?:v\.?\s*a\.?|various artists?)\b")
_BITS_HINT_RE = re.compile(r"(?i)^(?:16|24|32)\s*(?:bit|bits)?$")
_TRAILING_CHUNK_RE = re.compile(r"^(.*?)(?:\s*[\[(]([^\])]+)[\])]\s*)$")
_PURE_BPM_RE = re.compile(r"(?i)^\s*(\d{2,3})\+?\s*(?:bpm)?\s*$")
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
    r"|V\.?\s*A\.?\s+[^()[\]]*?\bVol\.?\s*\d+"
    rf"|{_DISPLAY_STATUS})[\s.!]*$"
)
_DISPLAY_EP_RE = re.compile(r"(?i)\bE\.?P\.?$")
VERSION_WORD_RE = re.compile(
    r"(?i)\b(?:remix(?:ed)?|rmx|mix|edit|version|vip|live|remaster(?:ed)?|"
    r"extended|acoustic|instrumental|dub|bootleg|rework|flip|mashup|radio)\b"
)
_DECORATION_RE = re.compile(r"[★☆☠♬ॐ❤🧡💛💚💙💜]+")
_DISPLAY_INLINE_BPM = r"(?<!\w)\+?(?P<bpm>\d{2,3})\+?\s*bpm\b"
_DISPLAY_INLINE_BPM_RE = re.compile(_DISPLAY_INLINE_BPM, re.IGNORECASE)
_DISPLAY_TEMPO_RE = re.compile(
    r"(?i)\((?P<parenthetical>[^()]*)\)|\[(?P<square>[^\[\]]*)\]"
    rf"|{_DISPLAY_INLINE_BPM}"
)


def _is_bpm_value(value: int | None) -> bool:
    return value is not None and 60 <= value <= 400


def _chunk_bpm(text: str | None) -> int | None:
    if not text:
        return None
    m = _PURE_BPM_RE.match(text)
    if not m:
        return None
    bpm = int(m.group(1))
    return bpm if _is_bpm_value(bpm) else None


def title_annotations(title: str) -> tuple[str, float | None]:
    """Today's title annotation rules (metadata_reader.display_title_hints with tidy=False), copied: promo and status
    suffixes, label/V.A/EP/bit-depth chunks at the end, tempo chunks anywhere. Returns the value and the tempo."""
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
        if VERSION_WORD_RE.search(chunk):
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

    while value:
        suffix = _DISPLAY_SUFFIX_RE.search(value)
        if suffix is not None:
            value = value[:suffix.start()].rstrip(" /~–—-|")
            if suffix.group("release") and value.endswith(")") and "(" not in value:
                value = value[:-1].rstrip()
            continue
        match = _TRAILING_CHUNK_RE.match(value)
        if match is None:
            break
        chunk = clean_chunk(match.group(2).strip(), allow_bare=True)
        if VERSION_WORD_RE.search(chunk) or (chunk and not (
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

    value = _DISPLAY_TEMPO_RE.sub(tempo_or_promo_chunk, value).rstrip()
    # names-4: a «!» or «#» glued to the last word is part of the title («Fuck The Rules!», «200C#»); only a detached
    # run at the end (left before a removed promo phrase) goes
    value = _WHITESPACE.sub(" ", value).lstrip(" -–—_|*#!+").rstrip(" -–—_|*+")
    value = re.sub(r"(?:\s+[!#]+)+$", "", value).rstrip(" -–—_|*+")
    return value, bpm


# ---------------------------------------------------------------- keys
LOOKALIKE = str.maketrans({"Δ": "A", "Λ": "A", "Ø": "O", "ø": "o", "∆": "A", "Ʌ": "A", "λ": "a", "δ": "a", "ə": "e",
                           "Ə": "E"})
# names-4: letters of other scripts used as Latin letters inside a word that also has Latin letters («รครt๏кє» =
# Sastoke): the fancy-text alphabet (Thai, Cyrillic, Hebrew shapes); folded only for the key, never shown
FANCY = str.maketrans({"ค": "a", "๒": "b", "ς": "c", "๔": "d", "є": "e", "Ŧ": "f", "ﻮ": "g", "ђ": "h", "เ": "i", "ן": "j",
                       "к": "k", "ɭ": "l", "๓": "m", "ภ": "n", "๏": "o", "ק": "p", "ợ": "q", "г": "r", "ร": "s", "Շ": "t",
                       "ย": "u", "ש": "v", "ฬ": "w", "א": "x", "ץ": "y", "չ": "z", "а": "a", "е": "e", "о": "o", "р": "p",
                       "с": "c", "у": "y", "х": "x", "м": "m", "т": "t", "в": "b", "н": "h", "і": "i", "ј": "j", "ѕ": "s",
                       "К": "K", "А": "A", "Е": "E", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "М": "M", "Н": "H",
                       "В": "B"})
FANCY_CHARS = set("ค๒ςє๔Ŧﻮђเןкɭ๓ภ๏קợгรՇยשฬאץչ")
_LATIN_WORD_RE = re.compile(r"\S+")


def _fancy(value: str) -> str:
    def word(m: re.Match[str]) -> str:
        w = m.group()
        if any("LATIN" in unicodedata.name(c, "") for c in w if c.isalpha()) and any(not c.isascii() for c in w):
            return w.translate(FANCY)
        return w
    return _LATIN_WORD_RE.sub(word, value)


def fold(value: str | None) -> str:
    """The act key (KEY_VERSION 2): NFKC, look-alike letters (names-4: «ə», and the fancy-text letters inside a word that
    also has Latin letters), accents removed, casefold, letters and digits only."""
    v = _fancy(unicodedata.normalize("NFKC", value or "")).translate(LOOKALIKE)
    v = unicodedata.normalize("NFKD", v)
    v = "".join(c for c in v if not unicodedata.combining(c))
    v = v.casefold().replace("&", "and")
    return "".join(c for c in v if c.isalnum())


_GREEK_LATIN = {"α": "a", "β": "v", "γ": "g", "δ": "d", "ε": "e", "ζ": "z", "η": "i", "θ": "th", "ι": "i", "κ": "k",
                "λ": "l", "μ": "m", "ν": "n", "ξ": "x", "ο": "o", "π": "p", "ρ": "r", "σ": "s", "ς": "s", "τ": "t", "υ": "y",
                "φ": "f", "χ": "ch", "ψ": "ps", "ω": "o"}


def latin_key(value: str | None) -> str:
    """The act key with Greek letters written in Latin (ELOT 743 style), for comparing a name in two scripts
    («Ραψωδός Φιλόλογος» = «Rapsodos Filologos»); never shown."""
    v = unicodedata.normalize("NFKD", unicodedata.normalize("NFKC", value or "").casefold())
    v = "".join(_GREEK_LATIN.get(c, c) for c in v if not unicodedata.combining(c))
    return fold(v)


def near(a: str, b: str) -> bool:
    """Two act keys of 6 or more letters that differ by one edit (a letter added, left out, changed, or two
    neighbours swapped)."""
    if a == b:
        return True
    if min(len(a), len(b)) < 6 or abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        diff = [i for i in range(len(a)) if a[i] != b[i]]
        return len(diff) == 1 or (len(diff) == 2 and diff[1] == diff[0] + 1 and a[diff[0]] == b[diff[1]]
                                  and a[diff[1]] == b[diff[0]])
    s, t = (a, b) if len(a) < len(b) else (b, a)
    return any(t[:i] + t[i + 1:] == s for i in range(len(t)))


def skeleton(value: str) -> str:
    """A spelling with case ignored and look-alike letters folded; spaces, hyphens and accents kept (N5)."""
    v = unicodedata.normalize("NFC", value).translate(LOOKALIKE).casefold()
    v = re.sub(r"\s*&\s*", " and ", v)
    v = re.sub(r"\s*([+/~])\s*", r"\1", v).rstrip(".")
    return _WHITESPACE.sub(" ", v).strip()


def words_of(value: str) -> list[str]:
    return [w for w in re.split(r"[^\w]+", fold_words(value)) if w]


def fold_words(value: str) -> str:
    v = unicodedata.normalize("NFKC", value or "").translate(LOOKALIKE)
    v = unicodedata.normalize("NFKD", v)
    v = "".join(c for c in v if not unicodedata.combining(c))
    return v.casefold()


def squash(value: str) -> str:
    return _WHITESPACE.sub(" ", value or "").strip()


def has_word(value: str) -> bool:
    return bool(re.search(r"\w", value or ""))
