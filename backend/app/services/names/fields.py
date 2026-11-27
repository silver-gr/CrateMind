"""Layer 1: the string rules inside one field (and N20, the one rule that reads both). No registry here (phase P0):
a rule that needs to know whether a name is an act leaves a candidate for phase P2."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from . import text as T
from .lexer import ROLE_BARE_RE, ROLE_END_RE, bracket_kind, brackets, segments
from .model import Step

PLACEHOLDER_RE = re.compile(
    r"(?i)^\s*(?:unknown(?:\s+artist)?|various(?:\s+artists?)?|v\.?\s*/?\s*a\.?|n/?a|artist|artists|none|null|-+"
    r"|compil(?:ed|ation)s?\b.*|likes of\b.*|downloaded by\b.*|mixed by\b.*|cd\s*\d+|disc\s*\d+"
    r"|track\s*\d*|untitled|bonus(?:\s+track)?|misc|\d{1,4}|(?:v\.\s*a\.?|v\s*/\s*a\.?)\s+\S.*"
    r"|(?:various(?:\s+artists?)?|v\.?\s*/?\s*a\.?)\s*[/|,-]\s*compil.*)\s*$")
AND_FRIENDS_RE = re.compile(r"(?i)\band\s+friends\b|&\s*friends\b")
LIVE_WORD_RE = re.compile(r"(?i)\b(?:live|bootleg|mashup)\b")
OFFICIAL_WORD_RE = re.compile(r"(?i)\s+official\s*$")


@dataclass
class Field:
    raw: str
    text: str = ""
    steps: list[Step] = field(default_factory=list)
    tempo: list[str] = field(default_factory=list)
    flags: set[str] = field(default_factory=set)
    members: list[str] = field(default_factory=list)
    alias: list[str] = field(default_factory=list)
    lead_number: str = ""  # N11L: a leading number kept for P2 («10 Ajja & Nirmal»)
    lead_bracket: str = ""  # N17: a leading non-genre bracket kept for P2 («[NEO]: Neill Moore»)
    wrapped: str = ""  # D1: a trailing word wrapped in decorations, kept for P2 («Plankton •anomalistic•»)
    pre_d5: str = ""  # D5: the title before «X - Y Remix» became «X (Y Remix)», for P2 when X is the artist
    note: dict = field(default_factory=dict)


def bpm_matches(value: float, refs: tuple[float | None, ...]) -> bool:
    """N11's limit: within 3 % of the grid or analysed BPM after whole octaves."""
    for ref in refs:
        if ref and ref > 0:
            for k in (0.25, 0.5, 1, 2, 4):
                r = ref * k
                if abs(value - r) / r <= 0.03:
                    return True
    return False


def _apply(f: Field, rule: str, regex: re.Pattern[str], repl: str = " ", tempo_group: bool = False,
           evidence: str = "") -> None:
    found: list[str] = []

    def sub(m: re.Match[str]) -> str:
        found.append(m.group().strip())
        if tempo_group:
            g = next((x for x in m.groups() if x), None)
            if g:
                f.tempo.append(g.replace(",", "."))
        return repl

    new = T.squash(regex.sub(sub, f.text))
    if found and T.has_word(new):
        f.steps.append(Step(rule, "", f.text, new, evidence or " ".join(found)))
        f.text = new
    elif found and tempo_group:
        del f.tempo[len(f.tempo) - len(found):]


def _set(f: Field, rule: str, new: str, evidence: str = "") -> None:
    new = T.squash(new)
    if new != f.text and T.has_word(new):
        f.steps.append(Step(rule, "", f.text, new, evidence))
        f.text = new


