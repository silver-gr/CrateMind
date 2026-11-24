"""Web mode only: answer to our own hostnames and refuse writes sent by other websites.

The Host check stops DNS rebinding (a foreign page whose name re-resolves to this machine);
the Origin check stops a cross-site write that needs no CORS preflight, such as a POST with no body.
The desktop profile has its own, stricter checks (`desktop_runtime/auth.py`).
"""
from __future__ import annotations

from urllib.parse import urlsplit

from fastapi.responses import JSONResponse

from .runtime_profile import RuntimeProfile, runtime_profile

_UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}


def _hostname(url: str) -> str | None:
    try:
        return urlsplit(url).hostname
    except ValueError:
        return None


class WebRequestGuard:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        from .config import get_settings

        with runtime_profile(RuntimeProfile.WEB):
            allowed = get_settings().allowed_hostnames  # per request, never bound at import
        headers = {key.decode(): value.decode("latin-1") for key, value in scope["headers"]
                   if key in (b"host", b"origin")}
        if _hostname("//" + headers.get("host", "")) not in allowed:
            code = "host_not_allowed"
            detail = "Το CrateMind δεν απαντά σε αυτή τη διεύθυνση. Πρόσθεσέ τη στο CRATEMIND_ALLOWED_HOSTS."
        elif scope["method"] in _UNSAFE and "origin" in headers and _hostname(headers["origin"]) not in allowed:
            # A browser sends Origin with every cross-site write; without one it is a script or the command line.
            code = "origin_not_allowed"
            detail = ("Το αίτημα ήρθε από άλλη ιστοσελίδα και απορρίφθηκε. "
                      "Αν είναι δική σου, πρόσθεσέ τη στο CRATEMIND_ALLOWED_HOSTS.")
        else:
            return await self.app(scope, receive, send)
        await JSONResponse(status_code=403, content={"detail": detail, "code": code})(scope, receive, send)
