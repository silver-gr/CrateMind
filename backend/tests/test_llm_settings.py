"""Settings «Μοντέλο τεχνητής νοημοσύνης»: the LLM file, its routes, the connection test and every
path the API key could leak through. Keys are made up; the provider is a loopback fake."""
from __future__ import annotations

import json
import logging
import os
import socket
import stat
import threading
import time
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from app.services import llm_client, llm_config

KEY = "sk-made-up-test-key-0123456789-wxyz"
OTHER_KEY = "sk-another-made-up-key-9876543210-abcd"


def _llm_file(tmp_path) -> Path:
    return tmp_path / llm_config.FILE_NAME


def _no_key(text: str, *keys: str) -> None:
    for key in keys or (KEY,):
        assert key not in text
        assert key[3:-4] not in text  # nor the middle of it


# ---------------------------------------------------------------------------------------- fake provider

class _Provider:
    """A loopback OpenAI-compatible endpoint: `GET /v1/models` answers `self.reply` after `self.delay`."""

    def __init__(self):
        self.reply: tuple[int, dict] = (200, {"object": "list", "data": [{"id": "test-model"}]})
        self.delay = 0.0
        self.location: str | None = None
        self.seen: list[tuple[str, str, str | None]] = []
        provider = self

        class Handler(BaseHTTPRequestHandler):
            def _answer(self):
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    self.rfile.read(length)
                provider.seen.append((self.command, self.path, self.headers.get("Authorization")))
                time.sleep(provider.delay)
                status, body = provider.reply
                data = json.dumps(body).encode()
                try:
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    if provider.location:
                        self.send_header("Location", provider.location)
                    self.end_headers()
                    self.wfile.write(data)
                except OSError:
                    pass

            do_GET = do_POST = _answer

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def provider():
    fake = _Provider()
    yield fake
    fake.close()


def _closed_port_url() -> str:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    return f"http://127.0.0.1:{port}/v1"


# ---------------------------------------------------------------------------------------- storage

@pytest.mark.skipif(os.name == "nt", reason="POSIX permission bits")
def test_save_writes_one_user_only_file_atomically(client, tmp_path):
    path = _llm_file(tmp_path)
    path.write_text("{}")
    path.chmod(0o644)  # an older, looser file is replaced, not rewritten in place
    before = {p.name for p in tmp_path.iterdir()}
    answer = client.post("/api/llm-settings", json={
        "base_url": "https://llm.example/v1", "model": "test-model", "effort": "max", "api_key": KEY})
    assert answer.status_code == 200, answer.text
    assert {p.name for p in tmp_path.iterdir()} == before  # no temp file left behind
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert json.loads(path.read_text()) == {"version": 1, "base_url": "https://llm.example/v1",
                                            "model": "test-model", "effort": "max", "api_key": KEY}


