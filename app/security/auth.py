"""API-key auth for mutating routes.

Behaviour:
- API_KEY set        -> every protected route requires a matching X-API-Key header
                        (compared in constant time).
- API_KEY not set    -> allowed only in local development. In production/staging
                        (APP_ENV=production|prod|staging) protected routes fail
                        closed with HTTP 503 instead of silently running open.
"""
from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, status

from app.config import get_settings

PROTECTED_ENVS = frozenset({"production", "prod", "staging"})


async def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    settings = get_settings()
    expected = (getattr(settings, "api_key", None) or "").strip() or None

    if not expected:
        if (settings.app_env or "").strip().lower() in PROTECTED_ENVS:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="API_KEY is not configured; protected routes are disabled in this environment",
            )
        return  # local development only

    supplied = (x_api_key or "").encode("utf-8")
    if not supplied or not hmac.compare_digest(supplied, expected.encode("utf-8")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-API-Key",
        )
