"""The one pure entry point: every track's inputs and the decision rows in, every track's result and the act and album
tables out. No I/O, no clock, no network; sorted iteration and total tie orders, so the same inputs give the same
output bytes. Phases: P0 string rules, P1 registry and votes, P2-P4 readings and the decision list, P5 spelling,
casing, album credit and folder."""
from __future__ import annotations

import re
from collections import Counter, defaultdict
from typing import Iterable

from . import album as AL
from . import kept as KP
from . import prefs as PF
from . import spelling as SP
from . import text as T
from .decide import Ctx, Decided, decide
from .explain import reason
from .fields import PLACEHOLDER_RE
from .lexer import bracket_kind, brackets, join_word, render_credit, split_credit
from .model import Act, Decision, References, Resolution, Step, TrackInput, TrackResult
from .readings import JOIN_LEAD_RE, P0, credit_of, p0
from .registry import SUBTITLE_RE, Registry, usable_key
from .ruleset import RULESET

UNKNOWN_ARTIST = "Unknown Artist"
# names-5: a weak join word between two name-like parts inside one act («Trypt X ZoHuWaBoRu», «Chillaoz With Ann»)
WEAK_IN_NAME_RE = re.compile(r"[^\W\d_]{2,}\s+(?:x|X|×|and|And|AND|with|With|WITH|meets|Meets|b2b|B2B|\+)\s+[^\W\d_]{2,}")
# names-5: a year at the end of a title, bare, after a dash or in its own bracket
ROLE_CAPS_RE = re.compile(r"\b(?:REMIX|EDIT|RE-?EDIT|BOOTLEG|REWORK|MIX|VERSION|REMAKE|MASHUP|DUB|FLIP|REFIX|REBOOT"
                          r"|COVER|REMASTER)\b")
YEAR_TAIL_RE = re.compile(r"(?:\s+[-–—]\s*|\s+)(?:19|20)\d\d\s*$|\s*[(\[](?:19|20)\d\d[)\]]\s*$")


def index_decisions(decisions: Iterable[Decision]) -> dict[tuple[str, str], Decision]:
    """One active row per (kind, scope); an owner row is never replaced by a row from another source."""
    out: dict[tuple[str, str], Decision] = {}
    for d in decisions:
        k = (d.kind, d.scope)
        if k in out and out[k].source == "owner" and d.source != "owner":
            continue
        out[k] = d
    return out


