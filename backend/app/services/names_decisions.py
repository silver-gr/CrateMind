"""«Καθαρά ονόματα», stage 2: the owner's answers, corrections, «Εντάξει» and acknowledgements.

Every function writes `name_decisions` rows in the engine's own grammar (kind, scope, value), revokes instead of
deleting, and asks for a run (`names_store.request_run("decision:<id>")`). A letter or a typed value becomes the
row's value through `names_store.cell_value`, except for two kinds whose engine value is not an option's text:
a pattern answer (`preference`) stores its letter and a «name:…» answer (`not_act`) stores «label» or «no», as
the preview's answers importer (run.py `load_answers`) does. The only `track_names` columns written here are the
owner's immediate ones: a hand correction's artist, title and status `hand`, `accepted`, and the `prev_*`
columns an acknowledgement clears. It never imports the engine: the questions come from the last run's record
(`names_store.read_run_record()`), and the Greek sentence of a rule from the row's own `why_json`.
Contract: .omc/research/name-cleaning-2026-11-27/integration/CONTRACT.md.
"""
from __future__ import annotations

import json
import logging
from collections import Counter
from datetime import UTC, datetime

from sqlmodel import Session, select

from .. import db as dbmod
from ..models import NameDecision, Track, TrackName
from . import names_store

log = logging.getLogger(__name__)

TEXT_KINDS = {"track", "spelling", "album_credit"}  # questions that take a typed value («Άλλο…»)
TEXT_HINT = {"track": "Καλλιτέχνης | Τίτλος", "spelling": "Η σωστή γραφή του ονόματος",
             "album_credit": "Καλλιτέχνης & Καλλιτέχνης"}
NOT_LISTED = {"setting", "accept"}  # never in «Οι απαντήσεις σου» (the switch, and one «Εντάξει» per look track)
FILE_CHANGED = "file"  # «Άλλαξαν» group: a corrected track whose file changed after the correction
SOURCE_TEXT = {"owner": "Δική σου απάντηση", "seed": "Από τις αρχικές απαντήσεις",
               "canonical": "από τη σελίδα ταυτότητας"}


