"""Layer 1: the string rules inside one field (and N20, the one rule that reads both). No registry here (phase P0):
a rule that needs to know whether a name is an act leaves a candidate for phase P2."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from . import text as T
from .lexer import (NAMEISH_RE, QUALIFIER_RE, ROLE_BARE_RE, ROLE_END_RE, STRONG_JOIN_RE, bracket_kind, brackets,
                    outside_split, segments)
from .model import Step

PLACEHOLDER_RE = re.compile(
    r"(?i)^\s*(?:unknown(?:\s+artist)?|various(?:\s+artists?)?|v\.?\s*/?\s*a\.?|n/?a|artist|artists|none|null|-+"
    r"|compil(?:ed|ation)s?\b.*|likes of\b.*|downloaded by\b.*|mixed by\b.*|cd\s*\d+|disc\s*\d+"
    r"|track\s*\d*|untitled|bonus(?:\s+track)?|misc|\d{1,4}|(?:v\.\s*a\.?|v\s*/\s*a\.?)\s+\S.*|(?-i:[A-Z]{2,5}0\d{2})"
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
    bracket_tags: list = field(default_factory=list)  # N8a: («Name», «(Tag)», «Tag») for P2: «Name» known alone
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


def clean_artist(raw: str, members: bool = True, bpm_refs: tuple = ()) -> Field:
    f = Field(raw=raw or "")
    f.text = T.chars(raw)
    if f.text != (raw or "").strip():
        f.steps.append(Step("D0", "", (raw or "").strip(), f.text))
    # underscores: a spaced one stands for «:» or «/» (SEP), a glued one is a space; names-4: P2 joins the parts back
    # with a space unless every part is a known act
    if re.search(r"\s+_+\s+|(?<=\w)_+\s+(?=\S)", f.text):
        f.flags.add("us_sep")
    _set(f, "N0", re.sub(rf"\s+_+\s+|(?<=\w)_+\s+(?=\S)", f" {T.SEP} ", f.text).replace("_", " "))
    # a wide gap between two words is a neutral separator, unless a join word follows it
    _set(f, "N0", re.sub(r"(?<=\S)\s{3,}(?!(?:x|X|&|vs\.?|VS|Vs\.?|feat\.?|ft\.?|and)\s)(?=\S)", f" {T.SEP} ", f.text))
    _set(f, "D1", T._LONE_MARK_RE.sub(" ", f.text))
    # names-5: a name written with a space between its letters («R h a ú m»): three or more single letters are one word
    _set(f, "N0s", re.sub(r"(?<!\S)(?:[^\W\d_] ){2,}[^\W\d_](?!\S)", lambda m: m.group().replace(" ", ""), f.text))
    # names-5: a final bracket that names a crew, a family or a collective, or lists affiliations with «|», goes to the notes
    m = re.search(r"\s*[(\[]([^()\[\]]*(?:\||(?i:\b(?:crew|family|collective|tribe)\b))[^()\[\]]*)[)\]]\s*$",
                  f.text)
    if m and T.has_word(f.text[:m.start()]):
        f.note.setdefault("tag", []).append(T.squash(m.group(1).strip()))
        _set(f, "N9c", f.text[:m.start()], m.group().strip())
    m = T.WRAPPED_WORD_RE.match(f.text)
    if m and T.has_word(m.group("head")) and T.has_word(m.group("word")):
        f.wrapped = m.group("word").strip()
        _set(f, "D1", m.group("head"), m.group("d") + f.wrapped + m.group("d"))
    _set(f, "D2", re.sub(r"(?i)\b(feat|ft)\.(?=[^\W\d_])", r"\1. ", f.text))  # «feat.Spaceshimp» (names-4)
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
        _set(f, "A3a", f.text[m.end():], m.group().strip())
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
    m = re.fullmatch(r"(?i)\s*(?:([A-G][#b♯♭]?(?:\s?(?:m|min|maj))?)\s+)?(\d{2,3})\s*", f.text)
    if m or re.fullmatch(r"(?i)\s*(?:1[0-2]|[1-9])[AB]\s*", f.text):
        f.flags.add("A2")  # only a key and/or a tempo («G# 145»): kept as facts (N11), the field holds no artist
        if m and 60 <= int(m.group(2)) <= 320 and (m.group(1) or bpm_matches(float(m.group(2)), bpm_refs)):
            f.tempo.append(m.group(2))
            if m.group(1):
                f.note.setdefault("key", m.group(1))
            f.steps.append(Step("N11", "", f.text, f.text, m.group().strip()))
    else:
        # names-4: a number at the end of an artist field within 3 % of the audio's tempo is a tempo («Hyperdrive 175»)
        m = re.search(r"\s+(\d{2,3})\s*$", f.text)
        if m and bpm_refs and 60 <= int(m.group(1)) <= 320 and bpm_matches(float(m.group(1)), bpm_refs) \
                and T.has_word(re.sub(r"\d", "", f.text[:m.start()])):
            f.tempo.append(m.group(1))
            _set(f, "N11", f.text[:m.start()], m.group(1))
            f.flags.add("N10t")
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


RELEASE_TYPE_RE = re.compile(r"(?i)^(?:(?:new|debut|upcoming|forthcoming|next|bonus)\s+)*(?:single|ep|lp|album|track|release)s?$")
LEAD_RELEASE_RE = re.compile(r"(?i)^\s*(?:(?:out|released|soon|coming)(?:\s+(?:out|soon|now))*(?:\s+(?:on|by|in))?\b|on\b)"
                             r"\s*(?:\.\.\.|…)?\s*")
COMPILED_RE = re.compile(r"(?i)\s*\bcompiled\s+by\s+(?P<who>[^()\[\]]+?)\s*$")


def album_note(f: Field, text: str) -> None:
    """names-5: the album note keeps only the release's name: «Out on», «on», «Out soon» are left out; a release type
    alone («Single», «New Single») gives no note; «Compiled by X» goes to the compilers; a name ending in «Label» or
    «Records» is the label."""
    t = T.tidy(text.strip(" -–—|,'\"“”"))
    m = COMPILED_RE.search(t)
    if m:
        f.note.setdefault("compilers", [x.strip() for x in re.split(r"\s*(?:&|,|\band\b)\s*", m.group("who")) if x.strip()])
        t = t[:m.start()]
    t = T.OUT_NOW_RE.sub(" ", re.sub(r"(?i)\s*\blink\s+in\s+(?:the\s+)?description\b", " ", t))
    t = T.tidy(LEAD_RELEASE_RE.sub("", T.squash(t), count=1).strip(" -–—|,.'\"“”"))
    t = re.sub(r"(?i)^album\s+(?=\S)", "", t).strip(" '\"“”")
    if not T.has_word(t) or RELEASE_TYPE_RE.match(t) or re.fullmatch(r"(?i)(?:out|soon|now|coming|new)(?:\s+\w+)?", t):
        return
    m = re.match(r"(?i)^(.*\blabel)\b(?:\s+(?:album|ep|lp|single))*\s*$", t)
    if m or re.search(r"(?i)\b(?:records?|recordings|recs?)\.?$", t):
        f.note.setdefault("label", m.group(1) if m else t)
    else:
        f.note.setdefault("album", t)


def _note(f: Field, rule: str, regex: re.Pattern[str], note: str) -> None:
    m = regex.search(f.text)
    if m and T.has_word(f.text[:m.start()]):
        if note == "album":
            album_note(f, m.group())
        else:
            f.note[note] = T.tidy(m.group().strip(" -–—"))
        _set(f, rule, f.text[:m.start()], m.group().strip())


def tempo_bracket(f: Field) -> None:
    def sub(m: re.Match[str]) -> str:
        g = next(x for x in m.groups() if x)
        n = float(g.replace(",", "."))
        if 60 <= n <= 320:
            found.append(m.group().strip())
            f.tempo.append(g.replace(",", "."))
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


def _render(parts: list[str], seps: list[str]) -> str:
    out = parts[0]
    for p, s in zip(parts[1:], seps):
        out += (", " if s in (",", ";") else f" {s} ") + p
    return T.squash(out)


def _members(f: Field) -> None:
    """N8: «Head (A & B)», «Head(A vs B)», «Head (A, B)», «Head (A and B)», or an unclosed «Head (A» → Head; the
    names go to members. A version bracket, a feat. bracket, a qualifier («(DE)») and an alias are not members.
    names-4: read per credit part («Superluminal (A & B), Argonik»); «A & B (Project)», a project name after a credit of
    two or more acts, shows the project with the acts as members (N8p, `look`); a one-name bracket after one act is
    kept for P2 (`f.bracket_tag`), which moves it to the notes when the name is known without it."""
    parts, seps = outside_split(f.text, STRONG_JOIN_RE)
    if len(parts) > 1 and all(parts):
        changed = False
        for i, p in enumerate(parts):
            brs = brackets(p)
            if brs and brs[-1].closed and T.has_word(p[:brs[-1].start]) and not p[brs[-1].end:].strip():
                kind, data = bracket_kind(brs[-1].inner, True)
                if kind == "members":
                    f.members += data["names"]
                    parts[i] = p[:brs[-1].start].strip()
                    changed = True
                elif kind == "other" and NAMEISH_RE.match(brs[-1].inner.strip()) \
                        and not QUALIFIER_RE.fullmatch(brs[-1].inner.strip()):
                    f.bracket_tags.append((p[:brs[-1].start].strip(), p[brs[-1].start:], brs[-1].inner.strip()))
        if changed:
            new = _render(parts, seps)
            f.steps.append(Step("N8", "", f.text, new, "members"))
            f.text = new
    brs = brackets(f.text)
    if brs and brs[-1].closed and not f.text[brs[-1].end:].strip():
        b = brs[-1]
        head = f.text[:b.start].strip()
        inner = b.inner.strip()
        hp, _ = outside_split(head, STRONG_JOIN_RE)
        if bracket_kind(inner, True)[0] == "other" and NAMEISH_RE.match(inner) and not QUALIFIER_RE.fullmatch(inner):
            if len([x for x in hp if T.has_word(x)]) >= 2 and len(inner.split()) <= 4:
                f.members += [x for x in hp if T.has_word(x)]
                f.steps.append(Step("N8p", "", f.text, inner, f.text[b.start:b.end]))
                f.text = inner
                f.flags.add("project")
                return
            if len(hp) == 1 and T.has_word(head):
                f.bracket_tags.append((head, f.text[b.start:], inner))
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
        f.steps.append(Step("N8a", "", f.text, head, f.text[b.start:b.end]))
        f.text = head
    elif kind == "qualifier":
        f.flags.add("N19")
    elif kind == "feat":
        # «Head ( Ft X )»: a featured credit in brackets reads «Head ft X» (its own word kept)
        word = re.match(r"(?i)\s*(feat\.?|ft\.?|featuring|with|pres\.?|presents)", b.inner).group(1)
        if word.lower().rstrip(".") in ("feat", "ft", "featuring"):
            new = f"{head} {word} {re.sub(r'(?i)^\s*(?:feat\.?|ft\.?|featuring)\s+', '', b.inner).strip()}"
            f.steps.append(Step("N8f", "", f.text, new, f.text[b.start:b.end]))
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
    # names-4: a version token («V2.0»), an episode code («S02E05»), a leading «Mix by», «X remixing Y»
    if re.search(r"(?i)\s[Vv]\d+(?:\.\d+)?\s*$|\bS\d{1,2}\s?E\d{1,3}\b|^\s*mix\s+by\b|\sremixing\s", f.text) \
            or re.search(r"\sV\.?A\.?\s*$", f.text):  # … or a compilation marker at the end («Wake Up [200] VA»)
        f.flags.add("N10")
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
        if note == "album":
            album_note(f, found[0].strip("()[] "))
        elif note:
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
    if note == "album":
        album_note(f, m.group())
    elif note:
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
    if label:
        f.note.setdefault("label", T.tidy(T.squash(T.TEMPO_WORD_RE.sub(" ", tail)).strip(" -–—|,")))
    else:
        album_note(f, T.squash(T.TEMPO_WORD_RE.sub(" ", tail)))
    _set(f, "D3", before, tail.strip())


def release_notes(f: Field) -> None:
    """D3 (names-3): compilation, release, mastering, preview, catalogue and genre notes in a title."""
    _drop_brackets(f, "D3", T.VA_BRACKET_RE, "album")
    m = T.RELEASED_BY_RE.search(f.text)
    if m and T.has_word(f.text[:m.start()] + f.text[m.end():]):
        f.note.setdefault("label", T.tidy(m.group("label")))  # names-5: «(released by X)» names the label
        _set(f, "D3", f.text[:m.start()] + " " + f.text[m.end():], m.group().strip())
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
    release_parts(f)
    _drop_tail(f, "D3", T.BIT_TAIL_RE)
    _drop_tail(f, "D3", T.CAPS_VOLUME_RE, "album", need_lower=True)  # album_note via _drop_tail
    _drop_tail(f, "D3", T.CAPS_PROMO_RE, need_lower=True)


def tempo_key(f: Field, bpm_refs: tuple) -> None:
    """N11 (names-4): a tempo and a key written together. In brackets always («(205D#)»); at the end of the title
    («/ 205A», «146A», «150 A», «B 146») when the audio agrees with the number or the key has a sharp, flat or minor
    sign. The key is kept as a fact beside the tempo. A title that held only a tempo and a key held no title."""
    def take(m: re.Match[str], n: str, key: str) -> None:
        f.tempo.append(n)
        f.note.setdefault("key", key)
        rest = T.squash(f.text[:m.start()] + " " + f.text[m.end():])
        f.steps.append(Step("N11", "", f.text, rest, m.group().strip()))
        f.text = rest
        if not T.has_word(rest):
            f.flags.add("tempo_only")

    m = T.TEMPO_KEY_BRACKET_RE.search(f.text)
    if m and 60 <= int(m.group(1)) <= 320:
        take(m, m.group(1), m.group(2))
    for rx, ni, ki in ((T.TEMPO_KEY_TAIL_RE, (1, 3), (2, 4)), (T.KEY_TEMPO_TAIL_RE, (2,), (1,))):
        m = rx.search(f.text)
        if not m:
            continue
        n = next(m.group(i) for i in ni if m.group(i))
        key = next(m.group(i) for i in ki if m.group(i))
        sure_key = bool(re.search(r"[#b♯♭m]", key[1:]))
        if 60 <= int(n) <= 320 and (bpm_matches(float(n), bpm_refs) or sure_key):
            take(m, n, key)


def glued_tempo(f: Field, bpm_refs: tuple) -> None:
    """N11 (names-4): a number glued after the final bracket («(DER SANDMANN REMIX)220»), or at the end of a version
    bracket («(X & Y Remix 180)»), when the audio agrees; a variable-tempo note («(VARI BPM)»)."""
    m = T.GLUED_NUMBER_RE.search(f.text)
    if m and 60 <= int(m.group(1)) <= 320 and bpm_matches(float(m.group(1)), bpm_refs):
        f.tempo.append(m.group(1))
        _set(f, "N11", f.text[:m.start()], m.group(1))
    brs = brackets(f.text)
    if brs and brs[-1].closed and (bracket_kind(brs[-1].inner, True)[0] == "version"
                                   or re.match(r"(?i)\s*(?:demo|preview|clip|wip)\b", brs[-1].inner)):
        # names-5: «(demo 207)», «(preview 200)» end in a tempo like a version bracket
        m = T.VERSION_TEMPO_RE.search(f.text)
        if m and m.start() > brs[-1].start and 60 <= int(m.group(1)) <= 320 and bpm_matches(float(m.group(1)), bpm_refs):
            f.tempo.append(m.group(1))
            _set(f, "N11", f.text[:m.start()] + f.text[m.end():], m.group(1))
    m = T.VARI_BPM_RE.search(f.text)
    if m and T.has_word(f.text[:m.start()] + f.text[m.end():]):
        f.note.setdefault("tempo_note", m.group().strip(" ()[]"))
        _set(f, "N11", f.text[:m.start()] + " " + f.text[m.end():], m.group().strip())


def _rel_words(text: str) -> list[str]:
    t = re.sub(r"(?i)\bv\s*/\s*a\b", "va", text)
    out = []
    for w in T.REL_TOKEN_RE.findall(t):
        w = w.casefold().rstrip(".")
        if re.fullmatch(r"vol\.?\s?\d+", w):
            w = "vol"  # names-5: «VOL.3» is a volume
        out.append(w if w.startswith("@") else w.replace(".", ""))
    return out


def release_kind(text: str, bracket: bool = False) -> str:
    """D3r (names-4): what a part of a title is when it is a release note: 'label' (a label name or an «@handle»),
    'album' (a compilation or release name: VA, Vol, EP, LP, Album, Single among at most 8 words), 'promo' (only
    release, promo and technical words; «demo» counts only beside another of them), 'genre' (only genre words), or
    '' (title words). A version or feat. part is never a note."""
    words = _rel_words(text)
    if not words:
        return ""
    if bracket and any(w in T.REL_PROMO_STRONG for w in words):
        return "promo"
    if bracket and words[-1] == "premiere" and len(words) <= 5:
        return "promo"  # names-5: a channel's premiere note («[Aquatic Collective Premiere]»)
    if T.VERSION_WORD_RE.search(text) and not re.search(r"(?i)\bpromo\s*mix\b", text):
        return ""
    if words[0].startswith("@"):
        return "label"
    if bracket and (words[0] in T.REL_MASTER or words[-1] in T.REL_MASTER) and len(words) <= 4:
        return "promo"  # a mastering credit («- Master infernaliz», «(Maleficium Masterd)»)
    last = words[-1]
    if (last in T.REL_LABEL or (last == "music" and bracket and len(words) >= 2)) and len(words) <= 6:
        return "label"
    if any(w in T.REL_NAME for w in words) and len(words) <= 8:
        return "album"
    if bracket and any(w in T.REL_PROMO_STRONG for w in words):
        return "promo"
    kinds = []
    for w in words:
        if w in T.REL_RELEASE or w in T.REL_PROMO or w in T.REL_LABEL:
            kinds.append("rel")
        elif w in T.REL_TECH or T.REL_TECH_RE.fullmatch(w):
            kinds.append("tech")
        elif w in T.REL_FUNC or re.fullmatch(r"(?:19|20)\d\d|#?\d{1,2}", w):
            kinds.append("func")
        elif w == "demo":
            kinds.append("demo")
        elif w in T.REL_GENRE:
            kinds.append("genre")
        else:
            return ""
    strong = [w for w, k in zip(words, kinds) if k == "tech" or (k == "rel" and w not in T.REL_WEAK)]
    if strong or (bracket and any(k == "rel" for k in kinds)):
        return "promo"
    if "demo" not in kinds and any(k == "genre" and w not in T.REL_GENRE_WEAK for w, k in zip(words, kinds)):
        return "genre"
    return ""


def _parts(text: str) -> list[tuple[str, str]]:
    """A title cut into (separator before, part) pairs at its outer separators and top-level brackets."""
    spans = [(b.start, b.end) for b in brackets(text)]
    cuts = [(m.start(), m.end()) for m in T.REL_SEP_RE.finditer(text) if not any(a <= m.start() < b for a, b in spans)]
    for a, b in spans:
        cuts += [(a, a), (b, b)]
    cuts.sort()
    out, last, sep = [], 0, ""
    for a, b in cuts:
        if a < last:
            continue
        piece = text[last:a]
        if piece.strip():
            out.append((sep, piece.strip()))
            sep = ""
        if a != b:
            sep = (sep + " " + text[a:b].strip()).strip()
        last = b
    if text[last:].strip():
        out.append((sep, text[last:].strip()))
    return out


def release_parts(f: Field) -> None:
    """D3r (names-4): release notes as parts of a title. Trailing parts that are notes move to the notes (from the end,
    while each one is a note); a pipe tail with a label or a release name goes whole (« | » is a metadata delimiter);
    one leading release name («Elements EP - Title», «VA Name - Title») goes too. A genre part goes only as a
    bracket. The title always keeps a part with words."""
    parts = _parts(f.text)
    if len(parts) < 2:
        return
    kinds = [release_kind(p.strip("()[]{}\"“” "), bracket=p[:1] in "([{") for _, p in parts]
    kinds = [k if (k != "genre" or p[:1] in "([{") else "" for (_, p), k in zip(parts, kinds)]
    end = len(parts)
    while end > 1 and kinds[end - 1] and any(T.has_word(p) and not k for (_, p), k in zip(parts[:end - 1], kinds)):
        end -= 1
    pipes = [i for i, (s, _) in enumerate(parts) if "|" in s and i > 0]
    if pipes and any(kinds[i] in ("label", "album") for i in range(pipes[0], len(parts))) \
            and any(T.has_word(p) and not k for (_, p), k in zip(parts[:pipes[0]], kinds)):
        end = min(end, pipes[0])
    start = 0
    if end > 1 and kinds[0] == "album" and parts[0][1][:1] not in "([{" and not kinds[1] \
            and parts[1][1][:1] not in "([{" and not T.VERSION_WORD_RE.search(parts[1][1]) and re.search(
            r"(?i)\b(?:ep|lp|album|vol\.?\s*\d+|v\.?\s*/?\s*a\.?)\s*$|^\s*(?:v\.?\s*/?\s*a\.?|va)\b", parts[0][1]):
        start = 1
    if end == len(parts) and start == 0:
        return
    new = ""
    for i, (s, p) in enumerate(parts[start:end]):
        if i and s:
            new += f" {s} "
        elif i:
            new += " "
        new += p
    new = T.squash(new)
    if start:
        m = T.TRACK_NUMBER_RE.match(new)
        new = new[m.end():] if m and T.has_word(new[m.end():]) else new
    if not T.has_word(new):
        return
    gone = list(zip(parts[:start] + parts[end:], kinds[:start] + kinds[end:]))
    for (_, p), k in gone:
        txt = p[1:-1] if p[:1] in "([{" and p[-1:] in ")]}" else p
        txt = T.tidy(re.sub(r"(?i)^\s*(?:for|on|by:?)\s+", "", txt.strip("\"“” @")))
        if k == "label":
            f.note.setdefault("label", txt)
        elif k == "album":
            album_note(f, f"{new} {txt}" if re.fullmatch(r"(?i)ep|lp|album", txt) else txt)
    rule = "N7" if all(k == "genre" for _, k in gone) else "D3"
    _set(f, rule, new, " ".join(p for (_, p), _ in gone))


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
    v = re.sub(r"(?<=\w)\s+&(?=[^\W\d_])|(?<=[^\W\d_])&\s+(?=\w)", " & ", v)  # «Ranji &Ghost Rider» (names-4); «R&B» stays
    v = re.sub(r"(?<=[)\]])\s*\.\s*$", "", v)
    v = re.sub(r'^"([^"]{2,})"(?=\s|$)', r"\1", v)  # «"Lullaby" 2012»: quotes around the title's opening words
    return T.squash(v)


def clean_title(raw: str, track_no: str = "", file_prefix: str = "", bpm_refs: tuple = (), cross: bool = False,
                file_stem: str = "") -> Field:
    f = Field(raw=raw or "")
    f.text = T.chars(raw)
    if f.text != (raw or "").strip():
        f.steps.append(Step("D0", "", (raw or "").strip(), f.text))
    # names-5: a glued «_» before a release word is a separator too («trip_EP Modern Primitive»)
    _set(f, "N0", re.sub(r"(?<=\d)_(?=\d)", "\ue01f", re.sub(r"\s+_+\s+|(?<=[^\W_])_+\s+(?=\S)|\s+_+(?=[^\W_])"
                                                             r"|(?i:(?<=[^\W_])_(?=(?:ep|lp|va|album)\b))", " - ",
                                                             f.text)).replace("_", " ").replace("\ue01f", "_"))
    # names-5: «*text*» at the end wraps a note like a bracket; other runs of asterisks are decoration; a «~» glued
    # between a number and a word separates them («200~clip»)
    _set(f, "D1", re.sub(r"(?<![\w*])\*{2,}|\*{2,}(?![\w*])", " ", re.sub(r"\s*(?<!\*)\*([^*]{2,40})\*\s*$", r" - \1", f.text)))
    _set(f, "D2", re.sub(r"(?<=\d)~(?=[^\W\d_])", " ~ ", f.text))
    _set(f, "D2", re.sub(r"(?<=[\w)\]])\s+(?:-?>+|=>)\s+(?=\w)", " - ", f.text))  # an arrow between parts is a dash
    _drop_tail(f, "D3", T.WRAPPED_LABEL_RE, "label")
    new, changed = T.decorations_title(f.text)
    if changed and T.has_word(new):
        f.steps.append(Step("D1", "", f.text, new))
        f.text = new
    # names-5: one letter at the head of a title, in a script no other word of the title uses, is a logo («Δ Tribute …»)
    m = re.match(r"^\s*([^\W\d_])\s+(?=\S)", f.text)
    if m:
        others = {T._script(c) for c in f.text[m.end():] if c.isalpha()}
        if others and T._script(m.group(1)) not in others:
            _set(f, "D1", f.text[m.end():], m.group(1))
    _apply(f, "D3", T.URL_RE)
    _apply(f, "D3", T.YOUTUBE_TAIL_RE)
    # A3: a leading track number in the raw title tag («04. Title», «11.Name - Title», «02 - Title»)
    m = T.TRACK_NUMBER_RE.match(f.text)
    if m and T.has_word(f.text[m.end():]):
        _set(f, "A3", f.text[m.end():], m.group().strip())
    release_tail(f)
    _drop_brackets(f, "D3", T.VA_BRACKET_RE, "album")  # names-5: before the copied annotation rules, which drop it unread
    # a tempo range outside brackets («Monk's Prayer 158-160 BPM»): the copied annotation rules would keep «158-»
    spans = [(b.start, b.end) for b in brackets(f.text)]
    m = T.TEMPO_RANGE_RE.search(f.text)
    if m and not any(a <= m.start() < b for a, b in spans) and T.has_word(f.text[:m.start()] + " " + f.text[m.end():]) \
            and int(m.group(1)) < int(re.findall(r"\d{2,3}", m.group())[1]):  # «200 - 200BPM» is no range
        f.tempo.append(m.group(1))
        _set(f, "N11", f.text[:m.start()] + " " + f.text[m.end():], m.group().strip())
    tempo_key(f, bpm_refs)
    tempo_bracket(f)  # before the copied annotation rules, which would take «160BPM» out of «(145 - 160BPM Prog Trance)»
    m = T.TEMPO_GENRE_TAIL_RE.search(f.text)
    if m and T.has_word(f.text[:m.start()]):
        f.tempo.append(m.group(1))
        _set(f, "N11", f.text[:m.start()], m.group().strip())
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
    m = re.search(r"(?i)\bout\s*now\s+on\s+([^()\[\]]*\b(?:records?|recordings|recs?)\b\.?)", f.text)
    if m:
        f.note.setdefault("label", T.tidy(m.group(1)))
    m = T.OUT_NOW_LABEL_RE.search(f.text)
    if m and T.has_word(f.text[:m.start()]) and not T.VERSION_WORD_RE.search(m.group("label")):
        # names-5: «Title >> Out Now >> Label»: the part after «Out Now» is the label (or the album it names)
        if release_kind(m.group("label")) == "album" or re.search(r"(?i)\bv\.?\s*/?\s*a\b|\bvol\.?\s*\d|\b(?:ep|lp|album)\b",
                                                                 m.group("label")):
            album_note(f, m.group("label"))
        else:
            f.note.setdefault("label", T.tidy(m.group("label")))
        _set(f, "D3", f.text[:m.start()], m.group().strip())
    _outside_versions(f, "D3", T.OUT_NOW_RE)
    _note(f, "D3", T.BY_LABEL_RE, "label")
    _note(f, "D3", T.DASH_LABEL_RE, "label")
    m = T.LABEL_VA_HEAD_RE.match(f.text)
    if m:
        f.note.setdefault("label", m.group("label").strip())
        _set(f, "D3", m.group("title"), m.group()[:m.start("title")].strip())
    _note(f, "D3", T.VA_TAIL_RE, "album")
    _apply(f, "D3", T.TECH_RE)
    _apply(f, "D3", T.TECH_TAIL_RE)
    release_notes(f)
    # «Album - 07 Title»: an album name and a track number in front of the title
    m = T.ALBUM_TRACK_RE.match(f.text)
    if m and T.has_word(f.text[m.end():]):
        album_note(f, m.group("album").strip())
        _set(f, "A3", f.text[m.end():], m.group().strip())
    _apply(f, "D4", T.ORIGINAL_MIX_RE)
    _apply(f, "N11", T.TEMPO_WORD_RE, tempo_group=True)
    tempo_bracket(f)
    _apply(f, "N11", T.KEY_RE)
    glued_tempo(f, bpm_refs)
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
    m = re.search(r"(?<=[^\W\d_])\s+(\d{2,3})\s+(?=[A-Z][^\W\d_])", f.text)
    if m and 60 <= int(m.group(1)) <= 320 and bpm_matches(float(m.group(1)), bpm_refs) and not brackets(f.text[:m.start()]):
        f.tempo.append(m.group(1))
        _set(f, "N11", f.text[:m.start()] + " - " + f.text[m.end():], m.group(1))
    tempo_key(f, bpm_refs)  # once more: a tempo and key left at the end by the removals above («150 A PREVIEW»)
    # a title that is only a number, or a bare trailing number: a tempo only when the audio agrees
    m = T.WHOLE_NUMBER_RE.match(f.text)
    if m and 60 <= int(m.group(1)) <= 320 and bpm_matches(float(m.group(1)), bpm_refs):
        f.tempo.append(m.group(1))
        f.steps.append(Step("N11", "", f.text, "", m.group(1)))
        f.text = ""
        f.flags.add("tempo_only")
    else:
        m = T.TRAILING_RANGE_RE.search(f.text)
        if m and 60 <= int(m.group(1)) <= 320 and bpm_matches(float(m.group(1)), bpm_refs) \
                and T.has_word(f.text[:m.start()]):
            f.tempo.append(m.group(1))
            _set(f, "N11", f.text[:m.start()] + " " + f.text[m.end():], m.group().strip())
        m = T.TRAILING_NUMBER_RE.search(f.text)
        n = (m.group(1) or m.group(2)) if m else None
        if m and 60 <= float(n) <= 320 and bpm_matches(float(n), bpm_refs) and T.has_word(f.text[:m.start()]) \
                and not T.PREPOSITION_NUMBER_RE.search(f.text[:m.end()]):
            f.tempo.append(n)
            _set(f, "N11", f.text[:m.start()] + f.text[m.end():], m.group().strip())
    # N11L: a leading number before a head, dropped here only on string evidence (the track-number tag or the
    # file-name prefix); the known-act case is decided in P2
    m = T.LEADING_NUMBER_RE.match(f.text)
    if m and T.has_word(f.text[m.end():]):
        n = m.group(1)
        tag_no = re.match(r"\s*0*(\d+)", track_no or "")
        from_file = file_prefix and file_prefix.lstrip("0") == n.lstrip("0") and not file_made_from(file_stem, f.text)
        audio = 60 <= int(n) <= 320 and bpm_matches(float(n), bpm_refs) and not re.match(r"(?i)\s*bpm\b",
                                                                                         f.text[m.end():])
        if (tag_no and tag_no.group(1) == n.lstrip("0")) or from_file or audio:
            if audio:
                f.tempo.append(n)
            _set(f, "N11L", f.text[m.end():], n)
        else:
            f.lead_number = n
    _set(f, "D2", re.sub(r"\s*(?:[;:]-?[)(]|<3+)\s*$", "", f.text))  # names-5: «<3» at the end too
    if any(s.rule == "D3" for s in f.steps) and re.search(r"\s[l|]\s*$", f.text):
        _set(f, "D2", re.sub(r"\s[l|]\s*$", "", f.text), "l")
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
    m = T.MASH_UP_RE.search(f.text)
    if m and T.has_word(f.text[:m.start()]):
        _set(f, "D5", f"{f.text[:m.start()]} ({m.group(1)}-{m.group(2)})")  # names-5: «… Mash - Up» → «… (Mash-Up)»
    if T.DASH_ROLE_ONLY_RE.match(f.text):
        _set(f, "D5", T.DASH_ROLE_ONLY_RE.sub(r"\1 (\2 \3)", f.text))
    elif T.DASH_WORD_RE.match(f.text):
        # names-5: a final dash tail that is only a version word («Moon Riders - Demo» → «Moon Riders (Demo)»); like
        # «X - Y Remix» it waits for the head (P2 undoes it when X is the artist)
        before_d5 = f.text
        _set(f, "D5", T.DASH_WORD_RE.sub(r"\1 (\2)", f.text))
        if f.text != before_d5 and len(segments(before_d5)) == 2:
            f.pre_d5 = before_d5
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
    if re.fullmatch(r"(?i)\s*\+?\d{2,3}(?:\s*[-–]\s*\d{2,3})?\s*-?\s*\+?\s*bpm\s*", f.text) or (
            T.TEMPO_BRACKET_RE.fullmatch(f.text) and 60 <= int(re.search(r"\d{2,3}", f.text).group()) <= 320):
        m = re.search(r"(\d{2,3})", f.text)
        f.tempo.append(m.group(1))
        f.steps.append(Step("N11", "", f.text, "", f.text))
        f.text = ""
        f.flags.add("tempo_only")
    elif T.RELEASE_NOTE_ONLY_RE.match(f.text) and not brackets(f.text):
        # names-5: the title is only a release note («Released on album 'Whispers In The Dark'»): it held no title
        album_note(f, T.RELEASE_NOTE_ONLY_RE.match(f.text).group("what"))
        f.steps.append(Step("D3", "", f.text, "", f.text))
        f.text = ""
        f.flags.add("tempo_only")
        f.flags.add("release_only")
    elif T.has_word(f.text) and (not T.has_word(T.PROMO_ANY_RE.sub(" ", T.OUT_NOW_RE.sub(" ", f.text)))
                                 or T.RELEASE_WORD_ONLY_RE.match(f.text)):
        f.steps.append(Step("D3", "", f.text, "", f.text))
        f.text = ""
        f.flags.add("tempo_only")
    if not T.has_word(f.text) and not f.flags & {"tempo_only"}:
        f.flags.add("empty")
    return f
