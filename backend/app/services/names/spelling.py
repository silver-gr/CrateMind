"""Layer 5: one spelling per act under the `first_capital` preference (H, N5, C2, C3, C4, N2).

Votes are the acts read in phase P0 from raw artist fields and title heads, never shown or decided values: one vote
per album group, one per track outside a group. Ties: more tracks, Spotify count, SoundCloud publisher count, fewer
capitals, code point order."""
from __future__ import annotations

import re
import unicodedata
from collections import Counter
from dataclasses import dataclass, field

from .text import skeleton

KEEP_FIXED = {"DJ": "DJ", "MC": "MC", "VIP": "VIP", "EP": "EP", "UK": "UK", "USA": "USA", "NZ": "NZ", "FX": "FX",
              "BPM": "BPM", "DNB": "DnB"}
ROMAN = {"II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII",
         "XVIII", "XIX", "XX"}
PARTICLES = {"van", "von", "de", "der", "den", "del", "della", "di", "da", "du", "la", "le", "el", "y"}
DOTTED_RE = re.compile(r"^(?:[A-Za-z]\.)+[A-Za-z]?\.?$")
CAMEL_RE = re.compile(r"^(?:[A-Z][a-z]+){2,}$")
CAMEL_PART_RE = re.compile(r"[A-Z][a-z]+")
JOIN_WORDS = {"x", "and", "vs", "vs.", "v/s", "feat", "feat.", "ft", "ft.", "featuring", "with", "meets", "b2b", "w/", "&"}
QUALIFIER_TOKEN_RE = re.compile(r"^[(\[][A-Z]{1,3}[)\]]$")
VOWELS = set("aeiouyAEIOUYáéíóúýàèìòùäëïöüÿâêîôûãõåæøœ")
LOOKALIKE_CHARS = set("ΔΛØø∆Ʌλδə") | set("ค๒ςє๔Ŧﻮђเןкɭ๓ภ๏קợгรՇยשฬאץչ")
JOIN_CHARS = "-'.~/_+’"


def _letters(w: str) -> list[str]:
    return [c for c in w if c.isalpha()]


def _is_latin(w: str) -> bool:
    return all("LATIN" in unicodedata.name(c, "LATIN") for c in _letters(w))


def _is_greek(w: str) -> bool:
    ls = _letters(w)
    return bool(ls) and all("GREEK" in unicodedata.name(c, "") for c in ls)


def keep_token(word: str, index: int, one_word: bool, mixed: bool = False) -> str | None:
    """N2: the kept form of a keep-token, or None. Tested per joiner-separated piece, so «AC/DC» is kept. `mixed`:
    the name is not written all in capitals (owner's answer 4, 2026-11-27: a 2-3 letter capital word inside a longer
    name keeps its capitals, «DLW ZuluTunes», «GK Music»; «ALL IN ONE» is all capitals and becomes «All In One»)."""
    core = word
    if QUALIFIER_TOKEN_RE.match(core):
        return core
    if DOTTED_RE.match(core) and len(_letters(core)) >= 1 and "." in core:
        return core.upper() if core.upper() == core or core.lower() == core else core
    if any(ch.isdigit() for ch in core):
        return core
    up = core.upper()
    if up in KEEP_FIXED:
        return KEEP_FIXED[up]
    if index > 0 and up in ROMAN:
        return up
    ls = _letters(core)
    if mixed and not one_word and ls and _is_latin(core) and 2 <= len(ls) <= 3 and core.isupper() and core.isalpha():
        return core
    if one_word and ls and _is_latin(core):
        if not any(c in VOWELS for c in ls):
            # names-4: a name with no vowel keeps its letters but never starts in lower case («kdd» → «Kdd»)
            return core.upper() if core.isupper() else core[:1].upper() + core[1:]
        if all(c.isupper() for c in ls) and len(ls) <= 3:
            return core
    pieces = [p for p in re.split(r"[/]", core) if p]
    if len(pieces) > 1 and all(p.upper() == p and len(_letters(p)) <= 3 for p in pieces):
        return core  # «AC/DC»
    return None


def camel(word: str) -> bool:
    """Clean CamelCase («BionicForm», «PsyToHigh», «RaRoot»): two or more parts, each a capital and lower-case letters
    with a vowel (Y counts), at least one part of 3 letters or more. «DoHm» (a part without a vowel), «RiDDeN» and
    names made only of 2-letter parts («KaYa», «ToHuWaBoHu», alternating case) are not."""
    if not CAMEL_RE.match(word):
        return False
    parts = CAMEL_PART_RE.findall(word)
    return all(any(c in VOWELS for c in p) for p in parts) and any(len(p) >= 3 for p in parts)


