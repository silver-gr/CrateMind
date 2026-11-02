from __future__ import annotations

import copy
import io
import json
from types import SimpleNamespace
from urllib.error import HTTPError, URLError

import pytest

from app.services import llm_client

URL = "https://label.example/artist"


@pytest.fixture
def settings(monkeypatch):
    value = SimpleNamespace(
        llm1_base_url="http://127.0.0.1:8317/v1/", llm1_api_key="private-test-key",
        llm1_model="gpt-6-luna", llm1_model_effort="max",
    )
    monkeypatch.setattr(llm_client, "get_settings", lambda: value)
    return value


def completed_response():
    return {
        "status": "completed", "model": "gpt-6-luna", "reasoning": {"effort": "max"},
        "output": [
            {"type": "web_search_call", "status": "completed", "action": {
                "type": "search", "sources": [{"type": "url", "url": URL}],
            }},
            {"type": "message", "role": "assistant", "status": "completed", "content": [
                {"type": "output_text", "text": '{"artist_id": 7}', "annotations": []},
            ]},
        ],
    }


def mock_body(monkeypatch, body):
    monkeypatch.setattr(llm_client.request, "urlopen", lambda *a, **k: io.BytesIO(
        json.dumps(body).encode("utf-8")))


def test_research_uses_requested_model_effort_search_and_strict_schema(settings, monkeypatch):
    seen = {}

    def open_request(req, **kwargs):
        seen.update(url=req.full_url, headers=req.headers, payload=json.loads(req.data), **kwargs)
        return io.BytesIO(json.dumps(completed_response()).encode())

    monkeypatch.setattr(llm_client.request, "urlopen", open_request)
    schema = {"type": "object", "properties": {"artist_id": {"type": "integer"}}}
    result = llm_client.research_json("system", "user", schema)
    assert seen["url"] == "http://127.0.0.1:8317/v1/responses"
    assert seen["payload"] == {
        "model": "gpt-6-luna", "reasoning": {"effort": "max"},
        "input": [{"role": "system", "content": "system"}, {"role": "user", "content": "user"}],
        "tools": [{"type": "web_search"}], "tool_choice": "required",
        "include": ["web_search_call.action.sources"], "store": False, "stream": False,
        "text": {"format": {"type": "json_schema", "name": "artist_genre_research",
                            "strict": True, "schema": schema}},
    }
    assert seen["headers"]["Authorization"] == "Bearer private-test-key"
    assert result == {"result": {"artist_id": 7}, "sources": [URL], "model": "gpt-6-luna",
                      "reasoning_effort": "max", "search_calls": 1}


def test_sources_include_tool_search_open_and_citations_not_model_claims(settings, monkeypatch):
    body = completed_response()
    body["output"].insert(1, {"type": "web_search_call", "status": "completed", "action": {
        "type": "open_page", "url": "https://Artist.Example/music#details",
    }})
    message = body["output"][-1]
    message["content"][0].update(
        text=json.dumps({"invented": "https://invented.example/fake"}),
        annotations=[{"type": "url_citation", "url": "https://citation.example/page"},
                     {"type": "url_citation", "url": URL}],
    )
    mock_body(monkeypatch, body)
    result = llm_client.research_json("s", "u", {})
    assert result["search_calls"] == 2
    assert result["sources"] == [URL, "https://artist.example/music", "https://citation.example/page"]
    assert "https://invented.example/fake" not in result["sources"]


def test_commentary_does_not_corrupt_structured_final_answer(settings, monkeypatch):
    body = completed_response()
    body["output"].insert(0, {"type": "message", "status": "completed", "role": "assistant",
                             "phase": "commentary", "content": [
                                 {"type": "output_text", "text": "Searching for the artist."},
                             ]})
    mock_body(monkeypatch, body)
    assert llm_client.research_json("s", "u", {})["result"] == {"artist_id": 7}


