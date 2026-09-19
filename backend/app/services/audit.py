"""Lightweight audit log for metadata changes. You'll thank yourself later."""
from __future__ import annotations

import json
from typing import Any, Optional

from sqlmodel import Session

from ..models import AuditLog


def log(
    session: Session,
    action: str,
    entity_type: Optional[str] = None,
    entity_id: Optional[int] = None,
    before: Optional[dict[str, Any]] = None,
    after: Optional[dict[str, Any]] = None,
) -> None:
    session.add(AuditLog(
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        before_json=json.dumps(before, default=str) if before is not None else None,
        after_json=json.dumps(after, default=str) if after is not None else None,
    ))
    session.commit()