def stylised(spelling: str) -> bool:
    """CamelCase that may be styling rather than two joined words: three or more parts, or a part of fewer than 3
    letters («TrypOphObia», «AkUma», «NanoCheeZe»; «BionicForm», «PeePeace» are not)."""
    for w in spelling.split(" "):
        if camel(w):
            parts = CAMEL_PART_RE.findall(w)
            if len(parts) >= 3 or any(len(p) < 3 for p in parts):
                return True
    return False


def _capitalised(word: str) -> bool:
    """First letter upper, the rest lower, except the letter after a joiner (- ' . ~ / _ +), which may be either."""
    seen_first = False
    after_join = False
    for c in word:
        if c in JOIN_CHARS:
            after_join = True
            continue
        if not c.isalpha():
            continue
        if c.upper() == c.lower():  # an uncased letter (CJK, Devanagari)
            seen_first = True
            after_join = False
            continue
        if not seen_first:
            if not c.isupper():
                return False
            seen_first = True
        elif after_join:
            pass
        elif not c.islower():
            return False
        after_join = False
    return True


def acceptable(spelling: str, lower_particles: frozenset[str] = frozenset()) -> bool:
    words = [w for w in spelling.split(" ") if w]
    if not words or not any(_letters(w) for w in words):
        return False
    if any(c in LOOKALIKE_CHARS for c in spelling):
        return False
    one = sum(1 for w in words if not QUALIFIER_TOKEN_RE.match(w)) == 1
    mixed = any(c.islower() for c in spelling)
    for i, w in enumerate(words):
        if not _letters(w):
            continue
        kept = keep_token(w, i, one, mixed)
        if kept is not None:
            if kept != w:
                return False
            continue
        if i > 0 and w in PARTICLES and w in lower_particles:
            continue
        if camel(w):
            continue
        if not _capitalised(w):
            return False
    return True


def _word_ok(w: str, i: int, one: bool, mixed: bool = False) -> bool:
    """A word that C4 leaves as written: a CamelCase or capitalised word."""
    if keep_token(w, i, one, mixed) is not None:
        return False
    return camel(w) or (_capitalised(w) and _letters(w)[:1] != [] and _letters(w)[0].isupper())


def _cap_piece(p: str, lower_first: bool) -> str:
    i = next((i for i, c in enumerate(p) if c.isalpha()), None)
    if i is None:
        return p
    first = p[i].lower() if lower_first else p[i].upper()
    return p[:i] + first + p[i + 1:].lower()


def _greek_lower(s: str) -> str:
    out = []
    for c in s:
        lc = c.lower()
        if c != lc and c.isupper():
            lc = "".join(x for x in unicodedata.normalize("NFD", lc) if unicodedata.category(x) != "Mn")
        out.append(lc)
    return "".join(out)


def generate(spelling: str) -> str:
    """C4: each space-separated word gets a capital first letter and the rest lower; lower after a hyphen or an
    apostrophe; keep-tokens stay; a word that is already clean (CamelCase, capitalised) and a join word written in
    lower case («x», «and») stay as written; non-Latin words as written, except Greek, whose capitals lose their
    accents when lowered."""
    words = spelling.split(" ")
    one = sum(1 for w in words if w and not QUALIFIER_TOKEN_RE.match(w)) == 1
    mixed = any(c.islower() for c in spelling)
    out = []
    for i, w in enumerate(words):
        if not _letters(w) or (i > 0 and w in JOIN_WORDS):
            out.append(w)
            continue
        kept = keep_token(w, i, one, mixed)
        if kept is not None:
            out.append(kept)
            continue
        if _is_latin(w) and _word_ok(w, i, one, mixed):
            out.append(w)  # already clean: a CamelCase or capitalised word, a lower-case join word
            continue
        if _is_greek(w):
            j = next(j for j, c in enumerate(w) if c.isalpha())
            out.append(w[:j] + w[j].upper() + _greek_lower(w[j + 1:]))
            continue
        if not _is_latin(w):
            out.append(w)
            continue
        pieces = re.split(r"([-'’~/+.])", w)
        res = []
        lower_next = False
        for p in pieces:
            if p in ("-", "'", "’"):
                res.append(p)
                lower_next = True
            elif p in ("~", "/", "+", "."):
                res.append(p)
                lower_next = False
            else:
                res.append(_cap_piece(p, lower_next and bool(res)))
                lower_next = False
        out.append("".join(res))
    return " ".join(out)


def capitals(s: str) -> int:
    return sum(1 for c in s if c.isupper())


@dataclass
class Votes:
    units: dict[str, set[str]] = field(default_factory=dict)   # spelling -> vote units
    tracks: Counter = field(default_factory=Counter)            # spelling -> tracks

    def add(self, spelling: str, unit: str, track_id: int) -> None:
        self.units.setdefault(spelling, set()).add(unit)
        self.tracks[spelling] += 1

    def seen(self, spelling: str) -> None:
        self.units.setdefault(spelling, set())


