"""Bulk profile and tag edits in one transaction, audited per track as diffs.

Everything that can be refused is checked before the first write. The scope
is a list of track ids or a search query (resolved by subquery, never as a
bound id list); the request commits once and rolls back entirely on failure.
"""
from __future__ import annotations

from sqlmodel import Session, select

from .. import db as dbmod
from ..models import Track
from ..schemas import BatchProfileUpdate
from . import audit, facets, search
from .facets import FacetError, TagDiff
from .sql_ids import ids_in


def _scope_ids(session: Session, req: BatchProfileUpdate) -> list[int]:
    if req.query is not None:
        stmt = search._build_query(session, req.query).with_only_columns(Track.id).order_by(Track.id)
    else:
        stmt = select(Track.id).where(ids_in(Track.id, req.track_ids)).order_by(Track.id)
    return list(session.exec(stmt).all())


def run_batch(session: Session, req: BatchProfileUpdate) -> dict:
    from ..api.tracks import _apply_profile

    if bool(req.track_ids) == (req.query is not None):
        raise FacetError("invalid", "Δώσε είτε κομμάτια είτε αναζήτηση.")
    profile = req.profile.model_dump(exclude_unset=True) if req.profile is not None else {}
    tags_requested = bool(req.add_tag_ids or req.remove_tag_ids)
    if not profile and not tags_requested:
        raise FacetError("invalid", "Δεν ζητήθηκε καμία αλλαγή.")
    facets.validate_tag_ids(session, req.add_tag_ids, req.remove_tag_ids)

    ids = _scope_ids(session, req)
    replaced = 0
    if req.dry_run:
        for track_id in ids:
            if tags_requested:
                replaced += len(facets.plan_tag_changes(session, track_id, req.add_tag_ids, req.remove_tag_ids).replaced)
        return {"updated": 0, "matched": len(ids), "replaced": replaced, "dry_run": True}

    try:
        for track_id in ids:
            change = _apply_profile(session, track_id, req.profile, bulk=True) if profile else None
            diff = facets.apply_tag_changes(
                session, track_id, req.add_tag_ids, req.remove_tag_ids, commit=False, reindex=False,
            ) if tags_requested else TagDiff()
            replaced += len(diff.replaced)
            if change is None and not diff.changed:
                continue
            before, after = dict(change["before"]) if change else {}, dict(change["after"]) if change else {}
            if diff.removed or diff.replaced:
                before["tags_removed"] = diff.removed + diff.replaced
            if diff.added:
                after["tags_added"] = diff.added
            dbmod.reindex_track(session, track_id, commit=False)
            audit.log(session, "batch_update", "track", track_id, before, after, commit=False)
        session.commit()
    except Exception:
        session.rollback()
        raise
    return {"updated": len(ids), "matched": len(ids), "replaced": replaced, "dry_run": False}