class DecisionError(Exception):
    """An answer the service refuses. `args[0]` is the Greek sentence shown to the owner; `status` the HTTP code."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------- small helpers
def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _iso(value: datetime | None) -> str | None:
    value = _aware(value)
    return value.isoformat() if value else None


def _options(strings) -> list[dict]:
    out = []
    for item in strings or ():
        letter, sep, text = str(item).partition("=")
        if sep and len(letter) == 1:
            out.append({"letter": letter, "text": text})
    return out


def _record() -> dict | None:
    return names_store.read_run_record()


def _question_index(record: dict | None) -> dict[tuple[str, str], tuple[str, dict]]:
    out: dict[tuple[str, str], tuple[str, dict]] = {}
    for section, key in (("open", "open"), ("pattern", "patterns")):
        for item in (record or {}).get(key) or []:
            out.setdefault((item.get("kind", ""), item.get("scope", "")), (section, item))
    return out


def _track_scope(scope: str) -> int | None:
    if scope.startswith("track:"):
        try:
            return int(scope[len("track:"):])
        except ValueError:
            return None
    return None


def _scope_of(row: NameDecision) -> str:
    return f"track:{row.track_id}" if row.track_id is not None else row.scope


def _active(session: Session, kind: str, scope: str = "", track_id: int | None = None) -> NameDecision | None:
    q = select(NameDecision).where(NameDecision.kind == kind, NameDecision.revoked_at.is_(None))
    if track_id is not None:
        q = q.where(NameDecision.track_id == track_id)
    else:
        q = q.where(NameDecision.scope == scope, NameDecision.track_id.is_(None))
    return session.exec(q).first()


def _write(session: Session, kind: str, value: str, *, scope: str = "", track_id: int | None = None,
           source: str = "owner", canonical_event_id: int | None = None) -> NameDecision:
    """Revoke the active row of (kind, scope) or (kind, track), then insert the new one (not committed)."""
    old = _active(session, kind, scope, track_id)
    if old is not None:
        old.revoked_at = datetime.now(UTC)
        session.add(old)
        session.flush()  # the partial unique index allows one active row
    key_version = names_store.engine_key_version() if scope.startswith(("act:", "pair:")) else None
    row = NameDecision(kind=kind, scope="" if track_id is not None else scope, track_id=track_id, value=value,
                       source=source, key_version=key_version, canonical_event_id=canonical_event_id)
    session.add(row)
    session.flush()
    return row


def _ask_run(row_id: int | None) -> None:
    """Queue the run that applies an answer. The answer is already committed; a failed request only waits for
    the next trigger (with the switch off nothing is queued, which is not a failure)."""
    if row_id is None:
        return
    try:
        names_store.request_run(f"decision:{row_id}")
    except Exception:  # noqa: BLE001 - the owner's write stands either way
        log.exception("names: could not queue the run after decision %s", row_id)


def _run_state() -> dict:
    try:
        return names_store.run_state()
    except Exception:  # noqa: BLE001
        return {"state": "idle", "cause": None, "job_id": None}


def _why(row: TrackName) -> list:
    try:
        steps = json.loads(row.why_json or "[]")
    except ValueError:
        return []
    return [s for s in steps if isinstance(s, (list, tuple)) and len(s) >= 3]


def _reason(row: TrackName) -> str:
    out: list[str] = []
    for step in _why(row):
        if step[2] and step[2] not in out:
            out.append(str(step[2]))
    return " · ".join(out)


def _chunks(ids: list[int], n: int = 90):
    for i in range(0, len(ids), n):
        yield ids[i:i + n]


def _names(session: Session, ids) -> dict[int, dict]:
    """ExampleTrack payloads: the engine's current name, else the stored one."""
    ids = sorted({int(i) for i in ids})
    out: dict[int, dict] = {}
    for part in _chunks(ids):
        for t in session.exec(select(Track).where(Track.id.in_(part))).all():
            out[t.id] = {"track_id": t.id, "artist": t.artist or "", "title": t.title or "",
                         "off_artist": t.artist or "", "off_title": t.title or ""}
        for n in session.exec(select(TrackName).where(TrackName.track_id.in_(part))).all():
            seen = out.get(n.track_id)
            if seen is not None:
                seen.update(artist=n.artist, title=n.title, off_artist=n.off_artist or seen["off_artist"],
                            off_title=n.off_title or seen["off_title"])
    return out


# ---------------------------------------------------------------- what an answer says, in Greek
def _value_text(row: NameDecision, item: dict | None) -> str:
    kind, value, scope = row.kind, row.value or "", row.scope or ""
    if item is not None and kind not in ("track", "accept"):
        options = {o["letter"]: o["text"] for o in _options(item.get("options"))}
        chosen = ""
        if kind == "preference":
            chosen = options.get(value.strip().upper(), "")
        elif kind == "not_act":
            chosen = options.get("A" if value.strip().lower() not in ("no", "όχι") else "B", "")
        elif kind == "same_act":
            chosen = options.get("B" if value.strip().lower() in ("yes", "ναι") else "A", "")
        elif kind == "bracket_word":
            chosen = options.get({"keep": "A", "genre": "B", "label": "C"}.get(value, ""), "")
        else:
            chosen = next((t for t in options.values() if t == value or "=" + t == value), value.lstrip("="))
        if chosen:
            return f"{item.get('question', '')} — {chosen}".strip(" —")
    key = scope.split(":", 1)[1] if ":" in scope else scope
    if kind == "track":
        artist, _, title = value.partition("|")
        return f"Διόρθωση: {artist.strip()} – {title.strip()}"
    if kind == "accept":
        parts = [p.strip() for p in value.split("|")]
        return "Εντάξει: " + " – ".join(p for p in parts[:2] if p)
    if kind == "spelling":
        return f"Το όνομα γράφεται «{value.lstrip('=').strip()}»"
    if kind == "same_act":
        a, _, b = key.partition("|")
        same = value.strip().lower() in ("yes", "ναι")
        return f"«{a}» και «{b}»: " + ("ο ίδιος καλλιτέχνης" if same else "διαφορετικοί καλλιτέχνες")
    if kind == "not_act":
        name = f"κάθε όνομα που τελειώνει σε «{key[1:]}»" if key.startswith("*") else f"«{key}»"
        return f"{name}: " + ("καλλιτέχνης" if value.strip().lower() in ("no", "όχι") else "δεν είναι καλλιτέχνης")
    if kind == "one_act":
        return f"«{key}»: ένας καλλιτέχνης"
    if kind == "bracket_word":
        what = {"keep": "μένει στο όνομα", "genre": "είδος μουσικής", "label": "δισκογραφική"}.get(value, value)
        return f"Η ετικέτα «[{key}]»: {what}"
    if kind == "album_credit":
        album = key.split("|", 1)[0]
        if value.strip().lower() in ("none", "όχι", "a"):
            return f"Το άλμπουμ «{album}»: κάθε κομμάτι στον δικό του φάκελο"
        return f"Το άλμπουμ «{album}»: φάκελος «{value.lstrip('=').strip()}»"
    if kind == "preference":
        return f"Απάντηση {value.strip().upper()} στην ερώτηση προτιμήσεων"
    return value


