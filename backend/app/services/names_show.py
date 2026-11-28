"""«Καθαρά ονόματα»: what the app shows and tells about it (stage 1). Reads `track_names`; never imports the
engine and never writes a name.

The overlay step (`apply`, called from canonical_library.overlay), the search side (`reindex_changed`, the
`names:` tokens and the `artist:` match used by services/search.py), and the three payloads of
api/names_status.py. Contract: .omc/research/name-cleaning-2026-11-27/integration/CONTRACT.md.
"""
from __future__ import annotations

import json
from datetime import UTC, datetime

from sqlalchemy import Integer, case, false, func, or_
from sqlalchemy.exc import OperationalError
from sqlmodel import Session, select

from ..models import NameDecision, Track, TrackName
from . import artist_catalog, artist_intelligence, names_store, names_switch
from .sql_ids import ids_in
from .text_fold import fold_text

UNKNOWN_ARTIST = "Άγνωστος καλλιτέχνης"  # shown for status `none`, whose stored artist is ''

STATUSES = ("sure", "look", "open", "none", "hand")
# The same words as frontend/src/lib/namesLabels.ts NAME_STATUS_LABEL and names/explain.py STATUS_TEXT.
STATUS_TEXT = {"sure": "", "look": "Για ματιά", "open": "Για απόφαση", "none": "Χωρίς καλλιτέχνη",
               "hand": "Δική σου διόρθωση"}
SOURCE_TEXT = {"owner": "Δική σου διόρθωση", "seed": "Δική σου διόρθωση", "canonical": "Από τη σελίδα ταυτότητας"}
ACCEPT_TEXT = "Το δέχτηκες με «Εντάξει»"
REFUSAL_TEXT = {
    "key_version": "Οι απαντήσεις σου γράφτηκαν με παλαιότερη έκδοση των κανόνων· τα ονόματα δεν ενημερώθηκαν",
}
NO_LINKS_NOTE = "χωρίς τα στοιχεία της πηγής, κατ' επιλογή σου"
# The facts of the preview sheet's column (run.py `facts_text`), in its order.
NOTE_LABELS = (
    ("original", "Αρχικός καλλιτέχνης"), ("members", "Μέλη"), ("alias", "Γνωστός και ως"), ("album", "Άλμπουμ"),
    ("label", "Δισκογραφική"), ("spotify", "Το Spotify γράφει"), ("key", "Τονικότητα"), ("tempo_note", "Tempo"),
    ("tag", "Σημείωση"), ("tag_artist", "Το tag γράφει"), ("compilers", "Επιμέλεια"),
    ("preview", "Προεπισκόπηση"), ("removed", "Από τον τίτλο"),
)


class SwitchRefused(Exception):
    """The switch may not be turned on yet. `args[0]` is the Greek reason shown to the owner."""


# ---------------------------------------------------------------- shared conditions over track_names
def _changed():
    """The shown name differs from the switch-off name (`names:changed`)."""
    return or_(TrackName.artist != TrackName.off_artist, TrackName.title != TrackName.off_title)


def _new():
    """An unacknowledged change of a run (`names:new`, «Άλλαξαν από την τελευταία ματιά»)."""
    return or_(TrackName.changed_at.is_not(None), TrackName.prev_artist.is_not(None),
               TrackName.prev_title.is_not(None), TrackName.prev_folder.is_not(None))


def _count_where(condition):
    """How many rows meet `condition`. Not `sum(condition)`: SQLAlchemy reads a sum of a boolean back as a
    boolean, so any count above 1 came back as 1."""
    return func.coalesce(func.sum(case((condition, 1), else_=0), type_=Integer), 0)


def search_criterion(value: str):
    """`names:<value>` as a criterion on Track.id; an unknown value matches nothing. The tokens read the stored
    rows, so they also answer with the switch off (the rows of the last run)."""
    value = value.strip().lower()
    if value in STATUSES:
        where = TrackName.status == value
    elif value == "changed":
        where = _changed()
    elif value == "new":
        where = _new()
    else:
        return false()
    return Track.id.in_(select(TrackName.track_id).where(where))


def artist_criterion(session: Session, value: str):
    """`artist:` over the shown artists, or None while the switch is off (search is then exactly today's)."""
    if not names_switch.is_on(session):
        return None
    return Track.id.in_(select(TrackName.track_id).where(
        func.instr(func.cratemind_fold(TrackName.artist), fold_text(value)) > 0))


