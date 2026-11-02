"""Track search: field-filter mini-syntax + SQLite FTS5 free text.

Examples:
    energy:7-9 darkness:6-10 role:peak bpm:148-155 status:approved
    substyle:hitech weirdness:7+ confidence:4+
    mandragora status:approved -retired
"""
from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import false, func, literal_column, table, text, tuple_
from sqlmodel import Session, select

from ..models import ArtistProfile, Tag, Track, TrackDJProfile, TrackTag
from . import facets
from .canonical_library import search_ids
from .musical_key import to_camelot
from .query_grammar import tokenize
from .sql_ids import ids_in
from .text_fold import fold_text

# numeric fields and where they live
_PROFILE_NUM = {
    "energy", "intensity", "darkness", "melody", "weirdness", "mixability",
    "confidence", "chaos_level", "tempo_bridge_score", "valence",
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


def _date_criterion(field: str, value: str):
    """UTC dates: N/Nd days, age range N-M days, or inclusive YYYY-MM-DD..YYYY-MM-DD.

    added is catalog import time; created is the stored filesystem birth/ctime.
    Invalid ranges match nothing rather than silently broadening a search.
    """
    from sqlalchemy import false
    col = Track.imported_at if field == "added" else Track.created_time
    now = datetime.now(UTC)
    try:
        if re.fullmatch(r"\d+d?", value):
            days = int(value.rstrip("d"))
            start, end = now - timedelta(days=days), now
            inclusive = True
        elif re.fullmatch(r"\d+-\d+d?", value):
            low, high = map(int, value.rstrip("d").split("-"))
            if low > high:
                return false()
            start, end = now - timedelta(days=high), now - timedelta(days=low)
            inclusive = True
        else:
            dates = value.split("..")
            if len(dates) == 1:
                dates *= 2
            if len(dates) != 2 or not all(re.fullmatch(r"\d{4}-\d{2}-\d{2}", d) for d in dates):
                return false()
            start, last = (datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=UTC) for d in dates)
            if start > last:
                return false()
            end = last + timedelta(days=1)
            inclusive = False
    except (ValueError, OverflowError):
        return false()
    if field == "created":
        start, end = start.timestamp(), end.timestamp()
    return col.is_not(None) & (col >= start) & ((col <= end) if inclusive else (col < end))


_LOCAL_TOKENS = {"remote_only", "local_playable", "missing_file", "soundcloud_like", "spotify_like"}


def _negate(crit, neg: bool):
    return ~crit if neg else crit


# --- field:value compilers -------------------------------------------------
# Each takes (session, field, val) and returns a criterion, or None to skip the
# token entirely (invalid value). The caller applies negation.

def _compile_date(session: Session, field: str, val: str):
    return _date_criterion(field, val)


def _compile_profile_num(session: Session, field: str, val: str):
    return _parse_numeric(getattr(TrackDJProfile, field), val)


def _compile_track_num(session: Session, field: str, val: str):
    if field == "bpm":
        col = func.cratemind_bpm(
            Track.bpm, Track.bpm_analyzed, Track.bpm_consensus, Track.bpm_consensus_sources,
            Track.artist, Track.title,
        )
        crit = _parse_numeric(col, val)
        # An unavailable BPM never matches a positive filter; negation includes
        # it, like negating a key filter, rather than dropping SQL NULL rows.
        return func.coalesce(crit, False) if crit is not None else None
    return _parse_numeric(getattr(Track, field), val)


def _compile_str(session: Session, field: str, val: str):
    model, col_name, kind = _STR_FIELDS[field]
    col_model = (
        TrackDJProfile if model == "profile"
        else ArtistProfile if model == "artist"
        else Track
    )
    col = getattr(col_model, col_name)
    if kind == "exact":
        # `status:approved,weapon` matches either value (the grammar has no OR).
        values = [v for v in val.split(",") if v]
        crit = col.in_(values) if len(values) > 1 else col == val
    elif kind == "review":
        truthy = val.lower() in {"1", "true", "yes", "needs_review", "review"}
        crit = col == truthy
        if not truthy:
            # ArtistProfile is LEFT-joined; tracks with no profile
            # have NULL needs_review. Count them as "not needing
            # review" instead of silently dropping them.
            crit = crit | col.is_(None)
    else:
        crit = func.instr(func.cratemind_fold(col), fold_text(val)) > 0
    if field in {"artist", "album"}:
        crit = crit | ids_in(Track.id, search_ids([val], field=field, session=session))
    return crit


