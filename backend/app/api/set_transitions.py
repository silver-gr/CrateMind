"""Per-set transitions between adjacent tracks.

Writes only CrateMind's own set_transitions rows plus an audit row; audio,
tags, cues and DJ-app data are never touched. An adjacent pair without a saved
row is answered with the transparent «Αυτόματο» resolution.
"""
from __future__ import annotations

from datetime import UTC, datetime
from itertools import pairwise

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from ..db import get_session
from ..models import DJSet, SetTransition, Track, TrackDJProfile
from ..schemas import SetTransitionIn, SetTransitionOut
from ..services import audit
from ..services.recommender import effective_bpm, effective_key
from ..services.set_transitions import PairInput, ProfileHints, anchor_error, resolve_auto
from .sets import _ordered_tracks

router = APIRouter(tags=["sets"])

_FIELDS = ("preset", "bars", "volume_curve", "eq_curve", "filter_curve", "loop_beats",
           "out_anchor_s", "in_anchor_s", "tempo_match")


def _set_or_404(session: Session, set_id: int) -> DJSet:
    dj_set = session.get(DJSet, set_id)
    if dj_set is None:
        raise HTTPException(404, "set not found")
    return dj_set


def _hints(session: Session, track_id: int) -> ProfileHints | None:
    prof = session.get(TrackDJProfile, track_id)
    if prof is None:
        return None
    return ProfileHints(prof.transition_role, prof.can_cut_into, prof.can_cut_out_of)


def _resolve(session: Session, a: Track, b: Track):
    return resolve_auto(PairInput(effective_bpm(a), effective_bpm(b), effective_key(a), effective_key(b),
                                  _hints(session, a.id), _hints(session, b.id)))


def _out(session: Session, set_id: int, a: Track, b: Track, row: SetTransition | None) -> dict:
    """A saved row as stored, or the Auto resolution for an unsaved pair.

    A saved Auto row keeps only its anchors: curves, bars, loop and tempo
    match are re-resolved on every read so they always agree with
    ``resolved_preset`` (Decision 6c).
    """
    if row is None or row.preset == "auto":
        resolved = _resolve(session, a, b)
        resolved_preset, reasons = resolved.preset, list(resolved.reasons)
        values = {"preset": "auto", "bars": resolved.bars, "volume_curve": resolved.volume_curve,
                  "eq_curve": resolved.eq_curve, "filter_curve": resolved.filter_curve,
                  "loop_beats": resolved.loop_beats, "tempo_match": resolved.tempo_match,
                  "out_anchor_s": row.out_anchor_s if row else None,
                  "in_anchor_s": row.in_anchor_s if row else None}
    else:
        resolved_preset, reasons = None, []
        values = {name: getattr(row, name) for name in _FIELDS}
    if row is None:
        identity = {"id": None, "persisted": False, "updated_at": None}
    else:
        identity = {"id": row.id, "persisted": True, "updated_at": row.updated_at}
    return SetTransitionOut(set_id=set_id, from_track_id=a.id, to_track_id=b.id, resolved_preset=resolved_preset,
                            reasons=reasons, **values, **identity).model_dump(mode="json")


def _snapshot(row: SetTransition) -> dict:
    return {"set_id": row.set_id, "from_track_id": row.from_track_id, "to_track_id": row.to_track_id,
            **{name: getattr(row, name) for name in _FIELDS}}


def _row(session: Session, set_id: int, from_id: int, to_id: int) -> SetTransition | None:
    return session.exec(select(SetTransition).where(
        SetTransition.set_id == set_id, SetTransition.from_track_id == from_id,
        SetTransition.to_track_id == to_id)).first()


@router.get("/sets/{set_id}/transitions")
def list_transitions(set_id: int, session: Session = Depends(get_session)):
    _set_or_404(session, set_id)
    ordered = [track for _link, track in _ordered_tracks(session, set_id)]
    saved = {(r.from_track_id, r.to_track_id): r for r in session.exec(
        select(SetTransition).where(SetTransition.set_id == set_id)).all()}
    return {"transitions": [_out(session, set_id, a, b, saved.get((a.id, b.id)))
                            for a, b in pairwise(ordered)]}


@router.post("/sets/{set_id}/transitions")
def save_transition(set_id: int, req: SetTransitionIn, session: Session = Depends(get_session)):
    _set_or_404(session, set_id)
    members = {track.id: track for _link, track in _ordered_tracks(session, set_id)}
    a, b = members.get(req.from_track_id), members.get(req.to_track_id)
    if a is None or b is None:
        raise HTTPException(404, "track not in set")
    for name, value, track in (("out_anchor_s", req.out_anchor_s, a), ("in_anchor_s", req.in_anchor_s, b)):
        problem = anchor_error(value, track.duration)
        if problem:
            raise HTTPException(422, f"{name} {problem}")
    row = _row(session, set_id, a.id, b.id)
    before = _snapshot(row) if row is not None else None
    values = {name: getattr(req, name) for name in _FIELDS}
    if row is None:
        row = SetTransition(set_id=set_id, from_track_id=a.id, to_track_id=b.id, **values)
    else:
        for name, value in values.items():
            setattr(row, name, value)
    row.updated_at = datetime.now(UTC)
    session.add(row)
    session.flush()
    audit.log(session, "set_transition_update", "set_transition", row.id, before, _snapshot(row), commit=False)
    session.commit()
    session.refresh(row)
    return _out(session, set_id, a, b, row)


@router.delete("/sets/{set_id}/transitions/{from_track_id}/{to_track_id}")
def delete_transition(set_id: int, from_track_id: int, to_track_id: int,
                      session: Session = Depends(get_session)):
    _set_or_404(session, set_id)
    row = _row(session, set_id, from_track_id, to_track_id)
    if row is None:
        return {"removed": False}
    audit.log(session, "set_transition_delete", "set_transition", row.id, _snapshot(row), None, commit=False)
    session.delete(row)
    session.commit()
    return {"removed": True}