def cross_field_bracket(artist: str, title: str) -> tuple[str, str, str, str]:
    """N20: a bracket opened in the artist field and closed in the title field (an ID3 truncation). A version
    bracket is closed on the artist side and the title side keeps the rest; any other is joined into one group
    («Ida Nadi (Visionary Shamanics» | «Temple of Dub VA)»). Returns (artist, title, kind, title-side part):
    kind '' (no such bracket), 'version' or 'group'."""
    a_br = brackets(artist)
    if not a_br or a_br[-1].closed:
        return artist, title, "", ""
    if title.count(")") <= title.count("(") and title.count("]") <= title.count("["):
        return artist, title, "", ""
    close = min((i for i in (title.find(")"), title.find("]")) if i >= 0), default=-1)
    if close < 0 or "(" in title[:close] or "[" in title[:close]:
        return artist, title, "", ""
    inner_a = a_br[-1].inner.strip()
    inside_t, rest_t = title[:close].strip(), title[close + 1:].strip()
    if ROLE_END_RE.match(inner_a):
        return T.squash(artist + ")"), T.squash(f"{inside_t} {rest_t}"), "version", inside_t
    return artist, title, "group", inside_t


def clean_artist(raw: str, members: bool = True) -> Field:
    f = Field(raw=raw or "")
    f.text = T.chars(raw)
    if f.text != (raw or "").strip():
        f.steps.append(Step("D0", "", (raw or "").strip(), f.text))
    # underscores: a spaced one stands for «:» or «/» (SEP), a glued one is a space
    _set(f, "N0", re.sub(rf"\s+_+\s+|(?<=\w)_+\s+(?=\S)", f" {T.SEP} ", f.text).replace("_", " "))
    # a wide gap between two words is a neutral separator, unless a join word follows it
    _set(f, "N0", re.sub(r"(?<=\S)\s{3,}(?!(?:x|X|&|vs\.?|VS|Vs\.?|feat\.?|ft\.?|and)\s)(?=\S)", f" {T.SEP} ", f.text))
    _set(f, "D1", T._LONE_MARK_RE.sub(" ", f.text))
    m = T.WRAPPED_WORD_RE.match(f.text)
    if m and T.has_word(m.group("head")) and T.has_word(m.group("word")):
        f.wrapped = m.group("word").strip()
        _set(f, "D1", m.group("head"), m.group("d") + f.wrapped + m.group("d"))
    if T.FRAGMENT_RE.match(f.text):
        f.flags.add("fragment")
    new, removed = T.decorations_artist(f.text)
    if removed and T.has_word(new):
        f.steps.append(Step("D1", "", f.text, new, " ".join(removed)))
        f.text = new
    _apply(f, "N7", T.GENRE_LEAD_RE, "")
    _apply(f, "N7", T.GENRE_PREFIX_RE, "")
    _apply(f, "N7", T.GENRE_TAIL_RE, "")
    # A3 in the artist field: a leading track number with a separator («4. Darq», «1- Zaaki», «02 Crone»); a bare
    # number and a space is N11L's (P2)
    m = T.TRACK_NUMBER_RE.match(f.text)
    if m and T.has_word(f.text[m.end():]):
        _set(f, "A3", f.text[m.end():], m.group().strip())
    m = T.LEAD_BRACKET_RE.match(f.text)
    if m and not T.GENRE_ONLY_RE.match(m.group(1)) and T.has_word(f.text[m.end():]) \
            and bracket_kind(m.group(1), True)[0] not in ("version", "feat"):
        f.lead_bracket = m.group(1).strip()
    _apply(f, "D3", T.URL_RE)
    _apply(f, "D3", T.WATERMARK_RE)
    _apply(f, "D3", T.PROMO_BRACKET_RE)
    _apply(f, "D3", T.PROMO_TAIL_RE)
    _apply(f, "D3", T.PROMO_LEAD_RE, "")
    tempo_at_start = bool(re.match(r"(?i)^\s*\d{2,3}\s*bpm\b", f.text))
    _apply(f, "N11", T.TEMPO_WORD_RE, tempo_group=True)
    tempo_bracket(f)
    _apply(f, "N11", T.KEY_RE)
    _apply(f, "N11", T.HZ_RE)
    _apply(f, "N9", T.ARTIST_LABEL_BRACKET_RE)
    _apply(f, "N9", T.OFFICIAL_BRACKET_RE)
    _apply(f, "N9", T.DISCOGS_RE)
    if T.ORIGINAL_MIX_RE.search(f.text):
        f.flags.add("N10")
    if members:
        _members(f)
    _apply(f, "D2", T._EMPTY_BRACKETS_RE)
    _set(f, "D2", T.tidy(f.text))
    _title_like(f)
    if tempo_at_start:
        f.flags.discard("N10t")  # «205 BPM Gambit»: a tempo in front of a name is a tag, not a title
    if re.fullmatch(r"(?i)\s*(?:[A-G][#b♯♭]?(?:\s?(?:m|min|maj))?\s+)?\d{2,3}\s*", f.text) or re.fullmatch(
            r"(?i)\s*(?:1[0-2]|[1-9])[AB]\s*", f.text):
        f.flags.add("A2")  # only a key and/or a tempo («G# 145»)
    m = T.LEADING_NUMBER_RE.match(f.text)
    if m and T.has_word(f.text[m.end():]) and not PLACEHOLDER_RE.match(f.text):
        f.lead_number = m.group(1)
    if not T.has_word(f.text) or PLACEHOLDER_RE.match(f.text) or PLACEHOLDER_RE.match(T.tidy(f.text.replace(T.SEP, " "))):
        f.flags.add("A2")
    if AND_FRIENDS_RE.search(f.text):
        f.flags.add("friends")
    return f


