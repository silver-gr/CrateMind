"""«Καθαρά ονόματα», stage 1 routes: the status, the switch, «Ενημέρωση ονομάτων» and one track's why.

The payload models here are the contract with the frontend (frontend/src/lib/types.ts mirrors them); the show
lane fills in services/names_show.py and leaves the shapes alone."""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session

from ..db import get_session
from ..services import names_show, names_store

router = APIRouter(prefix="/names", tags=["names"])

Status = Literal["sure", "look", "open", "none", "hand"]


class RunState(BaseModel):
    state: Literal["idle", "queued", "running"] = "idle"
    cause: Optional[str] = None
    job_id: Optional[int] = None


class LastRun(BaseModel):
    finished_at: str
    ruleset: str
    cause: str = ""
    written: int = 0
    seconds: float = 0.0


class StatusCounts(BaseModel):
    sure: int = 0
    look: int = 0
    open: int = 0
    none: int = 0
    hand: int = 0


class NamesStatus(BaseModel):
    on: bool
    can_turn_on: bool
    blocked_reason: Optional[str] = None  # Greek; set while can_turn_on is false
    ruleset: str  # the engine's current ruleset
    present: int  # present tracks
    named: int  # present tracks with a track_names row
    unread: int  # present tracks whose raw tags were never read (raw_state NULL)
    unreadable: int  # present tracks whose tags could not be read
    counts: StatusCounts
    accepted: int = 0  # look rows the owner accepted
    changed: int = 0  # rows whose name differs from the switch-off name (names:changed)
    new: int = 0  # rows with an unacknowledged change (names:new, «Άλλαξαν από την τελευταία ματιά»)
    run: RunState
    last_run: Optional[LastRun] = None
    refusal: Optional[Literal["key_version"]] = None
    refusal_text: Optional[str] = None  # Greek


class SwitchIn(BaseModel):
    on: bool


class RawTags(BaseModel):
    artist: Optional[str] = None
    title: Optional[str] = None
    album: Optional[str] = None
    track_no: Optional[str] = None
    state: Optional[Literal["ok", "unreadable"]] = None  # None: never read


class WhyStep(BaseModel):
    rule: str  # the rule id, shown small («κανόνας N7»)
    field: str  # artist / title / folder / …
    text: str  # one Greek sentence


class WhyFact(BaseModel):
    label: str  # Greek
    value: str


class WhyDecision(BaseModel):
    id: int
    kind: str  # track / accept
    source: str  # owner / canonical
    source_text: str  # Greek («Δική σου διόρθωση», «από τη σελίδα ταυτότητας»)
    undoable: bool
    created_at: str


class WhyChange(BaseModel):
    prev_artist: Optional[str] = None
    prev_title: Optional[str] = None
    prev_folder: Optional[str] = None
    changed_at: Optional[str] = None
    cause_text: str = ""  # Greek


class NameWhy(BaseModel):
    track_id: int
    on: bool  # the switch
    has_row: bool  # false: unread, missing, or no run yet; every field below is then empty
    status: Optional[Status] = None
    status_text: str = ""  # Greek; '' for sure
    artist: str = ""  # the engine's name (status none: '')
    title: str = ""
    folder: str = ""
    off_artist: str = ""  # «Με κλειστά τα καθαρά ονόματα: …»
    off_title: str = ""
    open_question: Optional[str] = None  # Greek, never a U-code
    open_code: str = ""  # the engine's code of the open question, for the frontend's own Greek text; never shown
    steps: list[WhyStep] = []
    facts: list[WhyFact] = []
    raw: RawTags = RawTags()
    accepted: bool = False
    decision: Optional[WhyDecision] = None
    change: Optional[WhyChange] = None
    note: Optional[str] = None  # Greek, e.g. «χωρίς τα στοιχεία της πηγής, κατ' επιλογή σου»
    ruleset: str = ""


@router.get("/status", response_model=NamesStatus)
def get_status(session: Session = Depends(get_session)):
    return names_show.status(session)


@router.post("/switch", response_model=NamesStatus)
def set_switch(req: SwitchIn, session: Session = Depends(get_session)):
    try:
        return names_show.set_switch(session, req.on)
    except names_show.SwitchRefused as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/run", response_model=NamesStatus)
def run_now(session: Session = Depends(get_session)):
    """«Ενημέρωση ονομάτων»: the one run the owner can start with the switch off."""
    names_store.request_run("manual", force=True)
    return names_show.status(session)


@router.get("/tracks/{track_id}", response_model=NameWhy)
def track_why(track_id: int, session: Session = Depends(get_session)):
    payload = names_show.why(session, track_id)
    if payload is None:
        raise HTTPException(404, "Το κομμάτι δεν βρέθηκε.")
    return payload
