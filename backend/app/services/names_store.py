"""«Καθαρά ονόματα»: the names job. The only module of the app that imports the engine (`services/names`).

It reads one snapshot of the library (raw tags, file name, folder relative to the library root, tempo evidence,
links and references from the identity library, the owner's active decisions, the /canonical states, today's
shown names), calls `names.resolve()`, and stores the result in `track_names`, rewriting only the rows whose
result differs. It never reads or writes an audio file and never touches `tracks.artist/title`.

Contract for the lanes: .omc/research/name-cleaning-2026-11-27/integration/CONTRACT.md. What is real in the
foundation: the run record file, `cell_value`, `engine_ruleset`, and the safe "switch off" answers of
`request_run` and `yield_to`. Everything else raises NotImplementedError until the store lane fills it in.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from sqlmodel import Session

from . import names_switch

RUN_RECORD_VERSION = 1


# ---------------------------------------------------------------- the engine, behind this module
def engine_ruleset() -> str:
    """The engine's ruleset name (for example «names-8»), for modules that may not import the engine."""
    from .names import RULESET

    return RULESET


def engine_key_version() -> int:
    """The engine's act-key version; an act-scoped decision is written with it (`name_decisions.key_version`)."""
    from .names import KEY_VERSION

    return KEY_VERSION


class BadAnswer(ValueError):
    """An answer that is neither one of the question's letters nor a typed value the row allows. The message
    is an internal reason; routes answer in Greek."""


def cell_value(kind: str, options: list[str], cell: str) -> str:
    """One answer («A», or «=typed value») as the value an engine decision of `kind` carries. `options` are the
    question's own strings («A=…», «B=…»). The grammar of the preview's sheet importer (run.py `load_decisions`),
    so an answer given in the app equals the same answer given on the sheet."""
    cell = (cell or "").strip()
    opts = dict(o.split("=", 1) for o in options if "=" in o)
    if cell.startswith("="):
        if not cell[1:].strip():
            raise BadAnswer("empty value")
        if kind == "track" and "|" not in cell:
            raise BadAnswer("a track answer needs «=Artist | Title»")
        if kind in ("same_act", "bracket_word"):
            raise BadAnswer("this question takes a letter")
        return cell[1:] if kind == "track" else cell
    if not (len(cell) == 1 and cell in opts):
        raise BadAnswer("not one of the letters")
    if kind == "bracket_word":
        return {"A": "keep", "B": "genre", "C": "label"}.get(cell, cell)
    if kind == "same_act":
        return {"A": "no", "B": "yes"}.get(cell, cell)
    if kind == "album_credit":
        return "none" if cell == "A" else opts[cell]
    return opts[cell]


# ---------------------------------------------------------------- the last run's record (a cache file)
def run_record_path() -> Path:
    """`cache/names-run.json` beside the catalog (like deck rescue): derived, never in a backup or a bundle."""
    from ..config import get_settings

    return get_settings().db_file.parent / "cache" / "names-run.json"