def _answer_out(session: Session, row: NameDecision, record: dict | None, index=None,
                tracks: dict[int, dict] | None = None) -> dict:
    index = _question_index(record) if index is None else index
    hit = index.get((row.kind, _scope_of(row)))
    reach = ((record or {}).get("reach") or {}).get(str(row.id))
    track = None
    if row.track_id is not None:
        track = (tracks if tracks is not None else _names(session, [row.track_id])).get(row.track_id)
    return {"id": row.id, "kind": row.kind, "scope": row.scope or "", "track_id": row.track_id,
            "value": row.value or "", "text": _value_text(row, hit[1] if hit else None),
            "source": row.source or "owner", "provisional": bool(row.provisional),
            "created_at": _iso(row.created_at) or "", "reach": reach if isinstance(reach, int) else None,
            "undoable": row.source != "canonical", "track": track}


# ---------------------------------------------------------------- questions and answers
def questions(session: Session) -> dict:
    """GET /api/names/questions (`QuestionsOut`): the engine's open questions and the pattern questions of the
    last run, each with the number of tracks it settles, up to five example tracks and its active answer."""
    record = _record()
    if record is None:
        return {"open": [], "patterns": [], "has_run": False, "run": _run_state()}
    index = _question_index(record)
    items = [("open", q) for q in record.get("open") or []] + [("pattern", q) for q in record.get("patterns") or []]
    wanted = {int(t) for _, q in items for t in (q.get("tracks") or [])[:5]}
    tracks = _names(session, wanted)
    active = session.exec(select(NameDecision).where(NameDecision.revoked_at.is_(None),
                                                     NameDecision.kind.not_in(NOT_LISTED))).all()
    by_scope = {(r.kind, _scope_of(r)): r for r in active}
    answer_tracks = _names(session, [r.track_id for r in by_scope.values() if r.track_id is not None])
    out = {"open": [], "patterns": [], "has_run": True, "run": _run_state()}
    for section, q in items:
        kind, scope = q.get("kind", ""), q.get("scope", "")
        ids = [int(t) for t in q.get("tracks") or []]
        row = by_scope.get((kind, scope))
        out["open" if section == "open" else "patterns"].append({
            "id": f"{kind}|{scope}", "kind": kind, "scope": scope, "section": section, "code": q.get("code") or "",
            "question": q.get("question") or "", "options": _options(q.get("options")),
            "allows_text": kind in TEXT_KINDS, "text_hint": TEXT_HINT.get(kind),
            "recommended": q.get("recommended") or None if section == "pattern" else None,
            "why": q.get("why") or None, "track_count": len(ids),
            "examples": [tracks[t] for t in ids[:5] if t in tracks],
            "answer": _answer_out(session, row, record, index, answer_tracks) if row is not None else None,
        })
    return out


