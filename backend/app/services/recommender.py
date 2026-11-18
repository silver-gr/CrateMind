"""Transparent next-track recommender.

Not "AI". A clear weighted scorer that always shows WHY a track was suggested.
Every candidate returns a list of positive/negative reason strings, a `match`
(0-100, musical fit only: tempo, key, style) and the rank score that also weighs
status, transition notes and recent plays.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Optional

from sqlmodel import Session, select

from ..artist_vocab import normalize_artist_genre
from ..models import (
    ArtistProfile, DuplicateGroup, DuplicateGroupTrack, PlayEvent, Track, TrackDJProfile, TrackPairNote,
)
from .musical_key import effective_key as effective_key_text, to_camelot as normalized_camelot
from .tempo import bpm_source, effective_bpm

@dataclass
class Weights:
    bpm: float = 1.0
    energy: float = 1.0
    key: float = 1.0
    role: float = 1.0


@dataclass
class Context:
    previous_key: Optional[str] = None
    previous_bpm: Optional[float] = None
    # bridge target — the track the candidate must LEAD INTO (Track B)
    next_key: Optional[str] = None
    next_bpm: Optional[float] = None
    after_track_id: Optional[int] = None
    before_track_id: Optional[int] = None
    target_bpm: Optional[float] = None
    target_energy: Optional[int] = None
    target_role: Optional[str] = None
    max_weirdness: Optional[int] = None
    approved_only: bool = False
    need_bridge: bool = False
    exclude_ids: set[int] = field(default_factory=set)
    recently_played_ids: set[int] = field(default_factory=set)
    weights: Weights = field(default_factory=Weights)
    # style of A and B (filled by build_context; tests may set them directly)
    previous_style: Optional[str] = None
    next_style: Optional[str] = None

    @property
    def is_bridge(self) -> bool:
        return self.before_track_id is not None or self.next_bpm is not None or self.next_key is not None


def to_camelot(key_text: Optional[str]) -> Optional[str]:
    code = normalized_camelot(key_text)
    return code.lower() if code else None


def effective_key(track: Track) -> Optional[str]:
    """Tag key when present, else djay's key, else the analyzed estimate."""
    return effective_key_text(track.key_text, track.key_djay, track.key_analyzed)


def key_fit(prev: Optional[str], cand: Optional[str]) -> tuple[float, Optional[str]]:
    a, b = to_camelot(prev), to_camelot(cand)
    if a is None or b is None:
        return 0.0, None
    if a == b:
        return 10.0, f"key match {b}"
    na, la = int(a[:-1]), a[-1]
    nb, lb = int(b[:-1]), b[-1]
    # adjacent on the wheel (same letter, +/-1 mod 12)
    if la == lb and (abs(na - nb) in (1, 11)):
        return 7.0, f"key adjacent {a}->{b}"
    # relative major/minor (same number, different letter)
    if na == nb and la != lb:
        return 6.0, f"key relative {a}->{b}"
    return -3.0, f"key clash {a}->{b}"


def bpm_fit(cand_bpm: Optional[float], target: Optional[float]) -> tuple[float, Optional[str]]:
    """Continuous tempo fit on the relative difference: 0% -> 10, 2% -> 5, 4% -> 0, >=5.6% -> -4."""
    if cand_bpm is None or target is None or cand_bpm <= 0 or target <= 0:
        return 0.0, None
    d = abs(cand_bpm - target) / target
    score = 10.0 * max(-0.4, 1.0 - d / 0.04)
    word = "close" if d <= 0.01 else "near" if d <= 0.025 else "reachable" if d <= 0.04 else "far"
    return score, f"BPM {word}: {target:g}->{cand_bpm:g}"


def energy_fit(cand_e: Optional[int], target: Optional[int]) -> tuple[float, Optional[str]]:
    if cand_e is None or target is None:
        return 0.0, None
    diff = abs(cand_e - target)
    if diff == 0:
        return 8.0, f"energy on target: {target}"
    if diff == 1:
        return 5.0, f"energy near: {cand_e} vs {target}"
    if diff == 2:
        return 1.0, f"energy ok: {cand_e} vs {target}"
    return -3.0, f"energy off: {cand_e} vs {target}"


# Style: a track's genre on a ladder from chill to psycore; neighbours mix, far rungs rarely do.
_CHILL = {"chill", "chillout", "chill out", "psychill", "psybient", "downtempo", "ambient", "psy chill"}
STYLE_RUNG = {
    "Psydub": 0, "Chill": 0, "Prog-psy": 1, "Zenonesque": 1, "Goa Trance": 2, "Full-On": 3,
    "Morning Full-On": 3, "Night Full-On": 4, "Twilight": 4, "Darkpsy": 5, "Forest": 5, "Hi-Tech": 6, "Psycore": 7,
}