def _compile_key(session: Session, field: str, val: str):
    code = to_camelot(val)
    if code is None:
        return false()
    # COALESCE makes negation include tracks with absent or unknown keys.
    return func.coalesce(func.cratemind_key(Track.key_text, Track.key_analyzed), "") == code


def _compile_recency(session: Session, field: str, val: str):
    try:
        days = int(val)
    except ValueError:
        return None
    cutoff = datetime.now(UTC) - timedelta(days=days)
    if field == "not_recent":
        # never played OR last play older than N days
        return (Track.last_played_at.is_(None)) | (Track.last_played_at < cutoff)
    return (Track.last_played_at.is_not(None)) & (Track.last_played_at >= cutoff)


def _compile_folder(session: Session, field: str, val: str):
    """Folded substring of the path, with backslashes as slashes on both sides."""
    path = func.cratemind_fold(func.replace(Track.absolute_path, "\\", "/"))
    return func.instr(path, fold_text(val.replace("\\", "/"))) > 0


def _compile_facet(session: Session, facet, val: str):
    """`key:*` = has any value of the vocabulary; `key:value` = folded value match."""
    if val == "*":
        prefix = f"{facet.key}:"  # a value is category AND name prefix, as everywhere else
        return Track.id.in_(
            select(TrackTag.track_id).join(Tag, Tag.id == TrackTag.tag_id)
            .where(Tag.category == facet.key, func.substr(Tag.name, 1, len(prefix)) == prefix)
        )
    ids = facets.value_ids(session, facet, fold_text(val))
    return Track.id.in_(select(TrackTag.track_id).where(TrackTag.tag_id.in_(ids))) if ids else false()


def _field_compilers() -> dict[str, Any]:
    table: dict[str, Any] = {"added": _compile_date, "created": _compile_date}
    table.update(dict.fromkeys(_PROFILE_NUM, _compile_profile_num))
    table.update(dict.fromkeys(_TRACK_NUM, _compile_track_num))
    table.update(dict.fromkeys(_STR_FIELDS, _compile_str))
    table["key"] = _compile_key
    table["folder"] = _compile_folder
    table.update({"not_recent": _compile_recency, "played_recently": _compile_recency})
    return table


_FIELD_COMPILERS = _field_compilers()


# --- bare tokens -----------------------------------------------------------
# Each takes neg and returns the final (already negated) criterion, or None
# when the token should fall through to free text.

def _flag(crit):
    return lambda neg: _negate(crit, neg)


_BARE_TOKENS: dict[str, Any] = {
    "untagged": lambda neg: None if neg else TrackDJProfile.track_id.is_(None),
    "weapons": _flag(TrackDJProfile.personal_status == "weapon"),
    "approved": _flag(TrackDJProfile.personal_status == "approved"),
    "missing": lambda neg: Track.missing == (not neg),
    "never_played": lambda neg: Track.play_count != 0 if neg else Track.play_count == 0,
    "dramatic": _flag(TrackDJProfile.dramatic_transition_candidate == True),  # noqa: E712
    "dramatic_transition_candidate": _flag(TrackDJProfile.dramatic_transition_candidate == True),  # noqa: E712
    "can_cut_into": _flag(TrackDJProfile.can_cut_into == True),  # noqa: E712
    "can_cut_out_of": _flag(TrackDJProfile.can_cut_out_of == True),  # noqa: E712
}
_BARE_TOKENS.update({s: _flag(TrackDJProfile.personal_status == s) for s in _STATUS_VALUES if s not in _BARE_TOKENS})


