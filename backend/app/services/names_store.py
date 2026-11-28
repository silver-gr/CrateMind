"""«Καθαρά ονόματα»: the names job. The only module of the app that imports the engine (`services/names`).

It reads one snapshot of the library (raw tags, file name, folder relative to the library root, tempo evidence,
links and references from the identity library, the owner's active decisions, the /canonical states, today's
shown names), calls `names.resolve()`, and stores the result in `track_names`, rewriting only the rows whose
result differs. It never reads or writes an audio file and never touches `tracks.artist/title`.

A run is library-wide (the engine's registry, spelling votes and album groups are), so there is no per-track
run. Runs wait in memory, at most one at a time, and give way to a scan or an analysis; a `jobs` row exists
only while one runs. The last run's digest, counts and questions live in `cache/names-run.json`.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import sqlite3
import threading
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Callable

from sqlalchemy import text
from sqlmodel import Session, select

from ..models import Job, NameDecision, Track, TrackName
from . import names_switch

logger = logging.getLogger(__name__)

RUN_RECORD_VERSION = 1
# Bumped when this module derives a different stored row from the same engine result, so the next run rewrites.
STORE_VERSION = 1
STATUSES = ("sure", "look", "open", "none", "hand")
# materialize()'s action filter: the review events that set a recording's /canonical state.
REVIEW_ACTIONS = ("accept", "bulk_accept", "edit", "keep_local", "reject")
REFUSAL_TEXT = "Οι απαντήσεις σου γράφτηκαν με παλαιότερη έκδοση των κανόνων· τα ονόματα δεν ενημερώθηκαν"


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


# ---------------------------------------------------------------- snapshot
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
    accepted: dict = field(default_factory=dict)  # track id -> the active «Εντάξει» row's «artist | title | folder»
    cold: bool = True  # no identity library was read (a friend's library, or a session on another database)
    # What the switch-off projection and the engine's "shown before" input are made from, per track id: the
    # stored columns `overlay` reads and the linked remote records. `basis` is one hash over it and over the
    # identity library's rows behind it, so the digest covers them without running the projection.
    evidence: dict = field(default_factory=dict)
    basis: str = ""


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


@dataclass(frozen=True)
class _Recording:
    """A track's recording in the identity library and its /canonical state."""
    id: str
    state: str = ""
    artist: str = ""
    title: str = ""
    event_id: int | None = None  # the recording's last review event (REVIEW_ACTIONS)
    action: str = ""
    event_at: datetime | None = None


ENGINE_KINDS = ("spelling", "same_act", "one_act", "not_act", "bracket_word", "album_credit", "facts", "preference")
_TRACKS_SQL = (
    "SELECT id, absolute_path, file_name, artist, title, album, raw_artist, raw_title, raw_album, raw_track_no, "
    "raw_state, bpm, bpm_analyzed, bpm_grid, bpm_consensus, bpm_consensus_sources FROM tracks WHERE missing = 0 "
    "ORDER BY id")
_CREDIT_SPLIT_RE = re.compile(r"(?i)\s*(?:,|;|&|\bvs\.?|\bx\b|\bfeat\.?|\bft\.?|\band\b)\s*")
_SC_TITLE_HEAD_RE = re.compile(r"^\s*.+?\s+[-–—]\s+(.+)$")


def _aware(value: datetime | str | None) -> datetime | None:
    """A stored time as UTC (SQLite gives naive datetimes back; the identity library stores ISO text)."""
    if value is None or value == "":
        return None
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError:
            return None
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _library_roots() -> list[str]:
    """The library roots as path prefixes, longest first."""
    from ..config import get_settings

    try:
        roots = [str(root).rstrip("/") + "/" for root in get_settings().roots]
    except OSError:
        roots = []
    return sorted(set(roots), key=lambda r: (-len(r), r))


def _folder(path: str, roots: list[str]) -> str:
    """The containing folder relative to the track's library root, «/»-separated; a file outside every root
    keeps its whole parent folder (what the preview fed the engine)."""
    rel = next((path[len(root):] for root in roots if path.startswith(root)), path)
    return rel.rsplit("/", 1)[0] if "/" in rel else ""


def _spotify_artists(entity: dict, normalized: dict, metadata: dict) -> list[str]:
    text_ = normalized.get("artist") or entity["artist"] or ""
    uris = [u for u in (metadata.get("artist_uris") or "").split(",") if u.strip()]
    for sep in (", ", ";"):
        parts = [p.strip() for p in text_.split(sep) if p.strip()]
        if uris and len(parts) == len(uris):
            return parts
    return [text_] if text_ else []


def _soundcloud_fields(entity: dict, normalized: dict, metadata: dict) -> tuple[str, str]:
    nm = metadata.get("normalized_metadata") or {}
    publisher = (nm.get("publisher_artist") or normalized.get("artist") or "").strip()
    uploader = (normalized.get("uploader") or nm.get("uploader_username") or entity["artist"] or "").strip()
    return publisher, uploader


def _tables(db) -> set[str]:
    return {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}


