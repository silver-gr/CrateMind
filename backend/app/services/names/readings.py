"""Layer 2: the readings of one track. Each reading proposes an artist credit and a title; nothing is chosen here."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable

from . import text as T
from .fields import PLACEHOLDER_RE, Field, clean_artist, clean_title
from .lexer import (ROLE_BARE_RE, Credit, bracket_kind, brackets, outside_split, render_credit, segments,
                    split_credit)
from .model import TrackInput
from .registry import SUBTITLE_RE

JOIN_LEAD_RE = re.compile(r"(?i)^\s*(&|and|vs\.?|x|feat\.?|ft\.?|with)\s+")
FILE_INDEX_RE = re.compile(r"^\s*\d{1,4}\s*[.)_-]?\s+(?=\S)")
GENERIC_FOLDER_RE = re.compile(r"(?i)^(?:unknown artist|unknown album|compilations?|various artists?|va|downloads?"
                               r"|music|likes of\b.*|\[χύμα\].*|χύμα.*|singles?|downloaded by\b.*|new folder.*)$")
ROLE_WORDS = {"rmx": "Remix", "remix": "Remix", "re-mix": "Remix", "remixed": "Remix", "re mix": "Remix"}


@dataclass
class P0:
    """Phase P0 of one track: both fields cleaned by string rules, read by the lexer, nothing decided."""
    t: TrackInput
    a: Field
    ti: Field
    n20: str = ""
    n20_part: str = ""
    credit: Credit = field(default_factory=Credit)
    head: str = ""
    rest: str = ""
    file_head: str = ""
    file_tail: str = ""
    file_prefix: str = ""
    group: str = ""
    album_head: str = ""  # N29: the «X» of an album tag «X - Y»


def file_parts(file_name: str) -> tuple[str, str, str]:
    base = (file_name or "").rsplit("/", 1)[-1]
    stem = base.rsplit(".", 1)[0] if "." in base else base
    m = re.match(r"^\s*(\d{1,4})", stem)
    prefix = m.group(1) if m else ""
    stem = FILE_INDEX_RE.sub("", stem)
    stem = T.chars(stem).replace("_", " ")
    stem, _ = T.title_annotations(stem)
    segs = segments(stem)
    if len(segs) >= 2:
        return segs[0], " - ".join(segs[1:]), prefix
    return "", stem, prefix


def p0(t: TrackInput) -> P0:
    """Phase P0: string rules only (layers 0-1), no registry."""
    from .fields import cross_field_bracket
    raw_a, raw_t = T.chars(t.artist), T.chars(t.title)
    a_text, t_text, n20, part = cross_field_bracket(raw_a, raw_t)
    fh, ft, prefix = file_parts(t.file_name)
    a = clean_artist(a_text, members=(n20 != "group"))
    if a_text != raw_a:
        a.steps.insert(0, _step("N20", raw_a, a_text, part))
    ti = clean_title(t_text, t.track_no, prefix, (t.bpm_grid, t.bpm_analyzed), cross=(n20 == "group"))
    if t_text != raw_t:
        ti.steps.insert(0, _step("N20", raw_t, t_text, part))
    p = P0(t=t, a=a, ti=ti, n20=n20, n20_part=part, file_head=fh, file_tail=ft, file_prefix=prefix)
    p.credit = split_credit(a.text)
    segs = segments(ti.text) if ti.text else []
    if len(segs) >= 2 and T.fold(segs[0]) == T.fold(t.album) and len(T.fold(segs[0])) >= 4:
        # the album's name repeated at the head of the title («Organic Beats - 02 Seamoon - Fractured Fractions»)
        rest = " - ".join(segs[1:])
        m = T.TRACK_NUMBER_RE.match(rest)
        if m and T.has_word(rest[m.end():]):
            rest = rest[m.end():]
        ti.steps.append(_step("A1album", ti.text, rest, segs[0]))
        ti.note["album"] = segs[0]
        ti.text = rest
        segs = segments(rest)
    if len(segs) >= 2 and not SUBTITLE_RE.match(segs[1]) and not re.fullmatch(r"\d{1,3}", segs[0]):
        p.head, p.rest = segs[0], " - ".join(segs[1:])
    m = re.match(r"^\s*(.+?)\s+[-–—]\s+\S", T.chars(t.album))
    if m and not PLACEHOLDER_RE.match(m.group(1)) and not re.search(r"(?i)\bv\.?\s*/?\s*a\b|various|compil|friends",
                                                                       m.group(1)):
        p.album_head = T.squash(m.group(1))
    return p


def _step(rule, before, after, evidence=""):
    from .model import Step
    return Step(rule, "", before, after, evidence)


@dataclass
class Reading:
    rule: str
    acts: list[str]
    joins: list[str] = field(default_factory=list)
    featured: list[str] = field(default_factory=list)
    feat_word: str = ""
    title: str = ""
    original: list[str] = field(default_factory=list)
    notes: dict = field(default_factory=dict)
    evidence: str = ""
    string_only: bool = False  # both fields of the same file agree: `sure` without a registry check

    @property
    def artist(self) -> str:
        s = render_credit(self.acts, self.joins)
        if self.featured:
            s += f" {self.feat_word or 'feat.'} " + render_credit(self.featured, [","] * len(self.featured))
        return s

    def key(self) -> tuple:
        return (tuple(sorted(T.fold(a) for a in self.acts)), T.fold(self.title))


def credit_of(text: str, known: Callable[[str], bool], one_act: Callable[[str], bool]) -> Credit:
    return split_credit(text, known, one_act)


def version_title(core: str, remixers: list[str], role: str) -> str:
    word = ROLE_WORDS.get(role.lower().replace(".", ""), role[:1].upper() + role[1:].lower() if role.islower() or
                          role.isupper() else role)
    who = render_credit(remixers, ["&"] * len(remixers))
    return T.squash(f"{core} ({who} {word})")


def title_from_field(f: Field) -> str:
    return f.text


def linked_split(title: str, links, own: set[str]) -> tuple[str, str] | None:
    """«Title - Artist» (spaced or not): the split whose tail is exactly the act set of a linked record that does not
    name the artist field's acts."""
    for ln in links:
        ref = {T.fold(a) for x in ln.artists for a in split_credit(x).acts}
        if not ref or ref & own:
            continue
        for m in re.finditer(r"\s*[-–—]\s*", title):
            head, tail = title[:m.start()].strip(), title[m.end():].strip()
            if T.has_word(head) and {T.fold(a) for a in split_credit(tail).acts} == ref:
                return head, tail
    return None