def normalize_style(value: Optional[str]) -> Optional[str]:
    if not isinstance(value, str) or not value.strip():
        return None
    genre = normalize_artist_genre(value)
    if genre:
        return genre
    return "Chill" if " ".join(value.casefold().replace("-", " ").split()) in _CHILL else None


def track_style(track: Track, prof: Optional[TrackDJProfile], artist_genre: Optional[str]) -> Optional[str]:
    """The track's own substyle first, then its artist's researched genre, then the file's genre tag."""
    for value in (prof.psy_substyle if prof else None, artist_genre, track.genre):
        style = normalize_style(value)
        if style:
            return style
    return None


def style_fit(a: Optional[str], b: Optional[str]) -> tuple[float, Optional[str]]:
    if a is None or b is None:
        return 0.0, None
    if a == b:
        return 8.0, f"style match {b}"
    gap = abs(STYLE_RUNG[a] - STYLE_RUNG[b])
    if gap == 0:
        return 6.0, f"style near {a}->{b}"
    if gap == 1:
        return 3.0, f"style near {a}->{b}"
    return 0.0, None  # two or more rungs apart: no bonus (a penalty measured worse)


def _signed(score: float, text: str) -> str:
    return ("- " if score < 0 else "+ ") + text


def _credit(score: float, best: float, known: bool) -> float:
    """One match axis as 0..1; a candidate that lacks the value gets a little credit, not half."""
    return max(0.0, min(1.0, score / best)) if known else 0.25


def _score(track: Track, prof: Optional[TrackDJProfile], ctx: Context,
           style: Optional[str] = None) -> tuple[float, list[str], Optional[int], Optional[float]]:
    """(rank score, reasons, match 0-100 or None, tempo distance for ordering)."""
    reasons: list[str] = []
    score = 0.0
    w = ctx.weights
    axes: list[tuple[float, float]] = []  # (weight, credit) of each match axis the context can compare
    cand_bpm = effective_bpm(track)
    cand_key = effective_key(track)
    tempo_dist: Optional[float] = None

    # tempo: in bridge mode with both tempos and no explicit target, one axis at the A-B midpoint
    if ctx.is_bridge and ctx.target_bpm is None and ctx.previous_bpm and ctx.next_bpm:
        mid = (ctx.previous_bpm + ctx.next_bpm) / 2
        s, _ = bpm_fit(cand_bpm, mid)
        s *= 1.5
        score += s * w.bpm
        if cand_bpm:
            tempo_dist = abs(cand_bpm - mid)
            text = "between A and B" if s >= 0 else "off the A-B path"
            reasons.append(_signed(s, f"BPM {text}: {ctx.previous_bpm:g}->{cand_bpm:g}->{ctx.next_bpm:g}"))
        axes.append((10.0, _credit(s, 15.0, cand_bpm is not None)))
    else:
        target = ctx.target_bpm or ctx.previous_bpm
        into_b = target is None and ctx.next_bpm is not None
        target = target or ctx.next_bpm
        s, r = bpm_fit(cand_bpm, target)
        score += s * w.bpm
        if r:
            tempo_dist = abs(cand_bpm - target)
            reasons.append(_signed(s, ("→ into B " if into_b else "") + r))
        if target:
            axes.append((10.0, _credit(s, 10.0, cand_bpm is not None)))

    s, r = key_fit(ctx.previous_key, cand_key)
    score += s * w.key
    if r:
        reasons.append(_signed(s, r))
    if to_camelot(ctx.previous_key):
        axes.append((10.0, _credit(s, 10.0, to_camelot(cand_key) is not None)))
    s, r = style_fit(ctx.previous_style, style)
    score += s
    if r:
        reasons.append(_signed(s, r))
    if ctx.previous_style:
        axes.append((8.0, _credit(s, 8.0, style is not None)))

    # bridge: the candidate must also LEAD INTO Track B (key and style per leg)
    if ctx.is_bridge:
        s, r = key_fit(cand_key, ctx.next_key)
        score += s * w.key
        if r:
            reasons.append(_signed(s, "→ into B " + r))
        if to_camelot(ctx.next_key):
            axes.append((10.0, _credit(s, 10.0, to_camelot(cand_key) is not None)))
        s, r = style_fit(style, ctx.next_style)
        score += s
        if r:
            reasons.append(_signed(s, "→ into B " + r))
        if ctx.next_style:
            axes.append((8.0, _credit(s, 8.0, style is not None)))

    energy = prof.energy if prof else None
    s, r = energy_fit(energy, ctx.target_energy)
    score += s * w.energy
    if r:
        reasons.append(_signed(s, r))

    if ctx.target_role and prof and prof.set_role:
        if ctx.target_role.lower() in prof.set_role.lower():
            score += 8 * w.role
            reasons.append(f"+ role match: {ctx.target_role}")

    # status is a quality prior; the card's badge shows it, so it adds no reason line
    status = prof.personal_status if prof else "unknown"
    score += {"weapon": 12, "approved": 8, "testing": 2}.get(status, 0)

    if ctx.need_bridge and prof and prof.transition_role and "bridge" in prof.transition_role.lower():
        score += 10
        reasons.append("+ bridge candidate")

    if prof and prof.tempo_bridge_score:
        score += prof.tempo_bridge_score * 0.5
        reasons.append(f"+ tempo bridge score {prof.tempo_bridge_score}")

    if track.id in ctx.recently_played_ids:
        score -= 8
        reasons.append("- played recently")

    weird = prof.weirdness if prof else None
    if weird is not None and ctx.max_weirdness is not None and weird > ctx.max_weirdness:
        score -= 10
        reasons.append(f"- weirdness {weird} > max {ctx.max_weirdness}")

    total = sum(weight for weight, _ in axes)
    match = round(100 * sum(weight * credit for weight, credit in axes) / total) if total else None
    return score, reasons, match, tempo_dist


