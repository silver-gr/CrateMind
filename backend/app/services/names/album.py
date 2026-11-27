"""Layer 6 and the album passes of P3: album groups (N12 key), the album-head pattern (S1), album credits (N12,
N27, N27a, N27b) and the folder artist (N24)."""
from __future__ import annotations

import re
import unicodedata
from collections import Counter, defaultdict

from . import text as T
from .fields import AND_FRIENDS_RE, PLACEHOLDER_RE
from .lexer import bracket_kind, brackets, split_credit
from .registry import Registry, usable_key

GENERIC_ALBUM_RE = re.compile(
    r"(?i)^\s*(?:unknown(?:\s+album)?|likes of\b.*|\d+|\d{1,4}[-./_]\d{1,2}(?:[-./_]\d{1,4})?|singles?|"
    r"downloaded by\b.*|downloads?|playlist\b.*|untitled|none|null|various|-+|)\s*$")
VA_ALBUM_RE = re.compile(r"(?i)^\s*(?:v\.?\s*/?\s*a\.?)\b|\bvarious artists\b|\bcompil|\bcompiled by\b|\bby\s+\w")


FOLDER_QUOTE_RE = re.compile(r"\s*[\"“”«»][^\"“”«»]*[\"“”«»]")
FOLDER_SLASH_RE = re.compile(r"\s*/\s*")


def folder_name(name: str) -> tuple[str, str]:
    """N24 (names-4): a folder name never holds a free-standing bracket (a qualifier such as «(DE)» and a bracket
    inside a word such as «thoma[s]» stay), a quoted phrase, a symbol (Unicode So or Sk), or a «/» between names of
    3 or more letters each (the first name is the folder; «AC/DC» stays). Returns the name and what was left out."""
    out, gone = name, []
    for b in reversed(brackets(out)):
        free = (b.start == 0 or not out[b.start - 1].isalnum()) and (b.end >= len(out) or not out[b.end:b.end + 1].isalnum())
        if free and not re.fullmatch(r"[A-Z]{1,3}|[A-Z][a-z]{1,2}", b.inner.strip()) and T.has_word(out[:b.start] + out[b.end:]):
            gone.append(out[b.start:b.end])
            out = out[:b.start] + " " + out[b.end:]
    m = FOLDER_QUOTE_RE.search(out)
    if m and T.has_word(out[:m.start()]):
        gone.append(m.group().strip())
        out = out[:m.start()] + out[m.end():]
    sym = "".join(c for c in out if unicodedata.category(c) in ("So", "Sk"))
    if sym and T.has_word("".join(c for c in out if c not in sym)):
        gone.append(sym)
        out = "".join(c for c in out if c not in sym)
    parts = FOLDER_SLASH_RE.split(out)
    if len(parts) >= 2 and all(len([c for c in p if c.isalpha()]) >= 3 for p in parts):
        gone.append(out[len(parts[0]):].strip())
        out = parts[0]
    out = T.tidy(T.squash(out))
    return (out, " ".join(gone)) if out and out != name else (name, "")


def album_key(album: str) -> str:
    a = T.squash(T.chars(album))
    if GENERIC_ALBUM_RE.match(a):
        return ""
    return T.fold(a)


def generic_folder(folder: str) -> bool:
    return "χύμα" in (folder or "").casefold()


def groups(p0s: dict) -> dict[int, str]:
    """N12 groups: tracks with the same folded album tag, joined when they share a folder or an act key
    (connected components), 2 or more tracks. Generic albums and the [Χύμα] folders have no group."""
    by_album: dict[str, list] = defaultdict(list)
    for tid in sorted(p0s):
        p = p0s[tid]
        k = album_key(p.t.album)
        if k and not generic_folder(p.t.folder):
            by_album[k].append(p)
    out: dict[int, str] = {}
    for k in sorted(by_album):
        ps = by_album[k]
        parent = {p.t.id: p.t.id for p in ps}

        def find(x: int) -> int:
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        def union(a: int, b: int) -> None:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[max(ra, rb)] = min(ra, rb)

        first_by: dict[tuple, int] = {}
        for p in ps:
            keys = [("folder", p.t.folder)] + [("act", usable_key(a)) for a in p.credit.acts if usable_key(a)]
            for kk in keys:
                if kk in first_by:
                    union(first_by[kk], p.t.id)
                else:
                    first_by[kk] = p.t.id
        comp: dict[int, list[int]] = defaultdict(list)
        for p in ps:
            comp[find(p.t.id)].append(p.t.id)
        for root, ids in comp.items():
            if len(ids) >= 2:
                for i in ids:
                    out[i] = f"{k}#{root}"
    return out