def read_run_record() -> dict | None:
    """The last finished run's record, or None (no run yet, another version, unreadable). Shape: CONTRACT.md."""
    try:
        data = json.loads(run_record_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and data.get("version") == RUN_RECORD_VERSION else None


def write_run_record(record: dict) -> None:
    """Replace the record atomically. Only a run calls this."""
    path = run_record_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps({**record, "version": RUN_RECORD_VERSION}, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


# ---------------------------------------------------------------- snapshot and run (store lane)
@dataclass(frozen=True)
class Snapshot:
    """Everything one run reads, taken at one moment. `inputs`, `references` and `decisions` are the engine's
    own types (TrackInput, References, Decision); `decision_ids` maps each passed decision's (kind, scope) to
    its `name_decisions.id` (None for one built for this run from a /canonical accept); `off` is today's shown
    (artist, title) per track id; `unread` are present tracks with `raw_state` NULL (they get no row)."""
    inputs: tuple = ()
    references: Any = None
    decisions: tuple = ()
    decision_ids: dict = field(default_factory=dict)
    off: dict = field(default_factory=dict)
    unread: tuple = ()
    stale_key_decisions: tuple = ()  # ids of active act-scoped rows whose key_version is not the engine's
    digest: str = ""  # input_digest(self)


@dataclass(frozen=True)
class RunResult:
    """What a run did. `state`: done (rows compared and written), unchanged (equal input digest, nothing
    read further or written), refused (a key-version mismatch: nothing written), cancelled (nothing written)."""
    state: str
    written: int = 0
    counts: dict = field(default_factory=dict)  # status -> number of rows after the run
    reach: dict = field(default_factory=dict)  # str(name_decisions.id) -> tracks whose result it changed
    reindexed: int = 0
    seconds: float = 0.0


def snapshot(session: Session) -> Snapshot:
    """Read the run's inputs (catalog session; the identity library read-only, absent for a cold library)."""
    raise NotImplementedError("store lane")


def input_digest(snap: Snapshot) -> str:
    """One sha256 over `names.digest()`, the raw columns, links, references, decisions and /canonical states:
    equal digests mean an equal result, so a run with the last run's digest writes nothing."""
    raise NotImplementedError("store lane")


def run(session: Session, *, cause: str = "manual", cancelled: Callable[[], bool] | None = None) -> RunResult:
    """One whole run in this thread: snapshot, digest check, key-version check, `names.resolve()`, then one
    transaction that rewrites only the differing `track_names` rows (prev_* per the «Άλλαξαν» rule), deletes
    rows of tracks that no longer qualify, reindexes the FTS rows whose shown name changed (through
    names_show.reindex_changed) and writes the run record. `cancelled` is asked between phases and before the
    write transaction. `cause`: launch, scan, analysis, links, decision:<id>, switch, manual, import."""
    raise NotImplementedError("store lane")


# ---------------------------------------------------------------- the queue (store lane)
def request_run(cause: str, *, force: bool = False) -> bool:
    """Ask for a run in the background: at most one waits (in memory, no Job row until it starts), and it does
    not start while a scan or analysis job is active or two decks play. Returns True when a run is now queued
    or running. With the switch off nothing is queued unless `force` («Ενημέρωση ονομάτων», turning the
    switch on, the answers import). Safe to call from any thread and from a finished job."""
    if not force and not names_switch.is_on():
        return False
    raise NotImplementedError("store lane")


def yield_to(kind: str) -> bool:
    """Called by `worker.create_job` before any job row is created. For `scan` and `analyze` a running names
    run is told to stop (it writes nothing) and is queued again; other kinds change nothing. Returns True when
    a run was cancelled. Never refuses and never raises: a names run may not block another job."""
    return False  # store lane: nothing can be running before the queue exists


def run_state() -> dict:
    """{"state": "idle" | "queued" | "running", "cause": str | None, "job_id": int | None}."""
    return {"state": "idle", "cause": None, "job_id": None}  # store lane: report the real queue


# ---------------------------------------------------------------- the owner's answers file (store lane)
def import_answers(session: Session, answers: dict, seed_rows: list[dict] | None = None,
                   loose_folders: tuple[str, ...] = (), *, dry_run: bool = False) -> dict:
    """Write the owner's research answers as `name_decisions` rows, once: `answers` is owner-answers.json's
    object ({"answers": [{"scope", "answer", "date", "into"?, "provisional"?}, …]}), `seed_rows` the rows of
    decisions-seed.csv (kind, scope, options, απόφαση, source). The mapping is run.py's `load_answers` and
    `load_decisions`. A decision that already has an active or revoked row is skipped, so a second import and
    an undone answer are both left alone. Returns {"added": n, "skipped": n, "rejected": [reasons]}."""
    raise NotImplementedError("store lane")


def record_canonical_edit(session: Session, event_id: int, track_ids: list[int], artist: str, title: str) -> int:
    """After a /canonical `edit` has committed in the identity library: one `track` decision (source
    `canonical`, `canonical_event_id`) per current member track, the track's previous active track decision
    revoked. Returns the rows written. A failure here is repaired by the next run, which copies an edit event
    that has no row at all."""
    raise NotImplementedError("store lane")