@dataclass
class Choice:
    spelling: str
    rule: str
    status: str  # sure | look
    doubt: str = ""  # U5 | U7 | ''
    evidence: str = ""


def _rank(spellings: list[str], votes: Votes, spotify: Counter, publisher: Counter) -> list[str]:
    return sorted(spellings, key=lambda s: (-len(votes.units.get(s, ())), -votes.tracks.get(s, 0), -spotify.get(s, 0),
                                            -publisher.get(s, 0), capitals(s), s))


def choose(votes: Votes, spotify: Counter, publisher: Counter, decided: str | None = None) -> Choice:
    """The chosen spelling of one act key."""
    if decided:
        return Choice(decided, "H", "sure", evidence="απόφαση")
    spellings = sorted(votes.units)
    if not spellings:
        spellings = sorted(set(spotify) | set(publisher))
    lower_particles = frozenset(w for s in list(spotify) + list(publisher) + list(votes.units) for w in s.split(" ")[1:]
                                if w in PARTICLES)
    # N5: one skeleton (spaces, hyphens, accents; case ignored) per act
    skel_units: dict[str, set[str]] = {}
    skel_tracks: Counter = Counter()
    for s in spellings:
        sk = skeleton(s)
        skel_units.setdefault(sk, set()).update(votes.units.get(s, set()))
        skel_tracks[sk] += votes.tracks.get(s, 0)
    skels = sorted(skel_units, key=lambda k: (-len(skel_units[k]), -skel_tracks[k],
                                              -sum(spotify.get(s, 0) for s in spellings if skeleton(s) == k), k))
    top = skels[0]
    doubt = ""
    total = sum(len(u) for u in skel_units.values())
    if len(skels) > 1 and total and len(skel_units[top]) < 2 / 3 * total:
        doubt = "U7"
    in_skel = [s for s in spellings if skeleton(s) == top]
    ok = [s for s in in_skel if acceptable(s, lower_particles)]
    if not ok and len(skels) > 1:
        # the leading skeleton has no acceptable spelling: the best acceptable one of the others, never `sure`
        ok = [s for s in spellings if acceptable(s, lower_particles)]
        doubt = doubt or ("U7" if ok else "")
    if ok:
        ranked = _rank(ok, votes, spotify, publisher)
        best = ranked[0]
        status, ev = "sure", f"{len(votes.units.get(best, ()))} ψήφοι"
        if stylised(best) and len(votes.units.get(best, ())) < 2 and not spotify.get(best) and not publisher.get(best):
            # names-4: capitals inside a word with no second source for them («TrypOphObia», «AkUma»): kept as
            # written, listed once (pattern question «as written or first capital only»)
            return Choice(best, "C2" if votes.units.get(best) else "C3", "look", "U5s", ev)
        if len(ranked) > 1:
            a, b = len(votes.units.get(best, ())), len(votes.units.get(ranked[1], ()))
            if a == b or a < 2 * b:
                status = "look"
        if not votes.units.get(best):
            status = "look"
            if not doubt:
                # names-4: no library vote for this spelling: it came from a reference (C3) or was generated (C4)
                src = "C3" if (spotify.get(best) or publisher.get(best)) else "C4"
                return Choice(best, src, "look", "", "publisher" if publisher.get(best) and not spotify.get(best) else "")
        return Choice(best, "N5" if doubt else "C2", "look" if doubt else status, doubt, ev)
    refs = [s for s in sorted(set(spotify) | set(publisher)) if acceptable(s, lower_particles)
            and skeleton(s) == top]
    if refs:
        best = sorted(refs, key=lambda s: (-spotify.get(s, 0), -publisher.get(s, 0), s))[0]
        return Choice(best, "C3", "look", doubt, "publisher" if publisher.get(best) and not spotify.get(best) else "")
    source = _rank(in_skel, votes, spotify, publisher)[0] if in_skel else spellings[0]
    look_alike = any(c in LOOKALIKE_CHARS for c in source)
    if look_alike:
        # kept as written; names-4: a word that starts in lower case still gets its capital («bill lee» → «Bill Lee»)
        fixed = " ".join(re.sub(r"(^|(?<=[/~+]))([^\W\d_])", lambda m: m.group(1) + m.group(2).upper(), w)
                         if w and w not in JOIN_WORDS else w for w in source.split(" "))
        return Choice(fixed, "C4", "look", "U5", "look-alike")
    gen = generate(source)
    words = [w for w in source.split(" ") if _letters(w)]
    joined = len(words) == 1 and len(_letters(words[0])) >= 7 and (words[0].isupper() or words[0].islower())
    return Choice(gen, "C4", "look", doubt or ("U5" if joined and gen != source else ""))