def _review_events(db, tables: set[str], recording_id: str | None = None) -> dict[str, tuple]:
    """Each recording's last review event: recording id -> (event id, action, time, after_json)."""
    if "canonical_events" not in tables:
        return {}
    marks = ",".join("?" for _ in REVIEW_ACTIONS)
    sql = f"SELECT recording_id, id, action, created_at, after_json FROM canonical_events WHERE action IN ({marks})"
    args: tuple = REVIEW_ACTIONS
    if recording_id is not None:
        sql, args = sql + " AND recording_id = ?", (*REVIEW_ACTIONS, recording_id)
    return {r[0]: (r[1], r[2], r[3], r[4]) for r in db.execute(sql + " ORDER BY id", args)}


def _current_locals(db, recording_id: str | None = None) -> list[tuple[int, str]]:
    """(track id, recording id) of every current local entity."""
    from .identity_library import current_local_predicate

    sql = "SELECT l.local_track_id, l.recording_id FROM entities l WHERE " + current_local_predicate("l")
    args: tuple = ()
    if recording_id is not None:
        sql, args = sql + " AND l.recording_id = ?", (recording_id,)
    return [(r[0], r[1]) for r in db.execute(sql + " ORDER BY l.local_track_id, l.id", args)
            if r[0] is not None and r[1] is not None]


def _read_identity(session: Session) -> dict | None:
    """Links, references and /canonical states from the identity library, read-only, as the preview's run.py
    `load()` assembled them. None for a cold library: no identity file, no entities table, or a session that
    is not on the configured catalog (so a test database never meets a real identity library)."""
    from . import canonical_library, identity_library
    from .names import Link
    from .names import text as T
    from .names.lexer import split_credit

    if not canonical_library.catalog_session_matches(session):
        return None
    try:
        with identity_library.connect() as db:
            tables = _tables(db)
            if "entities" not in tables:
                return None
            hashed = hashlib.sha256()
            by_recording: dict[str, list[tuple]] = defaultdict(list)
            sp_refs, pub_refs, title_refs = Counter(), Counter(), Counter()
            for e in db.execute("SELECT id, service, artist, title, recording_id, normalized_json, metadata_json "
                                "FROM entities WHERE service IN ('spotify','soundcloud') ORDER BY id"):
                e = dict(e)
                hashed.update(json.dumps([e[k] for k in ("id", "service", "artist", "title", "recording_id",
                                                         "normalized_json", "metadata_json")],
                                         ensure_ascii=False).encode("utf-8"))
                normalized, metadata = json.loads(e["normalized_json"] or "{}"), json.loads(e["metadata_json"] or "{}")
                title = e["title"] or ""
                retired = (metadata.get("asset_lifecycle") or {}).get("state") == "retired"
                if e["service"] == "spotify":
                    artists = _spotify_artists(e, normalized, metadata)
                    for a in artists:
                        sp_refs[a] += 1
                    title_refs[T.fold(T.title_annotations(T.chars(title))[0])] += 1
                    link = Link("spotify", tuple(artists), title)
                    shown_artist = e["artist"]
                else:
                    publisher, uploader = _soundcloud_fields(e, normalized, metadata)
                    if publisher and T.fold(publisher) != T.fold(uploader):
                        for a in split_credit(publisher).acts:
                            pub_refs[a] += 1
                    head = T.title_annotations(T.chars(title))[0]
                    m = _SC_TITLE_HEAD_RE.match(head)
                    title_refs[T.fold(m.group(1) if m else head)] += 1
                    link = Link("soundcloud", (publisher,) if publisher else (), title, uploader)
                    shown_artist = normalized.get("artist") or e["artist"]
                if e["recording_id"] is not None:
                    by_recording[e["recording_id"]].append(
                        (link, retired, {"service": e["service"], "artist": shown_artist, "title": title}))
            title_refs.pop("", None)
            locals_ = _current_locals(db)
            hashed.update(json.dumps(locals_).encode("utf-8"))
            for r in db.execute("SELECT l.id, l.artist, l.title FROM entities l WHERE l.service='local' ORDER BY l.id"):
                hashed.update(json.dumps(list(r), ensure_ascii=False).encode("utf-8"))
            canon: dict[str, tuple] = {}
            if "canonical_recordings" in tables:
                for r in db.execute("SELECT recording_id, state, artist, title FROM canonical_recordings "
                                    "ORDER BY recording_id"):
                    canon[r[0]] = (r[1] or "", r[2] or "", r[3] or "")
                    hashed.update(json.dumps(list(r), ensure_ascii=False).encode("utf-8"))
            events = _review_events(db, tables)
            hashed.update(json.dumps(sorted((rid, e[0], e[1]) for rid, e in events.items())).encode("utf-8"))
            # The projection reads match candidates only for a track with no artist of its own; their count
            # and score sum stand for them here (a proxy: a change that keeps both equal is not seen).
            for table, column in (("candidates", "score"), ("identity_acceptances", "revoked_at IS NOT NULL"),
                                  ("canonical_blocks", "1")):
                if table in tables:
                    row = db.execute(f"SELECT count(*), total({column}) FROM {table}").fetchone()
                    hashed.update(f"{table}:{row[0]}:{row[1]}".encode("utf-8"))
    except sqlite3.Error:
        return None
    links: dict[int, tuple] = {}
    providers: dict[int, list[dict]] = {}
    recording: dict[int, _Recording] = {}
    for track_id, rid in locals_:
        members = by_recording.get(rid, ())
        links[track_id] = links.get(track_id, ()) + tuple(link for link, retired, _ in members if not retired)
        providers.setdefault(track_id, []).extend(shown for _, _, shown in members)
        state, artist, title = canon.get(rid, ("", "", ""))
        event = events.get(rid)
        recording[track_id] = _Recording(rid, state, artist, title, event[0] if event else None,
                                         event[1] if event else "", _aware(event[2]) if event else None)
    return {"links": links, "providers": providers, "recording": recording, "basis": hashed.hexdigest(),
            "spotify": tuple(sorted(sp_refs.items())), "sc_publisher": tuple(sorted(pub_refs.items())),
            "titles": tuple(sorted(title_refs.items()))}