def _value_for(kind: str, options: list[str], letter: str | None, text: str | None) -> str:
    """The row's value for one answer; refusals in Greek."""
    letters = {o["letter"] for o in _options(options)}
    letter = (letter or "").strip().upper()
    text = (text or "").strip()
    if bool(letter) == bool(text):
        raise DecisionError("Διάλεξε μία επιλογή ή γράψε μια τιμή.")
    if text:
        if kind not in TEXT_KINDS:
            raise DecisionError("Αυτή η ερώτηση θέλει μία από τις επιλογές της.")
        if kind == "track" and "|" not in text:
            raise DecisionError("Γράψε «Καλλιτέχνης | Τίτλος».")
    elif letter not in letters:
        raise DecisionError("Αυτή η επιλογή δεν υπάρχει στην ερώτηση.")
    if kind == "preference":
        return letter
    if kind == "not_act":
        return "label" if letter == "A" else "no"
    try:
        return names_store.cell_value(kind, list(options), letter if letter else "=" + text)
    except names_store.BadAnswer as exc:
        raise DecisionError("Η απάντηση δεν ταιριάζει σε αυτή την ερώτηση.") from exc


def answer(session: Session, kind: str, scope: str, letter: str | None, text: str | None) -> dict:
    """POST /api/names/answers: answer one listed question by letter or, where it allows one, a typed value.
    Replaces the question's previous active answer. Returns the new answer (`AnswerOut`)."""
    if kind in NOT_LISTED:
        raise DecisionError("Αυτό δεν είναι ερώτηση.")
    record = _record()
    if record is None:
        raise DecisionError("Δεν έχει γίνει ακόμη ενημέρωση ονομάτων: πάτησε «Ενημέρωση ονομάτων».", 409)
    hit = _question_index(record).get((kind, scope))
    if hit is None:
        raise DecisionError("Η ερώτηση δεν υπάρχει πια· φόρτωσε ξανά τη σελίδα.", 404)
    value = _value_for(kind, hit[1].get("options") or [], letter, text)
    if kind == "track":
        track_id = _track_scope(scope)
        if track_id is None:
            raise DecisionError("Η ερώτηση δεν υπάρχει πια· φόρτωσε ξανά τη σελίδα.", 404)
        artist, _, title = value.partition("|")
        row = _correct(session, track_id, artist.strip(), title.strip())
    else:
        row = _write(session, kind, value, scope=scope)
        session.commit()
    _ask_run(row.id)
    return _answer_out(session, row, record)


def answers(session: Session) -> dict:
    """GET /api/names/answers (`AnswersOut`): every active answer and correction, newest first, each with
    «άλλαξε N κομμάτια» from the run that followed it (None until that run has finished). «Εντάξει» rows are
    not listed (one per look track; each is undone from its track's why block)."""
    rows = session.exec(select(NameDecision).where(NameDecision.revoked_at.is_(None),
                                                   NameDecision.kind.not_in(NOT_LISTED))).all()
    rows = sorted(rows, key=lambda r: (_aware(r.created_at) or datetime.min.replace(tzinfo=UTC), r.id or 0),
                  reverse=True)
    record = _record()
    index = _question_index(record)
    tracks = _names(session, [r.track_id for r in rows if r.track_id is not None])
    return {"items": [_answer_out(session, r, record, index, tracks) for r in rows]}


def undo(session: Session, decision_id: int) -> dict:
    """POST /api/names/answers/{id}/undo: revoke one active answer, correction or «Εντάξει» (a `canonical` row is
    refused: it is undone on /canonical). Returns {"ok": True, "run": names_store.run_state()}."""
    row = session.get(NameDecision, decision_id)
    if row is None:
        raise DecisionError("Η απάντηση δεν βρέθηκε.", 404)
    if row.kind == "setting":
        raise DecisionError("Αυτή είναι ρύθμιση· αλλάζει από τις Ρυθμίσεις.", 409)
    if row.revoked_at is not None:
        raise DecisionError("Η απάντηση έχει ήδη αναιρεθεί.", 409)
    if row.source == "canonical":
        raise DecisionError("Αυτή η διόρθωση έγινε στη σελίδα ταυτότητας· αναίρεσέ την εκεί.", 409)
    row.revoked_at = datetime.now(UTC)
    session.add(row)
    if row.kind == "accept" and row.track_id is not None:
        name = session.get(TrackName, row.track_id)
        if name is not None and name.accepted:
            name.accepted = False
            session.add(name)
    session.commit()
    _ask_run(row.id)
    return {"ok": True, "run": _run_state()}


