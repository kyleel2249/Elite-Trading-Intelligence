"""Simple API-key auth for mutating routes."""
from __future__ import annotations

from fastapi import Header, HTTPException, status

from app.config import get_settings


async def require_api_key(x_api_key: str | None = Header(default=None)) -> None:
    settings = get_settings()
    expected = getattr(settings, "api_key", None) or None
    # If no API key configured, allow (local dev); production should set ETI_API_KEY
    if not expected:
        return
    if not x_api_key or x_api_key != expected:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid or missing X-API-Key")