def build_registry(p0s: dict[int, P0], refs: References, D: dict) -> Registry:
    reg = Registry()
    reg.loose_folders = tuple(refs.loose_folders)
    for name, n in refs.spotify:
        k = T.fold(name)
        if k:
            reg.spotify[k] += n
            reg.spotify_whole.add(k)
            b = reg.bare(name)
            if b and b != k:
                reg.spotify_bare[b] += n
    for name, n in refs.sc_publisher:
        k = T.fold(name)
        if k:
            reg.sc_publisher[k] += n
    for key, n in refs.titles:
        reg.titles[key] += n
    for (kind, scope), d in D.items():
        key = scope.split(":", 1)[1] if ":" in scope else scope
        if kind == "spelling":
            reg.decided_acts.add(key)
        elif kind == "one_act" and d.value.strip().lower() in ("yes", "ναι", "a", "b", "one"):
            reg.one_act_keys.add(key)
        elif kind == "not_act" and d.value.strip().lower() not in ("no", "όχι"):
            # names-7: «label» says what the name is (its tracks keep it as the label fact); «*x» is a name pattern
            # («name:*music»: every name ending in «Music»)
            why = "label" if d.value.strip().lower() in ("label", "δισκογραφική") else "decision"
            if key.startswith("*"):
                reg.name_suffixes[T.fold(key[1:])] = why
            else:
                reg.not_act_keys.add(key)
                reg.channels[key] = why
    for tid in sorted(p0s):
        p = p0s[tid]
        sp, pub, own_titles = Counter(), Counter(), set()
        for ln in p.t.links:
            if ln.service == "spotify":
                for a in ln.artists:
                    sp[T.fold(a)] += 1
            elif ln.service == "soundcloud":
                for a in ln.artists:
                    if T.fold(a) != T.fold(ln.uploader):
                        pub[T.fold(a)] += 1
            if ln.title:
                own = T.title_annotations(T.chars(ln.title))[0]
                own_titles.add(T.fold(own))
                m = re.match(r"^\s*.+?\s+[-–—]\s+(.+)$", own)
                if m and ln.service == "soundcloud":
                    own_titles.add(T.fold(m.group(1)))  # the reference counts a SoundCloud title by its tail
        reg.own_links[tid] = (sp, pub, own_titles)
        clean_field = len(_segments(p.a.text)) == 1 and not ({"A2", "N10"} & p.a.flags) and not reg.channel(p.a.text)
        if clean_field:
            for a in p.credit.acts + p.credit.featured:
                reg.add_local(a, tid, p.group)
            if len(p.credit.acts) >= 2:
                reg.add_partners(p.credit.acts, tid)
            if len(p.credit.acts) == 1 and not p.credit.featured:
                k = usable_key(p.credit.acts[0])
                if k:
                    reg.solo[k].add(tid)
        if p.head and not ({"N10"} & _artist_flags_of(p.head)):
            own = {T.fold(x) for x in p.credit.acts} | {T.fold(p.a.text)}
            hc = split_credit(p.head)
            if not (({T.fold(x) for x in hc.acts} | {T.fold(p.head)}) & own) and not JOIN_LEAD_RE.match(p.head) \
                    and not re.fullmatch(r"\s*\d+\s*", p.head):
                for a in hc.acts + hc.featured:
                    reg.add_local(a, tid, p.group)
                if len(hc.acts) >= 2:
                    reg.add_partners(hc.acts, tid)
                if len(hc.acts) == 1 and not hc.featured and usable_key(hc.acts[0]):
                    reg.solo[usable_key(hc.acts[0])].add(tid)  # names-4: a solo title-head credit is known alone
            elif len(hc.acts) >= 2 and not JOIN_LEAD_RE.match(p.head) and {T.fold(x) for x in hc.acts} & own:
                # names-5: a head credit that holds the track's own act names its other acts too («Own vs B - Title»),
                # as the artist field would after the reading (so a second run reads the same registry)
                for a in hc.acts:
                    if T.fold(a) not in own:
                        reg.add_local(a, tid, p.group)
        if p.album_head:
            ac = split_credit(p.album_head)
            if len(ac.acts) == 1 and not ac.featured and usable_key(ac.acts[0]) and not PLACEHOLDER_RE.match(p.album_head):
                reg.solo[usable_key(ac.acts[0])].add(tid)  # names-4: a solo album-tag head is known alone
        reg.local_titles[T.fold(p.ti.text)].add(tid)
        if p.rest:
            reg.local_titles[T.fold(p.rest)].add(tid)
    # R3 channels: uploaders that post 5 or more different known acts (not their own), and artist fields that
    # front 3 or more tracks whose titles open with 2 or more different known credits
    posted: dict[str, set[str]] = defaultdict(set)
    for tid in sorted(p0s):
        p = p0s[tid]
        keys = {usable_key(a) for a in p.credit.acts} - {""}
        for ln in p.t.links:
            if ln.service == "soundcloud" and ln.uploader:
                uk = T.fold(ln.uploader)
                if uk and uk not in keys:
                    posted[uk] |= {k for k in keys if reg.known_key(k)}
    for uk, acts in posted.items():
        if len(acts) >= 5 and not reg.spotify.get(uk):
            reg.uploader_channels.add(uk)
    fronts: dict[str, list[tuple[int, str]]] = defaultdict(list)
    for tid in sorted(p0s):
        p = p0s[tid]
        if not p.head or JOIN_LEAD_RE.match(p.head) or SUBTITLE_RE.match(p.head):
            continue
        ak = T.fold(p.a.text)
        hc = split_credit(p.head)
        hk = T.fold(p.head)
        own = {T.fold(x) for x in p.credit.acts} | {ak} | {reg.bare(x) for x in p.credit.acts} | {reg.bare(p.a.text)}
        if not ak or hk in own or ({T.fold(x) for x in hc.acts} & own):
            continue
        if hc.acts and all(reg.known(x, tid, p.group) for x in hc.acts):
            fronts[ak].append((tid, hk))
    for ak, xs in fronts.items():
        if len(xs) >= 3 and len({h for _, h in xs}) >= 2 and not reg.spotify.get(ak):
            reg.channels.setdefault(ak, "fronts")
    return reg


def _segments(s: str) -> list[str]:
    from .lexer import segments
    return segments(s) if s else []


def _artist_flags_of(text: str) -> set[str]:
    from .decide import _title_like
    return {"N10"} if _title_like(text) else set()


def _votes(p0s: dict[int, P0]) -> dict[str, SP.Votes]:
    votes: dict[str, SP.Votes] = defaultdict(SP.Votes)
    for tid in sorted(p0s):
        p = p0s[tid]
        unit = p.group or f"t:{tid}"
        names = []
        if not ({"A2"} & p.a.flags):
            names += p.credit.acts + p.credit.featured
        if p.head:
            hc = split_credit(p.head)
            names += hc.acts + hc.featured  # a title head's credit counts like an artist field's, featured included
        if p.credit.acts and p.ti.text:
            # names-4: the own act glued to the title by a dash («Sastoke-Regreciones» under «รครt๏кє») is a spelling
            from .decide import own_head_rest
            rest = own_head_rest(p.ti.text, p.credit.acts + [p.a.text])
            if rest is not None and T.squash(p.ti.text[:len(p.ti.text) - len(rest)].rstrip(" -–—:")) != p.head:
                names.append(T.squash(p.ti.text[:len(p.ti.text) - len(rest)].rstrip(" -–—:")))
        seen = set()
        for n in names:
            n = T.squash(n.replace(T.SEP, " "))
            k = usable_key(n)
            if k and (k, n) not in seen:
                seen.add((k, n))
                votes[k].add(n, unit, tid)
    return votes


MIX_ROLE_RE = re.compile(r"(?i)^(?:mix|version|edit|re-?edit|dub|cut|live|instrumental|extended|radio)$")


def remixer(name: str, role: str, known) -> bool:
    """names-5: a name in a version bracket is a remixer when it reads like a name: never when it is only release,
    promo or technical words («Album Preview», «Full», «mp3», «New», «Mini»); before a word that also names a kind of
    mix («X Mix», «X Version», «X Edit») only when it is a known act («Back To Earth Mix» is the artist's own version)."""
    words = [w.casefold().rstrip(".") for w in re.findall(r"[^\W_]+(?:[-.'][^\W_]+)*\.?", name)]
    noise = T.REL_RELEASE | T.REL_PROMO | T.REL_TECH | T.REL_NAME | T.REL_GENRE | {"mini", "full", "demo", "cassette",
                                                                                     "original", "orginal", "short"}
    if not words or all(w in noise or T.REL_TECH_RE.fullmatch(w) for w in words):
        return False
    return not MIX_ROLE_RE.match((role or "").strip()) or known(name)