def _bare(name: str) -> str:
    v = re.sub(r"\s*[(\[][A-Z]{1,3}[)\]]\s*$", "", name or "")
    v = re.sub(r"(?i)\s*(?:and|&)\s+friends\s*$", "", v)
    return T.fold(v)


def is_title_junk(f: Field) -> bool:
    """The title field is empty, only a tempo, or only promo/placeholder text."""
    return not T.has_word(f.text) or "tempo_only" in f.flags or bool(PLACEHOLDER_RE.match(f.text))


def build(p: P0, known: Callable[[str], bool], one_act: Callable[[str], bool]) -> list[Reading]:
    """Every candidate reading other than the as-read one."""
    out: list[Reading] = []
    a_text, t_text = p.a.text, p.ti.text
    own = credit_of(a_text, known, one_act)
    own_keys = {T.fold(x) for x in own.acts} | {T.fold(a_text)} | {_bare(x) for x in own.acts + [a_text]} | {
        T.fold(x) for x in re.split(r"\s*/\s*", a_text)}
    own_keys.discard("")
    from .decide import own_head_rest
    rest = own_head_rest(t_text, own.acts + [a_text]) if own.acts else None
    if rest is not None:
        out.append(Reading("A1own", own.acts, own.joins, own.featured, own.feat_word, rest, string_only=True,
                           evidence=t_text[:len(t_text) - len(rest)].strip()))
    # A1 and its string-only forms (own head, S2 second names, S3 missing collaborators, album tag as head)
    if p.head and rest is None:
        head = p.head
        m = JOIN_LEAD_RE.match(head)
        if m and own.acts:
            extra = credit_of(head[m.end():], known, one_act)
            out.append(Reading("S2", own.acts + extra.acts, own.joins + [m.group(1)] + extra.joins,
                               own.featured + extra.featured, own.feat_word, p.rest, string_only=True,
                               evidence=head))
        else:
            hc = credit_of(head, known, one_act)
            head_keys = {T.fold(x) for x in hc.acts} | {T.fold(head)}
            if T.fold(head) in own_keys or (own.acts and {T.fold(x) for x in hc.acts} == {T.fold(x) for x in own.acts}):
                out.append(Reading("A1own", own.acts, own.joins, own.featured, own.feat_word, p.rest,
                                   string_only=True, evidence=head))
            elif T.fold(head) == T.fold(p.t.album) and own.acts:
                out.append(Reading("A1album", own.acts, own.joins, own.featured, own.feat_word, p.rest,
                                   string_only=True, evidence=head, notes={"album": head}))
            elif own.acts and own_keys & head_keys and len(hc.acts) > len(own.acts):
                out.append(Reading("S3", hc.acts, hc.joins, hc.featured, hc.feat_word, p.rest, string_only=True,
                                   evidence=head))
            elif len(own.acts) >= 3 and hc.acts and {T.fold(x) for x in hc.acts} < {T.fold(x) for x in own.acts}:
                # the title names which of the listed acts made this track
                out.append(Reading("S3", hc.acts, hc.joins, hc.featured, hc.feat_word, p.rest, string_only=True,
                                   evidence=head))
            elif hc.acts and not PLACEHOLDER_RE.match(head):
                out.append(Reading("A1", hc.acts, hc.joins, hc.featured, hc.feat_word, p.rest, evidence=head))
                # the reverse, «Title - Artist»: only an empty field chooses it, and only on evidence
                if len(segments(p.ti.text)) == 2 and not brackets(p.rest):
                    tc = credit_of(p.rest, known, one_act)
                    if tc.acts:
                        out.append(Reading("A1r", tc.acts, tc.joins, tc.featured, tc.feat_word, head, evidence=p.rest))
    ls = linked_split(t_text, p.t.links, own_keys) if t_text else None
    if ls and not any(c.rule == "A1r" for c in out):
        tc = credit_of(ls[1], known, one_act)
        out.append(Reading("A1r", tc.acts, tc.joins, tc.featured, tc.feat_word, ls[0], evidence=ls[1]))
    # N18: «A - B» inside the artist field
    a_segs = segments(a_text)
    if len(a_segs) >= 2:
        first = credit_of(a_segs[0], known, one_act)
        second = " - ".join(a_segs[1:])
        if is_title_junk(p.ti) or T.fold(t_text) == T.fold(second) or T.fold(second) in T.fold(t_text):
            out.append(Reading("N18", first.acts, first.joins, first.featured, first.feat_word,
                               t_text if T.has_word(t_text) and len(T.fold(t_text)) >= len(T.fold(second)) else second,
                               evidence=a_text))
        elif re.search(r"(?i)\b(?:records?|recordings|music|official)\s*$", second):
            out.append(Reading("N9", first.acts, first.joins, first.featured, first.feat_word, t_text,
                               evidence=second, notes={"label": second}))
    # N14: «X Remix [N Bpm] <sep> Y» in the artist field
    parts, _ = outside_split(a_text, re.compile(rf"\s*{T.SEP}\s*|\s+[-–—]+\s+"))
    parts = [x for x in parts if x]
    if parts:
        m = ROLE_BARE_RE.match(parts[0])
        if m and m.group("credit").strip() and T.has_word(t_text):
            rem = credit_of(m.group("credit").strip(), known, one_act)
            original = credit_of(" & ".join(parts[1:]), known, one_act).acts if len(parts) > 1 else []
            if original or all(known(x) for x in rem.acts):
                out.append(Reading("N14", rem.acts, rem.joins, [], "",
                                   version_title(t_text, rem.acts, m.group("role")), original=original,
                                   evidence=a_text))
    # N14t: the same shape in a title tag, «T Rmx [N Bpm] - Y», or «Y - T (X Remix)» under X
    t_segs = segments(t_text) if t_text else []
    if own.acts and len(t_segs) == 2:
        m = ROLE_BARE_RE.match(t_segs[0])
        if m and m.group("credit").strip():
            orig = credit_of(t_segs[1], known, one_act).acts
            out.append(Reading("N14t", own.acts, own.joins, own.featured, own.feat_word,
                               version_title(m.group("credit").strip(), own.acts, m.group("role")), original=orig,
                               evidence=t_text))
        else:
            brs = brackets(t_segs[1])
            if brs:
                kind, data = bracket_kind(brs[-1].inner, brs[-1].closed)
                if kind == "version" and {T.fold(x) for x in data["names"]} & own_keys:
                    out.append(Reading("N14t", own.acts, own.joins, own.featured, own.feat_word, t_segs[1],
                                       original=credit_of(t_segs[0], known, one_act).acts, evidence=t_text))
    # N13: swap
    if t_text and len(t_segs) <= 1 and T.has_word(a_text):
        tc = credit_of(t_text, known, one_act)
        if tc.acts and not brackets(t_text):
            out.append(Reading("N13", tc.acts, tc.joins, tc.featured, tc.feat_word, a_text, evidence=t_text))
    # N21: the artist field is the title (a version bracket) and the title field is empty, a tempo or junk
    brs = brackets(a_text)
    if brs and is_title_junk(p.ti):
        kind, data = bracket_kind(brs[-1].inner, brs[-1].closed)
        if kind == "version" and a_text[:brs[-1].start].strip():
            if data["names"]:
                rc = credit_of(" & ".join(data["names"]), known, one_act)
                out.append(Reading("N21", rc.acts, rc.joins, [], "", a_text, evidence=a_text))
            else:
                if p.file_head and T.fold(p.file_head) != T.fold(a_text):
                    fc = credit_of(p.file_head, known, one_act)
                    out.append(Reading("N21", fc.acts, fc.joins, fc.featured, fc.feat_word, a_text,
                                       evidence=f"file: {p.file_head}"))
                for ln in p.t.links:
                    if ln.service == "spotify" and ln.artists:
                        out.append(Reading("N21", list(ln.artists), ["&"] * (len(ln.artists) - 1), [], "", a_text,
                                           evidence=f"Spotify: {', '.join(ln.artists)}"))
                        break
    # N22: the file name «Artist - Title»
    if p.file_head:
        fc = credit_of(p.file_head, known, one_act)
        tail_ok = not T.has_word(t_text) or T.fold(p.file_tail) == T.fold(t_text) or (
            len(T.fold(t_text)) >= 4 and (T.fold(t_text) in T.fold(p.file_tail) or T.fold(p.file_tail) in T.fold(t_text)))
        if fc.acts and tail_ok and not PLACEHOLDER_RE.match(p.file_head):
            out.append(Reading("N22", fc.acts, fc.joins, fc.featured, fc.feat_word,
                               t_text if T.has_word(t_text) else p.file_tail, evidence=p.file_head))
    # N23: linked records (Spotify artist array; SoundCloud publisher when it is not the uploader)
    for ln in p.t.links:
        if ln.service == "spotify" and ln.artists:
            title = clean_title(ln.title).text or t_text
            out.append(Reading("N23", list(ln.artists), ["&"] * (len(ln.artists) - 1), [], "",
                               t_text if T.has_word(t_text) else title, evidence=f"Spotify: {', '.join(ln.artists)}"))
        elif ln.service == "soundcloud" and ln.artists and T.fold(ln.artists[0]) != T.fold(ln.uploader):
            pc = credit_of(clean_artist(ln.artists[0]).text, known, one_act)
            if pc.acts:
                out.append(Reading("N23sc", pc.acts, pc.joins, pc.featured, pc.feat_word, t_text,
                                   evidence=f"SoundCloud: {ln.artists[0]}"))
    return out