def _pair_note_maps(session: Session, ctx: Context):
    """Pre-fetch transition memory for the A→candidate and candidate→B legs."""
    from_a: dict[int, TrackPairNote] = {}
    to_b: dict[int, TrackPairNote] = {}
    if ctx.after_track_id is not None:
        for n in session.exec(
            select(TrackPairNote).where(TrackPairNote.from_track_id == ctx.after_track_id)
        ).all():
            if n.to_track_id not in from_a or n.id > from_a[n.to_track_id].id:  # newest note per pair wins
                from_a[n.to_track_id] = n
    if ctx.before_track_id is not None:
        for n in session.exec(
            select(TrackPairNote).where(TrackPairNote.to_track_id == ctx.before_track_id)
        ).all():
            if n.from_track_id not in to_b or n.id > to_b[n.from_track_id].id:
                to_b[n.from_track_id] = n
    return from_a, to_b


def _note_delta(n: TrackPairNote) -> float:
    """Transition memory: a rating of 3+ boosts as before, a clash (rating <= 2) subtracts, no rating keeps the plain boost."""
    if n.rating is None:
        return 6
    return 6 + n.rating if n.rating >= 3 else -(6 + (3 - n.rating))


def _note_phrase(n: TrackPairNote, lead: str) -> str:
    bits = [lead]
    if n.transition_type:
        bits.append(n.transition_type)
    if n.rating is not None:
        bits.append(f"{n.rating}/5")
    return " ".join(bits)


ACTIVE_DUPLICATE_ROLES = {None, "master", "duplicate"}


def duplicate_groups(session: Session) -> dict[int, set[int]]:
    """track id -> ids of its open duplicate groups (roles that still mean "same file"; ignored groups never)."""
    groups: dict[int, set[int]] = {}
    rows = session.exec(
        select(DuplicateGroupTrack.track_id, DuplicateGroupTrack.group_id, DuplicateGroupTrack.role)
        .join(DuplicateGroup, DuplicateGroup.id == DuplicateGroupTrack.group_id)
        .where(DuplicateGroup.status != "ignored")
    ).all()
    for track_id, group_id, role in rows:
        if role in ACTIVE_DUPLICATE_ROLES:
            groups.setdefault(track_id, set()).add(group_id)
    return groups


def artist_genre(session: Session, track: Optional[Track]) -> Optional[str]:
    if track is None or not track.artist_normalized:
        return None
    profile = session.exec(
        select(ArtistProfile).where(ArtistProfile.normalized_name == track.artist_normalized)
    ).first()
    return profile.primary_subgenre if profile else None


def style_of(session: Session, track: Optional[Track]) -> Optional[str]:
    if track is None:
        return None
    return track_style(track, session.get(TrackDJProfile, track.id), artist_genre(session, track))


