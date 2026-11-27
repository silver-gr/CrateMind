"""«Καθαρά ονόματα»: where the switch and the loose-folder words live, and the one getter every module uses.

Both are `name_decisions` rows of kind `setting`, so they travel with backups and exchange bundles like the
owner's answers; no `setting` row is ever passed to the engine as a decision. The switch is the row with scope
`switch` and value `on`; anything else, or no row, is off (the default for every library). Turning it replaces
the active row (the old one is revoked, never deleted). This module only stores and reads: the refusal while
unread tracks exist, the reindex and the run a turn starts belong to the route (services/names_show.py).
It never imports the engine.
"""
from __future__ import annotations

from datetime import UTC, datetime

from sqlalchemy.exc import OperationalError
from sqlmodel import Session, select

from ..models import NameDecision

KIND = "setting"
SWITCH_SCOPE = "switch"
LOOSE_FOLDER_PREFIX = "loose_folder:"


def _active(session: Session, scope: str) -> NameDecision | None:
    return session.exec(
        select(NameDecision).where(NameDecision.kind == KIND, NameDecision.scope == scope,
                                   NameDecision.track_id.is_(None), NameDecision.revoked_at.is_(None))
    ).first()


def is_on(session: Session | None = None) -> bool:
    """True only while the owner has «Καθαρά ονόματα» on. Off for a database without the table (an old
    library before its first start) or any unreadable state: off is always the safe answer."""
    if session is None:
        from ..db import get_engine

        with Session(get_engine()) as own:
            return is_on(own)
    try:
        row = _active(session, SWITCH_SCOPE)
    except OperationalError:
        return False
    return bool(row and row.value == "on")


def set_on(session: Session, on: bool, *, commit: bool = True) -> bool:
    """Store the switch. Returns True when the stored state changed. No checks and no side effects here."""
    row = _active(session, SWITCH_SCOPE)
    if bool(row and row.value == "on") == bool(on):
        return False
    if row:
        row.revoked_at = datetime.now(UTC)
        session.add(row)
        session.flush()  # the partial unique index allows one active row
    session.add(NameDecision(kind=KIND, scope=SWITCH_SCOPE, value="on" if on else "off", source="owner"))
    if commit:
        session.commit()
    return True


def loose_folders(session: Session) -> tuple[str, ...]:
    """The owner's words for a folder of loose tracks (References.loose_folders), sorted."""
    rows = session.exec(
        select(NameDecision.scope).where(NameDecision.kind == KIND, NameDecision.revoked_at.is_(None),
                                         NameDecision.scope.startswith(LOOSE_FOLDER_PREFIX))
    ).all()
    return tuple(sorted(scope[len(LOOSE_FOLDER_PREFIX):] for scope in rows))


def add_loose_folder(session: Session, word: str, *, commit: bool = True) -> bool:
    """Record one loose-folder word (used by the answers import). True when it was not there yet."""
    scope = LOOSE_FOLDER_PREFIX + word.strip()
    if not word.strip() or _active(session, scope):
        return False
    session.add(NameDecision(kind=KIND, scope=scope, value=word.strip(), source="owner"))
    if commit:
        session.commit()
    return True