# ---------------------------------------------------------------- a hand correction
def _correct(session: Session, track_id: int, artist: str, title: str, *, commit: bool = True) -> NameDecision:
    """The `track` decision and the immediate `track_names` write (artist, title, status `hand`)."""
    track = session.get(Track, track_id)
    if track is None:
        raise DecisionError("Το κομμάτι δεν βρέθηκε.", 404)
    if not artist or not title:
        raise DecisionError("Γράψε και καλλιτέχνη και τίτλο.")
    if "|" in artist:
        raise DecisionError("Ο καλλιτέχνης δεν μπορεί να περιέχει «|».")
    row = _write(session, "track", f"{artist} | {title}", track_id=track_id)
    name = session.get(TrackName, track_id)
    if name is None and track.raw_state is not None:
        name = TrackName(track_id=track_id)
    if name is not None:
        name.artist, name.title, name.status = artist, title, "hand"
        session.add(name)
        session.flush()
    dbmod.reindex_track(session, track_id, commit=False)
    if commit:
        session.commit()
    return row


def correct(session: Session, track_id: int, artist: str, title: str) -> dict:
    """POST /api/names/tracks/{id}/correct: the owner's own artist and title for one track. Writes the `track`
    decision (the previous one revoked) and the track's `track_names` row at once (status `hand`), reindexes
    the track, then asks for a run. Returns the new answer (`AnswerOut`). A hand correction is an input of every
    run, so a run, a new ruleset, a scan or a bundle never changes it; only its undo does."""
    row = _correct(session, track_id, (artist or "").strip(), (title or "").strip())
    _ask_run(row.id)
    return _answer_out(session, row, _record())


# ---------------------------------------------------------------- «Για ματιά»: the deciding rule and «Εντάξει»
def _deciding_rules(rows: list[TrackName]) -> dict[int, str]:
    """For each look row, the rule that puts tracks on «Για ματιά» most often in this library: the rule with the
    highest share of look rows among all rows that carry it (ties: earlier in the trail). A reading aid computed
    per request from the stored rows, so the review page and «Εντάξει» for a group always agree."""
    seen, looks = Counter(), Counter()
    for r in rows:
        rules = set((r.rules or "").split())
        seen.update(rules)
        if r.status == "look":
            looks.update(rules)
    out = {}
    for r in rows:
        if r.status != "look":
            continue
        rules = (r.rules or "").split()
        out[r.track_id] = max(rules, key=lambda k: (looks[k] / seen[k], -rules.index(k))) if rules else ""
    return out


def _rule_text(rows: list[TrackName], rule: str) -> str:
    for r in rows:
        for step in _why(r):
            if step[0] == rule and step[2]:
                return str(step[2])
    return "Για ματιά"


def _all_rows(session: Session) -> list[TrackName]:
    return list(session.exec(select(TrackName)).all())


def accept(session: Session, *, track_ids: list[int] | None, rule: str | None, dry_run: bool) -> dict:
    """POST /api/names/accept: «Εντάξει» for «Για ματιά» tracks, either the listed ids or every unaccepted look
    track (of one deciding rule when `rule` is given). `dry_run` only counts. Each accepted track gets an
    `accept` decision whose value is its current «artist | title | folder», and `accepted` set on its row.
    Returns {"count": n, "dry_run": bool}."""
    rows = _all_rows(session)
    deciding = _deciding_rules(rows) if rule else {}
    wanted = set(track_ids) if track_ids is not None else None
    chosen = [r for r in rows if r.status == "look" and not r.accepted
              and (wanted is None or r.track_id in wanted) and (not rule or deciding.get(r.track_id) == rule)]
    if dry_run or not chosen:
        return {"count": len(chosen), "dry_run": bool(dry_run)}
    last = None
    for r in chosen:
        last = _write(session, "accept", f"{r.artist} | {r.title} | {r.folder}", track_id=r.track_id)
        r.accepted = True
        session.add(r)
    session.commit()
    _ask_run(last.id if last else None)
    return {"count": len(chosen), "dry_run": False}