# ---------------------------------------------------------------- the overlay step
def _utc(value) -> datetime | None:
    """A stored or ISO time as an aware UTC datetime (SQLite hands naive UTC values back)."""
    if isinstance(value, str):
        try:
            value = datetime.fromisoformat(value)
        except ValueError:
            return None
    if not isinstance(value, datetime):
        return None
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _awaiting_run(session: Session, human_at: dict) -> set:
    """Tracks whose /canonical row is newer than the last finished run's start: they show that row for the
    seconds until the queued run finishes. An owner correction made after the /canonical edit is not one of
    them (its row was written at once)."""
    record = names_store.read_run_record() or {}
    started = _utc(record.get("started_at"))
    if started is None:
        return set()
    waiting = {tid: at for tid, raw in human_at.items() if (at := _utc(raw)) is not None and at > started}
    if waiting:
        for tid, created in session.exec(
            select(NameDecision.track_id, NameDecision.created_at).where(
                NameDecision.kind == "track", NameDecision.source == "owner", NameDecision.revoked_at.is_(None),
                ids_in(NameDecision.track_id, sorted(waiting)))
        ).all():
            if (_utc(created) or started) > waiting[tid]:
                del waiting[tid]
    return set(waiting)


def apply(rows: list[dict], session: Session | None, *, human_at: dict | None = None) -> list[dict]:
    """The overlay's last step, on every exit of `canonical_library.overlay`. With the switch on and a
    `track_names` row for the track: replace `artist` and `title`, add `names_status` and `names_off`
    ({"artist", "title"}: the values replaced). With the switch off, or no row: the row is returned exactly as
    it came. BPM fields, `original_*` and `metadata_provenance` are never touched. `human_at` is
    {track id: updated_at} of the rows whose /canonical recording is `human` (see `_awaiting_run`)."""
    if not rows or session is None:
        return rows
    try:
        if not names_switch.is_on(session):
            return rows
        ids = sorted({tid for row in rows if (tid := row.get("id", row.get("track_id"))) is not None})
        names = {tid: (artist, title, status) for tid, artist, title, status in session.exec(
            select(TrackName.track_id, TrackName.artist, TrackName.title, TrackName.status)
            .where(ids_in(TrackName.track_id, ids))).all()}
        skip = _awaiting_run(session, human_at) if human_at and names else set()
    except OperationalError:  # a catalog without the table: today's names
        return rows
    for row in rows:
        tid = row.get("id", row.get("track_id"))
        if tid not in names or tid in skip:
            continue
        artist, title, status = names[tid]
        row["names_off"] = {"artist": row.get("artist"), "title": row.get("title")}
        row["artist"] = UNKNOWN_ARTIST if status == "none" and not artist else artist
        row["title"] = title or row.get("title")  # a file with no tags at all has no engine title: keep today's
        row["names_status"] = status
    return rows


# ---------------------------------------------------------------- search index
def reindex_changed(session: Session, track_ids: list[int] | None = None, *, commit: bool = True) -> int:
    """Reindex the FTS rows whose shown name differs from the stored one (all of them when `track_ids` is None:
    a switch turn). Returns the number of rows reindexed. Called by the switch route and by a run."""
    from ..db import reindex_track

    if track_ids is None:
        track_ids = list(session.exec(
            select(TrackName.track_id).join(Track, Track.id == TrackName.track_id).where(or_(
                TrackName.artist != func.coalesce(Track.artist, ""),
                TrackName.title != func.coalesce(Track.title, "")))
        ).all())
    for track_id in track_ids:
        reindex_track(session, track_id, commit=False)
    if commit:
        session.commit()
    return len(track_ids)


# ---------------------------------------------------------------- status and the switch
def _blocked_reason(unread: int) -> str | None:
    if not unread:
        return None
    if unread == 1:
        return "1 κομμάτι δεν έχει διαβαστεί ακόμη: κάνε σάρωση"
    return f"{unread} κομμάτια δεν έχουν διαβαστεί ακόμη: κάνε σάρωση"


def _scan_roots() -> list[str]:
    """The library folders a scan walks, each ending in a slash; empty when none is known."""
    from ..config import get_settings
    return [str(root).replace("\\", "/").rstrip("/") + "/" for root in get_settings().roots]