def _outside_versions(f: Field, rule: str, regex: re.Pattern[str]) -> None:
    """Remove matches of regex that are not inside a version bracket («[Free Download Remix]» stays)."""
    spans = [(b.start, b.end) for b in brackets(f.text) if bracket_kind(b.inner, b.closed)[0] == "version"]
    found: list[str] = []

    def sub(m: re.Match[str]) -> str:
        if any(a <= m.start() < b for a, b in spans):
            return m.group()
        found.append(m.group().strip())
        return " "

    new = T.tidy(T.squash(regex.sub(sub, f.text)))
    if found and T.has_word(new):
        f.steps.append(Step(rule, "", f.text, new, " ".join(found)))
        f.text = new


def _note(f: Field, rule: str, regex: re.Pattern[str], note: str) -> None:
    m = regex.search(f.text)
    if m and T.has_word(f.text[:m.start()]):
        f.note[note] = T.tidy(m.group().strip(" -–—"))
        _set(f, rule, f.text[:m.start()], m.group().strip())


def tempo_bracket(f: Field) -> None:
    def sub(m: re.Match[str]) -> str:
        n = float(m.group(1).replace(",", "."))
        if 60 <= n <= 320:
            found.append(m.group().strip())
            f.tempo.append(m.group(1).replace(",", "."))
            return " "
        return m.group()
    found: list[str] = []
    before = len(f.tempo)
    new = T.squash(T.TEMPO_BRACKET_RE.sub(sub, f.text))
    if found and T.has_word(new):
        f.steps.append(Step("N11", "", f.text, new, " ".join(found)))
        f.text = new
    else:
        del f.tempo[before:]


def _members(f: Field) -> None:
    """N8: «Head (A & B)», «Head(A vs B)», «Head (A, B)», «Head (A and B)», or an unclosed «Head (A» → Head; the
    names go to members. A version bracket, a feat. bracket, a qualifier («(DE)») and an alias are not members."""
    brs = brackets(f.text)
    if not brs:
        return
    b = brs[-1]
    head = f.text[:b.start].strip()
    tail = f.text[b.end:].strip()
    if not T.has_word(head) or tail:
        return
    kind, data = bracket_kind(b.inner, b.closed)
    if kind in ("members", "truncated"):
        f.members += data["names"]
        f.steps.append(Step("N8", "", f.text, head, f.text[b.start:b.end]))
        f.text = head
    elif kind == "alias":
        f.alias.append(data["alias"])
        f.steps.append(Step("N8", "", f.text, head, f.text[b.start:b.end]))
        f.text = head
    elif kind == "qualifier":
        f.flags.add("N19")
    elif kind == "feat":
        # «Head ( Ft X )»: a featured credit in brackets reads «Head ft X» (its own word kept)
        word = re.match(r"(?i)\s*(feat\.?|ft\.?|featuring|with|pres\.?|presents)", b.inner).group(1)
        if word.lower().rstrip(".") in ("feat", "ft", "featuring"):
            new = f"{head} {word} {re.sub(r'(?i)^\s*(?:feat\.?|ft\.?|featuring)\s+', '', b.inner).strip()}"
            f.steps.append(Step("N8", "", f.text, new, f.text[b.start:b.end]))
            f.text = T.squash(new)