def _fts(expr: str, name: str):
    """Rowids matching an FTS5 expression. No bound ids; each MATCH gets its own
    bind name (two `:q` binds in one statement collide)."""
    return select(literal_column("rowid")).select_from(table("track_search")).where(
        text(f"track_search MATCH :{name}").bindparams(**{name: expr})
    )


def _fts_terms(terms: list[str]) -> list[tuple[str, str]]:
    """(raw, folded-and-quoted) pairs; punctuation-only terms are dropped."""
    out = []
    for raw in terms:
        if any(char.isalnum() for char in raw):
            out.append((raw, fold_text(raw).replace('"', '""')))
    return out


def _apply_free_text(session: Session, stmt, free_terms: list[str], exclude_terms: list[str]):
    # The index is folded, so both inclusions and exclusions are folded too.
    include = _fts_terms(free_terms)
    if include:
        expr = " ".join(f'"{t}"*' for _raw, t in include)  # prefix match
        raw_terms = [raw for raw, _t in include]
        stmt = stmt.where(
            Track.id.in_(_fts(expr, "fts_include"))
            | ids_in(Track.id, search_ids(raw_terms, session=session))
        )

    exclude = _fts_terms(exclude_terms)
    if exclude:
        expr = " OR ".join(f'"{t}"' for _raw, t in exclude)  # exact
        # FTS only: the identity lookup matches substrings, which would make
        # `-relax` also drop «Relaxation Two».
        stmt = stmt.where(~Track.id.in_(_fts(expr, "fts_exclude")))

    return stmt


def _build_query(session: Session, query: str):
    """Build the filtered SELECT (no order/limit)."""
    stmt = select(Track).join(
        TrackDJProfile, TrackDJProfile.track_id == Track.id, isouter=True
    ).join(
        ArtistProfile, ArtistProfile.normalized_name == Track.artist_normalized, isouter=True
    )
    free_terms: list[str] = []
    exclude_terms: list[str] = []

    for tok in tokenize(query):
        neg = tok.neg
        body = f"{tok.field}:{tok.value}" if tok.field else tok.value

        if body in _LOCAL_TOKENS or body.startswith("collections:"):
            from .library_completeness import local_search_ids
            stmt = stmt.where(_negate(ids_in(Track.id, local_search_ids(session, body)), neg))
            continue

        if tok.field:
            field, val = tok.field.lower(), tok.value
            compile_field = _FIELD_COMPILERS.get(field)
            if compile_field is None:
                facet = facets.get_by_key(session, field)
                if facet is None:
                    # unknown field:value -> treat as free text
                    (exclude_terms if neg else free_terms).append(val)
                    continue
                stmt = stmt.where(_negate(_compile_facet(session, facet, val), neg))
                continue
            crit = compile_field(session, field, val)
            if crit is not None:
                stmt = stmt.where(_negate(crit, neg))
            continue

        compile_bare = _BARE_TOKENS.get(tok.value.lower())
        crit = compile_bare(neg) if compile_bare else None
        if crit is not None:
            stmt = stmt.where(crit)
            continue

        (exclude_terms if neg else free_terms).append(tok.value)

    return _apply_free_text(session, stmt, free_terms, exclude_terms)


# Listing order shared by search and the plain track list. `id` makes it total,
# so a (artist, title, id) position is a stable keyset cursor.
QUEUE_ORDER = (func.coalesce(Track.artist, ""), func.coalesce(Track.title, ""), Track.id)


def after_position(cursor: tuple[str, str, int]):
    """Rows strictly after a cursor position (SQLite row values). The cursor is
    a position, so it works even when that track no longer matches the query."""
    return tuple_(*QUEUE_ORDER) > tuple_(*cursor)


def search(session: Session, query: str, limit: int = 500, offset: int = 0,
           after: tuple[str, str, int] | None = None) -> list[Track]:
    stmt = _build_query(session, query)
    if stmt is None:
        return []
    if after is not None:
        stmt = stmt.where(after_position(after))
    stmt = stmt.order_by(*QUEUE_ORDER).offset(offset)
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