def _unread(session: Session) -> int:
    """Present tracks a scan has still to read (`raw_state` NULL). A track outside every library folder (a file
    played once from elsewhere, say Downloads) is not counted: no scan reaches it, so it would block the switch
    for ever. It gets no stored name and keeps the one shown with the switch off. With no folder known, all count."""
    paths = session.exec(
        select(Track.absolute_path).where(Track.missing == False, Track.raw_state.is_(None))  # noqa: E712
    ).all()
    roots = _scan_roots() if paths else []
    if not roots:
        return len(paths)
    return sum(1 for path in paths if path.replace("\\", "/").startswith(tuple(roots)))  # «\\»: a Windows path


def status(session: Session) -> dict:
    """The payload of GET /api/names/status (api/names_status.py `NamesStatus`)."""
    present, unreadable = session.exec(
        select(func.count(), _count_where(Track.raw_state == "unreadable"))
        .select_from(Track).where(Track.missing == False)  # noqa: E712
    ).one()
    unread = _unread(session)
    counts = dict.fromkeys(STATUSES, 0)
    named = accepted = changed = new = 0
    for name_status, n, n_accepted, n_changed, n_new in session.exec(
        select(TrackName.status, func.count(), _count_where(TrackName.accepted == True),  # noqa: E712
               _count_where(_changed()), _count_where(_new()))
        .join(Track, Track.id == TrackName.track_id).where(Track.missing == False)  # noqa: E712
        .group_by(TrackName.status)
    ).all():
        named += n
        changed += int(n_changed or 0)
        new += int(n_new or 0)
        if name_status in counts:
            counts[name_status] = n
        if name_status == "look":
            accepted = int(n_accepted or 0)
    record = names_store.read_run_record() or {}
    refusal = record.get("refusal") if record.get("refusal") in REFUSAL_TEXT else None
    last_run = None
    if record.get("finished_at"):
        last_run = {"finished_at": str(record["finished_at"]), "ruleset": str(record.get("ruleset") or ""),
                    "cause": str(record.get("cause") or ""), "written": int(record.get("written") or 0),
                    "seconds": float(record.get("seconds") or 0.0)}
    return {
        "on": names_switch.is_on(session), "can_turn_on": not unread, "blocked_reason": _blocked_reason(unread),
        "ruleset": names_store.engine_ruleset(), "present": present, "named": named, "unread": unread,
        "unreadable": int(unreadable), "counts": counts, "accepted": accepted, "changed": changed, "new": new,
        "run": names_store.run_state(), "last_run": last_run, "refusal": refusal,
        "refusal_text": REFUSAL_TEXT.get(refusal),
    }


def set_switch(session: Session, on: bool) -> dict:
    """Turn the switch (names_switch.set_on), reindex the rows whose shown name differs and, when turning on,
    ask for a run (names_store.request_run("switch", force=True)). Raises SwitchRefused while a present track
    has `raw_state` NULL, and on any change while artist research waits or runs. A change rebuilds the artist
    pages (artist_catalog.rebuild_quietly). Returns `status(session)`."""
    if on and (unread := _unread(session)):
        raise SwitchRefused(_blocked_reason(unread))
    if names_switch.is_on(session) != bool(on) and artist_intelligence.research_running(session):
        raise SwitchRefused(artist_intelligence.SWITCH_WAIT_TEXT)
    if names_switch.set_on(session, on, commit=False):
        reindex_changed(session, commit=False)  # reads the new switch state in this transaction
        session.commit()
        artist_catalog.rebuild_quietly(session)  # the artist pages follow the switch (it holds no lock of ours)
        if on:
            names_store.request_run("switch", force=True)
    return status(session)


# ---------------------------------------------------------------- one track's why
def _iso(value) -> str:
    at = _utc(value)
    return at.isoformat() if at else ""


def _json(text: str, default):
    try:
        value = json.loads(text or "")
    except ValueError:
        return default
    return value if isinstance(value, type(default)) else default


def _fact_text(value) -> str:
    return ", ".join(str(v) for v in value) if isinstance(value, (list, tuple)) else str(value)


def _facts(facts: dict) -> list[dict]:
    out = []
    if facts.get("tempo"):
        out.append({"label": "Tempo", "value": _fact_text(facts["tempo"])})
    notes = facts.get("notes") if isinstance(facts.get("notes"), dict) else {}
    for key, label in NOTE_LABELS:
        if notes.get(key):
            out.append({"label": label, "value": _fact_text(notes[key])})
    if facts.get("remixers"):
        out.append({"label": "Remix", "value": _fact_text(sorted(set(map(str, facts["remixers"]))))})
    if facts.get("album_credit"):
        out.append({"label": "Καλλιτέχνης άλμπουμ", "value": _fact_text(facts["album_credit"])})
    return out


