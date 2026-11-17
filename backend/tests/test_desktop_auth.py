from fastapi import FastAPI
from fastapi.responses import Response, StreamingResponse
from fastapi.testclient import TestClient

from app.desktop_runtime.auth import CSP, DesktopAuth


def client():
    app = FastAPI()
    @app.get("/audio")
    def audio():
        return StreamingResponse(iter([b"one", b"two"]), media_type="audio/wav")
    @app.post("/edit")
    def edit():
        return {"ok": True}
    @app.get("/api/desktop/health")
    def health():
        return {"status": "ok"}
    wrapped = DesktopAuth(app, port=4567, launch_id="a" * 32, secret="secret" * 8)
    return TestClient(wrapped, base_url="http://127.0.0.1:4567")


COOKIE = {"cookie": "cratemind_" + "a" * 32 + "=" + "secret" * 8}


def test_native_media_without_origin_still_authenticated_stream():
    c = client()
    assert c.get("/audio").status_code == 403
    response = c.get("/audio", headers=COOKIE)
    assert response.status_code == 200 and response.content == b"onetwo"
    csp = response.headers["content-security-policy"]
    assert "script-src 'self' 'wasm-unsafe-eval'" in csp
    assert "'unsafe-eval'" not in csp.replace("'wasm-unsafe-eval'", "")


def test_foreign_host_origin_referrer_and_site_rejected():
    c = client()
    for extra in ({"host": "localhost:4567"}, {"origin": "http://127.0.0.1:9999"},
                  {"referer": "http://evil.test/path"}, {"sec-fetch-site": "cross-site"}):
        assert c.get("/audio", headers={**COOKIE, **extra}).status_code == 403


def test_mutations_require_exact_origin_and_native_header_only_health():
    c = client()
    assert c.post("/edit", headers=COOKIE).status_code == 403
    assert c.post("/edit", headers={**COOKIE, "origin": "http://127.0.0.1:4567"}).status_code == 200
    header = {"x-cratemind-desktop-secret": "secret" * 8}
    assert c.get("/api/desktop/health", headers=header).status_code == 200
    assert c.get("/audio", headers=header).status_code == 403


def test_master_host_port_adds_exactly_its_loopback_websocket():
    assert "connect-src 'self';" in client().get("/audio", headers=COOKIE).headers["content-security-policy"]
    app = FastAPI()
    @app.get("/audio")
    def audio():
        return {"ok": True}
    wrapped = DesktopAuth(app, port=4567, launch_id="a" * 32, secret="secret" * 8, master_host_port=5123)
    csp = TestClient(wrapped, base_url="http://127.0.0.1:4567").get("/audio", headers=COOKIE).headers["content-security-policy"]
    assert "connect-src 'self' ws://127.0.0.1:5123;" in csp
    assert csp.count("ws:") == 1 and "*" not in csp


def isolation_client(master_host_port):
    app = FastAPI()
    @app.get("/audio")
    def audio():
        return Response(b"part", status_code=206, media_type="audio/wav")
    @app.get("/page")
    def page():
        return {"ok": True}
    wrapped = DesktopAuth(app, port=4567, launch_id="a" * 32, secret="secret" * 8, master_host_port=master_host_port)
    return TestClient(wrapped, base_url="http://127.0.0.1:4567")


def test_master_host_port_isolates_every_authenticated_response():
    c = isolation_client(5123)
    for path, status in (("/page", 200), ("/audio", 206), ("/missing", 404)):
        response = c.get(path, headers=COOKIE)
        assert response.status_code == status
        assert response.headers["cross-origin-opener-policy"] == "same-origin"
        assert response.headers["cross-origin-embedder-policy"] == "require-corp"
        assert response.headers.get_list("cross-origin-embedder-policy") == ["require-corp"]


def test_without_master_host_port_no_isolation_headers_and_csp_unchanged():
    c = isolation_client(None)
    for path in ("/page", "/audio", "/missing"):
        response = c.get(path, headers=COOKIE)
        assert "cross-origin-opener-policy" not in response.headers
        assert "cross-origin-embedder-policy" not in response.headers
        assert response.headers["content-security-policy"] == CSP