@pytest.mark.parametrize("change", [
    lambda b: b.update(status="incomplete"),
    lambda b: b.update(error={"message": "secret-provider-details"}),
    lambda b: b.update(incomplete_details={"reason": "max_output_tokens"}),
    lambda b: b.update(model="fallback-model"),
    lambda b: b.update(reasoning={"effort": "high"}),
    lambda b: b.update(output=b["output"][1:]),
    lambda b: b["output"][0].update(status="failed"),
    lambda b: b["output"][0].update(action={}),
    lambda b: b["output"][0].update(action={"type": [], "sources": []}),
    lambda b: b["output"][0].update(action={"type": "search", "sources": 17}),
    lambda b: b["output"][-1]["content"][0].update(annotations=17),
    lambda b: b["output"][-1]["content"][0].update(text="not JSON"),
    lambda b: b["output"][-1]["content"][0].update(text="[]"),
    lambda b: b["output"][-1].update(content=[{"type": "refusal", "refusal": "secret"}]),
    lambda b: b["output"][-1].update(status="incomplete"),
    lambda b: b["output"][-1].update(content="bad shape"),
    lambda b: b.update(output=None),
])
def test_research_rejects_failed_incomplete_or_unsupported_output(settings, monkeypatch, change):
    body = copy.deepcopy(completed_response())
    change(body)
    mock_body(monkeypatch, body)
    with pytest.raises(llm_client.LLMClientError) as raised:
        llm_client.research_json("s", "u", {})
    assert "secret" not in str(raised.value)
    assert "private-test-key" not in str(raised.value)


@pytest.mark.parametrize("failure", [
    URLError("Authorization: Bearer private-test-key"),
    TimeoutError("private-test-key"),
    HTTPError("http://private-test-key@proxy/", 503, "private-test-key", {}, None),
])
def test_research_network_errors_are_credential_safe(settings, monkeypatch, failure):
    def fail(*args, **kwargs):
        raise failure

    monkeypatch.setattr(llm_client.request, "urlopen", fail)
    with pytest.raises(llm_client.LLMClientError) as raised:
        llm_client.research_json("s", "u", {})
    assert "private-test-key" not in str(raised.value)
    assert "Authorization" not in str(raised.value)
    assert raised.value.__suppress_context__


@pytest.mark.parametrize("response", [b"not json private-test-key", b"[]", b"\xff"])
def test_malformed_response_errors_do_not_echo_body(settings, monkeypatch, response):
    monkeypatch.setattr(llm_client.request, "urlopen", lambda *a, **k: io.BytesIO(response))
    with pytest.raises(llm_client.LLMClientError) as raised:
        llm_client.research_json("s", "u", {})
    assert "private-test-key" not in str(raised.value)


def test_request_construction_errors_are_credential_safe(settings, monkeypatch):
    def fail(*a, **k):
        raise ValueError("Invalid Authorization private-test-key")

    monkeypatch.setattr(llm_client.request, "Request", fail)
    with pytest.raises(llm_client.LLMClientError) as raised:
        llm_client.research_json("s", "u", {})
    assert "private-test-key" not in str(raised.value)
    assert "Authorization" not in str(raised.value)


@pytest.mark.parametrize("field", ["llm1_api_key", "llm1_model", "llm1_model_effort"])
def test_missing_configuration_never_attempts_provider_request(settings, monkeypatch, field):
    setattr(settings, field, "")
    monkeypatch.setattr(llm_client.request, "urlopen", lambda *a, **k: pytest.fail("Unexpected call"))
    with pytest.raises(llm_client.LLMClientError):
        llm_client.research_json("s", "u", {})


@pytest.mark.parametrize("url", [
    "javascript:alert(1)", "file:///tmp/x", "https://user:secret@example.com/",
    "http://127.0.0.1/", "http://[::1]/", "https://localhost/", "https://host.local/",
    "https://example.com:invalid/", "https://example.com/a\nb", None,
])
def test_research_source_urls_reject_unsafe_values(url):
    assert llm_client.source_url(url) is None


def test_legacy_chat_json_still_uses_chat_endpoint(settings, monkeypatch):
    seen = []

    def open_request(req, **kwargs):
        seen.append(req.full_url)
        return io.BytesIO(json.dumps({"choices": [{"message": {"content": '```json\n{"ok":true}\n```'}}]}).encode())

    monkeypatch.setattr(llm_client.request, "urlopen", open_request)
    assert llm_client.chat_json("s", "u") == {"ok": True}
    assert seen == ["http://127.0.0.1:8317/v1/chat/completions"]
