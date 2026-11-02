"""User vocabularies (facets). GET/POST/DELETE only: the desktop parity
validator rejects PATCH. Every write goes through services/facets.py."""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func
from sqlmodel import Session, select

from ..db import get_session
from ..models import Track, TrackTag
from ..services import facets, search
from ..services.facets import FacetError
from ..services.sql_ids import ids_in

router = APIRouter(prefix="/facets", tags=["facets"])


class FacetCreate(BaseModel):
    label: str
    multi: bool = True
    key: Optional[str] = None  # omitted: the server builds a slug from the label


class FacetUpdate(BaseModel):
    label: Optional[str] = None
    multi: Optional[bool] = None
    sort_order: Optional[int] = None


class FacetValueBody(BaseModel):
    value: str


def _http(error: FacetError) -> HTTPException:
    if error.code in {"reserved_key", "invalid", "single_conflict"}:
        status = 422
    elif error.code == "not_found":
        status = 404
    else:
        status = 409
    return HTTPException(status, str(error))


def _facet_payload(session: Session, facet_id: int) -> dict:
    return next(f for f in facets.list_facets(session) if f["id"] == facet_id)


def _value_payload(session: Session, value_id: int) -> dict:
    return next(v for f in facets.list_facets(session) for v in f["values"] if v["id"] == value_id)


@router.get("")
def list_facets(session: Session = Depends(get_session)):
    return facets.list_facets(session)


@router.post("")
def create_facet(req: FacetCreate, session: Session = Depends(get_session)):
    try:
        facet = facets.create_facet(session, req.label, req.multi, key=req.key)
    except FacetError as error:
        raise _http(error) from error
    return _facet_payload(session, facet.id)


@router.get("/counts")
def facet_counts(q: str = "", session: Session = Depends(get_session)):
    """Tracks matching `q` and, per facet value id, how many of them hold it.
    The query is a subquery, never a bound id list."""
    matching = search._build_query(session, q).with_only_columns(Track.id).subquery()
    total = session.execute(select(func.count()).select_from(matching)).scalar_one()
    value_ids = [v["id"] for f in facets.list_facets(session) for v in f["values"]]
    rows = session.exec(
        select(TrackTag.tag_id, func.count())
        .where(TrackTag.track_id.in_(select(matching.c.id)), ids_in(TrackTag.tag_id, value_ids))
        .group_by(TrackTag.tag_id)
    ).all() if value_ids else []
    return {"total": int(total), "counts": {str(tag_id): count for tag_id, count in rows}}


@router.post("/presets/{name}")
def load_preset(name: str, session: Session = Depends(get_session)):
    try:
        return facets.seed_preset(session, name)
    except FacetError as error:
        raise _http(error) from error


@router.post("/values/{value_id}")
def rename_value(value_id: int, req: FacetValueBody, session: Session = Depends(get_session)):
    try:
        return facets.rename_value(session, value_id, req.value)
    except FacetError as error:
        raise _http(error) from error


@router.delete("/values/{value_id}")
def delete_value(value_id: int, force: bool = False, session: Session = Depends(get_session)):
    try:
        return facets.delete_value(session, value_id, force=force)
    except FacetError as error:
        raise _http(error) from error


@router.post("/{facet_id}")
def update_facet(facet_id: int, req: FacetUpdate, session: Session = Depends(get_session)):
    try:
        return facets.update_facet(session, facet_id, label=req.label, multi=req.multi, sort_order=req.sort_order)
    except FacetError as error:
        raise _http(error) from error


@router.delete("/{facet_id}")
def delete_facet(facet_id: int, force: bool = False, session: Session = Depends(get_session)):
    try:
        return facets.delete_facet(session, facet_id, force=force)
    except FacetError as error:
        raise _http(error) from error


@router.post("/{facet_id}/values")
def add_value(facet_id: int, req: FacetValueBody, session: Session = Depends(get_session)):
    try:
        tag = facets.add_value(session, facet_id, req.value)
    except FacetError as error:
        raise _http(error) from error
    return _value_payload(session, tag.id)
