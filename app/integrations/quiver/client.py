"""
Quiver Quant API client.
Auth: Authorization: Bearer <token> (official docs).
Base: https://api.quiverquant.com
Never invent datasets; 403 means plan does not include dataset.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from app.config import Settings, get_settings

BASE = "https://api.quiverquant.com"


class QuiverClient:
    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
        self.api_key = getattr(self.settings, "quiver_api_key", None) or None

    @property
    def configured(self) -> bool:
        return bool(self.api_key)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}", "Accept": "application/json"}

    async def health(self) -> dict[str, Any]:
        if not self.configured:
            return {
                "provider": "quiver_quant",
                "status": "not_configured",
                "message": "QUIVER_API_KEY not set",
                "docs": "https://api.quiverquant.com/docs/authentication",
            }
        # Lightweight probe: congress trading live feed (documented)
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                r = await client.get(f"{BASE}/beta/live/congresstrading", headers=self._headers())
            if r.status_code == 200:
                return {
                    "provider": "quiver_quant",
                    "status": "ok",
                    "http_status": 200,
                    "retrieved_at": datetime.now(timezone.utc).isoformat(),
                }
            if r.status_code == 401:
                return {"provider": "quiver_quant", "status": "auth_failed", "http_status": 401, "detail": r.text[:200]}
            if r.status_code == 403:
                return {
                    "provider": "quiver_quant",
                    "status": "plan_restricted",
                    "http_status": 403,
                    "detail": "Valid key but dataset/plan not included",
                    "body": r.text[:200],
                }
            return {"provider": "quiver_quant", "status": "error", "http_status": r.status_code, "detail": r.text[:200]}
        except Exception as e:
            return {"provider": "quiver_quant", "status": "error", "error": str(e)}

    async def _get(self, path: str, params: Optional[dict] = None) -> dict[str, Any]:
        if not self.configured:
            return {"status": "not_configured", "path": path}
        url = f"{BASE}{path}"
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(url, headers=self._headers(), params=params or {})
        meta = {
            "provider": "quiver_quant",
            "path": path,
            "http_status": r.status_code,
            "retrieved_at": datetime.now(timezone.utc).isoformat(),
        }
        if r.status_code == 200:
            try:
                data = r.json()
            except Exception:
                data = r.text[:500]
            return {"status": "ok", "data": data, **meta}
        if r.status_code == 403:
            return {"status": "plan_restricted", "detail": r.text[:300], **meta}
        if r.status_code == 401:
            return {"status": "auth_failed", "detail": r.text[:300], **meta}
        return {"status": "error", "detail": r.text[:300], **meta}

    async def congress_trading_live(self) -> dict[str, Any]:
        return await self._get("/beta/live/congresstrading")

    async def congress_trading_ticker(self, ticker: str) -> dict[str, Any]:
        return await self._get(f"/beta/historical/congresstrading/{ticker.upper()}")

    async def bulk_congress_politicians(self, page_size: int = 10) -> dict[str, Any]:
        return await self._get("/beta/bulk/congress/politicians", {"page_size": page_size})