def _title_like(f: Field) -> None:
    """N10 (flag only): the artist field reads as a title: a version bracket, a remix word, «Original Mix», a tempo;
    «Live», «Bootleg», «Mashup» only inside a bracket or after a dash."""
    for b in brackets(f.text):
        if bracket_kind(b.inner, b.closed)[0] in ("version", "original") and f.text[:b.start].strip():
            f.flags.add("N10")
    if any(ROLE_BARE_RE.match(p.strip()) for p in f.text.split(T.SEP)):
        f.flags.add("N10")
    if re.search(r"\s[-–—]\s.*\b(?:live|bootleg|mashup)\b", f.text, re.I):
        f.flags.add("N10")
    if re.search(r"\s(?:EP|LP|Album|Single)\s*$", f.text):
        f.flags.add("N10")  # a release name («The Rising EP») is not an act
    if f.tempo and not f.flags & {"N10"}:
        f.flags.add("N10t")


def file_made_from(stem: str, text: str) -> bool:
    """The file name was made from this field (it starts with the same words): its leading number is then no
    independent evidence of a track number («7 Seas.mp3» for the title «7 Seas»)."""
    norm = lambda x: T.squash(re.sub(r"[_\W]+", " ", T.chars(x).casefold()))  # noqa: E731
    a, b = norm(stem), norm(text)
    return bool(b) and a.startswith(b)


def _drop_brackets(f: Field, rule: str, regex: re.Pattern[str], note: str = "") -> None:
    """Remove the brackets regex matches, unless one is a version bracket; the first removed text becomes a note."""
    spans = [(b.start, b.end) for b in brackets(f.text) if bracket_kind(b.inner, b.closed)[0] in ("version", "feat")]
    found: list[str] = []

    def sub(m: re.Match[str]) -> str:
        if any(a <= m.start() + len(m.group()) - len(m.group().lstrip()) < b for a, b in spans):
            return m.group()
        found.append(m.group().strip())
        return " "

    new = T.squash(regex.sub(sub, f.text))
    if found and T.has_word(new):
        if note:
            f.note.setdefault(note, T.tidy(found[0].strip("()[] ")))
        f.steps.append(Step(rule, "", f.text, new, " ".join(found)))
        f.text = new


def _drop_tail(f: Field, rule: str, regex: re.Pattern[str], note: str = "", need_lower: bool = False) -> None:
    """Remove a tail regex matches when a title is left before it (a word outside brackets)."""
    m = regex.search(f.text)
    if not m:
        return
    before = f.text[:m.start()]
    if not T.has_word(re.sub(r"[(\[][^()\[\]]*[)\]]", " ", before)):
        return
    if need_lower and not re.search(r"[a-z]", before):
        return
    if note:
        f.note.setdefault(note, T.tidy(m.group().strip(" -–—|,")))
    _set(f, rule, before, m.group().strip())


def release_tail(f: Field) -> None:
    """D3 (names-3): a label, compilation, volume or EP tail after the last closing bracket. A tempo inside it is kept."""
    m = T.RELEASE_TAIL_RE.search(f.text)
    if not m:
        return
    before = f.text[:m.start()]
    if not T.has_word(re.sub(r"[(\[][^()\[\]]*[)\]]", " ", before)):
        return
    tail = m.group("tail")
    for t in T.TEMPO_WORD_RE.finditer(tail):
        g = next((x for x in t.groups() if x), None)
        if g:
            f.tempo.append(g.replace(",", "."))
    label = re.search(r"(?i)\b(?:records?|recordings|recs?)\.?[\s.!,]*$", tail)
    f.note.setdefault("label" if label else "album", T.tidy(T.squash(T.TEMPO_WORD_RE.sub(" ", tail)).strip(" -–—|,")))
    _set(f, "D3", before, tail.strip())