def _roles(d: Decided, title: str, known=lambda n: True) -> list[tuple[str, str]]:
    out = [(a, "primary" if i == 0 else "collaborator") for i, a in enumerate(d.acts)]
    out += [(a, "featured") for a in d.featured]
    out += [(a, "original") for a in d.original]
    out += [(a, "member") for a in d.notes.get("members", [])]
    for b in brackets(title):
        kind, data = bracket_kind(b.inner, b.closed)
        if kind == "version":
            out += [(n, "remixer") for n in data.get("names", []) if remixer(n, data.get("role", ""), known)]
        elif kind == "feat":
            for n in data.get("names", []):
                out += [(x, "featured") for x in re.split(r"(?i)\s+(?:and|&)\s+", n) if x.strip()]
    return [(n, r) for n, r in out if T.fold(n) != "friends"]  # names-5: «X and Friends» names no act «Friends»


def resolve(tracks: Iterable[TrackInput], refs: References | None = None,
            decisions: Iterable[Decision] = ()) -> Resolution:
    refs = refs or References()
    D = index_decisions(decisions)
    tracks = sorted(tracks, key=lambda t: t.id)
    p0s = {t.id: p0(t) for t in tracks}
    gid = AL.groups(p0s, refs.loose_folders)
    for tid, p in p0s.items():
        p.group = gid.get(tid, "")
    reg = build_registry(p0s, refs, D)
    s1, s1_weak = AL.s1_groups(p0s, gid, reg)
    decided: dict[int, Decided] = {}
    for tid in sorted(p0s):
        p = p0s[tid]
        decided[tid] = decide(p, Ctx(reg, s1=p.group in s1, s1_evidence=s1.get(p.group, ""),
                                     s1_weak=p.group in s1_weak, decisions=D))

    # ---------------------------------------------------------------- P5: spelling and casing
    votes = _votes(p0s)
    sp_counts: dict[str, Counter] = defaultdict(Counter)
    pub_counts: dict[str, Counter] = defaultdict(Counter)
    for name, n in refs.spotify:
        sp_counts[T.fold(name)][name] += n
    for name, n in refs.sc_publisher:
        pub_counts[T.fold(name)][name] += n
    same_act = {}
    pair_answer: dict[str, Decision] = {}  # names-7: an act merged into another by the owner's answer
    for (kind, scope), d in D.items():
        if kind == "same_act" and d.value.strip().lower() in ("yes", "ναι", "b"):
            a, _, b = scope.split(":", 1)[1].partition("|")
            same_act[a] = b
            pair_answer[a] = d
    style = SP.Style(short_part=PF.answer(D, "pref:short_part_capitals") == "B",
                     alternating=PF.answer(D, "pref:alternating_case") == "B",
                     y_only=PF.answer(D, "pref:y_only_capitals") == "B",
                     asked=" ".join(code for code, scope in (("U5c", "pref:short_part_capitals"),
                                                              ("U5s", "pref:stylised_capitals"),
                                                              ("U5l", "pref:lookalike_letters"))
                                    if not PF.answer(D, scope)))
    lookalike_settled = bool(PF.answer(D, "pref:lookalike_letters"))
    year_settled = PF.answer(D, "pref:year_at_title_end") == "A"
    whole_settled = PF.answer(D, "pref:whole_credit_folder") == "A"
    roles = {tid: _roles(decided[tid], decided[tid].title, reg.known) for tid in decided}
    needed: dict[str, list[str]] = defaultdict(list)
    for tid in sorted(roles):
        if decided[tid].status == "hand":
            continue
        for name, _ in roles[tid]:
            k = usable_key(T.squash(name.replace(T.SEP, " ")))
            if k:
                needed[k].append(T.squash(name.replace(T.SEP, " ")))
    # C5 (names-4): an act whose spelling has a look-alike letter and whose key with that letter left out is a strong
    # act («KillatΔk» beside «Killatk» ×32) is that act (`look`); a decision about the pair overrides
    lookalike: dict[str, str] = {}
    for k in sorted(needed):
        for n in sorted(set(needed[k])):
            if any(c in SP.LOOKALIKE_CHARS for c in n):
                k2 = usable_key("".join(c for c in n if c not in SP.LOOKALIKE_CHARS))
                if k2 and k2 != k and k not in same_act and (reg.local_count(k2) >= 2 or reg.spotify.get(k2)):
                    lookalike[k] = k2
                    break
    same_act.update(lookalike)
    chosen: dict[str, SP.Choice] = {}
    for k in sorted(set(needed) | set(votes)):
        v = votes.get(k) or SP.Votes()
        for n in needed.get(k, []):
            v.seen(n)
        dec = D.get(("spelling", f"act:{k}"))
        chosen[k] = SP.choose(v, sp_counts.get(k, Counter()), pub_counts.get(k, Counter()),
                              dec.value.lstrip("=").strip() if dec else None, style)
        votes[k] = v

    def spell(name: str) -> str:
        n = T.squash(name.replace(T.SEP, " "))
        k = usable_key(n)
        k = same_act.get(k, k)
        c = chosen.get(k)
        return c.spelling if c else n

    shown_keys: set[str] = set()
    for tid in decided:
        if decided[tid].status not in ("open", "none", "hand"):
            shown_keys |= {usable_key(T.squash(a.replace(T.SEP, " "))) for a in decided[tid].acts}

    def spell_seen(name: str) -> str:
        """An open row is shown as written, except that an act the library shows on a resolved track takes that
        spelling (so a later run, which reads that spelling as a library spelling, gives the same row)."""
        n = T.squash(name.replace(T.SEP, " "))
        k = same_act.get(usable_key(n), usable_key(n))
        c = chosen.get(k)
        return c.spelling if c and (c.rule != "C4" or k in shown_keys) else n

    def credited(name: str) -> bool:
        """N28's known act: a decision, a reference, or a credit read from an artist field or a title head."""
        k = usable_key(name)
        return bool(k) and (reg.known(name) or any(votes.get(k, SP.Votes()).units.values()))

    def casing_of(name: str) -> str:
        """The rule that chose an act's spelling, for N28's sentence («C4», «C2/U5c», …)."""
        n = T.squash(name.replace(T.SEP, " "))
        k = usable_key(n)
        if k in lookalike:
            return "C5"
        c = chosen.get(same_act.get(k, k))
        return f"{c.rule}/{c.doubt}" if c else ""

    # D3l (names-6): names the library knows as a label: a title's label note (from the string rules or from the text
    # that left the title), a label-named artist field
    label_names = [p.a.text for p in p0s.values() if reg.channel(p.a.text) == "label"]
    for tid in sorted(p0s):
        p = p0s[tid]
        found = p.ti.note.get("label") or KP.kept_from_title(p.t.title, p.ti.text, [p.a.text], [],
                                                            set(p.ti.tempo), p.ti.note)[0].get("label")
        if found:
            label_names.append(found)
    labels = KP.label_keys(label_names)

    # ---------------------------------------------------------------- render each track
    results: dict[int, TrackResult] = {}
    for tid in sorted(decided):
        d, p = decided[tid], p0s[tid]
        trail = list(d.steps)
        status = d.status
        if d.status == "hand":
            artist = d.safe_artist
            acts = d.acts
        elif d.status == "open":
            acts = [x for x in (split_credit(d.safe_artist).acts or [d.safe_artist])]
            shown = [spell_seen(a) for a in acts]
            c = split_credit(d.safe_artist)
            artist = render_credit(shown, c.joins) if len(shown) > 1 else (shown[0] if shown else d.safe_artist)
            if c.featured:
                artist += f" {join_word(c.feat_word or 'feat.')} " + render_credit([spell_seen(x) for x in c.featured],
                                                                       [","] * len(c.featured))
            artist = T.squash(artist.replace(T.SEP, " "))
        elif d.status == "none":
            artist = UNKNOWN_ARTIST
            acts = []
        else:
            acts = d.acts
            shown = [spell(a) for a in acts]
            artist = render_credit(shown, d.joins)
            if d.featured:
                artist += f" {join_word(d.feat_word or 'feat.')} " + render_credit([spell(x) for x in d.featured],
                                                                       [","] * len(d.featured))
        if d.status not in ("hand", "none"):
            for a in acts + (d.featured if d.status != "open" else []):
                n = T.squash(a.replace(T.SEP, " "))
                k = usable_key(n)
                c = chosen.get(same_act.get(k, k))
                applied = c is not None and not (d.status == "open" and c.rule == "C4" and k not in shown_keys)
                if applied and c.doubt == "U5s":
                    trail.append(Step("N2s", "artist", n, c.spelling, ""))  # stylised capitals kept, one owner question
                    status = "look" if status == "sure" else status
                if applied and c.doubt == "U5c" and c.spelling != n:
                    trail.append(Step("N2c", "artist", n, c.spelling, ""))  # names-5: short capital part, one question
                    status = "look" if status == "sure" else status
                if c and c.spelling != n and not (d.status == "open" and c.rule == "C4" and k not in shown_keys):
                    if k in lookalike:
                        trail.append(Step("C5", "artist", n, c.spelling, lookalike[k]))
                        if not lookalike_settled:
                            status = "look" if status == "sure" else status
                    elif k in pair_answer:
                        # names-7: the owner said the two names are one act; a provisional answer stays `look`
                        pa = pair_answer[k]
                        trail.append(Step("N19h", "artist", n, c.spelling, "provisional" if pa.provisional else ""))
                        if pa.provisional:
                            status = "look" if status == "sure" else status
                    else:
                        trail.append(Step("CH" if c.rule == "H" else c.rule, "artist", n, c.spelling, c.evidence))
                    if c.status == "look" and status in ("sure",):
                        status = "look"
        artist = T.squash(artist.replace(T.SEP, " & "))
        if d.status not in ("hand", "none"):
            # N15w (names-4): a join word written in capitals is lowered («Vs» → «vs», «Feat» → «feat»)
            raw_joins = list(d.joins if d.status != "open" else split_credit(d.safe_artist).joins)
            fw = d.feat_word if d.status != "open" else split_credit(d.safe_artist).feat_word
            changed = [j for j in raw_joins + ([fw] if fw else []) if j and join_word(j) != j.strip()
                       and j.strip() not in (",", ";", T.SEP, "+")]
            if changed:
                trail.append(Step("N15w", "artist", " ".join(changed), " ".join(join_word(j) for j in changed)))
        title = d.title
        if d.status != "hand":
            # N30 (names-6): never more capitals than today's display; the linked record's spelling first
            records = [(ln.service, T.title_annotations(T.chars(ln.title))[0]) for ln in p.t.links if ln.title]
            new, used = KP.quieter_title(title, p.t.previous_title, records)
            if new != title:
                trail.append(Step("N30", "title", title, new, used))
                title = new
            new, changes = _n28(title, spell, credited, casing_of)
            if new != title:
                trail.append(Step("N28", "title", title, new, " ; ".join(changes)))
                if status == "sure":
                    status = "look"
                title = new
        if not T.has_word(title):
            title = T.chars(p.t.title) or title
        m = YEAR_TAIL_RE.search(title)
        if m and d.status not in ("hand",) and T.has_word(re.sub(r"\d", "", title[:m.start()])):
            # names-5: a year at the end of a title («Lullaby 2012», «Flow [2022]»): part of the title or a note is
            # taste; kept, `look`, one owner question (names-7: once answered, the answer says so and no look)
            if year_settled:
                trail.append(Step("D3y", "title", title, title, f"απάντηση|{m.group().strip()}"))
            else:
                trail.append(Step("D3y", "title", title, title, m.group().strip()))
                status = "look" if status == "sure" else status
        notes = dict(d.notes)
        if d.original:
            notes["original"] = [spell(x) for x in d.original]
        if notes.get("members"):
            notes["members"] = [spell(x) for x in notes["members"]]
        tempo = ""
        if d.tempo:
            uniq = []
            for x in d.tempo:
                x = f"{float(x):g}"
                if x not in uniq:
                    uniq.append(x)
            tempo = " | ".join(uniq)
        field_label = next((x for x in reversed(_segments(p.a.text.replace(T.SEP, " - "))) if reg.is_label(x)), "")
        if d.status not in ("hand", "open") and not notes.get("label") and field_label \
                and T.fold(field_label) not in {T.fold(a) for a in acts} | {T.fold(artist)}:
            # D3a (names-7): an artist field that names a label («QX Music», «ZARVO RECORDS», «Velo - Lumo
            # Records») that is not the artist shown keeps the label as the label fact, as the tag writes it
            notes["label"] = T.squash(field_label)
            trail.append(Step("D3a", "facts", "", notes["label"], ""))
        if d.status != "hand" and (isinstance(notes.get("label"), str) or isinstance(notes.get("album"), str)):
            # names-7: a label or album fact holds the name only (no promo words, no web address)
            lab = notes.pop("label", "") if isinstance(notes.get("label"), str) else ""
            alb = notes.pop("album", "") if isinstance(notes.get("album"), str) else ""
            tidy = KP.tidy_facts(lab, alb)
            notes["removed"] = list(notes.get("removed") or []) + tidy.pop("removed", [])
            if not notes["removed"]:
                notes.pop("removed")
            notes.update(tidy)
        if d.status != "hand":
            # D3l (names-6): a final bracket the library knows only as a label leaves the title as the label fact
            new, label = KP.label_bracket(title, labels, lambda n: reg.known(n) or credited(n))
            if label and not notes.get("label"):
                trail.append(Step("D3l", "title", title, new, label))
                notes["label"] = label
                title = new
            # D3p, D3n, D3c (names-6): nothing that left the title vanishes
            facts = [tempo, p.t.album] + [x for v in notes.values() for x in (v if isinstance(v, list) else [v])
                                          if isinstance(x, str)]
            tempos = {x for x in tempo.split(" | ") if x} | {x.split(".")[0] for x in tempo.split(" | ") if x}
            add, ksteps, look = KP.kept_from_title(p.t.title, title, [artist] + [n for n, _ in roles[tid]], facts,
                                                   tempos, notes)
            for k, v in add.items():
                if isinstance(v, list):
                    notes[k] = list(notes.get(k) or []) + v
                else:
                    notes.setdefault(k, v)
            trail += ksteps
            if look and status == "sure":
                status = "look"
        act_rows = tuple(Act(spell(n), same_act.get(usable_key(n), usable_key(n)), r) for n, r in roles[tid]
                         if usable_key(n))
        rem = [a.name for a in act_rows if a.role == "remixer"]
        if rem:
            trail.append(Step("N10r", "facts", "", ", ".join(rem), ""))  # names-5: the remix fact says where it came from
        t = p.t
        for fld, new, prev, src in (("artist", artist, t.previous_artist, t.previous_source_artist),
                                    ("title", title, t.previous_title, t.previous_source_title)):
            # R0 (names-4): the value differs from the one shown before and no rule changed this field (or the
            # previous value came from a linked record): the file's own tag is shown
            if (prev or src == "empty") and new != prev and d.status != "none" and (
                    src in ("spotify", "soundcloud") or not any(_explains(s, fld, prev) for s in trail)):
                ruled = any(s.field == fld or (s.field == "pair" and _side(s.before, fld) != _side(s.after, fld))
                            for s in trail if s.rule != "R0")
                # names-7: the sentence says «what the tag writes» only when it is the tag's value; a value the rules
                # read from the tag without a step of their own says it was read from the tag, and quotes the tag
                tag = T.squash(T.chars(t.artist if fld == "artist" else t.title))
                if not ruled and " ".join(new.split()) != tag:
                    ruled = any(s.field == "pair" and s.before != s.after for s in trail if s.rule != "R0")
                how = "|rules" if ruled else ("" if " ".join(new.split()) == tag else f"|read|{tag}")
                trail.append(Step("R0", fld, prev, new, src + how))
        results[tid] = TrackResult(id=tid, artist=artist, title=title, acts=act_rows, tempo_hint=tempo,
                                   notes=notes, status=status, open_code=d.open_code, trail=tuple(trail))

    # N19s (names-4): an act of one track whose key is one edit (or a leading «The») away from an act of 3 or more
    # tracks: never merged; the track is `look` and the pair is one owner question
    act_tracks: Counter = Counter()
    for tid, r in results.items():
        for k in {a.key for a in r.acts if a.role in ("primary", "collaborator", "featured")}:
            act_tracks[k] += 1
    big = sorted(k for k, n in act_tracks.items() if n >= 3)
    by_len: dict[int, list[str]] = defaultdict(list)
    for k in big:
        by_len[len(k)].append(k)
    similar: dict[str, str] = {}

    def asked(a: str, b: str) -> bool:
        return ("same_act", f"pair:{a}|{b}") in D or ("same_act", f"pair:{b}|{a}") in D

    for k in sorted(k for k, n in act_tracks.items() if n == 1 and len(k) >= 5):
        # names-5: «The X» or «DJ X» beside «X» is always listed (any track count); a 5-letter key one edit from an act
        # of 10 or more tracks too; featured names count
        for other in (k[3:] if k.startswith("the") else "", k[2:] if k.startswith("dj") else "", "the" + k, "dj" + k):
            if len(other) >= 4 and other != k and act_tracks.get(other) and not asked(k, other):
                similar[k] = other
                break
        if k in similar:
            continue
        for other in by_len.get(len(k), []) + by_len.get(len(k) - 1, []) + by_len.get(len(k) + 1, []):
            if other != k and (T.near(k, other) or (min(len(k), len(other)) == 5 and act_tracks[other] >= 10
                                                    and T.near(k, other, 5))) and not asked(k, other):
                similar[k] = other
                break
    for tid in sorted(results):
        r = results[tid]
        for a in r.acts:
            if a.key in similar and a.role in ("primary", "collaborator", "featured") \
                    and r.status not in ("open", "none", "hand"):
                other = similar[a.key]
                r.trail = r.trail + (Step("N19s", "artist", "", "", f"{a.name} ~ {chosen[other].spelling if other in chosen else other}"),)
                r.status = "look" if r.status == "sure" else r.status
                break

    # ---------------------------------------------------------------- album credit (N12, N27) and folder (N24)
    class _R:
        def __init__(self, r: TrackResult):
            self.acts = [(a.name, a.key, a.role) for a in r.acts]
            self.status, self.open_code = r.status, r.open_code
    albums = AL.credits(gid, {tid: _R(r) for tid, r in results.items()}, p0s)
    group_credit: dict[str, list[str]] = {}
    set_folder: dict[frozenset, str] = {}  # N12s: the act set of an N12 album -> that album's folder
    album_rows = []
    open_items: list[dict] = []
    for g, info in sorted(albums.items()):
        keys = info["credit"]
        names = [chosen[k].spelling if k in chosen else k for k in keys]
        scope = f"album:{AL.album_key(info['album'])}|{'+'.join(sorted(keys))}"
        answer = D.get(("album_credit", scope))
        kind = info["kind"]
        if answer is not None:
            v = answer.value.strip()
            if v.lower() in ("none", "όχι", "a"):
                kind = "decided_none"
            else:
                group_credit[g] = [x.strip() for x in re.split(r"\s*&\s*", v.lstrip("=")) if x.strip()]
                kind = "decided"
        elif kind == "N12":
            group_credit[g] = names
            set_folder.setdefault(frozenset(keys), " & ".join(names))
        elif kind in ("N27", "N27a"):
            for tid in info["tracks"]:
                r = results[tid]
                if r.status not in ("open", "none", "hand"):
                    r.status, r.open_code = "open", "U11"
                    r.trail = r.trail + (Step(kind, "folder", "", " & ".join(names), info["reason"]),)
            open_items.append({"kind": "album_credit", "scope": scope, "tracks": info["tracks"], "code": "U11",
                               "question": f"Το άλμπουμ «{info['album']}»: φάκελος με όλη τη σύμπραξη;",
                               "options": ["A=" + "κάθε κομμάτι στον δικό του φάκελο", "B=" + " & ".join(names)]})
        album_rows.append({**info, "credit": " & ".join(group_credit.get(g, [])), "kind": kind, "scope": scope,
                           "proposed": " & ".join(names)})

    # names-5: an act is known alone also when a SoundCloud account has its name, or when it is the only act of another
    # resolved track
    from .decide import uploader_name
    account_keys = {usable_key(uploader_name(ln.uploader)) for p in p0s.values() for ln in p.t.links
                    if ln.service == "soundcloud"} - {""}
    solo_tracks: dict[str, set[int]] = defaultdict(set)
    for tid, r in results.items():
        main = [a for a in r.acts if a.role in ("primary", "collaborator")]
        if len(main) == 1 and r.status not in ("open", "none"):
            solo_tracks[main[0].key].add(tid)
    for tid in sorted(results):
        r, d, p = results[tid], decided[tid], p0s[tid]
        top = (p.t.folder or "").split("/")[0]
        main = [a for a in r.acts if a.role in ("primary", "collaborator")]
        if r.status == "none":
            folder, frule = UNKNOWN_ARTIST, "none"
        elif r.status == "open":
            folder, frule = top or UNKNOWN_ARTIST, "open"
        elif p.group in group_credit:
            folder, frule = " & ".join(group_credit[p.group]), "N12"
            r.album_credit = folder
        elif len(main) <= 1:
            folder, frule = (main[0].name if main else r.artist), "N24"
            if main and WEAK_IN_NAME_RE.search(f" {main[0].name} ") and not reg.one_act(main[0].name) \
                    and ("one_act", f"credit:{main[0].key}") not in D and r.status not in ("hand",):
                # names-5: one act only because a weak join word («x», «and», «with», «+») was not split (its parts are
                # not all known acts): one act or two is knowledge the library does not hold
                if whole_settled:
                    r.trail = r.trail + (Step("N25q", "folder", "", "", "απάντηση"),)
                else:
                    r.trail = r.trail + (Step("N25q", "folder", "", "", main[0].name),)
                    r.status = "look" if r.status == "sure" else r.status
        elif frozenset(a.key for a in main) in set_folder:
            folder, frule = set_folder[frozenset(a.key for a in main)], "N12s"
        else:
            joins = d.joins if d.status != "hand" else []
            whole = render_credit([a.name for a in main], joins)
            solo = [a for a in main if reg.solo_count(a.key, tid) >= 1 or reg.spotify.get(a.key, 0) >= 1
                    or a.key in account_keys or solo_tracks.get(a.key, set()) - {tid}]
            # names-4: the whole credit is one folder only for 2-3 names joined by words that can be part of a name
            # («&», «and», «+», «x»), with no part known alone; «vs», «,», «feat» always give the first act
            name_joins = all(join_word(j) in ("&", "and", "e", "x") or j.strip() == "+" for j in joins[:len(main) - 1])
            if reg.one_act(whole) or (not solo and name_joins and len(main) <= 3):
                folder, frule = whole, "N25"
                if not reg.one_act(whole):
                    r.trail = r.trail + (Step("N25q", "folder", "", "", "απάντηση" if whole_settled else ""),)
                    if not whole_settled:
                        r.status = "look" if r.status == "sure" else r.status  # names-5: one act or two: one question
            else:
                folder, frule = main[0].name, "N24"
        folder, fsteps = T.squash(folder.replace(T.SEP, " & ")), ""
        if frule not in ("open", "none"):
            folder, fsteps = AL.folder_name(folder)
        r.folder = folder
        if frule in ("N12", "N12s", "N25") or (frule == "N24" and len(main) > 1) or fsteps:
            r.trail = r.trail + (Step(frule, "folder", top, r.folder, fsteps),)
        elif frule == "N24" and top and r.folder != top:
            r.trail = r.trail + (Step("N24s", "folder", top, r.folder, ""),)  # names-5: a moved folder says why
        r.trail = tuple(_punctuation_only(s) for s in r.trail)
        r.rules = tuple(sorted({s.rule for s in r.trail}))
        r.reason = reason(list(r.trail), r.status, r.open_code)

    # ---------------------------------------------------------------- the open list and the act table
    by_scope: dict[tuple[str, str], list[int]] = defaultdict(list)
    for tid in sorted(decided):
        d = decided[tid]
        if results[tid].status == "open" and results[tid].open_code != "U11" and d.open_scope[0]:
            by_scope[d.open_scope].append(tid)
    for (kind, scope), ids in sorted(by_scope.items()):
        d = decided[ids[0]]
        r = results[ids[0]]
        opts = [f"A={r.artist} | {r.title}"]
        letter = ord("B")
        seen = {(r.artist, r.title)}
        for c in d.candidates:
            pair = (render_credit([spell(a) for a in c.acts], c.joins), c.title)
            if pair not in seen and c.acts:
                seen.add(pair)
                opts.append(f"{chr(letter)}={pair[0]} | {pair[1]}")
                letter += 1
        if kind == "bracket_word":
            word = p0s[ids[0]].a.lead_bracket
            question = f"Τι είναι το «[{word}]» πριν από το όνομα;"
            opts = ["A=κράτα το όπως είναι", "B=είδος μουσικής (αφαίρεσέ το)", "C=δισκογραφική (αφαίρεσέ το)"]
        else:
            question = _question(r.open_code)
        open_items.append({"kind": kind, "scope": scope, "tracks": ids, "code": r.open_code, "question": question,
                           "options": opts})
    act_rows, look_items = [], []
    used = Counter()
    for r in results.values():
        for a in {(a.key) for a in r.acts}:
            used[a] += 1
    for k in sorted(chosen):
        if not used.get(k):
            continue
        c = chosen[k]
        v = votes.get(k) or SP.Votes()
        row = {"key": k, "spelling": c.spelling, "rule": c.rule, "status": c.status, "doubt": c.doubt,
               "tracks": used[k],
               "local": " ; ".join(f"{s} ×{len(v.units.get(s, ()))}/{v.tracks.get(s, 0)}"
                                   for s in sorted(v.units, key=lambda s: (-len(v.units[s]), s))),
               "spotify": " ; ".join(f"{s} ×{n}" for s, n in sp_counts.get(k, Counter()).most_common()),
               "publisher": " ; ".join(f"{s} ×{n}" for s, n in pub_counts.get(k, Counter()).most_common())}
        act_rows.append(row)
        if c.doubt and c.rule != "H":
            look_items.append(row)
            if c.doubt in ("U5s", "U5c"):
                continue  # one pattern question for every such act (owner-decisions), not one row per act
            others = [s for s in sorted(v.units, key=lambda s: (-len(v.units[s]), s)) if s != c.spelling][:4]
            opts = [f"A={c.spelling}"] + [f"{chr(ord('B') + i)}={s}" for i, s in enumerate(others)]
            ids = sorted(tid for tid, r in results.items() if any(a.key == k for a in r.acts))
            open_items.append({"kind": "spelling", "scope": f"act:{k}", "tracks": ids, "code": c.doubt,
                               "question": f"Πώς γράφεται το όνομα «{c.spelling}»;", "options": opts})
    # N19: a qualifier act («Neutralizer (A)») whose plain name is also an act raises one same_act question
    for k in sorted(used):
        c = chosen.get(k)
        if not c:
            continue
        m = re.match(r"^(.*\S)\s*[(\[]([A-Z]{1,3})[)\]]$", c.spelling)
        if m:
            plain = T.fold(m.group(1))
            if plain in used and plain != k and ("same_act", f"pair:{k}|{plain}") not in D:
                ids = sorted(tid for tid, r in results.items() if any(a.key in (k, plain) for a in r.acts))
                open_items.append({"kind": "same_act", "scope": f"pair:{k}|{plain}", "tracks": ids, "code": "N19",
                                   "question": f"Είναι το «{c.spelling}» ο ίδιος καλλιτέχνης με το «{chosen[plain].spelling}»;",
                                   "options": ["A=όχι, διαφορετικοί", "B=ναι, ο ίδιος"]})
    open_items.sort(key=lambda x: (x["kind"], x["scope"]))
    return Resolution(RULESET, results, act_rows, album_rows, open_items, look_items)


