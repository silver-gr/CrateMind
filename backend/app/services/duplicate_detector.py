"""Duplicate detection — builds review groups, never deletes or moves files.

Two passes:
  1. Exact: identical quick_hash → same bytes (highest confidence).
  2. Metadata suspect: normalised artist+title match with similar duration.
     Different remix / radio edit are flagged for HUMAN review, not resolved.
"""
from __future__ import annotations

import re
from collections import defaultdict

from sqlmodel import Session, delete, select

from ..models import DuplicateGroup, DuplicateGroupTrack, Track

_DUR_TOLERANCE = 5.0  # seconds — within this, "same recording" suspect


def normalize_title(artist: str | None, title: str | None) -> str:
    raw = f"{artist or ''} {title or ''}".lower()
    # strip bracketed qualifiers and bit-depth noise
    raw = re.sub(r"[\(\[].*?[\)\]]", " ", raw)
    raw = re.sub(r"\b(original mix|extended mix|radio edit|remaster(ed)?|\d+bit)\b", " ", raw)
    raw = re.sub(r"[^a-z0-9]+", " ", raw)
    return " ".join(raw.split())


def _clear_unreviewed(session: Session) -> None:
    """Remove previous auto-generated groups still needing review so a re-run is
    idempotent. Resolved/ignored groups (human decisions) are preserved."""
    stale = session.exec(
        select(DuplicateGroup).where(DuplicateGroup.status == "needs_review")
    ).all()
    stale_ids = [g.id for g in stale]
    if stale_ids:
        session.exec(
            delete(DuplicateGroupTrack).where(
                DuplicateGroupTrack.group_id.in_(stale_ids)  # type: ignore[attr-defined]
            )
        )
        session.exec(
            delete(DuplicateGroup).where(DuplicateGroup.id.in_(stale_ids))  # type: ignore[attr-defined]
        )
        session.commit()


def detect(session: Session) -> dict:
    _clear_unreviewed(session)
    tracks = session.exec(select(Track).where(Track.missing == False)).all()  # noqa: E712

    grouped_track_ids: set[int] = set()
    created = {"exact": 0, "metadata": 0}

    # --- exact byte duplicates ---
    by_hash: dict[str, list[Track]] = defaultdict(list)
    for tr in tracks:
        if tr.quick_hash:
            by_hash[tr.quick_hash].append(tr)
    for h, members in by_hash.items():
        if len(members) < 2:
            continue
        group = DuplicateGroup(reason="exact: identical quick_hash")
        session.add(group)
        session.commit()
        session.refresh(group)
        for tr in members:
            session.add(DuplicateGroupTrack(group_id=group.id, track_id=tr.id))
            grouped_track_ids.add(tr.id)
        session.commit()
        created["exact"] += 1

    # --- metadata suspects (same normalised artist/title, similar duration) ---
    by_norm: dict[str, list[Track]] = defaultdict(list)
    for tr in tracks:
        if tr.id in grouped_track_ids:
            continue
        norm = normalize_title(tr.artist, tr.title)
        if norm:
            by_norm[norm].append(tr)

    for norm, members in by_norm.items():
        if len(members) < 2:
            continue
        # split into duration-similar clusters so radio edit vs extended don't
        # auto-merge: cluster only those within tolerance of each other
        members.sort(key=lambda t: (t.duration or 0))
        clusters: list[list[Track]] = []
        for tr in members:
            placed = False
            for cl in clusters:
                base = cl[0].duration
                if base is None or tr.duration is None:
                    continue
                if abs((tr.duration or 0) - base) <= _DUR_TOLERANCE:
                    cl.append(tr)
                    placed = True
                    break
            if not placed:
                clusters.append([tr])
        for cl in clusters:
            if len(cl) < 2:
                continue
            group = DuplicateGroup(
                reason="metadata: same artist/title, similar duration — review"
            )
            session.add(group)
            session.commit()
            session.refresh(group)
            for tr in cl:
                session.add(DuplicateGroupTrack(group_id=group.id, track_id=tr.id))
                grouped_track_ids.add(tr.id)
            session.commit()
            created["metadata"] += 1

    return {
        "groups_created": created["exact"] + created["metadata"],
        "exact_groups": created["exact"],
        "metadata_groups": created["metadata"],
    }
