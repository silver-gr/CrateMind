"""Set story, batch 1: the reader. It turns an ordered set into chapters from tempo plateaus.

Pure and deterministic: rows in, numbers out; the frontend (`lib/setStory.ts`) writes the Greek.
The rules follow the prototype `.omc/research/set-story-2026-11-26/judge-prototype/proto2.py derive()`
rule for rule (plan `.omc/plans/2026-11-26-set-story.md`, section 3):

1. A track at double or half the set's median tempo (within 3%) is folded onto it.
2. A track 10% or more from both neighbours, which agree within 3%, is a parenthesis, set aside first.
3. A run continues while each step to the previous track is 3% or less; three or more tracks make a chapter.
4. Neighbouring runs of one or two tracks fuse into one wide («Περιπλάνηση») chapter.
5. A lone run of one or two joins the neighbour with the nearer median, which turns wide if over 6% away.
6. Neighbouring chapters of one kind whose medians are within 3% merge; above six, the closest pair merges.
7. A chapter's range is its tracks' lowest to highest tempo, widened to at least ±1.5% of its median.

Rows with no tempo are left out of the rules and belong to the chapter they sit in (or the one before).
"""
from __future__ import annotations

import statistics
from collections import Counter
from dataclasses import dataclass

STEP = 0.03            # a step inside a run, a blend, a merge, a tempo drift
VISIT = 0.10           # a parenthesis is this far from both neighbours
WIDE = 0.06            # a lone short run this far from its neighbour turns the chapter wide
PAD = 0.015            # a chapter's range is at least ±1.5% of its median
MAX_CHAPTERS = 6
JUMP = 0.20            # an entry over 20% is a jump («άλμα»), 3-20% a step («σκαλοπάτι»)
RATIO_TOL = 0.04       # a jump within 4% of 3:4 or 4:3
DRIFT_MIN_TRACKS = 8
DRIFT_LUFS = 1.0
DRIFT_BASS = 0.08
CRATE_SECONDS = 4 * 3600
_PLACEHOLDER_ARTISTS = {"unknown artist", "unknown", "various artists", "va", "misc"}


@dataclass(frozen=True)
class StoryRow:
    bpm: float | None = None
    duration: float | None = None       # seconds
    lufs: float | None = None
    bass_share: float | None = None     # share of the track's beats with the bass on, 0..1
    key: str | None = None              # Camelot, e.g. "8A"
    style: str | None = None
    artist: str | None = None


def _rel(a: float, b: float) -> float:
    return abs(a - b) / b


def _size(a: float, b: float) -> float:
    """A step's size either way: 200 → 146 and 146 → 200 are the same jump."""
    return max(a, b) / min(a, b) - 1


def _derive(b: list[float]) -> tuple[list[tuple[str, list[int]]], list[int]]:
    """Rules 2-6 on folded tempos; returns (kind, positions) chapters and the parentheses."""
    n = len(b)
    visit = [False] * n
    for i in range(1, n - 1):
        if (not visit[i - 1] and _rel(b[i], b[i - 1]) >= VISIT and _rel(b[i], b[i + 1]) >= VISIT
                and _rel(b[i + 1], b[i - 1]) <= STEP):
            visit[i] = True
    runs: list[list[int]] = []
    for i in range(n):
        if visit[i]:
            continue
        if runs and _rel(b[i], b[runs[-1][-1]]) <= STEP:
            runs[-1].append(i)
        else:
            runs.append([i])
    blocks: list[list] = []
    for r in runs:
        if len(r) < 3 and blocks and blocks[-1][0] == "w":
            blocks[-1][1].extend(r)
        else:
            blocks.append(["p" if len(r) >= 3 else "w", list(r)])

    def med(r: list[int]) -> float:
        return statistics.median(b[j] for j in r)

    ch: list[list] = []
    for k, (kind, r) in enumerate(blocks):
        if kind == "w" and len(r) < 3 and len(blocks) > 1:
            prev = ch[-1] if ch else None
            nxt = blocks[k + 1] if k + 1 < len(blocks) else None
            dp = _rel(med(r), med(prev[1])) if prev else 9.0
            dn = _rel(med(r), med(nxt[1])) if nxt else 9.0
            target = prev if (prev and dp <= dn) else nxt
            if target is prev:
                prev[1].extend(r)
            else:
                nxt[1][:0] = r
            if min(dp, dn) > WIDE:
                target[0] = "w"
        else:
            ch.append([kind, r])
    k = 0
    while k + 1 < len(ch):
        if ch[k][0] == ch[k + 1][0] and _rel(med(ch[k][1]), med(ch[k + 1][1])) <= STEP:
            ch[k][1].extend(ch[k + 1][1])
            del ch[k + 1]
        else:
            k += 1
    while len(ch) > MAX_CHAPTERS:
        k = min(range(len(ch) - 1), key=lambda k: _rel(med(ch[k][1]), med(ch[k + 1][1])))
        ch[k][1].extend(ch[k + 1][1])
        ch[k][0] = "w"
        del ch[k + 1]
    return [(kind, sorted(r)) for kind, r in ch], [i for i in range(n) if visit[i]]


def _enough(values: list, out_of: int) -> bool:
    return bool(values) and len(values) * 2 >= out_of


