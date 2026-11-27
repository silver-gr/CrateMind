"""Layer 4 (N26): the decision list. First match wins:

1. a track decision (`hand`);
2. no junk signal: the as-read reading (2b: the title head repeats, extends or contains the artist field: that
   reading, `sure`, both fields of the file agree);
3. exactly one junk-free reading with every act known and a title that is not a known act: `sure`;
4. exactly one junk-free reading from N14, N14t, N21, N20, S1-S3 or A1 with at least one known act: `look`
   (inside an S1 album or under an R3 channel the pattern alone resolves an unknown head);
   4b. an empty or placeholder artist field: an A1 head, the album-tag head (N29), the SoundCloud uploader, the
   file name (N22), the folder: `look`;
5. the only junk-free reading is a linked Spotify record: `look`;
6. otherwise `open` with a code (U1 U2 U3 U6 U8 U10), or `none` for an empty or placeholder field.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field, replace

from . import text as T
from .fields import (OFFICIAL_WORD_RE, PLACEHOLDER_RE, Field, bpm_matches, clean_artist, clean_title, file_made_from,
                     tidy_title)
from .lexer import ROLE_BARE_RE, Credit, bracket_kind, brackets, segments, split_credit
from .model import Decision, Step
from .readings import (CREDIT_TITLE_RE, GENERIC_FOLDER_RE, JOIN_LEAD_RE, VERSION_TITLE_RE, P0, Reading, build, credit_of,
                       is_title_junk, split_head, version_title)
from .registry import SUBTITLE_RE, Known, Registry

N20_RELEASE_RE = re.compile(r"(?i)^\s*\d{1,2}\s*[-–]|\b(?:va|v/a|v\.a\.?|vol\.?|records?|recs?|music|compil\w*|free\s+track"
                            r"|bonus)\b")
STEP_RULES = {"N14", "N14t", "N21", "N21t", "N20", "S1", "S2", "S3", "A1", "A1v", "A1own", "A1album"}


@dataclass
class Ctx:
    reg: Registry
    s1: bool = False              # the track's album shows the S1 pattern (artist field = uploader)
    s1_evidence: str = ""
    s1_weak: bool = False         # S1 only because the artist field fronts another S1 album (`look`)
    decisions: dict = field(default_factory=dict)  # (kind, scope) -> Decision


@dataclass
class Decided:
    acts: list[str]
    joins: list[str]
    featured: list[str]
    feat_word: str
    title: str
    original: list[str] = field(default_factory=list)
    notes: dict = field(default_factory=dict)
    status: str = "sure"
    open_code: str = ""
    rule: str = "as_read"
    steps: list[Step] = field(default_factory=list)
    tempo: list[str] = field(default_factory=list)
    candidates: list[Reading] = field(default_factory=list)
    open_scope: tuple[str, str] = ("", "")  # (kind, scope) of the decision that answers an open track
    signals: tuple[str, ...] = ()
    safe_artist: str = ""


def _worst(a: str, b: str) -> str:
    order = {"sure": 0, "look": 1, "open": 2, "none": 3}
    return a if order.get(a, 0) >= order.get(b, 0) else b


def _view(p: P0, a_text: str, t_text: str) -> P0:
    v = replace(p, a=replace(p.a, text=a_text), ti=replace(p.ti, text=t_text))
    v.credit = split_credit(a_text)
    v.head, v.rest = split_head(t_text)
    return v


def _title_like(text: str) -> bool:
    for b in brackets(text):
        if bracket_kind(b.inner, b.closed)[0] in ("version", "original") and text[:b.start].strip():
            return True
    return any(ROLE_BARE_RE.match(x.strip()) for x in text.split(T.SEP)) or bool(T.ORIGINAL_MIX_RE.search(text)) or \
        bool(re.search(r"\s(?:EP|LP|Album|Single)\s*$", text))


def _unbalanced(s: str) -> bool:
    return s.count("(") != s.count(")") or s.count("[") != s.count("]")


def signals(r: Reading, p: P0, ctx: Ctx, as_read: bool = False) -> set[str]:
    reg, tid, grp = ctx.reg, p.t.id, p.group
    known = Known(reg, tid, grp)
    s: set[str] = set()
    whole = p.a.text if as_read else r.artist
    acts = [a for a in r.acts if T.has_word(a)]
    if not acts or not T.has_word(whole):
        s.add("empty")
    elif PLACEHOLDER_RE.match(whole.replace(T.SEP, " ")) or all(PLACEHOLDER_RE.match(a) for a in acts) or (
            as_read and "A2" in p.a.flags):
        s.add("A2")
    else:
        if reg.channel(whole) or (as_read and ("account" in p.a.flags or _uploader_channel(p, reg))):
            s.add("R3")
        if _title_like(whole) or (as_read and "N10" in p.a.flags):
            s.add("N10")
        elif as_read and "N10t" in p.a.flags:
            s.add("N10t")
        if len(segments(whole)) >= 2 and not known(whole):
            s.add("dash")
    artist_known = bool(acts) and (known(whole) or all(known(a) for a in acts))
    t = r.title
    tsegs = segments(t) if t else []
    if not T.has_word(t):
        s.add("no_title")
    elif as_read and ROLE_ONLY_RE.fullmatch(t):
        s.add("role_title")  # the title field is only a version word («BOOTLEG»)
    if t and len(tsegs) <= 1 and not brackets(t) and as_read:
        tc = credit_of(t, known, reg.one_act)
        if len(tc.acts) >= 2 and all(known(x) for x in tc.acts) and not artist_known:
            s.add("swap")
        if len(tc.acts) == 1 and reg.strong(tc.acts[0], tid, grp) and "N10" in s:
            s.add("swap")
        # R2: the artist field is a known title and the title field names a known act; names-3: a single name on the
        # title side must be a strong act that is not itself a known title («Evolve» | «Infinity» stays)
        credit2 = len(tc.acts) + len(tc.featured) >= 2
        if acts and reg.known_title(whole, tid) and not artist_known and any(known(x) for x in tc.acts) and (
                credit2 or (any(reg.strong(x, tid, grp) for x in tc.acts) and not reg.known_title(t, tid))):
            s.add("R2")
    mv = VERSION_TITLE_RE.match(t or "") if as_read and acts and not artist_known and len(tsegs) <= 1 else None
    mv = mv or (CREDIT_TITLE_RE.match(t or "") if as_read and acts else None)
    if mv and all(known(x) for x in credit_of(mv.group("names"), known, reg.one_act).acts):
        s.add("title_version")  # N21t: the title field is only a remix credit by a known act
    elif as_read and t and len(brackets(t)) == 1 and not T.has_word(t[:brackets(t)[0].start] + t[brackets(t)[0].end:]) \
            and bracket_kind(brackets(t)[0].inner, True)[0] in ("version", "feat") \
            and bracket_kind(brackets(t)[0].inner, True)[1].get("names"):
        s.add("bracket_title")  # the title field is only a remix or feat. bracket («(Nanda Remix)»): no title words
    own_names = acts + [whole]
    head = split_head(t)[0] if t else ""
    if own_head_rest(t, own_names) is not None:
        s.add("own_head")
    elif head:
        own = {T.fold(a) for a in acts} | {T.fold(whole)} | {reg.bare(a) for a in own_names}
        hc = credit_of(head, known, reg.one_act)
        hk = {T.fold(x) for x in hc.acts} | {T.fold(head)}
        if JOIN_LEAD_RE.match(head) or (own & hk):
            s.add("own_head")
        elif as_read and any(known(x) for x in hc.acts) and not re.fullmatch(r"\d{1,3}", head):
            s.add("other_head")
        if ROLE_BARE_RE.match(head):
            s.add("N14t")
    if _unbalanced(whole) or _unbalanced(t):
        s.add("U8")
    if as_read and acts and t:
        # «Title - Artist»: the title's tail is the act set of a linked record and the artist field is not
        from .readings import linked_split
        if linked_split(t, p.t.links, {T.fold(a) for a in acts}):
            s.add("linked_tail")
    return s


ARTIST_SIDE = {"empty", "A2", "R3", "N10", "dash", "S1", "title_version"}
ROLE_ONLY_RE = re.compile(r"(?i)\s*[(\[]?\s*(?:remix|rmx|bootleg|edit|vip|rework|flip|mashup)\s*[)\]]?\s*")


def own_head_rest(title: str, names: list[str]) -> str | None:
    """The title opens with the track's own act (qualifier ignored) followed by a dash, spaced or not
    («Neutralizer (A)» | «Neutralizer-Go crazy!»): the rest of the title, else None."""
    keys = {T.fold(n.replace(T.SEP, " ")) for n in names if n} | {
        T.fold(re.sub(r"\s*[(\[][A-Z]{1,3}[)\]]\s*$", "", n)) for n in names if n}
    keys = {k for k in keys if len(k) >= 2}
    for m in re.finditer(r"\s*[-–—:]+\s*(?=\S)", title or ""):
        # the head before this dash is the own act, compared by act key («KillΔtk-Sadhvir» under «Killatk»)
        if m.start() and T.fold(title[:m.start()]) in keys and T.has_word(title[m.end():]):
            return title[m.end():].strip()
    return None


def _uploader_channel(p: P0, reg: Registry) -> bool:
    """R3 by upload: the artist field is an account that posts 5 or more other known acts, this track is its upload,
    and something else on the track names an act (a title head or a SoundCloud publisher)."""
    k = T.fold(p.a.text)
    if k not in reg.uploader_channels:
        return False
    mine = any(ln.service == "soundcloud" and T.fold(ln.uploader) == k for ln in p.t.links)
    other = bool(p.head) or any(ln.service == "soundcloud" and ln.artists and T.fold(ln.artists[0]) != k
                                for ln in p.t.links)
    return mine and other


def decide(p: P0, ctx: Ctx) -> Decided:
    reg, tid, grp = ctx.reg, p.t.id, p.group
    known = Known(reg, tid, grp)
    steps = [replace(s, field="artist") for s in p.a.steps] + [replace(s, field="title") for s in p.ti.steps]
    tempo = list(p.a.tempo) + list(p.ti.tempo)
    notes: dict = {}
    status = "sure"
    a_text, t_text = p.a.text, p.ti.text
    pending_bracket = ""

    # ---------------------------------------------------------------- P2: layer-1 rules that ask the registry
    if p.a.lead_bracket:
        m = T.LEAD_BRACKET_RE.match(a_text)
        rest = a_text[m.end():].strip() if m else ""
        word_key = T.fold(p.a.lead_bracket)
        answer = ctx.decisions.get(("bracket_word", f"token:{word_key}"))
        if answer is not None and answer.value in ("genre", "label") and rest:
            steps.append(Step("N17", "artist", a_text, rest, f"«{p.a.lead_bracket}»: απόφαση"))
            a_text = rest
        elif answer is not None:
            pass
        elif rest and known(rest):
            steps.append(Step("N17", "artist", a_text, rest, p.a.lead_bracket))
            a_text = rest
            status = _worst(status, "look")
        elif rest:
            pending_bracket = p.a.lead_bracket
    if p.a.lead_number:
        m = T.LEADING_NUMBER_RE.match(a_text)
        if m:
            rest = a_text[m.end():]
            first = (split_credit(rest).acts or [""])[0]
            n = m.group(1)
            tag_no = re.match(r"\s*0*(\d+)", p.t.track_no or "")
            from_file = p.file_prefix and p.file_prefix.lstrip("0") == n.lstrip("0") \
                and not file_made_from(p.file_stem, a_text)
            if known(first) or (tag_no and tag_no.group(1) == n.lstrip("0")) or from_file:
                steps.append(Step("N11L", "artist", a_text, rest, n))
                if 60 <= int(n) <= 320 and bpm_matches(float(n), (p.t.bpm_grid, p.t.bpm_analyzed)):
                    tempo.append(n)
                a_text = rest
    account = False
    m = OFFICIAL_WORD_RE.search(a_text)
    if m and T.has_word(a_text[:m.start()]):
        rest = a_text[:m.start()].strip()
        if known(rest):
            steps.append(Step("N9", "artist", a_text, rest, "Official"))
            a_text = rest
        else:
            account = True
    if p.ti.lead_number:
        m = T.LEADING_NUMBER_RE.match(t_text)
        if m:
            rest = t_text[m.end():]
            segs = segments(rest)
            first = (split_credit(segs[0]).acts or [""])[0] if len(segs) >= 2 else ""
            if first and known(first):
                n = m.group(1)
                steps.append(Step("N11L", "title", t_text, rest, n))
                if 60 <= int(n) <= 320 and bpm_matches(float(n), (p.t.bpm_grid, p.t.bpm_analyzed)):
                    tempo.append(n)
                t_text = rest
    if p.a.wrapped:
        # D1: «Name •word•»: the wrapped word is a second act only when it is a known act; else it goes to notes
        if known(p.a.wrapped):
            a_text = f"{a_text} & {p.a.wrapped}"
        else:
            notes["tag"] = p.a.wrapped
            status = _worst(status, "look")
    own_names = split_credit(a_text).acts + [a_text]
    own_keys = {T.fold(x) for x in own_names} | {reg.bare(x) for x in own_names}
    if p.ti.pre_d5 and t_text == p.ti.text:
        # D5 waits for the head: «X - Y Remix» stays split when X is the artist (an empty, placeholder or label artist
        # field, or X is the track's own act)
        head = split_head(p.ti.pre_d5)[0]
        if head and ("A2" in p.a.flags or not T.has_word(a_text) or reg.channel(a_text) or account
                     or T.fold(head) in own_keys):
            steps.append(Step("D5", "title", t_text, p.ti.pre_d5, "ο τίτλος ξεκινά με τον καλλιτέχνη"))
            t_text = p.ti.pre_d5
    glued = False
    if p.glued and t_text == p.ti.text and not split_head(t_text)[0]:
        # A1g: a head glued to the title by «-», «_», « / » or a wide gap. Adopted for the track's own act; for known
        # acts (one of them strong) only when the artist field has no act of its own (empty, placeholder, label, an
        # unknown name; a wide gap or « / » only when the field is empty, a placeholder or a label)
        field_junk = "A2" in p.a.flags or not T.has_word(a_text) or bool(reg.channel(a_text)) or account
        field_unknown = not (known(a_text) or any(known(x) for x in split_credit(a_text).acts))
        for head, rest, rest_tempo, sep in p.glued:
            hc = split_credit(head, known, reg.one_act)
            hk = {T.fold(x) for x in hc.acts} | {T.fold(head)}
            rc = split_credit(rest, known, reg.one_act)
            acts_ok = bool(hc.acts) and all(known(x) for x in hc.acts) and any(reg.strong(x, tid, grp) for x in hc.acts)
            # «Tezla-Little Bit (Ranji remix)» under «Ranji»: the rest names the artist field as remixer
            own_remix = any(T.fold(n) in own_keys for b in brackets(rest)
                            if bracket_kind(b.inner, b.closed)[0] == "version"
                            for n in bracket_kind(b.inner, b.closed)[1].get("names", []))
            # a glued head of two or more known acts is a credit even under a known artist field (then U3 lists it)
            if (hk & own_keys) or (acts_ok and (field_junk or (field_unknown and sep in "-–—_")
                                               or (len(hc.acts) >= 2 and sep in "-–—"))) \
                    or (own_remix and hc.acts and sep in "-–—_"):
                new_t = f"{head} - {rest}"
            elif own_keys & {T.fold(x) for x in rc.acts} and len(rc.acts) >= 2 and all(known(x) for x in rc.acts):
                new_t = f"{rest} - {head}"  # «Title_A & B» under A: the credit is the tail
            else:
                continue
            steps.append(Step("A1g", "title", t_text, new_t, "κολλημένο διαχωριστικό"))
            t_text, glued = new_t, not (hk & own_keys)  # the own act glued to its title is no doubt
            tempo += [x for x in rest_tempo if x not in tempo]
            break
    v = _view(p, a_text, t_text)
    if account:
        v.a = replace(v.a, flags=set(v.a.flags) | {"account"})
    if p.a.members:
        notes["members"] = list(p.a.members)
        if not (known(a_text) or any(known(x) for x in p.a.members)):
            status = _worst(status, "look")
    if p.a.alias:
        notes["alias"] = list(p.a.alias)
    for k, val in list(p.ti.note.items()) + list(p.a.note.items()):
        if k == "members":
            notes.setdefault("members", [])
            notes["members"] += [x for x in val if x not in notes["members"]]
        else:
            notes.setdefault(k, val)

    def result(r: Reading, st: str, rule: str, extra: list[Step] | None = None) -> Decided:
        d = Decided(list(r.acts), list(r.joins), list(r.featured), r.feat_word, r.title, list(r.original),
                    {**notes, **r.notes}, _worst(status, st), "", rule, steps + (extra or []), list(tempo))
        if rule not in ("as_read", "open", "none"):
            _settle(d, p)
        if rule not in ("open", "none"):
            _by_own_tail(d)
            _credit_bracket(d)
            if glued and d.status == "sure":
                d.status = "look"
        return d

    own = credit_of(v.a.text, known, reg.one_act)
    if len(own.acts) == 1 and not own.featured:
        # N15 by a linked record: «Ghost Rider  Durs», «Yatzee Fright Rate» are the record's two acts written together
        joined = {T.fold(own.acts[0]), T.fold(re.sub(r"(?i)\s+(?:and|x|&|vs\.?)\s+", " ", own.acts[0]))}
        for ln in p.t.links:
            la = [a for x in ln.artists for a in split_credit(x).acts]
            if len(la) >= 2 and T.fold("".join(la)) in joined:
                steps.append(Step("N15", "artist", v.a.text, " & ".join(la), f"{ln.service}: {', '.join(ln.artists)}"))
                own = Credit(acts=list(la), joins=["&"] * (len(la) - 1))
                status = _worst(status, "look")
                break
    as_read = Reading("as_read", own.acts, own.joins, own.featured, own.feat_word, v.ti.text)
    if own.weak_split:
        steps.append(Step("N15", "artist", v.a.text, as_read.artist, "x / and / +"))
        if own.relaxed:
            status = _worst(status, "look")  # split on one strong act: one source of evidence

    # ---------------------------------------------------------------- 1. a track decision
    hand = ctx.decisions.get(("track", f"track:{tid}"))
    if hand is not None:
        art, _, ttl = hand.value.partition("|")
        hc = split_credit(art.strip())
        d = Decided(hc.acts or [art.strip()], hc.joins, hc.featured, hc.feat_word, ttl.strip() or v.ti.text,
                    notes=notes, status="hand", rule="H", steps=steps + [Step("H", "pair", "", hand.value, hand.source)],
                    tempo=tempo)
        d.safe_artist = art.strip()
        return d

    if "fragment" in p.a.flags and not glued:
        # A2f: the credit was cut at its front («and Apollyon», «Vs Astrologic»). In order, all `look`: a linked record
        # that lists these acts and more (the whole credit); a linked record that lists exactly the remaining acts;
        # for a leading «&» only (a stray join of a multi-value tag), the remaining acts when each is a known act.
        # Else the track is open (U12) and shown as written: the missing first act is not guessed.
        lead = T.FRAGMENT_RE.match(v.a.text)
        word = lead.group().strip() if lead else "&"
        rest = credit_of(v.a.text[lead.end():] if lead else v.a.text, known, reg.one_act)
        mine = {T.fold(x) for x in rest.acts}
        title = v.ti.text if T.has_word(v.ti.text) else _restore_title(p)
        for ln in p.t.links:
            la = [a for x in ln.artists for a in split_credit(x).acts]
            if mine and mine <= {T.fold(a) for a in la}:
                r = Reading("N23", la, ["&"] * (len(la) - 1), [], "", title,
                            evidence=f"{ln.service}: {', '.join(ln.artists)}")
                return result(r, "look", "N23", [Step("A2f", "artist", v.a.text, r.artist, r.evidence)])
        if word == "&" and rest.acts and all(known(x) for x in rest.acts):
            r = Reading("A2f", rest.acts, rest.joins, rest.featured, rest.feat_word, title, evidence=v.a.text)
            return result(r, "look", "A2f", [Step("A2f", "artist", v.a.text, r.artist, word)])
        d = result(Reading("open", [v.a.text], [], [], "", title), "open", "open")
        d.status, d.open_code, d.open_scope = "open", "U12", ("track", f"track:{tid}")
        d.safe_artist = v.a.text
        return d

    sig = signals(as_read, v, ctx, as_read=True)
    if ctx.s1 and v.head and "own_head" not in sig:
        sig.add("S1")
    if pending_bracket:
        sig.add("lead_bracket")
    if p.n20 == "group":
        sig.add("U8")
    # ---------------------------------------------------------------- 2. no junk signal
    if not (sig - {"no_title"}) and T.has_word(v.ti.text):
        d = result(as_read, "sure", "as_read")
        spot = [ln for ln in p.t.links if ln.service == "spotify" and ln.artists]
        if spot and own.acts:
            mine = {T.fold(x) for x in own.acts + own.featured}
            if not any({T.fold(x) for x in ln.artists} == mine for ln in spot):
                d.status = _worst(d.status, "look")
                d.notes["spotify"] = ", ".join(spot[0].artists)
                d.steps.append(Step("N23diff", "artist", "", "", ", ".join(spot[0].artists)))
        return d

    cands = build(v, known, reg.one_act)
    if p.n20 == "group":
        b = brackets(p.a.text)
        if b:
            head = p.a.text[:b[-1].start].strip()
            inner = b[-1].inner.strip()
            if known(inner) and head:
                note = T.squash(f"{p.n20_part} {T.tidy(v.ti.text.replace(p.n20_part, '', 1).strip(' )]'))}")
                cands.append(Reading("N20", split_credit(inner, known, reg.one_act).acts, [], [], "", head,
                                     notes={"album": T.tidy(note.strip(" )]"))} if T.has_word(note) else {},
                                     evidence=p.a.text))
            elif head and N20_RELEASE_RE.search(f"{inner} {p.n20_part} {p.t.title}"):
                # N20 (names-3): the rejoined bracket is a release note (a track number, VA, a volume, a label): the
                # head is the title and the artist comes from the linked records, else none
                note = T.tidy(T.squash(re.sub(r"[()\[\]]|[-–]\s*\d{2,3}\s*$", " ", f"{inner} {T.chars(p.t.title)}")))
                m = re.search(r"[)\]]\s*[-–]?\s*(\d{2,3})\s*$", T.chars(p.t.title))
                if m and 60 <= int(m.group(1)) <= 320 and bpm_matches(float(m.group(1)), (p.t.bpm_grid, p.t.bpm_analyzed)):
                    tempo.append(m.group(1))  # the tempo after the rejoined bracket is kept (N11)
                    steps.append(Step("N11", "title", T.chars(p.t.title), note, m.group(1)))
                fb = fallback(v, ctx, known, links_only=True, title=head)
                if fb is not None:
                    fb.notes = {"album": note}
                    return result(fb, "look", "N20", [Step("N20", "pair", p.a.text + " | " + p.t.title,
                                                           fb.artist + " | " + head, fb.evidence)])
                d = result(Reading("none", [], [], [], "", head, notes={"album": note}), "none", "none")
                d.status = "none"
                d.steps.append(Step("N20", "pair", p.a.text + " | " + p.t.title, " | " + head, note))
                return d
    artist_side = sig & ARTIST_SIDE
    allow_a1 = bool(artist_side) or ctx.s1
    allow_swap = bool(sig & {"swap", "N10", "N10t", "dash"})  # R2 alone is one-sided evidence (U1)

    def eligible(c: Reading) -> bool:
        if c.rule in ("A1", "A1v") and not allow_a1:
            return False
        if c.rule == "N21t" and "title_version" not in sig:
            return False
        if c.rule == "A1r" and not (allow_a1 or "linked_tail" in sig):
            return False
        if c.rule == "N13" and not allow_swap:
            return False
        if c.rule == "N18" and "dash" not in sig and "N10" not in sig:
            return False
        if c.rule == "N14" and "N10" not in sig:
            return False
        if c.rule == "N21" and not (sig & {"N10", "no_title"}):
            return False
        return True

    cands = [c for c in cands if eligible(c)]
    jf = [c for c in cands if not (signals(c, v, ctx) - {"no_title"}) and T.has_word(c.title)]

    # 2b. the two fields of the file agree (own head, S2 second names, S3 missing collaborators)
    if "lead_bracket" not in sig:
        agree = [c for c in jf if c.string_only and (not (artist_side - {"dash"})
                                                     or (c.rule == "N14t" and artist_side <= {"S1", "dash"}))]
        if agree:
            c = agree[0]
            return result(c, "sure", c.rule, [Step(c.rule, "pair", as_read.artist + " | " + v.ti.text,
                                                   c.artist + " | " + c.title, c.evidence)])
        if "own_head" in sig and not jf and not artist_side:
            pass

    def pick(c: Reading, st: str) -> Decided:
        return result(c, st, c.rule, [Step(c.rule, "pair", as_read.artist + " | " + v.ti.text,
                                           c.artist + " | " + c.title, c.evidence)])

    def dedupe(xs: list[Reading]) -> list[Reading]:
        seen, out = set(), []
        for c in xs:
            if c.key() not in seen:
                seen.add(c.key())
                out.append(c)
        return out

    if "lead_bracket" not in sig and not (sig & {"U8"} and p.n20 == "group" and not any(c.rule == "N20" for c in jf)):
        # 3. exactly one junk-free reading with every act known
        main = [c for c in jf if c.rule not in ("N22", "N23", "N23sc", "A1r")]
        if "linked_tail" in sig:
            tails = dedupe([c for c in jf if c.rule == "A1r"])
            if len(tails) == 1:
                return pick(tails[0], "look")
        s3 = dedupe([c for c in main if c.acts and all(known(a) for a in c.acts) and not known(c.title)])

        def s3_status(c: Reading) -> str:
            # one-sided readings stay `look`: a swap on R2 alone, a remix credit or a version bracket naming the artist
            if c.rule == "N13" and not (sig & {"swap", "N10", "N10t"}) or c.rule in ("N21t", "A1v"):
                return "look"
            if ctx.s1_weak and c.rule == "A1":
                return "look"
            return "sure"
        if len(s3) == 1:
            return pick(s3[0], s3_status(s3[0]))
        if len(s3) > 1:
            side = {c.key() for c in jf if c.rule in ("N22", "N23", "N23sc")}
            agreeing = [c for c in s3 if c.key() in side]
            if len(agreeing) == 1:
                return pick(agreeing[0], s3_status(agreeing[0]))
        # 4. one junk-free reading of a pattern rule with at least one known act
        swap_ok = bool(sig & {"N10", "N10t"})  # the artist field reads as a title: evidence on both sides
        s4 = dedupe([c for c in main if (c.rule in STEP_RULES or (c.rule == "N13" and swap_ok)) and (
            any(known(a) for a in c.acts) or (c.rule == "A1" and (ctx.s1 or "R3" in sig)))])
        if len(s4) == 1:
            st = "sure" if (s4[0].rule in ("A1", "N20") and all(known(a) for a in s4[0].acts) and ctx.s1
                            and not ctx.s1_weak) else "look"
            d = pick(s4[0], st)
            if ctx.s1 and s4[0].rule == "A1":
                d.steps.append(Step("S1", "artist", as_read.artist, s4[0].artist, ctx.s1_evidence))
            return d
        # 4b. an empty or placeholder artist field
        if sig & {"empty", "A2"}:
            heads = dedupe([c for c in main if c.rule in ("A1", "A1v")])
            tails = dedupe([c for c in jf if c.rule == "A1r"])
            linked = {T.fold(a) for ln in p.t.links for x in ln.artists for a in split_credit(x).acts}
            if len(tails) == 1 and tails[0].acts and {T.fold(a) for a in tails[0].acts} <= linked:
                return pick(tails[0], "look")  # «Title - Artist», and the linked record names the artist
            if len(heads) == 1:
                return pick(heads[0], "look")
            fb = fallback(v, ctx, known)
            if fb is not None:
                return pick(fb, "look")
        if "R3" in sig and T.has_word(v.ti.text):
            # under a label or channel the album tag «X - Y» names the act: `sure` when X is a known act, else `look`
            ac = album_head_credit(v, known, reg, any_head=True)
            if ac is not None:
                r = Reading("N29", ac.acts, ac.joins, ac.featured, ac.feat_word, v.ti.text, evidence=p.t.album)
                return pick(r, "sure" if all(known(a) for a in ac.acts) else "look")
            # a label artist field and a remix bracket in the title: the remixer is the act the title names (`look`)
            rem = [n for b in brackets(v.ti.text) if bracket_kind(b.inner, b.closed)[0] == "version"
                   for n in bracket_kind(b.inner, b.closed)[1].get("names", [])]
            rc = credit_of(" & ".join(rem), known, reg.one_act) if rem else None
            if rc is not None and rc.acts and not ({T.fold(x) for x in rc.acts} & {T.fold(v.a.text)}):
                return pick(Reading("N21r", rc.acts, rc.joins, [], "", v.ti.text, evidence=v.ti.text), "look")
            fb = fallback(v, ctx, known, links_only=True)
            if fb is not None:
                return pick(fb, "look")
        # N21 without a version bracket: the title field held only a tempo or promo words, so the artist field
        # holds the title; the artist comes from the file name or the linked records
        if "no_title" in sig and not (sig & {"empty", "A2", "R3"}) and len(segments(v.a.text)) == 1:
            fb = fallback(v, ctx, known, links_only=True, title=v.a.text)
            if fb is not None and T.fold(" ".join(fb.acts)) != T.fold(v.a.text):
                fb.rule = "N21"
                return pick(fb, "look")
        # 5. the only junk-free reading is a linked record (Spotify, or a SoundCloud publisher that is not the
        # uploader)
        spot = dedupe([c for c in jf if c.rule in ("N23", "N23sc")])
        if spot and len(dedupe(jf)) == len(spot) == 1:
            return pick(spot[0], "look")
        if len(spot) == 1 and sig & {"R3", "A2", "empty"} and not s3 and not s4:
            return pick(spot[0], "look")
        if len(s3) > 1 or len(s4) > 1:
            opts = s3 if len(s3) > 1 else s4
        else:
            opts = []
    else:
        opts = []

    # ---------------------------------------------------------------- 6. open (or none)
    safe = as_read
    if not (sig - {"N10t", "no_title"}) and T.has_word(v.ti.text):
        # a tempo next to the name is the only signal and no reading moves anything: the file's own reading
        return result(as_read, "look", "as_read")
    if sig & {"empty", "A2"} and not pending_bracket:
        d = result(Reading("none", [], [], [], "", v.ti.text if T.has_word(v.ti.text) else _restore_title(p)),
                   "none", "none")
        d.status = "none"
        d.candidates = dedupe(jf)
        d.signals = tuple(sorted(sig))
        return d
    if pending_bracket:
        code, scope = "U6", ("bracket_word", f"token:{T.fold(pending_bracket)}")
    elif "U8" in sig:
        code, scope = "U8", ("track", f"track:{tid}")
    elif ("N10" in sig or "no_title" in sig) and not any(c.acts for c in jf) and _titleish(v.a.text) \
            and not (sig & {"R3"}):
        # N21b: the artist field is a title (a version or tribute bracket) and the title field held only a tempo or
        # promo words: the text is the title and no source names the artist
        d = result(Reading("none", [], [], [], "", v.a.text), "none", "none")
        d.status = "none"
        d.steps.append(Step("N21b", "pair", as_read.artist + " | " + v.ti.text, " | " + v.a.text, v.a.text))
        d.signals = tuple(sorted(sig))
        return d
    elif (sig & {"N10", "no_title", "title_version", "role_title", "bracket_title"}) and not any(c.acts for c in jf):
        code, scope = "U2", ("track", f"track:{tid}")
    elif "other_head" in sig:
        code, scope = "U3", ("track", f"track:{tid}")
    elif sig & {"swap", "R2"} or any(c.rule == "N13" for c in cands):
        code, scope = "U1", ("track", f"track:{tid}")
    elif "R3" in sig:
        code, scope = "U10", ("track", f"track:{tid}")
    else:
        code, scope = "U6", ("track", f"track:{tid}")
    title = v.ti.text if T.has_word(v.ti.text) else _restore_title(p)
    if glued or t_text != p.ti.text:
        title = p.ti.text if T.has_word(p.ti.text) else title  # an open row shows its own title, nothing moved
    d = result(Reading("open", safe.acts or [v.a.text], safe.joins, safe.featured, safe.feat_word, title), "open",
               "open")
    d.status, d.open_code, d.open_scope = "open", code, scope
    d.candidates = dedupe(opts or jf)
    d.signals = tuple(sorted(sig))
    d.safe_artist = v.a.text
    return d


def _settle(d: Decided, p: P0) -> None:
    """A reading that took the artist from a title head, a file name or a record, or moved or cut the title: the
    artist string rules on each act, the title string rules once more, and the own head off the new title, so that
    resolving the output again gives the same output."""
    acts = []
    for a in d.acts:
        f = clean_artist(a)
        acts.append(f.text if T.has_word(f.text) and "A2" not in f.flags else a)
        if f.members:
            d.notes.setdefault("members", [])
            d.notes["members"] += [x for x in f.members if x not in d.notes["members"]]
        if f.alias:
            d.notes.setdefault("alias", f.alias)
        d.tempo += [x for x in f.tempo if x not in d.tempo]
        if f.text != a and T.has_word(f.text):
            d.steps.append(Step("N8" if f.members or f.alias else "D3", "artist", a, f.text))
    d.acts = acts
    f = clean_title(d.title, bpm_refs=(p.t.bpm_grid, p.t.bpm_analyzed))
    if T.has_word(f.text) and f.text != d.title:
        d.steps.append(Step("D3", "title", d.title, f.text))
        d.title = f.text
        d.tempo += [x for x in f.tempo if x not in d.tempo]
    from .lexer import render_credit
    whole = render_credit(d.acts, d.joins)
    full = whole + (f" {d.feat_word or 'feat.'} " + render_credit(d.featured, [","] * len(d.featured)) if d.featured else "")
    rest = own_head_rest(d.title, d.acts + [whole, full])
    if rest is not None:
        rest = tidy_title(rest)
        d.steps.append(Step("A1own", "title", d.title, rest))
        d.title = rest


def _titleish(text: str) -> bool:
    """The artist field reads as a title: a version bracket, or a tribute, cover or remake bracket."""
    for b in brackets(text):
        if b.closed and text[:b.start].strip() and (bracket_kind(b.inner, True)[0] in ("version", "original") or re.search(
                r"(?i)\b(?:tribute|cover|remake|bootleg|rmx|remix)\b", b.inner)):
            return True
    return False


def album_head_credit(v: P0, known, reg: Registry, any_head: bool = False):
    """N29 (names-3): the «X» of an album tag «X - Y». Never the artist field itself: «Label - X - Album» gives X.
    Every act of X must be a known act, unless `any_head` (the artist field is a label or channel)."""
    if not v.album_head:
        return None
    own = {T.fold(v.a.text)} | {T.fold(x) for x in split_credit(v.a.text).acts}
    head = v.album_head
    if T.fold(head) in own:
        segs = segments(T.chars(v.t.album))
        head = segs[1] if len(segs) >= 3 else ""
        if not head or PLACEHOLDER_RE.match(head):
            return None
    ac = credit_of(head, known, reg.one_act)
    return ac if ac.acts and (any_head or all(known(a) for a in ac.acts)) else None


def _credit_bracket(d: Decided) -> None:
    """A «(vs X)», «(feat. X)» or «(with X)» bracket in the title whose names the chosen credit already holds leaves
    the title; a «vs» becomes the join word before X («Enter Your Mind (vs Sonic System)»)."""
    keys = [T.fold(a) for a in d.acts]
    fkeys = {T.fold(a) for a in d.featured}
    for b in reversed(brackets(d.title)):
        m = re.match(r"(?i)^\s*(vs\.?|v/s|feat\.?|ft\.?|featuring|with)\s+(.+?)\s*$", b.inner)
        if not (m and b.closed and d.title[:b.start].strip()):
            continue
        names = split_credit(m.group(2)).acts
        nk = [T.fold(x) for x in names]
        if not names or not all(k in keys or k in fkeys for k in nk):
            continue
        if m.group(1).lower().startswith(("vs", "v/")):
            for k in nk:
                if k in keys and keys.index(k) >= 1:
                    d.joins[keys.index(k) - 1] = m.group(1)
        new = T.squash(d.title[:b.start] + " " + d.title[b.end:])
        d.steps.append(Step("D3", "title", d.title, new, b.inner))
        d.title = new


def _by_own_tail(d: Decided) -> None:
    """D3 (names-3): «… by X» at the end of the title, where X is the chosen credit or one of its acts."""
    m = T.BY_TAIL_RE.search(d.title)
    if not m or not T.has_word(d.title[:m.start()]):
        return
    from .lexer import render_credit
    keys = {T.fold(a) for a in d.acts + d.featured} | {T.fold(render_credit(d.acts, d.joins))}
    if T.fold(m.group("who")) in keys:
        d.steps.append(Step("D3", "title", d.title, d.title[:m.start()].strip(), m.group().strip()))
        d.title = d.title[:m.start()].strip()


def _restore_title(p: P0) -> str:
    """A rule never empties a field: the title as cleaned before the step that emptied it."""
    for s in reversed(p.ti.steps):
        if T.has_word(s.before):
            return T.tidy(s.before)
    return T.chars(p.t.title)


def fallback(v: P0, ctx: Ctx, known, links_only: bool = False, title: str = "") -> Reading | None:
    """4b after the A1 head: the album-tag head (N29), the SoundCloud publisher (not the uploader), the SoundCloud
    uploader (not a channel), the file name (N22), the folder. `links_only`: skip the album tag and the folder."""
    reg = ctx.reg
    title = title or (v.ti.text if T.has_word(v.ti.text) else (v.file_tail or _restore_title(v)))
    ac = album_head_credit(v, known, reg) if not links_only else None
    if ac is not None:
        return Reading("N29", ac.acts, ac.joins, ac.featured, ac.feat_word, title, evidence=v.t.album)
    for ln in v.t.links:
        if ln.service == "soundcloud" and ln.artists and T.fold(ln.artists[0]) != T.fold(ln.uploader):
            pc = credit_of(clean_artist(ln.artists[0]).text, known, reg.one_act)
            if pc.acts and not PLACEHOLDER_RE.match(ln.artists[0]):
                return Reading("N23sc", pc.acts, pc.joins, pc.featured, pc.feat_word, title,
                               evidence=f"SoundCloud: {ln.artists[0]}")
    for ln in v.t.links:
        # an «X Official» account names X (names-3)
        up = OFFICIAL_WORD_RE.sub("", ln.uploader or "").strip() if ln.service == "soundcloud" else ""
        if up and not reg.channel(up) and T.fold(ln.uploader) not in reg.uploader_channels \
                and not PLACEHOLDER_RE.match(up):
            uc = credit_of(clean_artist(up).text, known, reg.one_act)
            if uc.acts:
                return Reading("4b.uploader", uc.acts, uc.joins, uc.featured, uc.feat_word, title,
                               evidence=f"SoundCloud: {ln.uploader}")
    for ln in v.t.links:
        if ln.service == "spotify" and ln.artists and links_only:
            return Reading("N23", [T.chars(a) for a in ln.artists], ["&"] * (len(ln.artists) - 1), [], "", title,
                           evidence=f"Spotify: {', '.join(ln.artists)}")
    if v.file_head and not PLACEHOLDER_RE.match(v.file_head) and T.fold(v.file_head) != T.fold(v.a.text):
        fc = credit_of(clean_artist(v.file_head).text, known, reg.one_act)
        if fc.acts:
            ttl = title if (T.has_word(v.ti.text) or links_only) else (v.file_tail or title)
            if v.head and T.fold(v.head) == T.fold(v.file_head):
                ttl = v.rest
            return Reading("N22", fc.acts, fc.joins, fc.featured, fc.feat_word, ttl, evidence=v.t.file_name)
    top = (v.t.folder or "").split("/")[0]
    ftop = T.tidy(T.chars(top))
    if ftop and not links_only and not GENERIC_FOLDER_RE.match(ftop) and not PLACEHOLDER_RE.match(ftop) \
            and not re.search(r"(?i)likes of|χύμα|compil|unknown|download", ftop) \
            and not T.fold(ftop).startswith(T.fold(title)[:12] or "\0"):  # a folder named after the title is no act
        fc = credit_of(ftop, known, reg.one_act)
        if fc.acts:
            return Reading("4b.folder", fc.acts, fc.joins, fc.featured, fc.feat_word, title, evidence=top)
    return None


def as_field(text: str) -> Field:
    return Field(raw=text, text=text)


def apply_decision_value(d: Decision) -> str:
    return d.value.strip()


__all__ = ["Ctx", "Decided", "decide", "signals", "is_title_junk"]