def release_notes(f: Field) -> None:
    """D3 (names-3): compilation, release, mastering, preview, catalogue and genre notes in a title."""
    _drop_brackets(f, "D3", T.VA_BRACKET_RE, "album")
    _drop_brackets(f, "D3", T.RELEASE_BRACKET_RE, "album")
    _drop_brackets(f, "D3", T.MASTER_BRACKET_RE)
    _drop_brackets(f, "D3", T.MARKER_BRACKET_RE)
    _drop_brackets(f, "D3", T.SINGLE_BRACKET_RE)
    for _ in range(2):
        _drop_tail(f, "D3", T.FILE_EXT_RE)
        _drop_tail(f, "D3", T.HASHTAG_TAIL_RE)
        _drop_tail(f, "D3", T.OUT_ON_RE, "album")
        _drop_tail(f, "D3", T.OUT_DATE_RE)
        _drop_tail(f, "D3", T.FULL_ALBUM_RE)
        _drop_tail(f, "D3", T.MASTER_TAIL_RE)
        _drop_tail(f, "D3", T.CAPS_MASTER_RE, need_lower=True)
        _drop_tail(f, "D3", T.MARKER_TAIL_RE)
        _drop_tail(f, "D3", T.CATALOGUE_RE)
        _drop_tail(f, "N7", T.GENRE_TITLE_BRACKET_RE)
        _drop_tail(f, "N7", T.GENRE_TITLE_DASH_RE)


def tidy_title(v: str) -> str:
    """D2 for titles (names-3): spaces inside brackets, a dash before the final bracket, a space before a glued
    version or feat. bracket, a dot after the final bracket, quotes around the opening words."""
    v = re.sub(r"([(\[])\s+", r"\1", v)
    v = re.sub(r"\s+([)\]])", r"\1", v)
    v = re.sub(r"\s+[-–—]\s*(?=[(\[][^()\[\]]*[)\]]\s*$)", " ", v)
    for b in reversed(brackets(v)):
        if b.closed and b.start and v[b.start - 1].isalnum() and v[b.start] == "(" \
                and bracket_kind(b.inner, True)[0] in ("version", "original", "feat"):
            v = v[:b.start] + " " + v[b.start:]
    v = re.sub(r"(?<=[)\]])\s*\.\s*$", "", v)
    v = re.sub(r'^"([^"]{2,})"(?=\s|$)', r"\1", v)  # «"Lullaby" 2012»: quotes around the title's opening words
    return T.squash(v)


