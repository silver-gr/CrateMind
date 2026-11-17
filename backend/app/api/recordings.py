"""Set recording («Εγγραφή»): the master bus as a WAV in the export folder.
Only the configured output folder is written to; source libraries never are."""
from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from ..services import recorder
from .export import _dest

router = APIRouter(prefix="/recordings", tags=["recordings"])

MAX_CHUNK_BYTES = 64 * 1024 * 1024


class RecordingStart(BaseModel):
    sample_rate: int = Field(ge=8000, le=192000)


def _candidates():
    stem = f"CrateMind-recording-{datetime.now():%Y-%m-%d_%H-%M}"
    yield _dest(f"{stem}.wav", f"{stem}.wav")
    for n in range(2, 100):
        yield _dest(f"{stem}-{n}.wav", f"{stem}-{n}.wav")


def _run(fn, *args):
    try:
        return fn(*args)
    except recorder.RecordingError as error:
        raise HTTPException(error.status, error.detail) from error


@router.post("/start")
def start_recording(req: RecordingStart):
    return _run(recorder.start, _candidates(), req.sample_rate)


@router.post("/{rid}/chunk")
async def append_chunk(rid: str, request: Request, seq: int = Query(ge=0)):
    raw = await request.body()
    if len(raw) > MAX_CHUNK_BYTES:
        raise HTTPException(413, "Πολύ μεγάλο κομμάτι ήχου.")
    return await run_in_threadpool(_run, recorder.append, rid, seq, raw)


@router.post("/{rid}/stop")
def stop_recording(rid: str):
    return _run(recorder.stop, rid)
