"""names-6: what leaves a title is kept, and a cleaned title never shouts more than its sources.

- N30: a cleaned title never shouts more than the value the app shows today: a word with more capitals than today's
  takes the linked record's spelling (Spotify or SoundCloud), else today's («INFINITY» where today shows Spotify's
  «Infinity» → «Infinity»). The plan keeps a title's own casing (no first-capital rule for titles), so nothing else
  changes case.
- D3p, D3n, D3c: every piece of the tag's title that is in no field and no fact of the result (a promo note, a
  preview word, a label, a mastering credit) is kept on the row: a preview word as the fact «preview» (the file is a
  preview), a label or a release name as that fact, anything else as a note from the title; a piece with words that
  are no release, promo or technical vocabulary may name an act or a label, so the row is `look`.
- D3l: a final bracket whose name the library knows only as a label («Moon Rox [Labelname]») leaves the title as
  the label fact.

Pure functions: strings and plain sets in, strings and steps out.
"""
from __future__ import annotations

import difflib
import re

from . import text as T
from .fields import release_kind
from .lexer import NAMEISH_RE, bracket_kind, brackets
from .model import Step

WORD_RE = re.compile(r"[^\W_]+(?:['’][^\W_]+)*")
PREVIEW_WORDS = {"preview", "prv", "trailer", "teaser", "sample", "snippet", "demo"}
# words that only wrap a release note («out on …», «released by …»): silent when the note itself was kept
WRAPPER_WORDS = {"out", "released", "release", "available", "coming", "soon", "now", "on", "at", "by", "via", "in",
                 "from", "the", "upcoming", "new", "exclusively", "album", "ep", "lp", "va", "compiled", "rerelease"}
JOIN_TOKENS = {"x", "vs", "feat", "ft", "featuring", "with", "and", "e", "y", "b2b", "meets", "pres", "presents"}
VERSION_TOKENS = {"original", "orginal", "mix", "remix", "rmx", "remx", "edit", "version", "bootleg", "rework", "vip",
                  "extended", "radio", "dub", "instrumental", "live", "cover", "mashup", "flip", "refix"}
# release, promo and technical words the shared lists miss (misspellings and glued forms seen in downloads)
EXTRA_VOCAB = {"bpm", "dowload", "downlaod", "donwload", "downlod", "dwnld", "downloadlink", "freedownloadlink", "fulltrck",
               "inprocess", "unrelease", "releases", "track", "top", "lyrics", "link", "buy", "thanks", "follower",
               "followers", "free", "unmastered", "masterfinal", "premaster", "semimaster", "https", "http", "www", "com",
               "offical", "music", "age", "ready", "play", "key", "series"}
LEAD_WRAPPER_RE = re.compile(r"(?i)^(?:(?:out|released?|available|coming|soon|now|on|at|by|via|in|from|the|upcoming"
                             r"|new|exclusively)\s+)+")
