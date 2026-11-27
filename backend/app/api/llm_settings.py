"""Settings «Μοντέλο AI»: the LLM connection for artist research.

The API key is write-only: no response ever contains it, only whether one is in use and its
last four characters (for a key of at least 12). Errors are Greek and never echo a submitted
value, so the body is parsed here: FastAPI's own 422 would echo the input."""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from ..config import get_settings
from ..services import llm_client, llm_config

router = APIRouter(prefix="/llm-settings", tags=["llm-settings"])


def _view() -> dict:
    settings = get_settings()
    cfg = llm_config.current(settings)
    key = cfg.llm1_api_key
    return {
        "base_url": cfg.llm1_base_url,
        "model": cfg.llm1_model,
        "effort": cfg.llm1_model_effort or llm_config.NO_EFFORT,
        "efforts": list(llm_config.EFFORTS),
        "api_key": {"stored": bool(key), "last4": key[-4:] if len(key) >= 12 else None},
        "sources": cfg.sources,
        "env_names": {name: llm_config.env_name(name) for name in llm_config.FIELDS},
        "key_file": str(llm_config.file_path(settings)),
        "configured": bool(cfg.llm1_base_url and key and cfg.llm1_model),
    }


async def _object(request: Request, *, empty_ok: bool = False) -> dict:
    raw = await request.body()
    if not raw and empty_ok:
        return {}
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        value = None
    if not isinstance(value, dict):
        raise HTTPException(422, "Μη έγκυρο αίτημα ρυθμίσεων μοντέλου.")
    return value


@router.get("")
def read_llm_settings():
    return _view()


@router.post("")
async def save_llm_settings(request: Request):
    patch = await _object(request)
    try:
        llm_config.save(patch)
    except llm_config.LLMSettingsError as exc:
        raise HTTPException(422, str(exc)) from None
    except OSError:
        raise HTTPException(500, "Δεν ήταν δυνατή η αποθήκευση των ρυθμίσεων του μοντέλου.") from None
    return _view()


@router.delete("/api-key")
def delete_llm_api_key():
    try:
        llm_config.delete_key()
    except OSError:
        raise HTTPException(500, "Δεν ήταν δυνατή η διαγραφή του κλειδιού.") from None
    return _view()


@router.post("/test")
async def test_llm_connection(request: Request):
    """Test the form's unsaved endpoint, model and key; whatever is left out comes from the values in use."""
    draft = await _object(request, empty_ok=True)
    draft = {k: v for k, v in draft.items() if k in {"base_url", "model", "api_key"} and v not in (None, "")}
    try:
        values = llm_config.validate_patch(draft)
    except llm_config.LLMSettingsError as exc:
        raise HTTPException(422, str(exc)) from None
    cfg = llm_config.current()
    return await run_in_threadpool(
        llm_client.check_connection, values.get("base_url", cfg.llm1_base_url), values.get("model", cfg.llm1_model),
        values.get("api_key", cfg.llm1_api_key))