# ---------------------------------------------------------------- «Άλλαξαν»
def _has_prev(r: TrackName) -> bool:
    return r.prev_artist is not None or r.prev_title is not None or r.prev_folder is not None


def _prev(r: TrackName) -> tuple[str, str]:
    """The previous artist and title of a changed row (a field the change left alone keeps its value)."""
    artist = r.prev_artist if r.prev_artist is not None else r.artist
    title = r.prev_title if r.prev_title is not None else r.title
    return (artist or "").strip(), (title or "").strip()


def _file_changed(session: Session, rows: list[TrackName]) -> dict[int, NameDecision]:
    """Hand-corrected tracks whose file was modified after the correction («Άλλαξαν τα στοιχεία του αρχείου»):
    the scanner's st_mtime against the decision's time, since the catalog keeps no copy of the tags a correction
    was made against. Acknowledging gives the correction a new time."""
    hand = {r.track_id for r in rows if r.status == "hand"}
    if not hand:
        return {}
    decisions = {d.track_id: d for d in session.exec(select(NameDecision).where(
        NameDecision.kind == "track", NameDecision.revoked_at.is_(None),
        NameDecision.track_id.is_not(None))).all() if d.track_id in hand}
    out = {}
    for part in _chunks(sorted(decisions)):
        for tid, mtime in session.exec(select(Track.id, Track.modified_time).where(Track.id.in_(part))).all():
            made = _aware(decisions[tid].created_at)
            if mtime is not None and made is not None and datetime.fromtimestamp(mtime, UTC) > made:
                out[tid] = decisions[tid]
    return out


def _cause_text(session: Session, cause: str | None, record: dict | None) -> str:
    cause = cause or "other"
    if cause == FILE_CHANGED:
        return "Άλλαξαν τα στοιχεία του αρχείου μετά τη διόρθωσή σου"
    if cause.startswith("ruleset:"):
        return f"Νέοι κανόνες ονομάτων ({cause[len('ruleset:'):]})"
    if cause.startswith("decision:"):
        try:
            row = session.get(NameDecision, int(cause[len("decision:"):]))
        except ValueError:
            row = None
        if row is None:
            return "Μετά από μια απάντησή σου"
        hit = _question_index(record).get((row.kind, _scope_of(row)))
        return "Μετά από την απάντησή σου: " + _value_text(row, hit[1] if hit else None)
    return {"scan": "Μετά από σάρωση", "links": "Μετά από αλλαγή στις συνδέσεις με τις πηγές",
            "analysis": "Μετά από ανάλυση BPM"}.get(cause, "Άλλη αλλαγή")


def _changed(session: Session, rows: list[TrackName]) -> list[tuple[TrackName, str]]:
    out = [(r, r.changed_cause or "other") for r in rows if _has_prev(r)]
    listed = {r.track_id for r, _ in out}
    files = _file_changed(session, rows)
    out += [(r, FILE_CHANGED) for r in rows if r.track_id in files and r.track_id not in listed]
    return out


