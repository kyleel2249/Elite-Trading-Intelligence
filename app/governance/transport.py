"""Encryption in transit: HTTPS enforcement + security headers (pure ASGI, no body buffering).

Enabled in every non-local environment (GOV_ENFORCE_HTTPS overrides). TLS itself terminates at the platform edge (Cloudflare /
Render); this layer refuses to serve cleartext requests that arrive through it (X-Forwarded-Proto: http), sends HSTS, and adds
no-store caching for API responses so secrets and approvals are never cached by browsers or intermediaries.
"""
from __future__ import annotations

import os
from typing import Awaitable, Callable

from app.governance import keys

EXEMPT = ("/health", "/healthz", "/api/health")
LOOPBACK = {"localhost", "127.0.0.1", "::1", "testserver"}


def https_enforced() -> bool:
    raw = (os.getenv("GOV_ENFORCE_HTTPS") or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return not keys.is_local()


class SecurityHeadersMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive: Callable[[], Awaitable[dict]], send: Callable[[dict], Awaitable[None]]):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
        path = scope.get("path", "")
        enforce = https_enforced()
        proto = (headers.get("x-forwarded-proto") or scope.get("scheme") or "https").split(",")[0].strip().lower()
        host = (headers.get("host") or "").split(":")[0].lower()
        if enforce and proto == "http" and path not in EXEMPT and host not in LOOPBACK:
            target = f"https://{headers.get('host', host)}{path}" + (f"?{scope['query_string'].decode()}" if scope.get("query_string") else "")
            await send({"type": "http.response.start", "status": 308, "headers": [(b"location", target.encode()), (b"content-length", b"0")]})
            return await send({"type": "http.response.body", "body": b""})
        is_api = path.startswith("/api/")

        async def wrapped(message: dict) -> None:
            if message["type"] == "http.response.start":
                hdr = list(message.get("headers", []))
                have = {k.lower() for k, _ in hdr}
                add = [(b"x-content-type-options", b"nosniff"), (b"x-frame-options", b"DENY"), (b"referrer-policy", b"no-referrer"),
                       (b"permissions-policy", b"camera=(), microphone=(), geolocation=(), payment=()"),
                       (b"cross-origin-opener-policy", b"same-origin")]
                if enforce:
                    add.append((b"strict-transport-security", b"max-age=31536000; includeSubDomains"))
                if is_api:
                    add += [(b"cache-control", b"no-store"), (b"content-security-policy", b"default-src 'none'; frame-ancestors 'none'")]
                hdr += [(k, v) for k, v in add if k not in have]
                message["headers"] = hdr
            await send(message)
        await self.app(scope, receive, wrapped)