def _cause_text(cause: str | None) -> str:
    cause = cause or ""
    if cause.startswith("ruleset:"):
        return f"Νέα έκδοση των κανόνων ({cause[len('ruleset:'):].replace('→', ' → ')})"
    if cause.startswith("decision:"):
        return "Μετά από απάντησή σου"
    return {"scan": "Μετά από σάρωση", "links": "Άλλαξαν οι συνδέσεις με τις πηγές",
            "analysis": "Μετά από ανάλυση"}.get(cause, "Ενημέρωση ονομάτων")


def _open_question(track_id: int) -> str | None:
    for item in (names_store.read_run_record() or {}).get("open") or []:
        if isinstance(item, dict) and track_id in (item.get("tracks") or []) and item.get("question"):
            return str(item["question"])
    return None


def _steps(row: TrackName) -> list[dict]:
    steps = [{"rule": str(step[0]), "field": str(step[1]), "text": str(step[2])}
             for step in _json(row.why_json, []) if isinstance(step, (list, tuple)) and len(step) >= 3]
    if row.status == "none" and not any(s["field"] in ("artist", "pair") for s in steps):
        # No rule names the empty artist: say why there is none (no rule id beside it).
        steps.append({"rule": "", "field": "artist", "text": names_store.engine_rule_text("none")})
    return steps


def why(session: Session, track_id: int) -> dict | None:
    """The payload of GET /api/names/tracks/{id} (api/names_status.py `NameWhy`); None for an unknown track."""
    track = session.get(Track, track_id)
    if track is None:
        return None
    payload: dict = {
        "track_id": track_id, "on": names_switch.is_on(session), "has_row": False,
        "raw": {"artist": track.raw_artist, "title": track.raw_title, "album": track.raw_album,
                "track_no": track.raw_track_no,
                "state": track.raw_state if track.raw_state in ("ok", "unreadable") else None},
    }
    row = session.get(TrackName, track_id)
    if row is None:
        return payload
    decisions = {d.kind: d for d in session.exec(
        select(NameDecision).where(NameDecision.track_id == track_id, NameDecision.revoked_at.is_(None),
                                   NameDecision.kind.in_(("track", "accept")))).all()}
    decision = decisions.get("track") or decisions.get("accept")
    status_text = STATUS_TEXT.get(row.status, "")
    if decision is not None and decision.kind == "track" and row.status == "hand":
        status_text = SOURCE_TEXT.get(decision.source, status_text)
    from .canonical_library import overlay_off

    state = overlay_off([{"id": track_id, "artist": track.artist, "title": track.title,
                          "file_name": track.file_name}], session)[0].get("canonical_state")
    change = None
    if row.changed_at is not None or any(v is not None for v in (row.prev_artist, row.prev_title, row.prev_folder)):
        change = {"prev_artist": row.prev_artist, "prev_title": row.prev_title, "prev_folder": row.prev_folder,
                  "changed_at": _iso(row.changed_at) or None, "cause_text": _cause_text(row.changed_cause)}
    payload.update({
        "has_row": True, "status": row.status if row.status in STATUSES else None, "status_text": status_text,
        "artist": row.artist, "title": row.title or row.off_title or "", "folder": row.folder,
        "off_artist": row.off_artist, "off_title": row.off_title,
        "open_question": (_open_question(track_id) or str(_json(row.facts_json, {}).get("question") or "") or None)
        if row.status == "open" else None,
        "open_code": row.open_code or "",
        "steps": _steps(row),
        "facts": _facts(_json(row.facts_json, {})),
        "accepted": bool(row.accepted),
        "decision": decision and {
            "id": decision.id, "kind": decision.kind, "source": decision.source,
            "source_text": ACCEPT_TEXT if decision.kind == "accept" else SOURCE_TEXT.get(decision.source, ""),
            "undoable": decision.source != "canonical", "created_at": _iso(decision.created_at),
        },
        "change": change,
        "note": NO_LINKS_NOTE if state in ("kept_local", "rejected") else None,
        "ruleset": row.ruleset,
    })
    return payload