def _acts_key(value: str) -> tuple:
    from .names import text as T

    return tuple(sorted(T.fold(x) for x in _CREDIT_SPLIT_RE.split(value or "") if T.fold(x)))


def _previous(off: tuple[str, str], evidence: dict) -> dict:
    """The engine's "shown before this run" input (rule R0), ported from the preview's run.py `previous()`:
    today's shown artist and title, and whether each came from the scanner's reading or a linked record."""
    from .names import text as T

    out = {"previous_artist": off[0], "previous_title": off[1]}
    for index, fld in enumerate(("artist", "title")):
        now, stored, source = off[index], evidence["stored_" + fld], ""
        if fld == "artist":
            def same(a, b):
                return _acts_key(a) == _acts_key(b)
        else:
            def same(a, b):
                return T.fold(a) == T.fold(b)
        if now and now == stored:
            source = "scanner"
        else:
            for provider in evidence["providers"]:
                if now and same(provider.get(fld) or "", now):
                    source = provider.get("service") or ""
                    break
            source = source or ("scanner" if same(now, stored) else "")
        out[f"previous_source_{fld}"] = source if now else "empty"
    return out


def _with_off(session: Session, snap: Snapshot) -> Snapshot:
    """Add today's shown names (`off`) and the engine's "shown before" input to a snapshot read without them."""
    from . import canonical_library

    rows = [{"id": tid, **{k: e[k] for k in ("file_name", "bpm", "bpm_analyzed", "bpm_grid", "bpm_consensus",
                                              "bpm_consensus_sources")},
             "artist": e["catalog_artist"], "title": e["catalog_title"]}
            for tid, e in snap.evidence.items()]
    shown = canonical_library.overlay_off(rows, session)
    off = {row["id"]: (row.get("artist") or "", row.get("title") or "") for row in shown}
    inputs = tuple(replace(t, **_previous(off.get(t.id, ("", "")), snap.evidence[t.id])) for t in snap.inputs)
    return replace(snap, inputs=inputs, off=off)


def snapshot(session: Session, *, with_off: bool = True) -> Snapshot:
    """Read the run's inputs (catalog session; the identity library read-only, absent for a cold library).
    `with_off=False` leaves out today's shown names (`off` and the inputs' `previous_*`), the slow part: the
    digest is the same either way, so a run reads them only when the digest says something changed."""
    from .names import KEY_VERSION, Decision, References, TrackInput

    rows = [dict(r) for r in session.connection().execute(text(_TRACKS_SQL)).mappings()]
    roots = _library_roots()
    identity = _read_identity(session)
    recording = identity["recording"] if identity else {}
    inputs, unread, evidence = [], [], {}
    for r in rows:
        if r["raw_state"] is None:
            unread.append(r["id"])
            continue
        read_ok = r["raw_state"] != "unreadable"  # an unreadable file is fed its stored columns, as the preview did
        rec = recording.get(r["id"])
        # A /canonical «κράτα το τοπικό» or rejection refuses the provider's version: no links for that track.
        links = () if rec and rec.state in ("kept_local", "rejected") else (identity["links"].get(r["id"], ()) if identity else ())
        inputs.append(TrackInput(
            id=r["id"],
            artist=(r["raw_artist"] if read_ok else r["artist"]) or "",
            title=(r["raw_title"] if read_ok else r["title"]) or "",
            album=(r["raw_album"] if read_ok else r["album"]) or "",
            track_no=(r["raw_track_no"] or "") if read_ok else "",
            file_name=r["file_name"] or "", folder=_folder(r["absolute_path"] or "", roots),
            bpm_grid=r["bpm_grid"], bpm_analyzed=r["bpm_analyzed"], links=links))
        evidence[r["id"]] = {
            "stored_artist": r["artist"] or "", "stored_title": r["title"] or "", "file_name": r["file_name"],
            "catalog_artist": r["artist"], "catalog_title": r["title"],
            "bpm": r["bpm"], "bpm_analyzed": r["bpm_analyzed"], "bpm_grid": r["bpm_grid"],
            "bpm_consensus": r["bpm_consensus"], "bpm_consensus_sources": r["bpm_consensus_sources"],
            "providers": identity["providers"].get(r["id"], []) if identity else []}
    references = References(
        spotify=identity["spotify"] if identity else (), sc_publisher=identity["sc_publisher"] if identity else (),
        titles=identity["titles"] if identity else (), loose_folders=names_switch.loose_folders(session))

    active = session.exec(select(NameDecision).where(NameDecision.revoked_at.is_(None))
                          .order_by(NameDecision.id)).all()
    decisions, decision_ids, stale, accepted, track_rows = [], {}, [], {}, {}
    for d in active:
        if d.kind == "accept" and d.track_id is not None:
            accepted[d.track_id] = d.value
        elif d.kind == "track" and d.track_id is not None:
            track_rows[d.track_id] = d
        elif d.kind in ENGINE_KINDS and d.track_id is None:
            if d.scope.startswith(("act:", "pair:")) and d.key_version is not None and d.key_version != KEY_VERSION:
                stale.append(d.id)
            decisions.append(Decision(d.kind, d.scope, d.value, d.source, bool(d.provisional)))
            decision_ids[(d.kind, d.scope)] = d.id
    # One track decision per track at most, the latest explicit action: the owner's stored correction, a stored
    # copy of a /canonical edit while that edit is still the recording's state, or a /canonical accept that is
    # (built here each run, never stored).
    for t in inputs:
        stored, rec = track_rows.get(t.id), recording.get(t.id)
        if stored is not None and stored.source == "canonical" and identity is not None and not (
                rec and rec.state == "human" and rec.event_id == stored.canonical_event_id):
            stored = None  # the edit it copies was replaced or dropped on /canonical
        built = None
        if rec and rec.state == "human" and rec.action in ("accept", "bulk_accept") and rec.artist.strip():
            built = f"{rec.artist} | {rec.title}"
            if stored is not None:
                mine, theirs = _aware(stored.created_at), rec.event_at
                if mine is not None and theirs is not None and theirs > mine:
                    stored = None
                else:
                    built = None
        scope = f"track:{t.id}"
        if stored is not None:
            decisions.append(Decision("track", scope, stored.value, stored.source, bool(stored.provisional)))
            decision_ids[("track", scope)] = stored.id
        elif built is not None:
            decisions.append(Decision("track", scope, built, "canonical"))
            decision_ids[("track", scope)] = None

    snap = Snapshot(inputs=tuple(inputs), references=references, decisions=tuple(decisions),
                    decision_ids=decision_ids, unread=tuple(unread), stale_key_decisions=tuple(stale),
                    accepted=accepted, cold=identity is None, evidence=evidence,
                    basis=identity["basis"] if identity else "")
    snap = replace(snap, digest=input_digest(snap))
    return _with_off(session, snap) if with_off else snap


