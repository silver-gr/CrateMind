"""«Καθαρά ονόματα», stage 2: the owner's answers, corrections, «Εντάξει» and acknowledgements.

The decide lane fills this in. Every function writes `name_decisions` rows in the engine's own grammar (kind,
scope, value; `names_store.cell_value` maps a letter or a typed value), revokes instead of deleting, and asks
for a run (`names_store.request_run("decision:<id>")`). The only `track_names` columns written here are the
owner's immediate ones: a hand correction's artist, title and status `hand`, `accepted`, and the `prev_*`
columns an acknowledgement clears. It never imports the engine: the questions come from the last run's record
(`names_store.read_run_record()`). Contract: .omc/research/name-cleaning-2026-11-27/integration/CONTRACT.md.
"""
from __future__ import annotations

from sqlmodel import Session


class DecisionError(Exception):
    """An answer the service refuses. `args[0]` is the Greek sentence shown to the owner; `status` the HTTP code."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def questions(session: Session) -> dict:
    """GET /api/names/questions (`QuestionsOut`): the engine's open questions and the pattern questions of the
    last run, each with the number of tracks it settles, up to five example tracks and its active answer."""
    raise NotImplementedError("decide lane")


def answer(session: Session, kind: str, scope: str, letter: str | None, text: str | None) -> dict:
    """POST /api/names/answers: answer one listed question by letter or, where it allows one, a typed value.
    Replaces the question's previous active answer. Returns the new answer (`AnswerOut`)."""
    raise NotImplementedError("decide lane")


def answers(session: Session) -> dict:
    """GET /api/names/answers (`AnswersOut`): every active answer and correction, newest first, each with
    «άλλαξε N κομμάτια» from the run that followed it (None until that run has finished)."""
    raise NotImplementedError("decide lane")


def undo(session: Session, decision_id: int) -> dict:
    """POST /api/names/answers/{id}/undo: revoke one active answer, correction or «Εντάξει» (a `canonical` row is
    refused: it is undone on /canonical). Returns {"ok": True, "run": names_store.run_state()}."""
    raise NotImplementedError("decide lane")


def correct(session: Session, track_id: int, artist: str, title: str) -> dict:
    """POST /api/names/tracks/{id}/correct: the owner's own artist and title for one track. Writes the `track`
    decision (the previous one revoked) and the track's `track_names` row at once (status `hand`), reindexes
    the track, then asks for a run. Returns the new answer (`AnswerOut`)."""
    raise NotImplementedError("decide lane")


def accept(session: Session, *, track_ids: list[int] | None, rule: str | None, dry_run: bool) -> dict:
    """POST /api/names/accept: «Εντάξει» for «Για ματιά» tracks, either the listed ids or every unaccepted look
    track (of one deciding rule when `rule` is given). `dry_run` only counts. Each accepted track gets an
    `accept` decision whose value is its current «artist | title | folder», and `accepted` set on its row.
    Returns {"count": n, "dry_run": bool}."""
    raise NotImplementedError("decide lane")


def acknowledge(session: Session, *, track_ids: list[int] | None, cause: str | None, action: str,
                dry_run: bool) -> dict:
    """POST /api/names/acknowledge: clear «Άλλαξαν» for the listed ids, or for every changed row (of one cause
    group when `cause` is given). `action` "ok" clears `prev_*`; "keep_previous" first writes a `track`
    decision with the previous artist and title. Returns {"count": n, "dry_run": bool}."""
    raise NotImplementedError("decide lane")


def review(session: Session, section: str, *, group: str | None, offset: int, limit: int) -> dict:
    """GET /api/names/review (`ReviewOut`): one page of a section of the /names page. `section`: look (grouped
    by deciding rule), none («Χωρίς καλλιτέχνη»), changed («Άλλαξαν», grouped by cause), open."""
    raise NotImplementedError("decide lane")
