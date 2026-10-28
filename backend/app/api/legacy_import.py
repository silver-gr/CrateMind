"""Desktop-only legacy metadata adapter, separate from complete state exchange."""
from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session

from ..db import get_session
from ..services.legacy_import import import_metadata

router = APIRouter(prefix="/import")


@router.post("/json-backup")
def import_json_backup(payload: dict, session: Session = Depends(get_session)):
    try:
        return import_metadata(session, payload)
    except (ValueError, KeyError, TypeError) as exc:
        session.rollback()
        raise HTTPException(422, "Μη έγκυρο metadata backup: " + str(exc)) from exc