def input_digest(snap: Snapshot) -> str:
    """One sha256 over `names.digest()`, the raw columns, links, references, decisions and /canonical states:
    equal digests mean an equal result, so a run with the last run's digest writes nothing. Today's shown
    names are covered through what they are made from (the stored columns and `basis`), not their values."""
    from .names import digest as engine_digest

    h = hashlib.sha256()

    def add(value) -> None:
        h.update(repr(value).encode("utf-8") + b"\n")

    add(("store", STORE_VERSION, engine_digest(), engine_ruleset(), snap.basis, snap.cold))
    for t in snap.inputs:
        add(replace(t, previous_artist="", previous_title="", previous_source_artist="", previous_source_title=""))
        e = snap.evidence.get(t.id) or {}
        add((e.get("stored_artist"), e.get("stored_title")))
    add(snap.references)
    add(sorted(snap.decisions, key=lambda d: (d.kind, d.scope)))
    add(sorted((k, v) for k, v in snap.decision_ids.items()))
    add(sorted(snap.accepted.items()))
    add((snap.unread, snap.stale_key_decisions))
    return h.hexdigest()


# ---------------------------------------------------------------- the run
def _facts(result) -> dict:
    from .names import explain

    facts = {"tempo": result.tempo_hint or "", "notes": result.notes or {},
             "remixers": sorted({a.name for a in result.acts if a.role == "remixer"}),
             "album_credit": result.album_credit or "",
             "acts": [{"name": a.name, "key": a.key, "role": a.role} for a in result.acts]}
    if result.open_code:
        # The open question in Greek, so the why block never needs the engine or a U-code.
        facts["question"] = explain.OPEN_TEXT.get(result.open_code, "")
    return facts


def _why(result) -> list[list[str]]:
    """[[rule, field, Greek sentence], …] in trail order, one line per distinct sentence (as `explain.reason`)."""
    from .names import explain

    out, seen = [], set()
    for step in result.trail:
        sentence = explain.text_of(step)
        if step.rule in explain.SILENT or not sentence or sentence in seen:
            continue
        seen.add(sentence)
        out.append([step.rule, step.field, sentence])
    return out


