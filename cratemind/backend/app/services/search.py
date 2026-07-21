"""Track search: field-filter mini-syntax + SQLite FTS5 free text.

Examples:
    energy:7-9 darkness:6-10 role:peak bpm:148-155 status:approved
    substyle:hitech weirdness:7+ confidence:4+
    mandragora status:approved -retired
"""
from __future__ import annotations

import re
import shlex
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlmodel import Session, select

from ..models import ArtistProfile, Track, TrackDJProfile

# numeric fields and where they live
_PROFILE_NUM = {
    "energy", "intensity", "darkness", "melody", "weirdness", "mixability",
    "confidence", "chaos_level", "tempo_bridge_score",
}
_TRACK_NUM = {"bpm", "year", "rating"}

# field alias -> (model, column, match_kind)
_STR_FIELDS: dict[str, tuple[str, str, str]] = {
    "role": ("profile", "set_role", "contains"),
    "transition": ("profile", "transition_role", "contains"),
    "substyle": ("profile", "psy_substyle", "contains"),
    "groove": ("profile", "groove_type", "contains"),
    "break": ("profile", "breakdown_profile", "contains"),
    "drop": ("profile", "drop_profile", "contains"),
    "bassline": ("profile", "bassline_type", "contains"),
    "lead": ("profile", "lead_character", "contains"),
    "festival": ("profile", "festival_time", "contains"),
    "crowd": ("profile", "crowd_risk", "contains"),
    "vocal": ("profile", "vocal_density", "contains"),
    "tolerance": ("profile", "bpm_jump_tolerance", "contains"),
    "status": ("profile", "personal_status", "exact"),
    "key": ("track", "key_text", "exact"),
    "genre": ("track", "genre", "contains"),
    "artist": ("track", "artist", "contains"),
    "label": ("track", "label", "contains"),
    "album": ("track", "album", "contains"),
    "artist_scene": ("artist", "scene_cluster", "contains"),
    "artist_subgenre": ("artist", "primary_subgenre", "contains"),
    "artist_confidence": ("artist", "confidence_label", "exact"),
    "artist_review": ("artist", "needs_review", "review"),
}

# bare boolean tokens
_STATUS_VALUES = {"unknown", "testing", "approved", "weapon", "retired", "avoid"}


def _parse_numeric(col: Any, raw: str):
    """Return a SQLAlchemy criterion for a numeric filter spec."""
    raw = raw.strip()
    if raw.endswith("+"):
        return col >= float(raw[:-1])
    if raw.endswith("-") and raw[:-1].replace(".", "", 1).isdigit():
        return col <= float(raw[:-1])
    m = re.match(r"^(-?\d+(?:\.\d+)?)-(-?\d+(?:\.\d+)?)$", raw)
    if m:
        return col.between(float(m.group(1)), float(m.group(2)))
    try:
        return col == float(raw)
    except ValueError:
        return None


