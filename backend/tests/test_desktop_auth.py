from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from app.desktop_runtime.auth import DesktopAuth


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
    assert "script-src 'self'" in response.headers["content-security-policy"]


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