def _dump(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _row_values(result, snap: Snapshot, ruleset: str) -> dict:
    from .names import UNKNOWN_ARTIST

    artist = "" if result.status == "none" and result.artist == UNKNOWN_ARTIST else result.artist
    off = snap.off.get(result.id, ("", ""))
    return {"artist": artist, "title": result.title, "folder": result.folder, "status": result.status,
            "open_code": result.open_code or "", "rules": " ".join(result.rules), "why_json": _dump(_why(result)),
            "facts_json": _dump(_facts(result)), "off_artist": off[0], "off_title": off[1], "ruleset": ruleset,
            "accepted": result.status == "look" and snap.accepted.get(result.id) == accept_value(artist, result.title, result.folder)}


def accept_value(artist: str, title: str, folder: str) -> str:
    """What an «Εντάξει» row stores: the accepted «artist | title | folder»."""
    return f"{artist} | {title} | {folder}"


def _changed_cause(cause: str, old_ruleset: str, new_ruleset: str) -> str:
    if old_ruleset and old_ruleset != new_ruleset:
        return f"ruleset:{old_ruleset}→{new_ruleset}"
    return cause if cause.startswith("decision:") or cause in ("scan", "links", "analysis") else "other"


def _counts(session: Session) -> dict:
    found = dict(session.connection().execute(text("SELECT status, count(*) FROM track_names GROUP BY status")).all())
    return {status: int(found.get(status, 0)) for status in STATUSES}


def _iso(moment: datetime) -> str:
    return moment.astimezone(UTC).isoformat()


def run(session: Session, *, cause: str = "manual", cancelled: Callable[[], bool] | None = None) -> RunResult:
    """One whole run in this thread: snapshot, digest check, key-version check, `names.resolve()`, then one
    transaction that rewrites only the differing `track_names` rows (prev_* per the «Άλλαξαν» rule), deletes
    rows of tracks that no longer qualify, reindexes the FTS rows whose shown name changed (through
    names_show.reindex_changed) and writes the run record. `cancelled` is asked between phases and before the
    write transaction. `cause`: launch, scan, analysis, links, decision:<id>, switch, manual, import."""
    from .names import digest as engine_digest
    from .names import questions, resolve

    stop = cancelled or (lambda: False)
    clock, started = time.perf_counter(), datetime.now(UTC)

    def result(state: str, **more) -> RunResult:
        return RunResult(state, seconds=round(time.perf_counter() - clock, 2), **more)

    copy_canonical_edits(session)  # the one write a run makes to name_decisions: a lost /canonical edit
    snap = snapshot(session, with_off=False)
    last = read_run_record() or {}
    if stop():
        return result("cancelled")
    if snap.stale_key_decisions:
        write_run_record({"ruleset": engine_ruleset(), "engine_digest": engine_digest(), "input_digest": "",
                          "started_at": _iso(started), "written": 0, "counts": _counts(session), "reach": {},
                          "open": [], "patterns": [], **last, "state": "refused", "refusal": "key_version",
                          "cause": cause, "finished_at": _iso(datetime.now(UTC)),
                          "seconds": round(time.perf_counter() - clock, 2)})
        return result("refused", counts=_counts(session))
    counts = _counts(session)
    if last.get("input_digest") == snap.digest and sum((last.get("counts") or {}).values()) == sum(counts.values()):
        write_run_record({**last, "state": "unchanged", "refusal": None, "cause": cause,
                          "finished_at": _iso(datetime.now(UTC))})
        return result("unchanged", counts=counts, reach=dict(last.get("reach") or {}))

    snap = _with_off(session, snap)
    if stop():
        return result("cancelled")
    resolution = resolve(snap.inputs, snap.references, snap.decisions)
    if stop():
        return result("cancelled")
    patterns = questions.pattern_questions(resolution, list(snap.inputs), list(snap.decisions))
    existing = {row.track_id: row for row in session.exec(select(TrackName)).all()}
    written = renamed = 0
    reindex: list[int] = []
    now = datetime.now(UTC)
    if stop():
        session.rollback()
        return result("cancelled")
    for track_id in sorted(resolution.tracks):
        values = _row_values(resolution.tracks[track_id], snap, resolution.ruleset)
        row = existing.pop(track_id, None)
        if row is None:
            session.add(TrackName(track_id=track_id, **values))
            written += 1
            reindex.append(track_id)
            continue
        if all(getattr(row, key) == value for key, value in values.items()):
            continue
        before, after = (row.artist, row.title, row.folder), (values["artist"], values["title"], values["folder"])
        if before != after:
            renamed += 1
            if row.prev_artist is None and row.prev_title is None and row.prev_folder is None:
                row.prev_artist, row.prev_title, row.prev_folder = before
                row.changed_at, row.changed_cause = now, _changed_cause(cause, row.ruleset, values["ruleset"])
            elif after == (row.prev_artist, row.prev_title, row.prev_folder):
                row.prev_artist = row.prev_title = row.prev_folder = row.changed_at = row.changed_cause = None
            if before[:2] != after[:2]:
                reindex.append(track_id)
        for key, value in values.items():
            setattr(row, key, value)
        session.add(row)
        written += 1
    for track_id, row in existing.items():  # a track that is gone, missing or unread again has no result
        session.delete(row)
        written += 1
        reindex.append(track_id)
    session.flush()
    reindexed = 0
    if reindex and names_switch.is_on(session):
        from . import names_show

        reindexed = names_show.reindex_changed(session, sorted(reindex), commit=False) or 0
    session.commit()

    counts = _counts(session)
    reach = dict(last.get("reach") or {})
    if cause.startswith("decision:"):
        reach[cause.split(":", 1)[1]] = renamed
    seconds = round(time.perf_counter() - clock, 2)
    write_run_record({
        "state": "done", "ruleset": resolution.ruleset, "engine_digest": engine_digest(),
        "input_digest": snap.digest, "cause": cause, "started_at": _iso(started),
        "finished_at": _iso(datetime.now(UTC)), "seconds": seconds, "written": written, "counts": counts,
        "reach": reach, "refusal": None, "open": resolution.open_items, "patterns": patterns})
    return RunResult("done", written=written, counts=counts, reach=reach, reindexed=reindexed, seconds=seconds)


# ---------------------------------------------------------------- the queue
# At most one run waits and at most one runs, both held here, in memory: a waiting run has no `jobs` row, so
# orphan recovery never discards it. Lock order: worker.submission_lock, then _LOCK (never the other way).
_LOCK = threading.RLock()
_pending: dict | None = None  # {"cause", "force"}
_running: dict | None = None  # {"cause", "force", "job_id", "cancel": threading.Event}
_dispatcher: threading.Thread | None = None
POLL_S = 2.0
JOB_MESSAGE = {"unchanged": "Τα ονόματα είναι ήδη ενημερωμένα",
               "cancelled": "Η ενημέρωση ονομάτων σταμάτησε για άλλη εργασία· θα ξανατρέξει μετά",
               "refused": REFUSAL_TEXT}
JOB_ERROR = "Η ενημέρωση των ονομάτων απέτυχε· τα προηγούμενα ονόματα διατηρούνται."


def request_run(cause: str, *, force: bool = False) -> bool:
    """Ask for a run in the background: at most one waits (in memory, no Job row until it starts), and it does
    not start while a scan or analysis job is active or two decks play. Returns True when a run is now queued
    or running. With the switch off nothing is queued unless `force` («Ενημέρωση ονομάτων», turning the
    switch on, the answers import). Safe to call from any thread and from a finished job."""
    global _pending
    if not force and not names_switch.is_on():
        return False
    with _LOCK:
        waiting = _pending
        # A burst of answers runs once. The run keeps the latest cause, but an answer's cause is not replaced
        # by a scan or a link change, so «άλλαξε N κομμάτια» stays with an answer.
        keep = waiting is not None and waiting["cause"].startswith("decision:") and not cause.startswith("decision:")
        _pending = {"cause": waiting["cause"] if keep else cause, "force": force or bool(waiting and waiting["force"])}
        _ensure_dispatcher()
    return True


def yield_to(kind: str) -> bool:
    """Called by `worker.create_job` before any job row is created. For `scan` and `analyze` a running names
    run is told to stop (it writes nothing) and is queued again; other kinds change nothing. Returns True when
    a run was cancelled. Never refuses and never raises: a names run may not block another job."""
    try:
        if kind not in ("scan", "analyze"):
            return False
        with _LOCK:
            if _running is None:
                return False
            _running["cancel"].set()  # run_job queues it again when it has stopped
            return True
    except Exception:  # noqa: BLE001
        logger.exception("names_yield_failed kind=%s", kind)
        return False


def run_state() -> dict:
    """{"state": "idle" | "queued" | "running", "cause": str | None, "job_id": int | None}."""
    with _LOCK:
        if _running is not None:
            return {"state": "running", "cause": _running["cause"], "job_id": _running["job_id"]}
        if _pending is not None:
            return {"state": "queued", "cause": _pending["cause"], "job_id": None}
    return {"state": "idle", "cause": None, "job_id": None}


def _blocked() -> bool:
    """A run waits while any other job is pending or running, or while a two-deck set plays."""
    from ..api.deck_rescue import deck_playing
    from ..db import get_engine
    from ..jobs import worker

    if deck_playing():
        return True
    with Session(get_engine()) as session:
        worker.recover_orphan_jobs(session)  # as every job start does: a dead job's row must not hold a run back
        return session.exec(select(Job.id).where(Job.status.in_(("pending", "running")), Job.kind != "names")).first() is not None


def _step() -> str:
    """One turn of the dispatcher: `idle` (nothing waits or runs), `busy` (a run is running), `wait` (the
    waiting run may not start yet) or `started`."""
    global _pending, _running
    from ..db import get_engine
    from ..jobs import worker

    with _LOCK:
        if _running is not None:
            if _running["job_id"] in worker.active_job_ids():
                return "busy"
            _running = None  # its thread is gone without reporting back
        if _pending is None:
            return "idle"
    with worker.submission_lock:  # no scan or analysis can be created between the check and our job row
        if _blocked():
            return "wait"
        with _LOCK:
            item, _pending = _pending, None
        if item is None or not (item["force"] or names_switch.is_on()):
            return "idle"
        with Session(get_engine()) as session:
            job_id = worker.create_job(session, "names").id
        run_item = {**item, "job_id": job_id, "cancel": threading.Event()}
        with _LOCK:
            _running = run_item
        try:
            worker.start_names(job_id, item["cause"], run_item["cancel"].is_set)
        except Exception:  # noqa: BLE001 - maintenance in progress, or no thread: wait and try again
            logger.exception("names_start_failed job_id=%s", job_id)
            worker._worker_failed(job_id, JOB_ERROR, engine=get_engine())
            with _LOCK:
                _running, _pending = None, _pending or item
            return "wait"
    return "started"


def _dispatch_loop() -> None:
    global _dispatcher
    while True:
        try:
            state = _step()
        except Exception:  # noqa: BLE001
            logger.exception("names_dispatch_failed")
            state = "wait"
        if state == "idle":
            with _LOCK:
                if _pending is None and _running is None:
                    _dispatcher = None
                    return
        time.sleep(0.2 if state == "started" else POLL_S)


def _ensure_dispatcher() -> None:
    global _dispatcher
    with _LOCK:
        if _dispatcher is None or not _dispatcher.is_alive():
            _dispatcher = threading.Thread(target=_dispatch_loop, daemon=True, name="names-queue")
            _dispatcher.start()


def run_job(job_id: int, cause: str, cancelled: Callable[[], bool] | None = None) -> RunResult | None:
    """The body of a `names` job (worker.start_names runs it in the job's thread): one run, the job row's
    Greek message, and the queue's bookkeeping. A cancelled run is queued again."""
    global _pending, _running
    from ..db import get_engine
    from ..jobs import worker

    outcome: RunResult | None = None
    try:
        with Session(get_engine()) as session:
            job = session.get(Job, job_id)
            if job is None:
                return None
            job.status, job.message = "running", "Καθαρισμός ονομάτων"
            session.add(job)
            session.commit()
            try:
                outcome = run(session, cause=cause, cancelled=cancelled)
            except Exception:  # noqa: BLE001 - a failed run leaves the last rows
                logger.exception("names_run_failed job_id=%s cause=%s", job_id, cause)
                session.rollback()
                worker._finish(session, job, "error", error=JOB_ERROR)
                return None
            message = JOB_MESSAGE.get(outcome.state) or (
                "Ονόματα: άλλαξε 1 κομμάτι" if outcome.written == 1
                else f"Ονόματα: άλλαξαν {outcome.written} κομμάτια" if outcome.written else "Ονόματα: καμία αλλαγή")
            worker._finish(session, job, "done", message)
            return outcome
    finally:
        with _LOCK:
            mine = _running is not None and _running["job_id"] == job_id
            if mine and outcome is not None and outcome.state == "cancelled" and _pending is None:
                _pending = {"cause": cause, "force": _running["force"]}
            if mine:
                _running = None
            if _pending is not None:
                _ensure_dispatcher()


def _reset_queue() -> None:
    """Forget the waiting and the running run (tests; a running thread still finishes on its own)."""
    global _pending, _running
    with _LOCK:
        _pending = _running = None


# ---------------------------------------------------------------- /canonical edits as track decisions
def record_canonical_edit(session: Session, event_id: int, track_ids: list[int], artist: str, title: str) -> int:
    """After a /canonical `edit` has committed in the identity library: one `track` decision (source
    `canonical`, `canonical_event_id`) per current member track, the track's previous active track decision
    revoked. Returns the rows written. A failure here is repaired by the next run, which copies an edit event
    that has no row at all."""
    written, now = 0, datetime.now(UTC)
    for track_id in sorted(set(track_ids)):
        if session.get(Track, track_id) is None:
            continue
        rows = session.exec(select(NameDecision).where(NameDecision.kind == "track",
                                                       NameDecision.track_id == track_id)).all()
        if any(r.canonical_event_id == event_id for r in rows):
            continue  # copied before (a revoked copy counts: an undone decision is never recreated)
        for row in rows:
            if row.revoked_at is None:
                row.revoked_at = now
                session.add(row)
        session.flush()  # one active row per (kind, track)
        session.add(NameDecision(kind="track", scope="", track_id=track_id, value=f"{artist} | {title}",
                                 source="canonical", canonical_event_id=event_id))
        written += 1
    session.commit()
    return written


def copy_canonical_edits(session: Session, recording_id: str | None = None) -> int:
    """Copy every /canonical `edit` that is still its recording's state and has no decision row at all (a
    revoked one counts) into track decisions. A track whose own correction is later than the edit keeps it.
    The route calls this for its recording right after the identity commit; every run calls it for all, so
    a copy that failed between the two databases is made later. Returns the rows written."""
    from . import canonical_library, identity_library

    if not canonical_library.catalog_session_matches(session):
        return 0
    try:
        with identity_library.connect() as db:
            tables = _tables(db)
            if not {"entities", "canonical_recordings", "canonical_events"} <= tables:
                return 0
            edits = {rid: event for rid, event in _review_events(db, tables, recording_id).items()
                     if event[1] == "edit"}
            if not edits:
                return 0
            human = {r[0] for r in db.execute("SELECT recording_id FROM canonical_recordings WHERE state='human'")}
            members: dict[str, list[int]] = defaultdict(list)
            for track_id, rid in _current_locals(db, recording_id):
                members[rid].append(track_id)
    except sqlite3.Error:
        return 0
    known = set(session.exec(select(NameDecision.canonical_event_id)
                             .where(NameDecision.canonical_event_id.is_not(None))).all())
    written = 0
    for rid, (event_id, _action, created_at, after_json) in sorted(edits.items()):
        if rid not in human or event_id in known or not members.get(rid):
            continue
        try:
            after = json.loads(after_json or "{}")
        except ValueError:
            continue
        artist, title = (after.get("artist") or "").strip(), (after.get("title") or "").strip()
        if not artist or not title:
            continue
        edited_at, keep = _aware(created_at), []
        for track_id in members[rid]:
            own = session.exec(select(NameDecision).where(
                NameDecision.kind == "track", NameDecision.track_id == track_id,
                NameDecision.revoked_at.is_(None))).first()
            if own is not None and edited_at is not None and (_aware(own.created_at) or edited_at) > edited_at:
                continue  # the owner's later correction on /names stands
            keep.append(track_id)
        written += record_canonical_edit(session, event_id, keep, artist, title)
    return written


def after_identity_write(recording_id: str | None = None, action: str = "") -> None:
    """Called by the identity routes after their commit: a /canonical `edit` becomes track decisions, and a
    run is asked for (only while the switch is on). Never raises: the identity write has already happened."""
    try:
        if action == "edit" and recording_id:
            from ..db import get_engine

            with Session(get_engine()) as session:
                copy_canonical_edits(session, recording_id)
        request_run("links")
    except Exception:  # noqa: BLE001
        logger.exception("names_after_identity_write_failed")


# ---------------------------------------------------------------- the owner's answers file
def _answer_rows(answers: dict | None) -> list[tuple]:
    """owner-answers.json's entries as (kind, scope, value, provisional), by run.py `load_answers`; an entry
    that gives the engine nothing («pass», «pair:similar_names», «note:…») gives no row."""
    out = []
    for a in (answers or {}).get("answers", []):
        scope, answer = a["scope"], a["answer"].strip()
        if answer == "pass" or scope == "pair:similar_names" or scope.startswith("note:"):
            continue
        if scope.startswith(("pref:", "status:")):
            out.append(("preference", scope, answer, False))
        elif scope.startswith("pair:") and "|" in scope:
            x, _, y = scope[5:].partition("|")
            if a.get("into") == x:
                scope = f"pair:{y}|{x}"
            if answer not in ("same", "different"):
                raise BadAnswer(f"{scope}: «{answer}» is neither same nor different")
            out.append(("same_act", scope, {"same": "yes", "different": "no"}[answer], bool(a.get("provisional"))))
        elif scope.startswith("name:"):
            out.append(("not_act", scope, "label" if answer == "A" else "no", False))
        else:
            raise BadAnswer(f"unknown scope {scope!r}")
    return out


def import_answers(session: Session, answers: dict, seed_rows: list[dict] | None = None,
                   loose_folders: tuple[str, ...] = (), *, dry_run: bool = False) -> dict:
    """Write the owner's research answers as `name_decisions` rows, once: `answers` is owner-answers.json's
    object ({"answers": [{"scope", "answer", "date", "into"?, "provisional"?}, …]}), `seed_rows` the rows of
    decisions-seed.csv (kind, scope, options, απόφαση, source). The mapping is run.py's `load_answers` and
    `load_decisions`. A decision that already has an active or revoked row is skipped, so a second import and
    an undone answer are both left alone. Returns {"added": n, "skipped": n, "rejected": [reasons]}."""
    from .names import KEY_VERSION

    rejected: list[str] = []
    wanted: list[dict] = []  # kind, scope, track_id, value, source, provisional
    for row in seed_rows or []:
        cell = (row.get("απόφαση") or "").strip()
        if not cell:
            continue
        kind, scope = row.get("kind") or "", row.get("scope") or ""
        try:
            value = cell_value(kind, (row.get("options") or "").split(" ‖ "), cell)
        except BadAnswer as error:
            rejected.append(f"{kind} {scope} «{cell}»: {error}")
            continue
        track_id = None
        if kind == "track":
            if not scope.startswith("track:") or not scope[6:].isdigit():
                rejected.append(f"{kind} {scope}: not a track scope")
                continue
            track_id, scope = int(scope[6:]), ""
            if session.get(Track, track_id) is None:
                rejected.append(f"track {track_id}: no such track")
                continue
        elif kind not in ENGINE_KINDS:
            rejected.append(f"{kind} {scope}: unknown kind")
            continue
        wanted.append({"kind": kind, "scope": scope, "track_id": track_id, "value": value, "source": "seed",
                       "provisional": False})
    try:
        for kind, scope, value, provisional in _answer_rows(answers):
            wanted.append({"kind": kind, "scope": scope, "track_id": None, "value": value, "source": "owner",
                           "provisional": provisional})
    except (BadAnswer, KeyError, AttributeError) as error:
        rejected.append(f"owner answers: {error}")
    for word in loose_folders:
        if word.strip():
            wanted.append({"kind": names_switch.KIND, "scope": names_switch.LOOSE_FOLDER_PREFIX + word.strip(),
                           "track_id": None, "value": word.strip(), "source": "owner", "provisional": False})

    have = {(d.kind, d.scope, d.track_id) for d in session.exec(select(NameDecision)).all()}
    added = skipped = 0
    for item in wanted:
        key = (item["kind"], item["scope"], item["track_id"])
        if key in have:
            skipped += 1
            continue
        have.add(key)
        added += 1
        if not dry_run:
            session.add(NameDecision(**item, key_version=KEY_VERSION if item["scope"].startswith(("act:", "pair:")) else None))
    if not dry_run:
        session.commit()
    return {"added": added, "skipped": skipped, "rejected": rejected}
