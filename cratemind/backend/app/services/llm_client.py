"""Tiny OpenAI-compatible chat client for local artist enrichment."""
from __future__ import annotations

import json
from typing import Any
from urllib import request

from ..config import get_settings


class LLMClientError(RuntimeError):
    pass


def _strip_code_fences(value: str) -> str:
    text = value.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines).strip()
    return text


def is_configured() -> bool:
    settings = get_settings()
    return bool(settings.llm1_base_url and settings.llm1_api_key and settings.llm1_model)


def chat_json(system: str, user: str) -> dict[str, Any]:
    settings = get_settings()
    if not is_configured():
        raise LLMClientError("LLM1 is not configured.")

    payload = {
        "model": settings.llm1_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.2,
    }
    if settings.llm1_model_effort:
        payload["reasoning_effort"] = settings.llm1_model_effort

    base_url = settings.llm1_base_url.rstrip("/")
    req = request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {settings.llm1_api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=120) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise LLMClientError(str(exc)) from exc

    try:
        content = body["choices"][0]["message"]["content"]
    except Exception as exc:  # noqa: BLE001
        raise LLMClientError(f"Malformed LLM response: {body!r}") from exc

    if isinstance(content, list):
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    if not isinstance(content, str):
        raise LLMClientError(f"Unexpected content type: {type(content)!r}")
    content = _strip_code_fences(content)
    try:
        return json.loads(content)
    except json.JSONDecodeError as exc:
        raise LLMClientError(f"LLM returned non-JSON content: {content[:200]!r}") from exc
