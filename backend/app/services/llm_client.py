"""Tiny OpenAI-compatible chat client for local artist enrichment."""
from __future__ import annotations

import ipaddress
import json
from typing import Any
from urllib import error, parse, request

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


def _post_json(endpoint: str, payload: dict, settings, *, timeout: int) -> dict:
    try:
        req = request.Request(
            f"{settings.llm1_base_url.rstrip('/')}/{endpoint}",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {settings.llm1_api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        with request.urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as exc:
        raise LLMClientError(f"LLM request failed (HTTP {exc.code}).") from None
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise LLMClientError("LLM returned an invalid JSON response.") from None
    except Exception:  # noqa: BLE001 - never surface credential-bearing provider exceptions
        raise LLMClientError("LLM request failed; check the configured provider connection.") from None
    if not isinstance(body, dict):
        raise LLMClientError("Malformed LLM response: expected an object.")
    return body


def source_url(value: Any) -> str | None:
    """Keep public HTTP links, normalizing only case and non-resource fragments."""
    if not isinstance(value, str) or not value or any(c.isspace() for c in value):
        return None
    try:
        url = parse.urlsplit(value)
        host = url.hostname
        if (url.scheme not in {"http", "https"} or not host or url.username or url.password
                or host.lower() in {"localhost", "localhost.localdomain"}
                or host.lower().endswith((".local", ".internal", ".localhost"))):
            return None
        try:
            if not ipaddress.ip_address(host).is_global:
                return None
        except ValueError:
            pass
        port = url.port
    except ValueError:
        return None
    netloc = host.lower()
    if ":" in netloc:
        netloc = f"[{netloc}]"
    if port is not None:
        netloc += f":{port}"
    return parse.urlunsplit((url.scheme.lower(), netloc, url.path, url.query, ""))


def research_json(system: str, user: str, schema: dict) -> dict[str, Any]:
    """Require real web-tool evidence and completed structured Responses output."""
    settings = get_settings()
    if not is_configured() or not settings.llm1_model_effort:
        raise LLMClientError("Configure LLM1 model, reasoning effort and connection first.")
    payload = {
        "model": settings.llm1_model,
        "reasoning": {"effort": settings.llm1_model_effort},
        "input": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "tools": [{"type": "web_search"}],
        "tool_choice": "required",
        "include": ["web_search_call.action.sources"],
        "store": False,
        "stream": False,
        "text": {"format": {
            "type": "json_schema", "name": "artist_genre_research", "strict": True,
            "schema": schema,
        }},
    }
    body = _post_json("responses", payload, settings, timeout=180)
    try:
        return _research_response(body, settings)
    except LLMClientError:
        raise
    except (KeyError, TypeError, ValueError, AttributeError):
        raise LLMClientError("Malformed research provider response.") from None


def _research_response(body: dict, settings) -> dict[str, Any]:
    if body.get("status") != "completed" or body.get("error") or body.get("incomplete_details"):
        raise LLMClientError("Artist research did not complete; no finding was saved.")
    if (body.get("model") != settings.llm1_model
            or not isinstance(body.get("reasoning"), dict)
            or body["reasoning"].get("effort") != settings.llm1_model_effort):
        raise LLMClientError("Provider did not confirm the requested model and reasoning effort.")
    output = body.get("output")
    if not isinstance(output, list):
        raise LLMClientError("Malformed research response: missing output.")
    sources: list[str] = []
    texts: list[str] = []
    search_calls = 0

    def add_source(value):
        url = source_url(value)
        if url and url not in sources:
            sources.append(url)

    for item in output:
        if not isinstance(item, dict):
            raise LLMClientError("Malformed research output item.")
        if item.get("type") == "web_search_call":
            if item.get("status") != "completed" or not isinstance(item.get("action"), dict):
                raise LLMClientError("Web research did not complete; no finding was saved.")
            action = item["action"]
            if action.get("type") not in {"search", "open_page", "find_in_page"}:
                raise LLMClientError("Malformed web research tool call.")
            tool_sources = action.get("sources") or []
            if not isinstance(tool_sources, list):
                raise LLMClientError("Malformed web research source list.")
            search_calls += 1
            add_source(action.get("url"))
            for source in tool_sources:
                if isinstance(source, dict):
                    add_source(source.get("url"))
        elif item.get("type") == "message":
            if item.get("status") != "completed" or item.get("role") != "assistant":
                raise LLMClientError("Incomplete research answer.")
            content = item.get("content")
            if not isinstance(content, list):
                raise LLMClientError("Malformed research answer.")
            for part in content:
                if not isinstance(part, dict):
                    raise LLMClientError("Malformed research answer content.")
                if part.get("type") == "refusal":
                    raise LLMClientError("Provider declined the artist research request.")
                if part.get("type") == "output_text":
                    if not isinstance(part.get("text"), str):
                        raise LLMClientError("Malformed research answer text.")
                    if item.get("phase") != "commentary":
                        texts.append(part["text"])
                    for annotation in part.get("annotations", []) or []:
                        if isinstance(annotation, dict) and annotation.get("type") == "url_citation":
                            add_source(annotation.get("url"))
        elif item.get("type") == "refusal":
            raise LLMClientError("Provider declined the artist research request.")
    if not search_calls:
        raise LLMClientError("Provider returned no completed web research tool call.")
    try:
        result = json.loads("".join(texts))
    except (json.JSONDecodeError, TypeError):
        raise LLMClientError("Research answer was not a valid JSON object.") from None
    if not isinstance(result, dict):
        raise LLMClientError("Research answer was not a valid JSON object.")
    return {"result": result, "sources": sources, "model": body["model"],
            "reasoning_effort": body["reasoning"]["effort"], "search_calls": search_calls}


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

    body = _post_json("chat/completions", payload, settings, timeout=120)

    try:
        content = body["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise LLMClientError("Malformed LLM response: missing answer content.") from None

    if isinstance(content, list):
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    if not isinstance(content, str):
        raise LLMClientError(f"Unexpected content type: {type(content)!r}")
    content = _strip_code_fences(content)
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        raise LLMClientError("LLM returned non-JSON content.") from None