def _drift(rows: list[StoryRow], bpms: dict[int, float], members: list[int]) -> dict | None:
    """First third against last third of a long chapter: tempo by 3%, loudness by 1 dB, bass share by 0.08."""
    if len(members) < DRIFT_MIN_TRACKS:
        return None
    third = len(members) // 3
    head, tail = members[:third], members[-third:]
    out: dict[str, list[float] | None] = {"tempo": None, "lufs": None, "bass": None}
    for name, pick, mean, moved in (
        ("tempo", lambda i: bpms.get(i), statistics.median, lambda a, z: _rel(z, a) >= STEP),
        ("lufs", lambda i: rows[i].lufs, statistics.fmean, lambda a, z: abs(z - a) >= DRIFT_LUFS),
        ("bass", lambda i: rows[i].bass_share, statistics.fmean, lambda a, z: abs(z - a) >= DRIFT_BASS),
    ):
        a = [v for v in map(pick, head) if v is not None]
        z = [v for v in map(pick, tail) if v is not None]
        if _enough(a, len(head)) and _enough(z, len(tail)):
            start, end = mean(a), mean(z)
            if moved(start, end):
                out[name] = [round(start, 3), round(end, 3)]
    return out if any(out.values()) else None


def _lead(values: list[str], at_least_half: bool) -> dict | None:
    """The most common value when it says something: twice or more, and a majority or the clear top."""
    counts = Counter(values).most_common()
    if not counts or counts[0][1] < 2:
        return None
    name, count = counts[0]
    if at_least_half and count * 2 < len(values):
        return None
    if not at_least_half and len(counts) > 1 and counts[1][1] == count:
        return None
    return {"name": name, "count": count, "of": len(values)}


def read_story(rows: list[StoryRow]) -> dict:
    """The reading of an ordered set: chapters, parentheses and counted unknowns, as numbers."""
    n = len(rows)
    total = sum(r.duration or 0 for r in rows)
    reading = {
        "track_count": n,
        "seconds": round(total, 1),
        "crate": total > CRATE_SECONDS,
        "unknown": {"bpm": sum(not r.bpm for r in rows), "duration": sum(not r.duration for r in rows)},
        "folded": [],
        "chapters": [],
        "parentheses": [],
    }
    known = [i for i, r in enumerate(rows) if r.bpm]
    if not known:
        return reading
    m0 = statistics.median(rows[i].bpm for i in known)
    bpms: dict[int, float] = {}
    for i in known:
        x = rows[i].bpm
        if 1.94 <= x / m0 <= 2.06:
            x, folded = x / 2, True
        elif 0.485 <= x / m0 <= 0.515:
            x, folded = x * 2, True
        else:
            folded = False
        bpms[i] = x
        if folded:
            reading["folded"].append(i)
    folded_b = [bpms[i] for i in known]
    chapters, visits = _derive(folded_b)
    visit_rows = {known[j] for j in visits}

    starts = [0] + [known[positions[0]] for _, positions in chapters[1:]]
    ends = [s - 1 for s in starts[1:]] + [n - 1]
    chapter_of: dict[int, int] = {}
    prev_last: float | None = None
    prev_lufs: float | None = None
    for c, ((kind, positions), first, last) in enumerate(zip(chapters, starts, ends)):
        span = list(range(first, last + 1))
        for i in span:
            chapter_of[i] = c
        members = [i for i in span if i not in visit_rows]
        tempos = [bpms[known[j]] for j in positions]
        med = statistics.median(tempos)
        lufs = [rows[i].lufs for i in members if rows[i].lufs is not None]
        mean_lufs = round(statistics.fmean(lufs), 2) if _enough(lufs, len(members)) else None
        entry = None
        if prev_last is not None:
            to = tempos[0]
            size = _size(prev_last, to)
            ratio = to / prev_last
            entry = {
                "kind": "blend" if size <= STEP else "step" if size <= JUMP else "jump",
                "from_bpm": round(prev_last, 1),
                "to_bpm": round(to, 1),
                "three_four": size > JUMP and any(abs(ratio / r - 1) <= RATIO_TOL for r in (0.75, 4 / 3)),
            }
        artists = [rows[i].artist for i in members
                   if rows[i].artist and rows[i].artist.strip().casefold() not in _PLACEHOLDER_ARTISTS]
        repeated = Counter(artists).most_common(1)
        reading["chapters"].append({
            "kind": "plateau" if kind == "p" else "wander",
            "first_row": first,
            "last_row": last,
            "track_count": len(span),
            "start_seconds": round(sum(rows[i].duration or 0 for i in range(first)), 1),
            "seconds": round(sum(rows[i].duration or 0 for i in span), 1),
            "lo": round(min(min(tempos), med * (1 - PAD)), 1),
            "hi": round(max(max(tempos), med * (1 + PAD)), 1),
            "median": round(med, 1),
            "entry": entry,
            "lufs": mean_lufs,
            "lufs_change": round(mean_lufs - prev_lufs, 2) if mean_lufs is not None and prev_lufs is not None else None,
            "style": _lead([rows[i].style for i in members if rows[i].style], at_least_half=True),
            "key": _lead([rows[i].key.upper() for i in members if rows[i].key], at_least_half=False),
            "artist": {"name": repeated[0][0], "count": repeated[0][1]} if repeated and repeated[0][1] >= 2 else None,
            "unknown": {
                "bpm": sum(not rows[i].bpm for i in members),
                "lufs": sum(rows[i].lufs is None for i in members),
                "bass": sum(rows[i].bass_share is None for i in members),
                "key": sum(not rows[i].key for i in members),
                "style": sum(not rows[i].style for i in members),
            },
            "drift": _drift(rows, bpms, members),
        })
        prev_last = tempos[-1]
        prev_lufs = mean_lufs
    for j in visits:
        i = known[j]
        reading["parentheses"].append({
            "row": i,
            "chapter": chapter_of[i],
            "bpm": round(bpms[i], 1),
            "before_bpm": round(folded_b[j - 1], 1),
            "after_bpm": round(folded_b[j + 1], 1),
        })
    return reading