def test_a_failed_write_keeps_the_old_file_and_leaves_no_temp(tmp_path, monkeypatch):
    path = _llm_file(tmp_path)
    llm_config.write_file(path, {"api_key": KEY})
    monkeypatch.setattr(llm_config.os, "replace", lambda *a: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        llm_config.write_file(path, {"api_key": OTHER_KEY})
    assert llm_config.read_file(path) == {"api_key": KEY}
    assert [p.name for p in tmp_path.iterdir()] == [llm_config.FILE_NAME]


def test_unreadable_or_odd_files_read_as_empty(tmp_path):
    path = _llm_file(tmp_path)
    assert llm_config.read_file(path) == {}
    for text in ("not json", "[1]", json.dumps({"api_key": 5, "model": "a\nb", "base_url": ""})):
        path.write_text(text)
        assert llm_config.read_file(path) == {}
    path.write_text(" " * (llm_config.MAX_FILE_BYTES + 1))
    assert llm_config.read_file(path) == {}


def test_a_save_takes_effect_without_a_restart(client):
    assert not llm_client.is_configured()
    client.post("/api/llm-settings", json={"base_url": "https://llm.example/v1", "model": "m", "api_key": KEY})
    assert llm_client.is_configured()
    config = llm_config.current()
    assert (config.llm1_base_url, config.llm1_model, config.llm1_model_effort, config.llm1_api_key) == \
        ("https://llm.example/v1", "m", "high", KEY)
    client.post("/api/llm-settings", json={"effort": "none"})
    assert llm_config.current().llm1_model_effort == ""  # «Χωρίς»: no effort is sent


def test_delete_removes_only_the_key(client, tmp_path):
    client.post("/api/llm-settings", json={"base_url": "https://llm.example/v1", "model": "m", "api_key": KEY})
    view = client.delete("/api/llm-settings/api-key").json()
    assert view["api_key"] == {"stored": False, "last4": None} and view["model"] == "m"
    assert llm_config.read_file(_llm_file(tmp_path)) == {"base_url": "https://llm.example/v1", "model": "m"}
    assert not llm_client.is_configured()
    assert client.delete("/api/llm-settings/api-key").status_code == 200  # idempotent


def test_an_environment_value_stays_in_use_and_says_so(client, monkeypatch):
    from app import config
    monkeypatch.setenv("CRATEMIND_LLM1_MODEL", "env-model")
    monkeypatch.setenv("CRATEMIND_LLM1_API_KEY", "")  # an empty variable (.env.example) does not count
    config.get_settings.cache_clear()
    view = client.post("/api/llm-settings", json={"model": "file-model", "api_key": KEY}).json()
    assert view["model"] == "env-model" and view["sources"]["model"] == "env"
    assert view["sources"]["api_key"] == "file" and view["env_names"]["model"] == "CRATEMIND_LLM1_MODEL"
    assert llm_config.current().llm1_model == "env-model"
    config.get_settings.cache_clear()


def test_short_keys_show_no_last_characters(client):
    assert client.post("/api/llm-settings", json={"api_key": "short-key"}).json()["api_key"] == \
        {"stored": True, "last4": None}


# ---------------------------------------------------------------------------------------- routes never return the key

def test_no_route_returns_the_key(client):
    view = client.post("/api/llm-settings", json={
        "base_url": "https://llm.example/v1", "model": "m", "effort": "high", "api_key": KEY}).json()
    assert view["api_key"] == {"stored": True, "last4": "wxyz"} and view["configured"] is True
    assert view["key_file"].endswith(llm_config.FILE_NAME)
    for path in ("/api/llm-settings", "/api/settings", "/api/health", "/api/capabilities"):
        answer = client.get(path)
        assert answer.status_code == 200
        _no_key(answer.text)
    _no_key(client.delete("/api/llm-settings/api-key").text)


@pytest.mark.parametrize("body", [
    {"api_key": KEY + "\nX-Injected: 1"},
    {"api_key": KEY, "base_url": "ftp://llm.example/" + KEY},
    {"api_key": KEY, "model": ""},
    {"api_key": KEY, "effort": "turbo"},
    {"api_key": KEY, "unknown": KEY},
    {"api_key": [KEY]},
])
def test_invalid_saves_are_refused_in_greek_without_echo(client, tmp_path, body):
    answer = client.post("/api/llm-settings", json=body)
    assert answer.status_code == 422
    _no_key(answer.text)
    assert not _llm_file(tmp_path).exists()


def test_a_non_object_body_is_refused_without_echo(client):
    answer = client.post("/api/llm-settings", json=[KEY])
    assert answer.status_code == 422
    _no_key(answer.text)


def test_settings_repr_never_shows_the_key(monkeypatch):
    from app.config import Settings
    monkeypatch.setenv("CRATEMIND_LLM1_API_KEY", KEY)
    settings = Settings(_env_file=None)
    assert settings.llm1_api_key == KEY
    _no_key(repr(settings))
    _no_key(repr(llm_config.LLMConfig("u", "m", "high", KEY)))


# ---------------------------------------------------------------------------------------- connection test

def test_connection_success_lists_the_model(provider):
    answer = llm_client.check_connection(provider.url, "test-model", KEY)
    assert answer == {"ok": True, "model_listed": True,
                      "message": "Η σύνδεση πέτυχε· το μοντέλο «test-model» είναι διαθέσιμο."}
    assert provider.seen == [("GET", "/v1/models", f"Bearer {KEY}")]  # one request, no tokens spent
    unlisted = llm_client.check_connection(provider.url, "other-model", KEY)
    assert unlisted["ok"] is True and unlisted["model_listed"] is False


def test_connection_401_reports_the_code_but_never_the_key_or_message(provider):
    provider.reply = (401, {"error": {"message": f"Incorrect API key provided: {KEY}", "code": "invalid_api_key"}})
    answer = llm_client.check_connection(provider.url, "test-model", KEY)
    assert answer["ok"] is False
    assert answer["message"] == "Ο πάροχος απέρριψε το κλειδί API (HTTP 401 · invalid_api_key)."
    _no_key(json.dumps(answer))


def test_connection_timeout_is_short_and_greek(provider):
    provider.delay = 1.0
    started = time.monotonic()
    answer = llm_client.check_connection(provider.url, "test-model", KEY, timeout=0.2)
    assert time.monotonic() - started < 0.9
    assert answer == {"ok": False, "model_listed": None,
                      "message": "Ο πάροχος δεν απάντησε μέσα σε 0,2 δευτερόλεπτα."}


def test_a_redirect_never_carries_the_key_to_another_host(provider, monkeypatch):
    # urllib's default handler would resend the Authorization header to wherever Location points.
    elsewhere = _Provider()
    try:
        provider.reply = (302, {})
        provider.location = elsewhere.url + "/models"
        answer = llm_client.check_connection(provider.url, "test-model", KEY)
        assert answer["ok"] is False and answer["message"].startswith("Η διεύθυνση ανακατευθύνει αλλού (HTTP 302)")
        monkeypatch.setattr(llm_client, "current_config", lambda: llm_config.LLMConfig(provider.url, "m", "high", KEY))
        with pytest.raises(llm_client.LLMClientError):
            llm_client.research_json("s", "u", {})
        assert [seen[0] for seen in provider.seen] == ["GET", "POST"]
        assert elsewhere.seen == []
    finally:
        elsewhere.close()


def test_connection_refused_and_other_failures():
    answer = llm_client.check_connection(_closed_port_url(), "m", KEY, timeout=2)
    assert answer["ok"] is False and answer["message"].startswith("Δεν έγινε σύνδεση")
    assert llm_client.check_connection("", "m", KEY)["message"].startswith("Συμπλήρωσε")


def test_connection_route_uses_the_draft_and_the_saved_key(client, provider):
    client.post("/api/llm-settings", json={"base_url": "https://saved.example/v1", "model": "saved", "api_key": KEY})
    answer = client.post("/api/llm-settings/test", json={"base_url": provider.url, "model": "test-model"})
    assert answer.status_code == 200 and answer.json()["ok"] is True
    assert provider.seen[-1] == ("GET", "/v1/models", f"Bearer {KEY}")
    _no_key(answer.text)
    provider.reply = (401, {"error": {"message": f"bad key {OTHER_KEY}", "type": "invalid_request_error"}})
    answer = client.post("/api/llm-settings/test", json={"base_url": provider.url, "api_key": OTHER_KEY})
    assert answer.json()["ok"] is False and provider.seen[-1][2] == f"Bearer {OTHER_KEY}"
    _no_key(answer.text, KEY, OTHER_KEY)
    refused = client.post("/api/llm-settings/test", json={"base_url": "file:///etc", "api_key": OTHER_KEY})
    assert refused.status_code == 422
    _no_key(refused.text, KEY, OTHER_KEY)


def test_no_key_in_logs_or_streams_during_provider_errors(provider, caplog, capfd, monkeypatch):
    caplog.set_level(logging.DEBUG)
    provider.reply = (500, {"error": {"message": f"upstream saw {KEY}"}})
    assert llm_client.check_connection(provider.url, "m", KEY)["ok"] is False
    monkeypatch.setattr(llm_client, "current_config",
                        lambda: llm_config.LLMConfig(provider.url, "m", "high", KEY))
    with pytest.raises(llm_client.LLMClientError) as raised:
        llm_client.research_json("s", "u", {})
    provider.delay = 1.0
    llm_client.check_connection(provider.url, "m", KEY, timeout=0.2)
    out, err = capfd.readouterr()
    for text in (caplog.text, out, err, str(raised.value), repr(raised.value)):
        _no_key(text)


# ---------------------------------------------------------------------------------------- backups and exchange bundles

def _texts_with(root: Path, needle: bytes) -> set[str]:
    hits = set()
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        data = path.read_bytes()
        if needle in data:
            hits.add(str(path.relative_to(root)))
        if zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as archive:
                for name in archive.namelist():
                    if needle in archive.read(name):
                        hits.add(f"{path.relative_to(root)}!{name}")
    return hits


def test_the_key_is_in_no_backup_or_exchange_bundle(tmp_path, monkeypatch):
    from app import config
    from app.library_exchange import operations as exchange
    from app.services.backup import create_backup

    root = tmp_path / "app-data"
    dataset = exchange.initialize_empty(root)
    monkeypatch.setenv("CRATEMIND_DATASET_ROOT", str(root))
    for key in ("CRATEMIND_DB_PATH", "CRATEMIND_IDENTITY_DB_PATH"):
        monkeypatch.delenv(key, raising=False)
    config.get_settings.cache_clear()
    try:
        assert llm_config.file_path() == root / llm_config.FILE_NAME  # beside desktop-config.json, outside datasets/
        llm_config.save({"base_url": "https://llm.example/v1", "model": "m", "api_key": KEY})
        create_backup(dataset.catalog_path, root / "backups")
        exchange.export_exchange(root, tmp_path / "bundle.cmexchange")
    finally:
        config.get_settings.cache_clear()
    assert (tmp_path / "bundle.cmexchange").is_file() and any((root / "backups").iterdir())
    assert _texts_with(tmp_path, KEY.encode()) == {f"app-data/{llm_config.FILE_NAME}"}


# ---------------------------------------------------------------------------------------- migration out of desktop-config.json

def _config(root: Path, **extra) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    path = root / "desktop-config.json"
    path.write_text(json.dumps({"version": 1, "revision": "r1", "library_roots": [], "scan_roots": ["/x"], **extra}))
    return path


def test_migration_moves_top_level_values_and_removes_them(tmp_path):
    path = _config(tmp_path, llm1_base_url="http://127.0.0.1:9/v1", llm1_api_key=KEY,
                   llm1_model="test-model", llm1_model_effort="max")
    assert llm_config.migrate_desktop_config(tmp_path) is True
    assert json.loads(path.read_text()) == {"version": 1, "revision": "r1", "library_roots": [], "scan_roots": ["/x"]}
    assert llm_config.read_file(_llm_file(tmp_path)) == {
        "base_url": "http://127.0.0.1:9/v1", "api_key": KEY, "model": "test-model", "effort": "max"}
    if os.name != "nt":
        assert stat.S_IMODE(_llm_file(tmp_path).stat().st_mode) == 0o600
    # Idempotent: a second start finds nothing to move and rewrites nothing.
    mtime = path.stat().st_mtime_ns
    assert llm_config.migrate_desktop_config(tmp_path) is False
    assert path.stat().st_mtime_ns == mtime


def test_migration_reads_the_older_nested_object_with_the_top_level_winning(tmp_path):
    path = _config(tmp_path, llm1_model="top-model",
                   artist_enrichment={"llm1_api_key": KEY, "llm1_model": "nested-model", "llm1_base_url": ""})
    assert llm_config.migrate_desktop_config(tmp_path) is True
    assert llm_config.read_file(_llm_file(tmp_path)) == {"api_key": KEY, "model": "top-model"}
    assert "artist_enrichment" not in json.loads(path.read_text())
    _no_key(path.read_text())


def test_migration_never_overwrites_a_saved_value_but_still_clears_the_old_key(tmp_path):
    llm_config.write_file(_llm_file(tmp_path), {"api_key": OTHER_KEY})
    path = _config(tmp_path, llm1_api_key=KEY, artist_enrichment={"llm1_model": "m", "other": 1})
    assert llm_config.migrate_desktop_config(tmp_path) is True
    assert llm_config.read_file(_llm_file(tmp_path)) == {"api_key": OTHER_KEY, "model": "m"}
    assert json.loads(path.read_text())["artist_enrichment"] == {"other": 1}
    _no_key(path.read_text())


def test_migration_fills_a_file_saved_earlier_without_a_key(tmp_path):
    # The web runner can share this folder and save a model before the desktop's first start.
    llm_config.write_file(_llm_file(tmp_path), {"model": "web-model"})
    path = _config(tmp_path, llm1_api_key=KEY, llm1_model="old-model")
    assert llm_config.migrate_desktop_config(tmp_path) is True
    assert llm_config.read_file(_llm_file(tmp_path)) == {"api_key": KEY, "model": "web-model"}
    _no_key(path.read_text())


def test_a_crash_between_the_two_writes_is_finished_by_the_next_start(tmp_path, monkeypatch):
    from app.desktop_runtime import preferences
    path = _config(tmp_path, llm1_api_key=KEY)
    monkeypatch.setattr(preferences, "atomic_json", lambda *a: (_ for _ in ()).throw(OSError("crash")))
    with pytest.raises(OSError):
        llm_config.migrate_desktop_config(tmp_path)
    assert llm_config.read_file(_llm_file(tmp_path)) == {"api_key": KEY}  # never lost
    monkeypatch.undo()
    assert llm_config.migrate_desktop_config(tmp_path) is True
    assert llm_config.read_file(_llm_file(tmp_path)) == {"api_key": KEY}
    _no_key(path.read_text())


def test_migration_leaves_configs_without_llm_values_alone(tmp_path):
    assert llm_config.migrate_desktop_config(tmp_path) is False  # no config at all
    path = _config(tmp_path)
    mtime = path.stat().st_mtime_ns
    assert llm_config.migrate_desktop_config(tmp_path) is False
    assert path.stat().st_mtime_ns == mtime and not _llm_file(tmp_path).exists()
    path.write_text("{broken")
    assert llm_config.migrate_desktop_config(tmp_path) is False
