"""Streaming ASGI authentication for a single launch-specific loopback origin."""
from __future__ import annotations

import hmac
from http.cookies import SimpleCookie, CookieError
from urllib.parse import urlsplit

from starlette.responses import JSONResponse

CSP = (
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; "
    "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; "
    "form-action 'self'"
)


class DesktopAuth:
    def __init__(self, app, *, port: int, launch_id: str, secret: str, diagnostics: bool = False):
        self.app = app
        self.authority = f"127.0.0.1:{port}"
        self.origin = "http://" + self.authority
        self.cookie_name = "cratemind_" + launch_id
        self.secret = secret
        self.diagnostics = diagnostics

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        raw = scope.get("headers", [])
        headers = {k.decode("latin1").lower(): v.decode("latin1") for k, v in raw}
        valid = sum(k.lower() == b"host" for k, _ in raw) == 1
        valid &= headers.get("host") == self.authority
        health = scope.get("path") == "/api/desktop/health" and scope.get("method") == "GET"
        checks = {"host": bool(valid)}
        if health:
            valid &= hmac.compare_digest(headers.get("x-cratemind-desktop-secret", "").encode(), self.secret.encode())
        else:
            cookies = SimpleCookie()
            try:
                cookies.load(headers.get("cookie", ""))
                token = cookies[self.cookie_name].value if self.cookie_name in cookies else ""
            except CookieError:
                token = ""
            checks["cookie_present"] = bool(token)
            checks["cookie_matches"] = hmac.compare_digest(token.encode(), self.secret.encode())
            valid &= checks["cookie_matches"]
            origin = headers.get("origin")
            checks["origin_present"] = origin is not None
            checks["origin_matches"] = origin == self.origin
            if scope.get("method") not in {"GET", "HEAD"}:
                valid &= origin == self.origin
            elif origin is not None:
                valid &= origin == self.origin
            if "referer" in headers:
                ref = urlsplit(headers["referer"])
                checks["referer_matches"] = ref.scheme + "://" + ref.netloc == self.origin
                valid &= checks["referer_matches"]
            checks["fetch_site_allowed"] = headers.get("sec-fetch-site", "same-origin") in {"same-origin", "none"}
            valid &= checks["fetch_site_allowed"]
        if not valid:
            return await JSONResponse(status_code=403, content={
                "detail": "Μη έγκυρη συνεδρία εφαρμογής.", "code": "desktop_session_required",
                **({"checks": checks} if self.diagnostics else {}),
            })(scope, receive, send)

        async def secure_send(message):
            if message["type"] == "http.response.start":
                message = dict(message)
                message["headers"] = list(message.get("headers", [])) + [
                    (b"content-security-policy", CSP.encode()),
                    (b"referrer-policy", b"same-origin"),
                    (b"x-content-type-options", b"nosniff"),
                    (b"cache-control", b"no-store"),
                ]
            await send(message)
        await self.app(scope, receive, secure_send)