def _punctuation_only(s: Step) -> Step:
    """names-6: a D3 step that removed no word (only punctuation or symbols) is a D2 tidy-up, and says so."""
    words = lambda x: [T.fold(w) for w in re.findall(r"[^\W_]+", x or "")]  # noqa: E731
    if s.rule == "D3" and s.before != s.after and T.has_word(s.after) and words(s.before) == words(s.after):
        return Step("D2", s.field, s.before, s.after, s.evidence)
    return s


def _side(pair: str, fld: str) -> str:
    a, _, t = (pair or "").partition(" | ")
    return a if fld == "artist" else t


def _explains(s: Step, fld: str, prev: str) -> bool:
    """A step explains a change of this field from the value shown before when it acts on this field and starts from
    that value (case and spaces ignored), or when it is a field-wide rule (a pair reading that changes this side)."""
    if s.rule == "R0":
        return False
    if s.field == "pair":
        return _side(s.before, fld) != _side(s.after, fld) and T.fold(_side(s.before, fld)) == T.fold(prev)
    if s.field != fld:
        return False
    return T.fold(s.before) == T.fold(prev) or s.rule in ("C2", "C2k", "C3", "C4", "CH", "N5", "N2s", "N2c", "C5", "N15w",
                                                          "N28", "N30", "N19h")


