"""Web mode answers only to its own hostnames and refuses writes sent by other websites.

TestClient's own Host, `testserver`, is allowed by the hermetic environment in conftest.py.
"""
import anyio
import pytest
from fastapi.testclient import TestClient

EVIL = "https://evil.example"


def _configure(monkeypatch, **env):
    import app.config as cfg
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    cfg.get_settings.cache_clear()


# ----- Host (DNS rebinding) -----

@pytest.mark.parametrize("path", ["/api/health", "/docs", "/api/tracks/1/audio", "/api/tracks/1/artwork"])
def test_foreign_host_is_refused_on_reads(client, path):
    response = client.get(path, headers={"host": "evil.example"})
    assert response.status_code == 403
    assert response.json()["code"] == "host_not_allowed"
    assert "CRATEMIND_ALLOWED_HOSTS" in response.json()["detail"]


@pytest.mark.parametrize("host", [
    "localhost", "localhost:8000", "LOCALHOST:8000", "127.0.0.1:8010", "[::1]:8000", "[::1]", "testserver",
])
def test_own_hosts_are_served(client, host):
    assert client.get("/api/health", headers={"host": host}).status_code == 200


@pytest.mark.parametrize("host", [
    "evil.example:8000", "localhost.evil.example", "localhost@evil.example", "evil.example#localhost",
    "localhost.", "[::2]:8000", "[::1", "",
])
def test_other_hosts_are_refused(client, host):
    assert client.get("/api/health", headers={"host": host}).status_code == 403


def test_missing_host_is_refused(client):
    sent = []

    async def call():
        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            sent.append(message)

        await client.app({"type": "http", "asgi": {"version": "3.0"}, "http_version": "1.0", "method": "GET",
                          "scheme": "http", "path": "/api/health", "raw_path": b"/api/health", "query_string": b"",
                          "headers": [], "server": ("127.0.0.1", 8000), "client": ("127.0.0.1", 1)}, receive, send)

    anyio.run(call)
    assert sent[0]["status"] == 403


def test_allowed_hosts_setting_is_exact_and_read_per_request(client, monkeypatch):
    assert client.get("/api/health", headers={"host": "studio.example:8000"}).status_code == 403
    _configure(monkeypatch, CRATEMIND_ALLOWED_HOSTS="Studio.Example, [fd7a::1], .ts.net, *.ngrok-free.dev")
    assert client.get("/api/health", headers={"host": "studio.example:8000"}).status_code == 200
    assert client.get("/api/health", headers={"host": "[fd7a::1]:8000"}).status_code == 200
    assert client.post("/api/sets", json={"title": "from the studio"},
                       headers={"host": "studio.example", "origin": "https://studio.example"}).status_code == 200
    # No wildcard suffixes: anyone can register a name under a shared domain.
    for host in ("mac.ts.net", "x.ngrok-free.dev", "sub.studio.example", "testserver"):
        assert client.get("/api/health", headers={"host": host}).status_code == 403


def test_cors_origin_hostnames_are_allowed(client, monkeypatch):
    _configure(monkeypatch, CRATEMIND_CORS_ORIGINS="http://localhost:5173, https://front.example:8446")
    assert client.get("/api/health", headers={"host": "front.example"}).status_code == 200
    assert client.post("/api/sets", json={"title": "from the front"},
                       headers={"origin": "https://front.example:8446"}).status_code == 200


# ----- Origin on writes (cross-site requests) -----

def test_cross_site_json_write_is_refused(client):
    response = client.post("/api/sets", json={"title": "cross-site"}, headers={"origin": EVIL})
    assert response.status_code == 403
    assert response.json()["code"] == "origin_not_allowed"
    assert client.get("/api/sets").json() == []


def test_cross_site_write_without_a_body_is_refused(client):
    """A POST with no body needs no preflight, so only the Origin check stops it."""
    response = client.post("/api/facets/presets/therapy", headers={"origin": EVIL})
    assert response.status_code == 403
    assert client.get("/api/facets").json() == []
    assert client.post("/api/facets/presets/therapy").status_code == 200
    assert client.get("/api/facets").json() != []


@pytest.mark.parametrize("origin", [EVIL, "null", "http://localhost.evil.example", "evil.example", ""])
@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_foreign_origin_is_refused_on_every_unsafe_method(client, method, origin):
    assert client.request(method, "/api/sets/1", headers={"origin": origin}).status_code == 403


@pytest.mark.parametrize("origin", [
    None, "http://localhost:5173", "http://localhost:5174", "HTTP://LOCALHOST:5173", "http://127.0.0.1:5173",
    "http://[::1]:5173", "http://testserver",
])
def test_own_origins_and_scripts_may_write(client, origin):
    headers = {"origin": origin} if origin else {}
    assert client.post("/api/sets", json={"title": "mine"}, headers=headers).status_code == 200
    assert client.patch("/api/sets/1/tracks/reorder", json={"track_ids": []}, headers=headers).status_code != 403


def test_reads_check_the_host_only(client):
    for origin in (EVIL, "null"):
        response = client.get("/api/health", headers={"origin": origin})
        assert response.status_code == 200
        assert "access-control-allow-origin" not in response.headers


def test_json_sent_as_plain_text_is_not_parsed(client):
    """FastAPI parses a body as JSON only with a JSON Content-Type (true before the guard as well)."""
    for headers in ({"content-type": "text/plain"}, {}, {"content-type": "application/x-www-form-urlencoded"}):
        response = client.post("/api/sets", content=b'{"title": "plain"}', headers=headers)
        assert response.status_code == 422
    assert client.get("/api/sets").json() == []


# ----- unchanged behaviour -----

def test_cors_for_the_configured_origin_is_unchanged(client):
    origin = "http://localhost:5173"
    for response in (client.get("/api/health", headers={"origin": origin}),
                     client.post("/api/sets", json={"title": "cors"}, headers={"origin": origin})):
        assert response.status_code == 200
        assert response.headers["access-control-allow-origin"] == origin
        assert response.headers["access-control-allow-credentials"] == "true"
    preflight = {"access-control-request-method": "POST", "access-control-request-headers": "content-type"}
    allowed = client.options("/api/sets", headers={"origin": origin, **preflight})
    assert allowed.status_code == 200
    assert allowed.headers["access-control-allow-origin"] == origin
    assert client.options("/api/sets", headers={"origin": EVIL, **preflight}).status_code == 400


def test_desktop_profile_is_unaffected(db):
    """The desktop app has its own checks (DesktopAuth); the shared app must not gain this one."""
    from app.app_factory import create_app
    from app.runtime_profile import RuntimeProfile
    with TestClient(create_app(RuntimeProfile.DESKTOP_CORE)) as desktop:
        assert desktop.get("/api/health", headers={"host": "evil.example"}).status_code == 200
        assert desktop.post("/api/sets", json={"title": "desktop"}, headers={"origin": EVIL}).status_code == 200