def build_context(session: Session, after: Optional[Track], before: Optional[Track] = None, *,
                  exclude_ids=(), target_bpm: Optional[float] = None, target_energy: Optional[int] = None,
                  target_role: Optional[str] = None, max_weirdness: Optional[int] = None,
                  approved_only: bool = False, need_bridge: bool = False,
                  recent_days: Optional[int] = 30) -> Context:
    """The one context both routes (and the offline evaluation) score with. Without an explicit
    target_bpm the scorer aims at A's tempo, or the A-B midpoint in bridge mode."""
    recent: set[int] = set()
    if recent_days:
        cutoff = datetime.now(UTC) - timedelta(days=recent_days)
        recent = set(session.exec(select(PlayEvent.track_id).where(PlayEvent.played_at >= cutoff)).all())
    return Context(
        previous_key=effective_key(after) if after else None,
        previous_bpm=effective_bpm(after) if after else None,
        next_key=effective_key(before) if before else None,
        next_bpm=effective_bpm(before) if before else None,
        after_track_id=after.id if after else None,
        before_track_id=before.id if before else None,
        target_bpm=target_bpm,
        target_energy=target_energy,
        target_role=target_role,
        max_weirdness=max_weirdness,
        approved_only=approved_only,
        need_bridge=need_bridge or before is not None,
        exclude_ids=set(exclude_ids),
        recently_played_ids=recent,
        previous_style=style_of(session, after),
        next_style=style_of(session, before),
    )


def recommend(session: Session, ctx: Context, limit: int = 20) -> list[dict]:
    rows = session.exec(
        select(Track, TrackDJProfile, ArtistProfile.primary_subgenre)
        .join(TrackDJProfile, TrackDJProfile.track_id == Track.id, isouter=True)
        .join(ArtistProfile, ArtistProfile.normalized_name == Track.artist_normalized, isouter=True)
        .where(Track.missing == False)  # noqa: E712
    ).all()

    from_a, to_b = _pair_note_maps(session, ctx)

    # A, B and everything excluded take their open duplicate copies with them.
    groups = duplicate_groups(session)
    excluded = set(ctx.exclude_ids) | {i for i in (ctx.after_track_id, ctx.before_track_id) if i is not None}
    excluded_groups = set().union(*(groups.get(i, set()) for i in excluded))

    results: list[dict] = []
    for track, prof, genre in rows:
        if track.id in excluded or groups.get(track.id, set()) & excluded_groups:
            continue
        status = prof.personal_status if prof else "unknown"
        if status in ("retired", "avoid"):
            continue
        if ctx.approved_only and status not in ("approved", "weapon"):
            continue
        style = track_style(track, prof, genre)
        score, reasons, match, tempo_dist = _score(track, prof, ctx, style)

        # transition memory: did you note these pairings worked before?
        note_a = from_a.get(track.id)
        if note_a is not None:
            delta = _note_delta(note_a)
            score += delta
            reasons.append("+ " + _note_phrase(note_a, "noted A→this worked:") if delta > 0
                           else "- σημειώθηκε ότι η μετάβαση A→αυτό δεν δούλεψε")
        note_b = to_b.get(track.id)
        if note_b is not None:
            delta = _note_delta(note_b)
            score += delta
            reasons.append("+ " + _note_phrase(note_b, "noted this→B worked:") if delta > 0
                           else "- σημειώθηκε ότι η μετάβαση αυτό→B δεν δούλεψε")

        bpm = effective_bpm(track)
        results.append({
            "track_id": track.id,
            "artist": track.artist,
            "title": track.title,
            "bpm": bpm,
            "key": effective_key(track),
            "bpm_is_analyzed": bool(bpm_source(track) and not bpm_source(track).startswith(("metadata", "manual:metadata"))),
            "key_is_analyzed": not (track.key_text and track.key_text.strip()) and bool(effective_key(track)),
            "energy": prof.energy if prof else None,
            "set_role": prof.set_role if prof else None,
            "personal_status": status,
            "style": style,
            "bpm_delta_pct": round((bpm - ctx.previous_bpm) / ctx.previous_bpm * 100, 1)
            if bpm and ctx.previous_bpm else None,
            "match": match,
            "score": round(score, 2),
            "reasons": reasons,
            "_order": (-score, -(match if match is not None else -1),
                       tempo_dist if tempo_dist is not None else float("inf"), track.id),
        })

    results.sort(key=lambda r: r["_order"])
    picked: list[dict] = []
    seen_groups: set[int] = set()
    for row in results:  # one copy per open duplicate group: the best-ranked
        row_groups = groups.get(row["track_id"], set())
        if row_groups & seen_groups:
            continue
        seen_groups |= row_groups
        del row["_order"]
        picked.append(row)
        if len(picked) >= limit:
            break

    from .canonical_library import overlay
    overlay(picked, session)
    return picked
