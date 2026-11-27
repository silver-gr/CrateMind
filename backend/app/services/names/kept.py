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
                 "from", "the", "upcoming", "new", "exclusively", "album", "ep", "lp", "va", "compiled"}
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


def quieter_title(title: str, today: str, records: list[tuple[str, str]]) -> tuple[str, str]:
    """N30: a word of the title written with more capitals than the value the app shows today («INFINITY» where today
    shows «Infinity») takes the linked record's spelling of it (Spotify or SoundCloud, the one with fewest capitals,
    never more than today's), else today's. Only case changes; a version word («Remix») keeps the engine's form.
    Returns the title and the sources used ('' when nothing changed)."""
    toks = list(WORD_RE.finditer(title))
    if not toks or not today:
        return title, ""
    keys = [T.fold(m.group()) for m in toks]
    now = _aligned(keys, today)
    recs = [(name, _aligned(keys, src)) for name, src in records]
    best: dict[int, str] = {}
    used: list[str] = []
    for i, m in enumerate(toks):
        ours, shown = m.group(), now.get(i)
        if shown is None or shown.casefold() != ours.casefold() or _caps(ours) <= _caps(shown) \
                or ours.casefold() in VERSION_TOKENS:
            continue
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


def kept_from_title(raw: str, title: str, artist_side: list[str], fact_side: list[str], tempos: set[str],
                    notes: dict) -> tuple[dict, list[Step], bool]:
    """D3p, D3n, D3c: the runs of words of the tag's title `raw` that are in no field and no fact of the result. A
    word is accounted when the title or a fact holds it (it ends a run), filler when it is a join or function word, a
    number, a tempo the facts hold, a word of the artist, or a wrapper of a release note that was kept («out on»);
    every other word is lost, and each run from its first to its last lost word is kept. Returns the notes to add,
    the steps, and whether the row needs a look (a run that may name an act or a label)."""
    text = re.sub(rf"[{T._DECOR}]", " ", T.chars(raw))
    in_title, in_facts, in_artist = _keys([title]), _keys(fact_side), _keys(artist_side)
    noted = any(notes.get(k) for k in ("album", "label", "compilers"))

    def state(w: str) -> str:
        k, lk, low = T.fold(w), T.latin_key(w), w.casefold().replace("’", "'")
        if not k:
            return "F"
        filler = (low in JOIN_TOKENS or low in T.REL_FUNC or low in CREDIT_WORDS or re.fullmatch(r"\d+", low)
                  or (len(w) == 1 and w.isalpha()))
        if k in in_title or k in in_facts or lk in in_facts:
            return "F" if filler else "A"
        if filler or k in in_artist or lk in in_artist:
            return "F"
        m = re.fullmatch(r"(\d{2,3})(?:bpm|[a-g](?:#|b|m)?)?", low)
        if (m and m.group(1) in tempos) or (low == "bpm" and tempos):
            return "F"  # «200bpm», «205D#»: the tempo (and key) facts
        if low in VERSION_TOKENS and low != "original" and re.search(
                rf"(?i)\b{'remix' if low in ('rmx', 'remx') else re.escape(low)}\b", title):
            return "F"  # «Rmx» became «(X Remix)»
        if noted and low in WRAPPER_WORDS:
            return "F"
        return "L"

    runs: list[str] = []
    for a, b in part_spans(text):
        piece = text[a:b]
        cur: list = []
        for m in list(WORD_RE.finditer(piece)) + [None]:
            st = state(m.group()) if m else "A"
            if st != "A":
                cur.append((m, st))
                continue
            lost = [i for i, (_, x) in enumerate(cur) if x == "L"]
            if lost:
                runs.append(piece[cur[lost[0]][0].start():cur[lost[-1]][0].end()])
            cur = []
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
        m = LABEL_IN_RE.search(note)
        if m:
            head = re.split(r"\s+[-–—]\s+|\s*[,|]\s*", note[:m.end()])
            label = _strip(LEAD_WRAPPER_RE.sub("", head[-1]))
            before = _strip(note[:m.end() - len(head[-1])])
            after = _strip(note[m.end():])
            if T.has_word(LABEL_PART_RE.sub("", label)):
                if not notes.get("label") and "label" not in add:
                    add["label"] = label
                    steps.append(Step("D3n", "facts", "", label, f"label|{note}"))
                elif T.fold(label) != T.fold(notes.get("label") or add.get("label") or ""):
                    keep(label, "label")
                for rest in (before, after):
                    if T.has_word(rest) and any(state(w) == "L" and w.casefold() not in WRAPPER_WORDS
                                                for w in WORD_RE.findall(rest)):
                        keep(rest, "rest")
                continue
        core = YEAR_END_RE.sub("", note)
        if release_kind(core, bracket=True) == "album" and not notes.get("album") and "album" not in add:
            album = _strip(LEAD_WRAPPER_RE.sub("", core))
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