def acknowledge(session: Session, *, track_ids: list[int] | None, cause: str | None, action: str,
                dry_run: bool) -> dict:
    """POST /api/names/acknowledge: clear «Άλλαξαν» for the listed ids, or for every changed row (of one cause
    group when `cause` is given). `action` "ok" clears `prev_*`; "keep_previous" first writes a `track`
    decision with the previous artist and title (a row whose previous name had no artist cannot be kept and is
    left listed). A corrected track whose file changed is cleared by giving its correction a new time.
    Returns {"count": n, "dry_run": bool}."""
    if action not in ("ok", "keep_previous"):
        raise DecisionError("Άγνωστη ενέργεια.")
    rows = _all_rows(session)
    wanted = set(track_ids) if track_ids is not None else None
    chosen = [(r, c) for r, c in _changed(session, rows)
              if (wanted is None or r.track_id in wanted) and (not cause or c == cause)]
    if action == "keep_previous":
        chosen = [(r, c) for r, c in chosen if c == FILE_CHANGED or (_prev(r)[0] and _prev(r)[1])]
    if dry_run or not chosen:
        return {"count": len(chosen), "dry_run": bool(dry_run)}
    last = None
    for r, c in chosen:
        if c == FILE_CHANGED:
            old = _active(session, "track", track_id=r.track_id)
            if old is not None:
                last = _write(session, "track", old.value, track_id=r.track_id, source=old.source,
                              canonical_event_id=old.canonical_event_id)
            continue
        if action == "keep_previous":
            artist, title = _prev(r)
            last = _correct(session, r.track_id, artist, title, commit=False)
        r.prev_artist = r.prev_title = r.prev_folder = None
        r.changed_at = None
        r.changed_cause = None
        session.add(r)
    session.commit()
    _ask_run(last.id if last else None)
    return {"count": len(chosen), "dry_run": False}


# ---------------------------------------------------------------- the review page
def _row_out(r: TrackName, group: str, reason: str, cause_text: str = "") -> dict:
    return {"track_id": r.track_id, "artist": r.artist, "title": r.title, "folder": r.folder or "",
            "off_artist": r.off_artist or "", "off_title": r.off_title or "", "status": r.status, "group": group,
            "reason": reason, "accepted": bool(r.accepted), "prev_artist": r.prev_artist,
            "prev_title": r.prev_title, "prev_folder": r.prev_folder, "changed_at": _iso(r.changed_at),
            "cause_text": cause_text}


def review(session: Session, section: str, *, group: str | None, offset: int, limit: int) -> dict:
    """GET /api/names/review (`ReviewOut`): one page of a section of the /names page. `section`: look (the
    unaccepted «Για ματιά» rows, grouped by deciding rule), none («Χωρίς καλλιτέχνη»), changed («Άλλαξαν»,
    grouped by cause), open (grouped by the open question's code)."""
    rows = _all_rows(session)
    record = _record()
    entries: list[tuple[TrackName, str, str, str]] = []  # row, group key, reason, cause text
    labels: dict[str, str] = {}
    if section == "look":
        deciding = _deciding_rules(rows)
        for r in rows:
            if r.status == "look" and not r.accepted:
                key = deciding.get(r.track_id, "")
                if key not in labels:
                    labels[key] = _rule_text(rows, key) if key else "Για ματιά"
                entries.append((r, key, labels[key], ""))
    elif section == "none":
        entries = [(r, "", _reason(r), "") for r in rows if r.status == "none"]
    elif section == "open":
        asked: dict[int, str] = {}
        for item in (record or {}).get("open") or []:
            for t in item.get("tracks") or []:
                asked.setdefault(int(t), item.get("question") or "")
        for r in rows:
            if r.status == "open":
                key = r.open_code or ""
                labels.setdefault(key, asked.get(r.track_id) or "Για απόφαση")
                entries.append((r, key, asked.get(r.track_id) or _reason(r), ""))
    elif section == "changed":
        for r, c in _changed(session, rows):
            if c not in labels:
                labels[c] = _cause_text(session, c, record)
            entries.append((r, c, _reason(r), labels[c]))
    else:
        raise DecisionError("Άγνωστη ενότητα.")
    counts = Counter(key for _, key, _, _ in entries)
    groups = [{"key": k, "label": labels.get(k, ""), "count": n}
              for k, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))] if labels else []
    if group is not None:
        entries = [e for e in entries if e[1] == group]
    entries.sort(key=lambda e: (e[1], (e[0].artist or "").casefold(), (e[0].title or "").casefold(), e[0].track_id))
    page = entries[offset:offset + limit]
    return {"section": section, "total": len(entries), "groups": groups,
            "items": [_row_out(r, key, reason, ctext) for r, key, reason, ctext in page],
            "offset": offset, "limit": limit}


__all__ = ["DecisionError", "questions", "answer", "answers", "undo", "correct", "accept", "acknowledge", "review"]
