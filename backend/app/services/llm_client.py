"""Tiny OpenAI-compatible client for artist research (Responses API; Chat Completions kept as legacy)."""
from __future__ import annotations

import ipaddress
import json
import re
import socket
from typing import Any
from urllib import error, parse, request

from .llm_config import current as current_config


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
    settings = current_config()
    return bool(settings.llm1_base_url and settings.llm1_api_key and settings.llm1_model)


class _NoRedirect(request.HTTPRedirectHandler):
    """urllib would resend the Authorization header, the API key, to any host a redirect names."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # the redirect becomes an HTTPError


_OPENER = request.build_opener(_NoRedirect)


def _urlopen(req: request.Request, *, timeout: float):
    """Every provider request goes through here: a redirect is reported, never followed."""
    return _OPENER.open(req, timeout=timeout)


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
        with _urlopen(req, timeout=timeout) as resp:
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
    settings = current_config()
    if not (settings.llm1_base_url and settings.llm1_api_key and settings.llm1_model):
        raise LLMClientError("Configure LLM1 model, reasoning effort and connection first.")
    payload = {
        "model": settings.llm1_model,
        # «Χωρίς» in Settings: no effort is sent and none is checked in the answer.
        **({"reasoning": {"effort": settings.llm1_model_effort}} if settings.llm1_model_effort else {}),
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
            or (settings.llm1_model_effort and (
                not isinstance(body.get("reasoning"), dict)
                or body["reasoning"].get("effort") != settings.llm1_model_effort))):
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
            "reasoning_effort": settings.llm1_model_effort, "search_calls": search_calls}


def chat_json(system: str, user: str) -> dict[str, Any]:
    settings = current_config()
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


TEST_TIMEOUT_S = 10.0
_ERROR_CODE = re.compile(r"[A-Za-z0-9_.-]{1,40}")


def _provider_code(exc: error.HTTPError) -> str:
    """The provider's short error code (`invalid_api_key`, `insufficient_quota`), never its message."""
    try:
        body = json.loads(exc.read(8192).decode("utf-8"))
        detail = body.get("error") if isinstance(body, dict) else None
        code = detail.get("code") or detail.get("type") if isinstance(detail, dict) else None
    except Exception:  # noqa: BLE001 - the code is optional
        return ""
    return f" · {code}" if isinstance(code, str) and _ERROR_CODE.fullmatch(code) else ""


def check_connection(base_url: str, model: str, api_key: str, *, timeout: float = TEST_TIMEOUT_S) -> dict:
    """One GET of the provider's model list: checks the endpoint and the key without spending tokens.

    The answer is Greek, says whether `model` is listed, and never contains the key or the
    provider's own message text (only its short error code)."""
    if not (base_url and model and api_key):
        return {"ok": False, "model_listed": None,
                "message": "Συμπλήρωσε διεύθυνση, μοντέλο και κλειδί API πριν από τη δοκιμή."}
    seconds = f"{timeout:g}".replace(".", ",")
    try:
        req = request.Request(f"{base_url.rstrip('/')}/models", method="GET",
                              headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"})
        with _urlopen(req, timeout=timeout) as resp:
            body = json.loads(resp.read(4 * 1024 * 1024).decode("utf-8"))
    except error.HTTPError as exc:
        code = exc.code
        extra = _provider_code(exc)
        if 300 <= code < 400:
            message = (f"Η διεύθυνση ανακατευθύνει αλλού (HTTP {code}). Γράψε την τελική διεύθυνση του παρόχου· "
                       "το CrateMind δεν στέλνει το κλειδί σε ανακατεύθυνση.")
        elif code in (401, 403):
            message = f"Ο πάροχος απέρριψε το κλειδί API (HTTP {code}{extra})."
        elif code == 404:
            message = (f"Η διεύθυνση δεν βρέθηκε (HTTP 404{extra}). Έλεγξε ότι τελειώνει όπως ζητά ο πάροχος, "
                       "συνήθως σε /v1.")
        elif code == 429:
            message = f"Ο πάροχος αρνήθηκε προσωρινά το αίτημα (HTTP 429{extra}): όριο χρήσης ή χρέωσης."
        elif code >= 500:
            message = f"Σφάλμα στον πάροχο (HTTP {code}{extra}). Δοκίμασε ξανά αργότερα."
        else:
            message = f"Ο πάροχος απάντησε με σφάλμα (HTTP {code}{extra})."
        return {"ok": False, "model_listed": None, "message": message}
    except (TimeoutError, socket.timeout):
        return {"ok": False, "model_listed": None, "message": f"Ο πάροχος δεν απάντησε μέσα σε {seconds} δευτερόλεπτα."}
    except error.URLError as exc:
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            return {"ok": False, "model_listed": None,
                    "message": f"Ο πάροχος δεν απάντησε μέσα σε {seconds} δευτερόλεπτα."}
        return {"ok": False, "model_listed": None,
                "message": "Δεν έγινε σύνδεση με τη διεύθυνση. Έλεγξε ότι είναι σωστή και ότι ο πάροχος τρέχει."}
    except (ValueError, UnicodeDecodeError):
        return {"ok": False, "model_listed": None,
                "message": "Η διεύθυνση απάντησε, αλλά όχι σαν πάροχος συμβατός με OpenAI."}
    except Exception:  # noqa: BLE001 - never surface credential-bearing exceptions
        return {"ok": False, "model_listed": None, "message": "Η δοκιμή απέτυχε. Έλεγξε τη διεύθυνση."}
    data = body.get("data") if isinstance(body, dict) else None
    ids = {item.get("id") for item in data if isinstance(item, dict)} if isinstance(data, list) else set()
    if not ids:
        return {"ok": True, "model_listed": None,
                "message": "Η σύνδεση πέτυχε. Ο πάροχος δεν έδωσε λίστα μοντέλων, οπότε το μοντέλο δεν ελέγχθηκε."}
    if model in ids:
        return {"ok": True, "model_listed": True, "message": f"Η σύνδεση πέτυχε· το μοντέλο «{model}» είναι διαθέσιμο."}
    return {"ok": True, "model_listed": False,
            "message": f"Η σύνδεση πέτυχε, αλλά το μοντέλο «{model}» δεν είναι στη λίστα του παρόχου."}
