"""Memory Crates — saved smart searches that re-run live over your tags."""
from __future__ import annotations

from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..db import get_session
from ..models import SavedSearch
from ..schemas import SavedSearchCreate, SavedSearchUpdate
from ..services import search

router = APIRouter(prefix="/searches", tags=["searches"])


def _payload(session: Session, s: SavedSearch) -> dict:
    return {**s.model_dump(mode="json"), "count": search.count(session, s.query)}


@router.get("")
def list_searches(session: Session = Depends(get_session)):
    rows = session.exec(
        select(SavedSearch).order_by(SavedSearch.sort_order, SavedSearch.name)
    ).all()
    return [_payload(session, s) for s in rows]


@router.post("")
def create_search(req: SavedSearchCreate, session: Session = Depends(get_session)):
    s = SavedSearch(**req.model_dump())
    session.add(s)
    session.commit()
    session.refresh(s)
    return _payload(session, s)


@router.patch("/{search_id}")
def update_search(search_id: int, req: SavedSearchUpdate, session: Session = Depends(get_session)):
    s = session.get(SavedSearch, search_id)
    if s is None:
        raise HTTPException(404, "saved search not found")
    for k, v in req.model_dump(exclude_unset=True).items():
        setattr(s, k, v)
    s.updated_at = datetime.now(UTC)
    session.add(s)
    session.commit()
    session.refresh(s)
    return _payload(session, s)


@router.delete("/{search_id}")
def delete_search(search_id: int, session: Session = Depends(get_session)):
    s = session.get(SavedSearch, search_id)
    if s is None:
        raise HTTPException(404, "saved search not found")
    session.delete(s)
    session.commit()
    return {"deleted": True}


@router.get("/{search_id}/tracks")
def run_search(search_id: int, limit: int = 300, session: Session = Depends(get_session)):
    s = session.get(SavedSearch, search_id)
    if s is None:
        raise HTTPException(404, "saved search not found")
    tracks = search.search(session, s.query, limit=limit)
    return [t.model_dump(mode="json") for t in tracks]