def s1_groups(p0s: dict, gid: dict[int, str], reg: Registry) -> tuple[dict[str, str], set[str]]:
    """S1: every track of an album group has the same artist field and a credit head in its title that is not that
    artist: the artist field is the uploader. Needs 2 or more different heads, or an R3 artist field, or one head
    that is a known act while the artist field is not known outside the album. A second pass (names-3): an artist
    field that is the S1 uploader of another album also fronts its one-head albums (returned as `weak`, `look`)."""
    members: dict[str, list] = defaultdict(list)
    for tid, g in gid.items():
        members[g].append(p0s[tid])
    out: dict[str, str] = {}
    weak: set[str] = set()
    pending: list[tuple[str, list, list]] = []
    for g, ps in sorted(members.items()):
        artists = {T.fold(p.a.text) for p in ps}
        if len(artists) != 1 or len(ps) < 2:
            continue
        heads, own_heads, broken = [], 0, False
        for p in ps:
            if not p.head:
                broken = True
                break
            own = {T.fold(x) for x in p.credit.acts} | {T.fold(p.a.text)} | {reg.bare(x) for x in p.credit.acts}
            hk = T.fold(p.head)
            names = [n for b in brackets(p.rest) for n in bracket_kind(b.inner, b.closed)[1].get("names", [])
                     if bracket_kind(b.inner, b.closed)[0] == "version"]
            if hk in own or re.match(r"(?i)^\s*(?:&|and|vs\.?|x|feat\.?|ft\.?)\s", p.head) \
                    or own & {T.fold(x) for x in split_credit(p.head).acts} or {T.fold(n) for n in names} & own:
                own_heads += 1
                continue
            heads.append(hk)
        if broken or not heads:
            continue
        distinct = set(heads)
        a = ps[0].a.text
        ok = (len(distinct) >= 2 and len(heads) >= 2) or (not own_heads and (
            bool(reg.channel(a)) or bool(PLACEHOLDER_RE.match(a)) or (
                len(distinct) == 1 and reg.known(ps[0].head) and reg.local_count(T.fold(a), None, g) == 0
                and reg.remote_count(T.fold(a)) == 0)))
        if ok:
            out[g] = f"{len(ps)} κομμάτια, {len(distinct)} διαφορετικά ονόματα στην αρχή του τίτλου"
        elif not own_heads and len(distinct) == 1 and reg.known(ps[0].head):
            pending.append((g, ps, heads))
    uploaders = {T.fold(members[g][0].a.text) for g in out}
    for g, ps, heads in pending:
        if T.fold(ps[0].a.text) in uploaders:
            out[g] = f"{len(ps)} κομμάτια· ο «{ps[0].a.text}» ανεβάζει κι άλλα άλμπουμ με άλλους καλλιτέχνες"
            weak.add(g)
    return out, weak


def credits(gid: dict[int, str], results: dict, p0s: dict) -> dict[str, dict]:
    """N12, N27, N27a, N27b per album group. `results[tid]` has .acts (rendered act names with roles), .status."""
    members: dict[str, list[int]] = defaultdict(list)
    for tid, g in gid.items():
        members[g].append(tid)
    out: dict[str, dict] = {}
    for g, ids in sorted(members.items()):
        ids = sorted(ids)
        info = {"group": g, "album": p0s[ids[0]].t.album, "tracks": ids, "kind": "", "credit": [], "reason": ""}
        statuses = {results[i].status for i in ids}
        sets, orders = [], Counter()
        for i in ids:
            acts = [a for a in results[i].acts if a[2] in ("primary", "collaborator")]
            sets.append(frozenset(a[1] for a in acts))
            orders[tuple(a[1] for a in acts)] += 1
        album = p0s[ids[0]].t.album
        barred = bool(VA_ALBUM_RE.search(album)) or any(
            AND_FRIENDS_RE.search(p0s[i].a.text) or PLACEHOLDER_RE.match(p0s[i].a.text) for i in ids)
        if any(results[i].status in ("open", "none") and results[i].open_code != "U11" for i in ids):
            info.update(kind="N27b", reason="κάποιο κομμάτι της ομάδας περιμένει απόφαση")
        elif barred:
            info.update(kind="barred", reason="συλλογή, VA ή «and Friends»")
        elif len(set(sets)) == 1 and 2 <= len(sets[0]) <= 3:
            order = max(sorted(orders), key=lambda o: (orders[o], -sorted(orders).index(o)))
            info.update(kind="N12", credit=list(order))
        else:
            core = frozenset.intersection(*sets) if sets else frozenset()
            common = Counter(sets).most_common()
            best, n = (common[0] if common else (frozenset(), 0))
            if len(core) >= 2 and len(core) <= 3 and len(set(sets)) > 1:
                info.update(kind="N27", credit=sorted(core), reason="κοινό δίδυμο σε όλα τα κομμάτια και καλεσμένοι σε μερικά")
            elif 2 <= len(best) <= 3 and n >= 2 and n * 3 >= 2 * len(ids):
                info.update(kind="N27a", credit=sorted(best), reason=f"{n} από {len(ids)} κομμάτια έχουν την ίδια σύμπραξη")
            elif all(len(s) >= 4 for s in sets):
                info.update(kind="various", reason="4 ή περισσότερα ονόματα")
        out[g] = info
    return out
