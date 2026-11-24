"""Deck rescue: the decks' last state in one file of CrateMind's own cache folder, so the next start can offer to
bring them back after a crash, a force-quit or a page reload. No database, audio, tags or djay files are touched."""
from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..config import get_settings
from ..desktop_runtime.preferences import atomic_json

router = APIRouter(prefix="/deck-rescue", tags=["deck-rescue"])

MAX_BYTES = 8 * 1024
MAX_AGE_S = 24 * 3600
_lock = threading.Lock()

# The frontend mixer store's own units (frontend/src/lib/mixer.ts).
Bipolar = Annotated[float, Field(ge=-1, le=1)]
Unit = Annotated[float, Field(ge=0, le=1)]
Seconds = Annotated[float, Field(ge=0, allow_inf_nan=False)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Loop(_Strict):
    start_s: Seconds
    end_s: Seconds

    @model_validator(mode="after")
    def _ordered(self):
        if self.end_s <= self.start_s:
            raise ValueError("loop end must be after its start")
        return self


class Eq(_Strict):
    hi: Bipolar
    mid: Bipolar
    lo: Bipolar


class Deck(_Strict):
    track_id: int = Field(gt=0)
    position_s: Seconds
    pitch: Bipolar
    range: Literal[0.08, 0.16, 0.5]
    keylock: bool
    eq: Eq
    filter: Bipolar
    trim: Bipolar
    loop: Loop | None


class Decks(_Strict):
    A: Deck | None
    B: Deck | None

    @model_validator(mode="after")
    def _one_loaded(self):
        if self.A is None and self.B is None:
            raise ValueError("at least one deck must hold a track")
        return self


class Volume(_Strict):
    A: Unit
    B: Unit


class Mixer(_Strict):
    volume: Volume
    crossfader: Bipolar
    master: Unit


class DeckRescueBody(_Strict):
    v: Literal[1]
    decks: Decks
    mixer: Mixer


class DeckRescueSnapshot(DeckRescueBody):
    saved_at: Seconds  # unix seconds, stamped by the server


def _path() -> Path:
    return get_settings().db_file.parent / "cache" / "deck-rescue.json"


@router.get("")
def read_rescue():
    """The saved snapshot and its age, or nulls: missing, unreadable, another version or older than 24 hours."""
    empty = {"snapshot": None, "age_s": None}
    path = _path()
    try:
        if path.stat().st_size > MAX_BYTES:
            return empty
        snapshot = DeckRescueSnapshot.model_validate_json(path.read_bytes())
    except (OSError, ValueError):
        return empty
    age = max(0.0, time.time() - snapshot.saved_at)  # a clock set back counts as just saved
    if age > MAX_AGE_S:
        return empty
    return {"snapshot": snapshot.model_dump(), "age_s": age}


@router.post("", status_code=204)
def save_rescue(body: DeckRescueBody):
    with _lock:
        atomic_json(_path(), {**body.model_dump(), "saved_at": round(time.time(), 3)})
    return Response(status_code=204)


@router.delete("", status_code=204)
def clear_rescue():
    with _lock:
        _path().unlink(missing_ok=True)
    return Response(status_code=204)
