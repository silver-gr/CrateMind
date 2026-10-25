"""Transparent next-track recommender.

Not "AI". A clear weighted scorer that always shows WHY a track was suggested.
Every candidate returns a list of positive/negative reason strings.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from sqlmodel import Session, select

from ..models import Track, TrackDJProfile, TrackPairNote
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

    @property
    def is_bridge(self) -> bool:
        return self.next_bpm is not None or self.next_key is not None


def to_camelot(key_text: Optional[str]) -> Optional[str]:
    code = normalized_camelot(key_text)
    return code.lower() if code else None


def effective_key(track: Track) -> Optional[str]:
    """Tag key when present, else the analyzed estimate."""
    return effective_key_text(track.key_text, track.key_analyzed)


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
    if cand_bpm is None or target is None:
        return 0.0, None
    diff = abs(cand_bpm - target)
    if diff <= 1:
        return 10.0, f"BPM close: {target:g}->{cand_bpm:g}"
    if diff <= 3:
        return 6.0, f"BPM near: {target:g}->{cand_bpm:g}"
    if diff <= 6:
        return 2.0, f"BPM reachable: {target:g}->{cand_bpm:g}"
    return -4.0, f"BPM far: {target:g}->{cand_bpm:g}"


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


def _score(track: Track, prof: Optional[TrackDJProfile], ctx: Context) -> tuple[float, list[str]]:
    reasons: list[str] = []
    score = 0.0
    w = ctx.weights

    s, r = bpm_fit(effective_bpm(track), ctx.target_bpm or ctx.previous_bpm)
    score += s * w.bpm
    if r:
        reasons.append(("+ " if s >= 0 else "- ") + r)

    s, r = key_fit(ctx.previous_key, effective_key(track))
    score += s * w.key
    if r:
        reasons.append(("+ " if s >= 0 else "- ") + r)

    # bridge: candidate must also LEAD INTO the next track (Track B)
    if ctx.is_bridge:
        s, r = bpm_fit(effective_bpm(track), ctx.next_bpm)
        score += s * w.bpm
        if r:
            reasons.append(("+ " if s >= 0 else "- ") + "→ into B " + r)
        s, r = key_fit(effective_key(track), ctx.next_key)
        score += s * w.key
        if r:
            reasons.append(("+ " if s >= 0 else "- ") + "→ into B " + r)

    energy = prof.energy if prof else None
    s, r = energy_fit(energy, ctx.target_energy)
    score += s * w.energy
    if r:
        reasons.append(("+ " if s >= 0 else "- ") + r)

    if ctx.target_role and prof and prof.set_role:
        if ctx.target_role.lower() in prof.set_role.lower():
            score += 8 * w.role
            reasons.append(f"+ role match: {ctx.target_role}")

    status = prof.personal_status if prof else "unknown"
    if status == "weapon":
        score += 12
        reasons.append("+ weapon")
    elif status == "approved":
        score += 8
        reasons.append("+ approved")
    elif status == "testing":
        score += 2
        reasons.append("+ testing")

    if ctx.need_bridge and prof and prof.transition_role and "bridge" in prof.transition_role.lower():
        score += 10
        reasons.append("+ bridge candidate")

    if prof and prof.tempo_bridge_score:
        score += prof.tempo_bridge_score * 0.5
        reasons.append(f"+ tempo bridge score {prof.tempo_bridge_score}")

    # freshness vs recently played
    if track.id in ctx.recently_played_ids:
        score -= 8
        reasons.append("- played recently")
    elif track.play_count == 0:
        score += 2
        reasons.append("+ fresh (never played)")

    weird = prof.weirdness if prof else None
    if weird is not None and ctx.max_weirdness is not None and weird > ctx.max_weirdness:
        score -= 10
        reasons.append(f"- weirdness {weird} > max {ctx.max_weirdness}")

    return score, reasons


def _pair_note_maps(session: Session, ctx: Context):
    """Pre-fetch transition memory for the A→candidate and candidate→B legs."""
    from_a: dict[int, TrackPairNote] = {}
    to_b: dict[int, TrackPairNote] = {}
    if ctx.after_track_id is not None:
        for n in session.exec(
            select(TrackPairNote).where(TrackPairNote.from_track_id == ctx.after_track_id)
        ).all():
            from_a[n.to_track_id] = n
    if ctx.before_track_id is not None:
        for n in session.exec(
            select(TrackPairNote).where(TrackPairNote.to_track_id == ctx.before_track_id)
        ).all():
            to_b[n.from_track_id] = n
    return from_a, to_b


def _note_phrase(n: TrackPairNote, lead: str) -> str:
    bits = [lead]
    if n.transition_type:
        bits.append(n.transition_type)
    if n.rating is not None:
        bits.append(f"{n.rating}/5")
    return " ".join(bits)


def recommend(session: Session, ctx: Context, limit: int = 20) -> list[dict]:
    rows = session.exec(
        select(Track, TrackDJProfile).join(
            TrackDJProfile, TrackDJProfile.track_id == Track.id, isouter=True
        ).where(Track.missing == False)  # noqa: E712
    ).all()

    from_a, to_b = _pair_note_maps(session, ctx)

    results: list[dict] = []
    for track, prof in rows:
        if track.id in ctx.exclude_ids:
            continue
        status = prof.personal_status if prof else "unknown"
        if status in ("retired", "avoid"):
            continue
        if ctx.approved_only and status not in ("approved", "weapon"):
            continue
        score, reasons = _score(track, prof, ctx)

        # transition memory: did you note these pairings worked before?
        note_a = from_a.get(track.id)
        if note_a is not None:
            bonus = 6 + (note_a.rating or 0)
            score += bonus
            reasons.append("+ " + _note_phrase(note_a, "noted A→this worked:"))
        note_b = to_b.get(track.id)
        if note_b is not None:
            bonus = 6 + (note_b.rating or 0)
            score += bonus
            reasons.append("+ " + _note_phrase(note_b, "noted this→B worked:"))

        results.append({
            "track_id": track.id,
            "artist": track.artist,
            "title": track.title,
            "bpm": effective_bpm(track),
            "key": effective_key(track),
            "bpm_is_analyzed": bpm_source(track) not in (None, "metadata", "manual:metadata"),
            "key_is_analyzed": not (track.key_text and track.key_text.strip()) and bool(
                track.key_analyzed and track.key_analyzed.strip()
            ),
            "energy": prof.energy if prof else None,
            "set_role": prof.set_role if prof else None,
            "personal_status": status,
            "score": round(score, 2),
            "reasons": reasons,
        })

    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:limit]