def _n28(title: str, spell, known, casing=lambda n: "") -> tuple[str, list[str]]:
    """N28: an act named inside a title's version or feat. bracket takes its act's chosen spelling. Returns the title
    and each change as «old→new:rule» (names-6: the sentence says which name changed and why)."""
    out, changes = title, []
    for b in reversed(brackets(title)):
        kind, data = bracket_kind(b.inner, b.closed)
        if kind not in ("version", "feat"):
            continue
        inner = b.inner
        for n in data.get("names", []):
            s = spell(n)
            if s != n and known(n) and T.fold(s) == T.fold(n):
                inner = inner.replace(n, s, 1)
                changes.append(f"{n}→{s}:{casing(n)}")
        if inner != b.inner and not any(c.islower() for c in b.inner):
            # names-7: in a bracket written all in capitals, the version word (and any other word of 4 or more
            # capitals) goes with the re-spelled act: «(GLASSY TIDO REMIX)» → «(Glassy Tido Remix)», never «(Glassy Tido
            # REMIX)»; an abbreviation («RMX», «VIP») stays
            def role(m: re.Match[str]) -> str:
                changes.append(f"{m.group()}→{m.group().capitalize()}:role")
                return m.group().capitalize()
            done = {T.fold(x) for x in data.get("names", [])}
            inner = re.sub(r"\b[A-Z]{4,}\b|" + ROLE_CAPS_RE.pattern,
                           lambda m: m.group() if T.fold(m.group()) in done else role(m), inner)
        if inner != b.inner:
            out = out[:b.start + 1] + inner + out[b.start + 1 + len(b.inner):]
    return out, sorted(changes)


def _question(code: str) -> str:
    return {
        "U1": "Ποιο πεδίο είναι ο καλλιτέχνης;",
        "U2": "Ποιος είναι ο καλλιτέχνης; (το πεδίο καλλιτέχνη έχει τον τίτλο)",
        "U3": "Ο τίτλος ξεκινά με άλλον καλλιτέχνη: ποιος είναι ο σωστός;",
        "U6": "Πώς πρέπει να διαβαστεί αυτό το κομμάτι;",
        "U8": "Η παρένθεση δεν κλείνει: πώς πρέπει να διαβαστεί;",
        "U10": "Το όνομα είναι δισκογραφική ή κανάλι: ποιος είναι ο καλλιτέχνης;",
        "U12": "Το όνομα ξεκινά με «and», «vs» ή «with»: ποιος είναι ο πρώτος καλλιτέχνης;",
        "U13": "Ο τίτλος είχε μόνο tempo: ποιος είναι ο τίτλος;",
    }.get(code, "Πώς πρέπει να διαβαστεί αυτό το κομμάτι;")


__all__ = ["resolve", "index_decisions", "UNKNOWN_ARTIST"]
