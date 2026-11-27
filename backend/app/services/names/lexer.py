"""The one way every source string is read: tokens -> bracket groups -> segments -> credits.

Reused from the grammar prototype with its three measured faults fixed: a bracket opened in the artist field and
closed in the title field is joined by the caller (rules.cross_field_bracket) before this module sees it; an
underscore with no space is a space (text.chars keeps it, clean_artist turns it into a space); a wide gap between two
words of an artist field is the neutral separator SEP, which always splits acts («Radikal Moodz   Thelios»).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable

from .text import SEP, has_word

ROLE = (r"(?:remix(?:ed)?|rmx|re-?mix|edit|re-?edit|rework|re-?work|bootleg|boot|vip|dub|mix|mashup|mash-?up|flip"
        r"|cover|version|refix|remake|remaster(?:ed)?|live|instrumental|reboot)")
ROLE_END_RE = re.compile(rf"(?i)^(?P<credit>.*?)\s*\b(?P<role>{ROLE})\b\.?\s*(?:'?\d{{2,4}})?\s*$")
# outside brackets only the unambiguous remix words count («Kayros Live», «Club Mix» are names or titles)
ROLE_BARE_RE = re.compile(r"(?i)^(?P<credit>.*?)\s+\b(?P<role>remix|rmx|re-?mix|edit|rework|bootleg|vip|mashup|flip"
                          r"|refix|remake|reboot)\b\.?\s*$")
ROLE_WORD_RE = re.compile(r"(?i)\b(?:remix(?:ed)?|rmx|re-?mix|rework|bootleg|mashup|vip\s+mix|original\s+mix|edit)\b")
STRONG_JOIN_RE = re.compile(
    rf"(?i)\s*(?:&|,|;|{SEP}|(?<=\s)vs\.?(?=\s)|(?<=\s)v/s(?=\s)|(?<=\s)(?:feat\.?|ft\.?|featuring)(?=\s))\s*")
WEAK_JOIN_RE = re.compile(r"\s+(?:x|X|×|and|And|AND|meets|Meets|with|With|b2b|B2B|\+)\s+|(?<=\w)\s*\+\s*(?=\w)"
                          r"|(?<=\w)\s*/\s*(?=\w)")
# N15 relaxed: these weak joins also split when every part is name-like and one part is a strong act (a Spotify
# entry, two other tracks or a decision) and the whole is not one act: «Marcuz x Lunawatt»
RELAXED_JOIN_RE = re.compile(r"(?i)^(?:x|×|and|b2b|meets)$")
NAME_PART_RE = re.compile(r"[^\W\d_].*[^\W\d_]|[^\W\d_]{2,}")
FEAT_RE = re.compile(r"(?i)(?:^|\s+)(?:feat\.?|ft\.?|featuring)\s+")
SEGMENT_RE = re.compile(r"\s+[-–—]+\s+|(?<=\w)[-–—]\s+|\s+[-–—](?=[^\W\d_])|\s+\|\s+|\s+//\s+|\s+~\s+")
NAMEISH_RE = re.compile(r"^[\w'’.!$-]+(?:\s+[\w'’.!$()-]+){0,4}$")
QUALIFIER_RE = re.compile(r"^(?:[A-Z]{1,3}|[A-Z][a-z]{1,2})$")
FEAT_OPEN_RE = re.compile(r"(?i)^\s*(?:feat\.?|ft\.?|featuring|with|pres\.?|presents)\s+")
ALIAS_RE = re.compile(r"(?i)^\s*a\.?k\.?a\.?\s+")
# names-4: style words before the version word name the kind of mix, not the remixer («Grouch in Dub Remix», «Tribute
# Mix», «Re Edit 2018», «Henrique Camacho Hi-Tech Remix»); a dangling «in» or «by» goes with them
STYLE_RUN_RE = re.compile(
    r"(?i)(?:^|\s+)(?:(?:dub|re|edit|tribute|hi-?\s?tech|extended|radio|club|live|vip|original|special|alternative|alt"
    r"|instrumental|acoustic|vocal|mix|version|bootleg|mashup|rework|flip|refix|remake|psy|psytrance|dark|darkpsy|forest"
    r"|goa|prog(?:ressive)?|full\s*-?\s*on|trance|techno|ambient|downtempo|chill(?:out)?|hybrid|reggae|funk|minimal"
    r"|twilight|night|psycore|\d{2,4})(?:\s+|$))+$")
DANGLING_RE = re.compile(r"(?i)\s+(?:in|by|the|and|&|with)$")


def remixer_name(name: str) -> str:
    """The remixer in a version credit with the style words before the version word left out ('' when none is left)."""
    n = name.strip()
    prev = None
    while prev != n:
        prev = n
        n = STYLE_RUN_RE.sub("", n).strip()
        n = DANGLING_RE.sub("", n).strip()
    return n


@dataclass(frozen=True)
class Bracket:
    start: int
    end: int
    inner: str
    closed: bool


def brackets(s: str) -> list[Bracket]:
    """Top-level bracket groups of s, in order. An unclosed group runs to the end."""
    out: list[Bracket] = []
    depth, start = 0, -1
    for i, c in enumerate(s):
        if c in "([{":
            if depth == 0:
                start = i
            depth += 1
        elif c in ")]}" and depth:
            depth -= 1
            if depth == 0:
                out.append(Bracket(start, i + 1, s[start + 1:i], True))
    if depth and start >= 0:
        out.append(Bracket(start, len(s), s[start + 1:], False))
    return out


def outside_split(s: str, regex: re.Pattern[str]) -> tuple[list[str], list[str]]:
    """Split s on matches of regex that lie outside brackets. Returns (parts, the separators)."""
    spans = [(b.start, b.end) for b in brackets(s)]
    parts, seps, last = [], [], 0
    for m in regex.finditer(s):
        if m.start() == m.end() or any(a <= m.start() < b for a, b in spans):
            continue
        parts.append(s[last:m.start()])
        seps.append(m.group())
        last = m.end()
    parts.append(s[last:])
    return [p.strip() for p in parts], [x.strip() for x in seps]


def segments(s: str) -> list[str]:
    """«X - Y | Z» -> [X, Y, Z] (outside brackets). A one-letter side is not a split («O - Zone»)."""
    parts, seps = outside_split(s, SEGMENT_RE)
    out: list[str] = []
    for p in parts:
        if not p:
            continue
        if out and (len(re.sub(r"\W", "", out[-1])) <= 1 or len(re.sub(r"\W", "", p)) <= 1) \
                and not re.fullmatch(r"\d+", p):
            out[-1] = f"{out[-1]} - {p}"
            continue
        out.append(p)
    return out


def bracket_kind(inner: str, closed: bool) -> tuple[str, dict]:
    """What a bracket inside an artist field or a title is: version, original, feat, qualifier, alias, members,
    truncated (an unclosed name), other."""
    t = inner.strip()
    if not t:
        return "empty", {}
    m = ROLE_END_RE.match(t)
    if m:
        credit = m.group("credit").strip(" -")
        if m.group("role").lower() == "mix" and re.search(r"(?i)\soriginal$", credit):
            # «(Munrra Original Mix)»: the artist's own original mix, not a remix by «Munrra Original»
            return "original", {"names": [re.sub(r"(?i)\s+original$", "", credit).strip()], "role": "Original Mix"}
        if not credit or re.fullmatch(r"(?i)original|extended|radio|club|\d{2,4}|'\d\d", credit):
            kind = "original" if re.fullmatch(r"(?i)original", credit or "") and m.group("role").lower() == "mix" else "version"
            return kind, {"names": [], "role": m.group("role")}
        names, _ = outside_split(credit, STRONG_JOIN_RE)
        # «(Deadhead Mashup & Rmx)»: a role word left at the end of a name is not part of it; nor are style words
        names = [remixer_name(re.sub(rf"(?i)\s+{ROLE}\.?$", "", n).strip()) for n in names]
        return "version", {"names": [n for n in names if n and not re.fullmatch(rf"(?i){ROLE}\.?", n)],
                           "role": m.group("role")}
    if FEAT_OPEN_RE.match(t):
        names, _ = outside_split(FEAT_OPEN_RE.sub("", t, count=1), STRONG_JOIN_RE)
        return "feat", {"names": [n for n in names if n]}
    if QUALIFIER_RE.fullmatch(t):
        return "qualifier", {}
    if ALIAS_RE.match(t):
        return "alias", {"alias": ALIAS_RE.sub("", t).strip()}
    parts, _ = outside_split(t, STRONG_JOIN_RE)
    parts = [p for p in parts if p]
    if len(parts) < 2:
        weak = [p.strip() for p in re.split(r"\s+(?:x|X|×|and|And|AND|vs\.?|VS\.?|Vs\.?)\s+", t) if p.strip()]
        parts = weak if len(weak) >= 2 else parts
    if len(parts) >= 2 and all(NAMEISH_RE.match(p) for p in parts) and not re.search(
            r"(?i)\s(?:feat\.?|ft\.?|featuring)\s", t):
        return "members", {"names": parts}  # a «feat.» inside is a credit, not a member list (names-3)
    if not closed and NAMEISH_RE.match(t) and not re.search(
            r"(?i)\b(?:va|v/a|vol\.?|records?|recs?|music|compil\w*|bonus|free|ep|lp)\b", t):
        return "truncated", {"names": [t]}
    return "other", {}


@dataclass
class Credit:
    """A credit read into acts. `joins[i]` is the join word between acts[i] and acts[i+1] as written."""
    acts: list[str] = field(default_factory=list)
    joins: list[str] = field(default_factory=list)
    featured: list[str] = field(default_factory=list)
    feat_word: str = ""
    weak_split: bool = False
    relaxed: bool = False  # a weak join split on one strong part only (N15 relaxed): `look`


def split_credit(text: str, known: Callable[[str], bool] | None = None,
                 one_act: Callable[[str], bool] | None = None) -> Credit:
    """N15: a credit into acts. Strong joins always split (outside brackets); weak joins («x», «/», «and», «+»,
    «with», «meets», «b2b») only when every part is a known act and the whole is not, or (for «x», «and», «b2b»,
    «meets») when one part is a strong act (`known.strong`) and every part is name-like. A credit that is one act on
    Spotify or by a `one_act` decision (N25) is never split."""
    c = Credit()
    body = text.strip()
    if not body:
        return c
    if one_act and one_act(body):
        c.acts = [body]
        return c
    parts, seps = outside_split(body, FEAT_RE)
    if len(parts) > 1 and parts[0]:
        body = parts[0]
        c.feat_word = seps[0]
        for f in parts[1:]:
            names, _ = outside_split(f, STRONG_JOIN_RE)
            c.featured += [n for n in names if n]
    parts, seps = outside_split(body, STRONG_JOIN_RE)
    acts: list[str] = []
    joins: list[str] = []
    for i, p in enumerate(parts):
        if not p:
            continue
        if acts:
            joins.append(seps[i - 1] if i - 1 < len(seps) else "&")
        weak_parts, weak_seps = outside_split(p, WEAK_JOIN_RE)
        weak_parts = [w for w in weak_parts if w]
        strong = getattr(known, "strong", None)
        relaxed = (strong is not None and len(weak_parts) > 1 and all(RELAXED_JOIN_RE.match(x) for x in weak_seps)
                   and all(NAME_PART_RE.search(w) for w in weak_parts) and any(strong(w) for w in weak_parts))
        if (len(weak_parts) > 1 and known is not None and (all(known(w) for w in weak_parts) or relaxed)
                and not known(p) and not (one_act and one_act(p))):
            acts.append(weak_parts[0])
            for w, s in zip(weak_parts[1:], weak_seps):
                joins.append(s)
                acts.append(w)
            c.weak_split = True
            c.relaxed = c.relaxed or not all(known(w) for w in weak_parts)
        else:
            acts.append(p)
    c.acts = [a for a in acts if has_word(a)]
    c.joins = joins[:max(0, len(c.acts) - 1)]
    return c


def join_word(sep: str) -> str:
    """The join word as shown under `first_capital`: lowered, its own spelling and dot kept."""
    s = sep.strip()
    if s in ("", SEP, "+"):
        return "&"
    if s in (",", ";"):
        return ","
    if re.fullmatch(r"(?i)vs\.?|v/s|feat\.?|ft\.?|featuring|x|and|meets|with|b2b", s):
        return s.lower()
    return s


def render_credit(acts: list[str], joins: list[str]) -> str:
    out = acts[0] if acts else ""
    for i, a in enumerate(acts[1:]):
        j = join_word(joins[i] if i < len(joins) else "&")
        out += (", " if j == "," else f" {j} ") + a
    return out
