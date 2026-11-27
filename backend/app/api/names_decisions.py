"""«Καθαρά ονόματα», stage 2 routes: questions, answers and their undo, corrections, «Εντάξει», «Άλλαξαν».

The payload models here are the contract with the frontend (frontend/src/lib/types.ts mirrors them); the
decide lane fills in services/names_decisions.py and leaves the shapes alone."""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel import Session

from ..db import get_session
from ..services import names_decisions
from .names_status import RunState

router = APIRouter(prefix="/names", tags=["names"])


class QuestionOption(BaseModel):
    letter: str
    text: str  # Greek


class ExampleTrack(BaseModel):
    track_id: int
    artist: str  # the engine's current name
    title: str
    off_artist: str = ""
    off_title: str = ""


class AnswerOut(BaseModel):
    id: int
    kind: str
    scope: str = ""
    track_id: Optional[int] = None
    value: str
    text: str  # Greek: what was answered, readable without the question
    source: str  # owner / seed / canonical
    provisional: bool = False
    created_at: str
    reach: Optional[int] = None  # «άλλαξε N κομμάτια»; None until the run after it has finished
    undoable: bool = True
    track: Optional[ExampleTrack] = None  # for a one-track row


class QuestionOut(BaseModel):
    id: str  # kind + "|" + scope
    kind: str
    scope: str
    section: Literal["open", "pattern"]
    code: str = ""  # internal; never shown
    question: str  # Greek
    options: list[QuestionOption] = []
    allows_text: bool = False  # «Άλλο…»
    text_hint: Optional[str] = None  # Greek placeholder for the typed value
    recommended: Optional[str] = None  # a letter (pattern questions)
    why: Optional[str] = None  # Greek
    track_count: int = 0
    examples: list[ExampleTrack] = []
    answer: Optional[AnswerOut] = None


class QuestionsOut(BaseModel):
    open: list[QuestionOut] = []
    patterns: list[QuestionOut] = []
    has_run: bool = True  # false: no run yet, so there is nothing to ask; the page says «κάνε ενημέρωση»
    run: RunState = RunState()


class AnswerIn(BaseModel):
    kind: str
    scope: str
    letter: Optional[str] = Field(default=None, max_length=1)
    text: Optional[str] = Field(default=None, max_length=500)


class AnswersOut(BaseModel):
    items: list[AnswerOut] = []


class UndoOut(BaseModel):
    ok: bool = True
    run: RunState = RunState()


class CorrectIn(BaseModel):
    artist: str = Field(max_length=500)
    title: str = Field(max_length=500)


class AcceptIn(BaseModel):
    track_ids: Optional[list[int]] = None  # None: every unaccepted «Για ματιά» track (of `rule`, when given)
    rule: Optional[str] = None
    dry_run: bool = False


class AcknowledgeIn(BaseModel):
    track_ids: Optional[list[int]] = None  # None: every changed row (of `cause`, when given)
    cause: Optional[str] = None
    action: Literal["ok", "keep_previous"] = "ok"
    dry_run: bool = False


class CountOut(BaseModel):
    count: int
    dry_run: bool = False


class ReviewGroup(BaseModel):
    key: str
    label: str  # Greek
    count: int


class ReviewRow(BaseModel):
    track_id: int
    artist: str
    title: str
    folder: str = ""
    off_artist: str = ""
    off_title: str = ""
    status: str
    group: str = ""  # the deciding rule (look) or the cause key (changed)
    reason: str = ""  # Greek sentence
    accepted: bool = False
    prev_artist: Optional[str] = None
    prev_title: Optional[str] = None
    prev_folder: Optional[str] = None
    changed_at: Optional[str] = None
    cause_text: str = ""  # Greek


class ReviewOut(BaseModel):
    section: str
    total: int  # rows of the section (of the group, when one is given)
    groups: list[ReviewGroup] = []
    items: list[ReviewRow] = []
    offset: int = 0
    limit: int = 100


def _call(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except names_decisions.DecisionError as exc:
        raise HTTPException(exc.status, str(exc)) from exc


@router.get("/questions", response_model=QuestionsOut)
def list_questions(session: Session = Depends(get_session)):
    return _call(names_decisions.questions, session)


@router.get("/answers", response_model=AnswersOut)
def list_answers(session: Session = Depends(get_session)):
    return _call(names_decisions.answers, session)


@router.post("/answers", response_model=AnswerOut)
def give_answer(req: AnswerIn, session: Session = Depends(get_session)):
    return _call(names_decisions.answer, session, req.kind, req.scope, req.letter, req.text)


@router.post("/answers/{decision_id}/undo", response_model=UndoOut)
def undo_answer(decision_id: int, session: Session = Depends(get_session)):
    return _call(names_decisions.undo, session, decision_id)


@router.post("/tracks/{track_id}/correct", response_model=AnswerOut)
def correct_track(track_id: int, req: CorrectIn, session: Session = Depends(get_session)):
    return _call(names_decisions.correct, session, track_id, req.artist, req.title)


@router.post("/accept", response_model=CountOut)
def accept_look(req: AcceptIn, session: Session = Depends(get_session)):
    return _call(names_decisions.accept, session, track_ids=req.track_ids, rule=req.rule, dry_run=req.dry_run)


@router.post("/acknowledge", response_model=CountOut)
def acknowledge_changed(req: AcknowledgeIn, session: Session = Depends(get_session)):
    return _call(names_decisions.acknowledge, session, track_ids=req.track_ids, cause=req.cause,
                 action=req.action, dry_run=req.dry_run)


@router.get("/review", response_model=ReviewOut)
def review_section(section: Literal["look", "none", "changed", "open"], group: Optional[str] = None,
                   offset: int = Query(0, ge=0), limit: int = Query(100, ge=1, le=500),
                   session: Session = Depends(get_session)):
    return _call(names_decisions.review, session, section, group=group, offset=offset, limit=limit)