def _build_query(session: Session, query: str):
    """Build the filtered SELECT (no order/limit). Returns None when the query
    provably matches nothing (e.g. a free-text term with zero FTS hits)."""
    try:
        tokens = shlex.split(query or "")
    except ValueError:
        tokens = (query or "").split()

    stmt = select(Track).join(
        TrackDJProfile, TrackDJProfile.track_id == Track.id, isouter=True
    ).join(
        ArtistProfile, ArtistProfile.normalized_name == Track.artist_normalized, isouter=True
    )
    free_terms: list[str] = []
    exclude_terms: list[str] = []

    for tok in tokens:
        neg = tok.startswith("-")
        body = tok[1:] if neg else tok

        if ":" in body:
            field, _, val = body.partition(":")
            field = field.lower()
            if field in _PROFILE_NUM:
                crit = _parse_numeric(getattr(TrackDJProfile, field), val)
                if crit is not None:
                    stmt = stmt.where(~crit if neg else crit)
                continue
            if field in _TRACK_NUM:
                crit = _parse_numeric(getattr(Track, field), val)
                if crit is not None:
                    stmt = stmt.where(~crit if neg else crit)
                continue
            if field in _STR_FIELDS:
                model, col_name, kind = _STR_FIELDS[field]
                col_model = (
                    TrackDJProfile if model == "profile"
                    else ArtistProfile if model == "artist"
                    else Track
                )
                col = getattr(col_model, col_name)
                if kind == "exact":
                    crit = col == val
                elif kind == "review":
                    truthy = val.lower() in {"1", "true", "yes", "needs_review", "review"}
                    crit = col == truthy
                    if not truthy:
                        # ArtistProfile is LEFT-joined; tracks with no profile
                        # have NULL needs_review. Count them as "not needing
                        # review" instead of silently dropping them.
                        crit = crit | col.is_(None)
                else:
                    crit = col.ilike(f"%{val}%")
                stmt = stmt.where(~crit if neg else crit)
                continue
            if field in ("not_recent", "played_recently"):
                try:
                    days = int(val)
                except ValueError:
                    continue
                cutoff = datetime.now(UTC) - timedelta(days=days)
                if field == "not_recent":
                    # never played OR last play older than N days
                    crit = (Track.last_played_at.is_(None)) | (Track.last_played_at < cutoff)
                else:
                    crit = (Track.last_played_at.is_not(None)) & (Track.last_played_at >= cutoff)
                stmt = stmt.where(~crit if neg else crit)
                continue
            # unknown field:value -> treat as free text
            (exclude_terms if neg else free_terms).append(val)
            continue

        low = body.lower()
        # bare boolean tokens
        if low == "untagged" and not neg:
            stmt = stmt.where(TrackDJProfile.track_id.is_(None))
            continue
        if low == "weapons":
            crit = TrackDJProfile.personal_status == "weapon"
            stmt = stmt.where(~crit if neg else crit)
            continue
        if low == "approved":
            crit = TrackDJProfile.personal_status == "approved"
            stmt = stmt.where(~crit if neg else crit)
            continue
        if low == "missing":
            stmt = stmt.where(Track.missing == (not neg))
            continue
        if low == "never_played":
            stmt = stmt.where(Track.play_count != 0 if neg else Track.play_count == 0)
            continue
        if low in ("dramatic", "dramatic_transition_candidate"):
            crit = TrackDJProfile.dramatic_transition_candidate == True  # noqa: E712
            stmt = stmt.where(~crit if neg else crit)
            continue
        if low == "can_cut_into":
            crit = TrackDJProfile.can_cut_into == True  # noqa: E712
            stmt = stmt.where(~crit if neg else crit)
            continue
        if low == "can_cut_out_of":
            crit = TrackDJProfile.can_cut_out_of == True  # noqa: E712
            stmt = stmt.where(~crit if neg else crit)
            continue
        if low in _STATUS_VALUES:
            crit = TrackDJProfile.personal_status == low
            stmt = stmt.where(~crit if neg else crit)
            continue

        (exclude_terms if neg else free_terms).append(body)

    # FTS for positive free-text terms
    if free_terms:
        match_expr = " ".join(f'"{t}"' for t in free_terms)
        rows = session.execute(
            text("SELECT rowid FROM track_search WHERE track_search MATCH :q"),
            {"q": match_expr},
        ).all()
        ids = [r[0] for r in rows]
        if not ids:
            return None
        stmt = stmt.where(Track.id.in_(ids))

    if exclude_terms:
        rows = session.execute(
            text(
                "SELECT rowid FROM track_search WHERE track_search MATCH :q"
            ),
            {"q": " OR ".join(f'"{t}"' for t in exclude_terms)},
        ).all()
        bad = [r[0] for r in rows]
        if bad:
            stmt = stmt.where(Track.id.notin_(bad))

    return stmt


def search(session: Session, query: str, limit: int = 500, offset: int = 0) -> list[Track]:
    stmt = _build_query(session, query)
    if stmt is None:
        return []
    stmt = stmt.order_by(Track.artist, Track.title).offset(offset)
    if limit and limit > 0:  # limit <= 0 means unbounded (e.g. tagging queue)
        stmt = stmt.limit(limit)
    return list(session.exec(stmt).all())


def count(session: Session, query: str) -> int:
    """Count matches for a query without materialising rows — used by the
    dashboard review-queue cards and Memory Crate badges."""
    from sqlalchemy import func

    stmt = _build_query(session, query)
    if stmt is None:
        return 0
    total = session.execute(
        select(func.count()).select_from(stmt.subquery())
    ).scalar_one()
    return int(total)