YEAR_END_RE = re.compile(r"\s+(?:19|20)\d\d\s*$")
LABEL_PART_RE = re.compile(r"(?i)\b(?:records?|recordings|recs?|label|productions?|music)\.?\s*$")
# a label name inside a kept run: up to its label word («Sangoma Records», «ADN Music»; «Official Music Video» is no label)
LABEL_IN_RE = re.compile(r"(?i)\b(?:records?|recordings|recs?|label|productions?)\b\.?|(?<=\w)\s+music\b(?!\s+video)")
MONTH_RE = re.compile(r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*")
# names-7: promo words around a label or album fact («OUT NOW ON X Records», «Release@X Records», «X OUT SOON»)
FACT_LEAD_RE = re.compile(r"(?i)^(?:(?:re-?)?releas(?:e|ed)|out|now|soon|coming|available|buy|exclusively|upcoming)\b"
                          r"(?:\s*@|\s+(?:on|at|via|by)\b)?\s*|^@\s*|^(?:on|by)\s+(?=v\.?\s*/?\s*a\b|various\b"
                          r"|.*\b(?:records?|recordings|recs?|label)\.?$)")
# a label in a bracket after the release name («V.A. Moonway [Lumo Records]»)
FACT_BRACKET_LABEL_RE = re.compile(r"(?i)^(?P<what>.*?)\s*[(\[](?P<label>[^()\[\]]*\b(?:records?|recordings|recs?|label|music"
                                   r"|productions?)\.?)\s*[)\]]$")
FACT_EDGE = " -–—|,:;!@*\"“”'"
FACT_DATE_RE = re.compile(r"^(?P<date>\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?)\s+(?i:on|at)\s+(?=\S)")
FACT_TAIL_RE = re.compile(r"(?i)\s*[-–—:|]?\s*\b(?:out\s+now|out\s+soon|coming\s+soon|soon|now|available\s+now)\b[\s!.]*$")
FACT_SPLIT_RE = re.compile(r"(?i)\s+(?:out\s+now|out\s+soon|coming\s+soon|soon|(?:re-?)?released?)\s+(?:on|at|by|via)\s+")
FACT_BY_LABEL_RE = re.compile(r"(?i)^(?P<what>.+?)\s+by\s+(?P<label>[^()\[\]]*\b(?:records?|recordings|recs?|label|music"
                              r"|productions?)\.?)$")
LABEL_WORD_END_RE = re.compile(r"(?i)\b(?:records?|recordings|recs?|label|music|productions?)\.?$")
# credit words before a name the result already holds («produced by X», «aka X»)
CREDIT_WORDS = {"produced", "prod", "mixed", "composed", "written", "aka", "dj", "mc"}


def _caps(s: str) -> int:
    return sum(1 for c in s if c.isupper())


def _aligned(keys: list[str], src: str) -> dict[int, str]:
    """Title word index -> the source's word with the same letters (case only), by a difflib alignment of the folded
    words; empty unless at least half of the title's words are matched."""
    words = [m.group() for m in WORD_RE.finditer(src or "")]
    if not words:
        return {}
    sm = difflib.SequenceMatcher(None, keys, [T.fold(w) for w in words], autojunk=False)
    blocks = [b for b in sm.get_matching_blocks() if b.size]
    if 2 * sum(b.size for b in blocks) < len(keys):
        return {}
    return {b.a + i: words[b.b + i] for b in blocks for i in range(b.size)}


# names-7: short words written in capitals that are no acronym («OF», «THE», «YOU»)
CAPS_WORDS = {"you", "are", "our", "my", "me", "we", "it", "its", "is", "be", "am", "so", "go", "up", "no", "oh", "not",
              "all", "one", "two", "new", "old", "out", "big", "bad", "sun", "god", "war", "day", "way", "man", "her",
              "his", "she", "he", "him", "who", "why", "how", "yes", "let", "get", "got", "now", "far", "low", "red"}


def acronym(word: str) -> bool:
    """names-7: a short word written in capitals that reads as an acronym («DMT», «4K», «TV», «UFO»), not a short word
    of the title's language shouted («OF», «THE», «YOU»)."""
    ls = [c for c in word if c.isalpha()]
    low = word.casefold()
    return (2 <= len(word) <= 4 and 1 <= len(ls) <= 3 and all(c.isupper() for c in ls)
            and low not in JOIN_TOKENS and low not in T.REL_FUNC and low not in CAPS_WORDS)


def quieter_title(title: str, today: str, records: list[tuple[str, str]]) -> tuple[str, str]:
    """N30: a word of the title written with more capitals than the value the app shows today («INFINITY» where today
    shows «Infinity») takes the linked record's spelling of it (Spotify or SoundCloud, the one with fewest capitals,
    never more than today's), else today's. Only case changes; a version word («Remix») keeps the engine's form.
    names-7: in a title that does not shout (a word in lower case, or one word only) an acronym keeps its capitals
    («4K Dawn», «DMT») unless every linked record that writes the word writes it with fewer.
    Returns the title and the sources used ('' when nothing changed)."""
    toks = list(WORD_RE.finditer(title))
    if not toks or not today:
        return title, ""
    keys = [T.fold(m.group()) for m in toks]
    now = _aligned(keys, today)
    recs = [(name, _aligned(keys, src)) for name, src in records]
    best: dict[int, str] = {}
    used: list[str] = []
    quiet = len(toks) == 1 or any(any(c.islower() for c in m.group()) for m in toks)
    for i, m in enumerate(toks):
        ours, shown = m.group(), now.get(i)
        if shown is None or shown.casefold() != ours.casefold() or _caps(ours) <= _caps(shown) \
                or ours.casefold() in VERSION_TOKENS:
            continue
        marks = [w for w in (al.get(i) for _, al in recs) if w is not None]
        if quiet and acronym(ours) and (not marks or any(_caps(w) >= _caps(ours) for w in marks)):
            continue  # names-7: «DMT», «4K» keep their capitals unless every linked record writes the word quieter
        pick, src = shown, "today"
        for name, al in recs:
            w = al.get(i)
            if w is not None and w.casefold() == ours.casefold() and _caps(w) <= _caps(pick) and src == "today":
                pick, src = w, name
        best[i] = pick
        if src not in used:
            used.append(src)
    if not best:
        return title, ""
    out, last = [], 0
    for i, m in enumerate(toks):
        out.append(title[last:m.start()])
        out.append(best.get(i, m.group()))
        last = m.end()
    out.append(title[last:])
    return "".join(out), ",".join(used)


def part_spans(text: str) -> list[tuple[int, int]]:
    """The parts of a title (as fields.release_parts cuts it: outer separators and top-level brackets), as spans; a
    bracket part keeps its brackets."""
    spans = [(b.start, b.end) for b in brackets(text)]
    cuts = [(m.start(), m.end()) for m in T.REL_SEP_RE.finditer(text) if not any(a <= m.start() < b for a, b in spans)]
    for a, b in spans:
        cuts += [(a, a), (b, b)]
    cuts.sort()
    out, last = [], 0
    for a, b in cuts:
        if a < last:
            continue
        if text[last:a].strip():
            out.append((last, a))
        last = b
    if text[last:].strip():
        out.append((last, len(text)))
    return out


def _vocab(w: str) -> bool:
    """A word of the release, promo, technical, genre or join vocabulary (not a name)."""
    return (w in T.REL_RELEASE or w in T.REL_PROMO or w in T.REL_MASTER or w in T.REL_LABEL or w in T.REL_TECH
            or w in T.REL_FUNC or w in T.REL_GENRE or w in T.REL_NAME or w in PREVIEW_WORDS or w in JOIN_TOKENS
            or w in VERSION_TOKENS or w in EXTRA_VOCAB or w in CREDIT_WORDS or bool(T.REL_TECH_RE.fullmatch(w))
            or bool(MONTH_RE.fullmatch(w)) or bool(re.fullmatch(r"\d+[a-z]{0,4}|[a-z]{1,6}\d+[a-z]?|[a-g][#b]?m?", w))
            or len([c for c in w if c.isalpha()]) <= 1)


def _keys(texts: list[str]) -> set[str]:
    out: set[str] = set()
    for x in texts:
        for m in WORD_RE.finditer(re.sub(rf"[{T._DECOR}]", " ", x or "")):
            out.add(T.fold(m.group()))
            out.add(T.latin_key(m.group()))
    out.discard("")
    return out


def _strip(x: str) -> str:
    return T.squash(x).strip("()[]{} -–—|/~*@\"“”'.,:;!#")


def tidy_facts(label: str = "", album: str = "") -> dict:
    """names-7: a label or album fact holds the name only. Promo words around it go («OUT NOW ON Orbo Records» →
    «Orbo Records», «Release@X Records», «Full Album OUT SOON»), «X out now on Y Records» is the label Y (X left
    out), «A by Y Records» is the album A of the label Y; a fact with a web address, or with nothing but a release
    word left, is no fact (its words stay with what left the title). Returns the facts to keep."""
    out: dict = {}

    def clean(v: str) -> str:
        v = T.squash(re.sub(rf"[{T._DECOR}]", " ", T.chars(v))).strip(FACT_EDGE)
        prev = None
        while prev != v:
            prev = v
            v = T.squash(FACT_TAIL_RE.sub("", FACT_LEAD_RE.sub("", v))).strip(FACT_EDGE)
        return v

    def ok(v: str, kind: str) -> bool:
        # a name: a label has a word besides its label word; an album a word that is no release, promo or technical
        # word («Full Album», «Single 2022», «Free Download» are no album; «V.A Z A R V O» is one)
        if kind == "label":
            return T.has_word(LABEL_PART_RE.sub("", v)) and not re.fullmatch(r"[\d\s/.-]*", LABEL_PART_RE.sub("", v))
        ws = WORD_RE.findall(v)
        return any(len(w) > 1 and not _vocab(w.casefold()) for w in ws) or sum(len(w) == 1 for w in ws) >= 3

    for kind, v in (("label", label), ("album", album)):
        if not v or T.URL_RE.search(v) or re.search(r"(?i)\bbuy\b", v):
            continue
        m = FACT_DATE_RE.match(T.squash(v))
        if m:  # «13/9 On X Records»: the date is a fact of its own
            out.setdefault("removed", []).append(m.group("date"))
            v = T.squash(v)[m.end():]
        parts = FACT_SPLIT_RE.split(T.squash(v))
        if len(parts) > 1 and LABEL_WORD_END_RE.search(_strip(parts[-1])):
            v = parts[-1]
            kind = "label"
        v = clean(v)
        m = FACT_BRACKET_LABEL_RE.match(v)
        if m and ok(clean(m.group("what")), "album") and "album" not in out and not album:
            out["album"] = clean(m.group("what"))
            v, kind = clean(m.group("label")), "label"
        m = FACT_BY_LABEL_RE.match(v)
        if m:
            what = clean(m.group("what"))
            if ok(what, "album") and "album" not in out and not album:
                out["album"] = what
            elif T.has_word(what):
                out.setdefault("removed", []).append(what)  # «Free Download by X Records»: the label is X Records
            v, kind = clean(m.group("label")), "label"
        if ok(v, kind) and kind not in out:
            out[kind] = v
    return out


def kept_from_title(raw: str, title: str, artist_side: list[str], fact_side: list[str], tempos: set[str],
                    notes: dict) -> tuple[dict, list[Step], bool]:
    """D3p, D3n, D3c: the runs of words of the tag's title `raw` that are in no field and no fact of the result. A
    word is accounted when the title or a fact holds it (it ends a run), filler when it is a join or function word, a
    number, a tempo the facts hold, a word of the artist, or a wrapper of a release note that was kept («out on»);
    every other word is lost, and each run from its first to its last lost word is kept. names-7: a run takes the
    words of its phrase next to it (a join or function word, a number that is no tempo, one letter, and vocabulary a
    fact holds: «no-master», «QRSX 2019», «Hi-tech Psy Trance», «Kelvo Records»), and a bracket of numbers only
    that left the title («[24]») is kept too. Returns the notes to add, the steps, and whether the row needs a look
    (a run that may name an act or a label)."""
    text = re.sub(rf"[{T._DECOR}]", " ", T.chars(raw))
    in_title, in_facts, in_artist = _keys([title]), _keys(fact_side), _keys(artist_side)
    noted = any(notes.get(k) for k in ("album", "label", "compilers"))

    def kind(w: str) -> str:
        """A: in the title; B: in a fact; F: filler that may belong to a kept phrase; W: other filler (a tempo, a
        word of the artist, a wrapper of a kept release note); L: lost."""
        k, lk, low = T.fold(w), T.latin_key(w), w.casefold().replace("’", "'")
        if not k:
            return "W"
        m = re.fullmatch(r"(\d{2,3})(?:bpm|[a-g](?:#|b|m)?)?", low)
        if (m and m.group(1) in tempos) or (low == "bpm" and tempos):
            return "W"  # «200bpm», «205D#»: the tempo (and key) facts
        filler = (low in JOIN_TOKENS or low in T.REL_FUNC or low in CREDIT_WORDS or re.fullmatch(r"\d+", low)
                  or (len(w) == 1 and w.isalpha()))
        if filler and (k in in_title or k in in_artist) and (low.isdigit() or len(w) == 1):
            return "W"  # a number or a letter the title or the artist holds
        if filler:
            return "F"
        if k in in_title:
            return "A"
        if k in in_facts or lk in in_facts:
            return "B"
        if k in in_artist or lk in in_artist:
            return "W"
        if low in VERSION_TOKENS and low != "original" and re.search(
                rf"(?i)\b{'remix' if low in ('rmx', 'remx') else re.escape(low)}\b", title):
            return "W"  # «Rmx» became «(X Remix)»
        if noted and (low in WRAPPER_WORDS or k in WRAPPER_WORDS):
            return "W"
        return "L"

    def state(w: str) -> str:
        x = kind(w)
        return "A" if x == "B" else ("F" if x == "W" else x)

    runs: list[str] = []
    for a, b in part_spans(text):
        piece = text[a:b]
        toks = [(m, kind(m.group())) for m in WORD_RE.finditer(piece)]

        def grows(i: int, left: bool) -> bool:
            # to the left only a number, a join or function word or a negation («no-master», «#20 on Beatport»,
            # «For New Tracks …»); to the right also a letter and vocabulary a fact holds («Psy Trance»)
            w, x = toks[i][0].group(), toks[i][1]
            if left:
                return x == "F" and (w.isdigit() or len(w) > 1)
            return x == "F" or (x == "B" and _vocab(w.casefold()))
        if toks and piece.strip()[:1] in ("(", "[", "{") and all(x == "F" and m.group().isdigit() for m, x in toks):
            runs.append(piece)  # names-7: «[24]», «(2016)»: numbers that left the title are kept
            continue
        i, floor = 0, 0
        while i < len(toks):
            if toks[i][1] != "L":
                i += 1
                continue
            j = k = i
            while k + 1 < len(toks) and toks[k + 1][1] in ("L", "F", "W"):
                k += 1
                if toks[k][1] == "L":
                    j = k
            lo, hi = i, j
            while lo - 1 >= floor and grows(lo - 1, True):
                lo -= 1
            while hi + 1 < len(toks) and grows(hi + 1, False):
                hi += 1
            while hi > j and toks[hi][0].group().casefold() in (T.REL_FUNC | JOIN_TOKENS) and len(toks[hi][0].group()) > 1:
                hi -= 1  # a kept phrase does not end on «by», «on», «for»
            runs.append(piece[toks[lo][0].start():toks[hi][0].end()])
            i = floor = hi + 1
    add: dict = {}
    steps: list[Step] = []
    look = False

    def keep(note: str, why: str) -> None:
        nonlocal look
        add.setdefault("removed", []).append(note)
        names = [w for w in WORD_RE.findall(note) if state(w) == "L" and not _vocab(w.casefold())]
        if names:
            steps.append(Step("D3c", "facts", "", note, f"{why}|{note}"))
            look = True
        else:
            steps.append(Step("D3n", "facts", "", note, f"note|{note}"))

    for run in runs:
        note = _strip(run)
        if not T.has_word(note):
            continue
        ws = [w.casefold() for w in WORD_RE.findall(note)]
        if any(w in PREVIEW_WORDS for w in ws):
            add.setdefault("preview", []).append(note)
            steps.append(Step("D3p", "facts", "", note, note))
            continue
        if T.URL_RE.search(note):
            keep(note, "note")  # names-7: a web address is no label or album: the whole run is the note
            continue
        m = LABEL_IN_RE.search(note)
        if m:
            head = re.split(r"\s+[-–—]\s+|\s*[,|]\s*", note[:m.end()])
            label = _strip(LEAD_WRAPPER_RE.sub("", head[-1]))
            before = _strip(note[:m.end() - len(head[-1])])
            after = _strip(note[m.end():])
            parts = FACT_SPLIT_RE.split(label)
            if len(parts) > 1:  # names-7: «Geek Out Now On X Records»: the label is after «out now on»
                before = _strip(f"{before} {parts[0]}")
                label = _strip(parts[-1])
            tidy = tidy_facts(label=label)
            label = tidy.get("label", label)
            if tidy.get("album") and not notes.get("album") and "album" not in add:
                add["album"] = tidy["album"]
                steps.append(Step("D3n", "facts", "", tidy["album"], f"album|{note}"))
            for rest in tidy.get("removed", []):
                keep(rest, "rest")
            if T.has_word(LABEL_PART_RE.sub("", label)):
                if not notes.get("label") and "label" not in add:
                    add["label"] = label
                    steps.append(Step("D3n", "facts", "", label, f"label|{note}"))
                elif T.fold(label) != T.fold(notes.get("label") or add.get("label") or ""):
                    keep(label, "label")
                for rest in (before, after):
                    if T.has_word(rest) and (any(state(w) == "L" and w.casefold() not in WRAPPER_WORDS
                                                 for w in WORD_RE.findall(rest))
                                             or re.fullmatch(r"[\d\s/.-]*\d[\d\s/.-]*", rest)):
                        # names-7: a year or date next to the label is a fact of its own («… Records 2016»); other
                        # words that only finish the label's phrase keep the phrase whole («Lumo Records Series»,
                        # «LUMO RECORDS 07»), never a cut piece
                        whole = rest is after and not re.fullmatch(r"(?:19|20)\d\d|\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?",
                                                                    rest) and all(_vocab(w.casefold()) for w in WORD_RE.findall(rest))
                        if whole:
                            phrase = _strip(f"{label} {rest}")
                            add.setdefault("removed", []).append(phrase)
                            steps.append(Step("D3n", "facts", "", phrase, f"note|{phrase}"))
                        else:
                            keep(rest, "rest")
                continue
        core = YEAR_END_RE.sub("", note)
        if release_kind(core, bracket=True) == "album" and not notes.get("album") and "album" not in add:
            album = tidy_facts(album=_strip(LEAD_WRAPPER_RE.sub("", note))).get("album", "")  # names-7: its year stays
            if T.has_word(album) and not re.fullmatch(r"(?i)(?:ep|lp|album|single|va|v\.?/?a\.?)", album):
                add["album"] = album
                steps.append(Step("D3n", "facts", "", album, f"album|{note}"))
                continue
        keep(note, "note")
    return add, steps, look


def label_bracket(title: str, labels: set[str], known) -> tuple[str, str]:
    """D3l: a final bracket that holds only a name the library knows as a label and never as an act. Returns the title
    without it and the label ('' when the rule does not apply)."""
    brs = brackets(title)
    if not brs or not brs[-1].closed or title[brs[-1].end:].strip():
        return title, ""
    b = brs[-1]
    inner = b.inner.strip()
    head = title[:b.start].strip()
    if not T.has_word(head) or not NAMEISH_RE.match(inner) or len(inner.split()) > 4 \
            or bracket_kind(inner, True)[0] != "other" or known(inner):
        return title, ""
    k = T.fold(inner)
    if k and (k in labels):
        return head, inner
    return title, ""


def label_keys(names: list[str]) -> set[str]:
    """The keys a label name is known by: the whole name and the name without its label word («X Records» → x)."""
    out: set[str] = set()
    for n in names:
        n = T.squash(n or "")
        if not n:
            continue
        out.add(T.fold(n))
        stem = LABEL_PART_RE.sub("", n).strip(" -–—.,")
        if stem and stem != n and len(T.fold(stem)) >= 3:
            out.add(T.fold(stem))
    out.discard("")
    return out