def clean_title(raw: str, track_no: str = "", file_prefix: str = "", bpm_refs: tuple = (), cross: bool = False,
                file_stem: str = "") -> Field:
    f = Field(raw=raw or "")
    f.text = T.chars(raw)
    if f.text != (raw or "").strip():
        f.steps.append(Step("D0", "", (raw or "").strip(), f.text))
    _set(f, "N0", re.sub(r"(?<=\d)_(?=\d)", "\ue01f", re.sub(r"\s+_+\s+|(?<=[^\W_])_+\s+(?=\S)", " - ", f.text))
         .replace("_", " ").replace("\ue01f", "_"))
    _drop_tail(f, "D3", T.WRAPPED_LABEL_RE, "label")
    new, changed = T.decorations_title(f.text)
    if changed and T.has_word(new):
        f.steps.append(Step("D1", "", f.text, new))
        f.text = new
    _apply(f, "D3", T.URL_RE)
    _apply(f, "D3", T.YOUTUBE_TAIL_RE)
    # A3: a leading track number in the raw title tag («04. Title», «11.Name - Title», «02 - Title»)
    m = T.TRACK_NUMBER_RE.match(f.text)
    if m and T.has_word(f.text[m.end():]):
        _set(f, "A3", f.text[m.end():], m.group().strip())
    release_tail(f)
    # a tempo range outside brackets («Monk's Prayer 158-160 BPM»): the copied annotation rules would keep «158-»
    spans = [(b.start, b.end) for b in brackets(f.text)]
    m = T.TEMPO_RANGE_RE.search(f.text)
    if m and not any(a <= m.start() < b for a, b in spans) and T.has_word(f.text[:m.start()]) \
            and int(m.group(1)) < int(re.findall(r"\d{2,3}", m.group())[1]):  # «200 - 200BPM» is no range
        f.tempo.append(m.group(1))
        _set(f, "N11", f.text[:m.start()] + " " + f.text[m.end():], m.group().strip())
    new, bpm = T.title_annotations(f.text)
    if T.has_word(new) and new != f.text:
        # a change that only took a tempo is explained as a tempo (N11), not as promo text
        only_tempo = T.tidy(T.squash(T.TEMPO_WORD_RE.sub(" ", T.TEMPO_BRACKET_RE.sub(" ", f.text)))) == T.tidy(new)
        if bpm is not None:
            f.steps.append(Step("N11", "", f.text, new, f"{bpm:g}"))
        if not (only_tempo and bpm is not None):
            f.steps.append(Step("D3", "", f.text, new, "annotations"))
        f.text = new
    if bpm is not None:
        f.tempo.append(f"{bpm:g}")
    _apply(f, "D3", T.WATERMARK_RE)
    _apply(f, "D3", T.PROMO_BRACKET_RE)
    _apply(f, "D3", T.PROMO_TAIL_RE)
    _apply(f, "D3", T.PROMO_LEAD_RE, "")
    _outside_versions(f, "D3", T.PROMO_ANY_RE)
    _outside_versions(f, "D3", T.OUT_NOW_RE)
    _note(f, "D3", T.BY_LABEL_RE, "label")
    _note(f, "D3", T.DASH_LABEL_RE, "label")
    _note(f, "D3", T.VA_TAIL_RE, "album")
    _apply(f, "D3", T.TECH_RE)
    _apply(f, "D3", T.TECH_TAIL_RE)
    release_notes(f)
    # «Album - 07 Title»: an album name and a track number in front of the title
    m = T.ALBUM_TRACK_RE.match(f.text)
    if m and T.has_word(f.text[m.end():]):
        f.note.setdefault("album", m.group("album").strip())
        _set(f, "A3", f.text[m.end():], m.group().strip())
    _apply(f, "D4", T.ORIGINAL_MIX_RE)
    _apply(f, "N11", T.TEMPO_WORD_RE, tempo_group=True)
    tempo_bracket(f)
    _apply(f, "N11", T.KEY_RE)
    _apply(f, "N11", T.HZ_RE)
    m = T.NUMBER_BEFORE_BRACKET_RE.search(f.text) or T.NUMBER_KEY_TAIL_RE.search(f.text)
    if m and 60 <= int(m.group(1)) <= 320 and T.has_word(f.text[:m.start()]) and (
            bpm_matches(float(m.group(1)), bpm_refs) or m.group(1) in f.tempo):
        f.tempo.append(m.group(1))
        tail = "" if m.re is T.NUMBER_KEY_TAIL_RE else f.text[m.end():]
        _set(f, "N11", f.text[:m.start()] + " " + tail, m.group().strip())
    m = T.LEADING_TEMPO_DASH_RE.match(f.text)
    if m and 60 <= int(m.group(1)) <= 320 and bpm_matches(float(m.group(1)), bpm_refs) and T.has_word(f.text[m.end():]):
        f.tempo.append(m.group(1))
        _set(f, "N11", f.text[m.end():], m.group().strip())
    m = T.MIDDLE_NUMBER_RE.search(f.text)
    if m and 60 <= int(m.group(1)) <= 320 and bpm_matches(float(m.group(1)), bpm_refs):
        f.tempo.append(m.group(1))
        _set(f, "N11", f.text[:m.start()] + " " + f.text[m.end():], m.group().strip())
    # a title that is only a number, or a bare trailing number: a tempo only when the audio agrees
    m = T.WHOLE_NUMBER_RE.match(f.text)
    if m and 60 <= int(m.group(1)) <= 320 and bpm_matches(float(m.group(1)), bpm_refs):
        f.tempo.append(m.group(1))
        f.steps.append(Step("N11", "", f.text, "", m.group(1)))
        f.text = ""
        f.flags.add("tempo_only")
    else:
        m = T.TRAILING_NUMBER_RE.search(f.text)
        n = (m.group(1) or m.group(2)) if m else None
        if m and 60 <= float(n) <= 320 and bpm_matches(float(n), bpm_refs) and T.has_word(f.text[:m.start()]):
            f.tempo.append(n)
            _set(f, "N11", f.text[:m.start()] + f.text[m.end():], m.group().strip())
    # N11L: a leading number before a head, dropped here only on string evidence (the track-number tag or the
    # file-name prefix); the known-act case is decided in P2
    m = T.LEADING_NUMBER_RE.match(f.text)
    if m and T.has_word(f.text[m.end():]):
        n = m.group(1)
        tag_no = re.match(r"\s*0*(\d+)", track_no or "")
        from_file = file_prefix and file_prefix.lstrip("0") == n.lstrip("0") and not file_made_from(file_stem, f.text)
        if (tag_no and tag_no.group(1) == n.lstrip("0")) or from_file:
            if bpm_matches(float(n), bpm_refs) and 60 <= int(n) <= 320:
                f.tempo.append(n)
            _set(f, "N11L", f.text[m.end():], n)
        else:
            f.lead_number = n
    _set(f, "D2", re.sub(r"\s*[;:]-?[)(]\s*$", "", f.text))
    brs = brackets(f.text)
    if brs and not brs[-1].closed:
        kind, _ = bracket_kind(brs[-1].inner, False)
        inner = brs[-1].inner
        if kind in ("version", "original"):
            _set(f, "D2", f.text + ")")
        elif not T.has_word(T.PROMO_ANY_RE.sub(" ", T.URL_RE.sub(" ", re.sub(r"(?i)\bbuy\b", " ", inner)))):
            _set(f, "D3", f.text[:brs[-1].start])
    if not cross and f.text.count(")") == f.text.count("(") + 1 and f.text.rstrip().endswith(")"):
        _set(f, "D2", re.sub(r"\)\s*$", "", f.text))
    _apply(f, "D4", T.ORIGINAL_MIX_RE)
    # a last title segment that is only a bracket of names names the members («Hope - (A & B)»)
    m = re.search(r"\s+[-–—]\s*(\([^()]+\))\s*$", f.text)
    if m and T.has_word(f.text[:m.start()]):
        kind, data = bracket_kind(m.group(1)[1:-1], True)
        if kind == "members":
            f.note.setdefault("members", []).extend(data["names"])
            _set(f, "N8", f.text[:m.start()], m.group(1))
    if T.DASH_ROLE_ONLY_RE.match(f.text):
        _set(f, "D5", T.DASH_ROLE_ONLY_RE.sub(r"\1 (\2 \3)", f.text))
    elif T.DASH_VERSION_RE.match(f.text):
        before_d5 = f.text
        _set(f, "D5", T.DASH_VERSION_RE.sub(r"\1 (\2)", f.text))
        if f.text != before_d5 and len(segments(before_d5)) == 2:
            f.pre_d5 = before_d5
    _apply(f, "D2", T._EMPTY_BRACKETS_RE)
    _set(f, "D2", T.tidy(f.text))
    if f.pre_d5:
        f.pre_d5 = tidy_title(T.tidy(T._EMPTY_BRACKETS_RE.sub(" ", f.pre_d5)))
    if not cross:
        _set(f, "D2", tidy_title(f.text))
        new, bpm = T.title_annotations(f.text)
        if T.has_word(new) and new != f.text:
            f.steps.append(Step("D3", "", f.text, new, "annotations"))
            f.text = new
            if bpm is not None:
                f.tempo.append(f"{bpm:g}")
    # a title left with only a tempo or only promo words held no title at all
    if re.fullmatch(r"(?i)\s*\+?\d{2,3}(?:\s*[-–]\s*\d{2,3})?\s*-?\s*\+?\s*bpm\s*", f.text):
        m = re.match(r"\s*\+?(\d{2,3})", f.text)
        f.tempo.append(m.group(1))
        f.steps.append(Step("N11", "", f.text, "", f.text))
        f.text = ""
        f.flags.add("tempo_only")
    elif T.has_word(f.text) and (not T.has_word(T.PROMO_ANY_RE.sub(" ", T.OUT_NOW_RE.sub(" ", f.text)))
                                 or T.RELEASE_WORD_ONLY_RE.match(f.text)):
        f.steps.append(Step("D3", "", f.text, "", f.text))
        f.text = ""
        f.flags.add("tempo_only")
    if not T.has_word(f.text) and not f.flags & {"tempo_only"}:
        f.flags.add("empty")
    return f
