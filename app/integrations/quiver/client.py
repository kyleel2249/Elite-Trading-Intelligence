"""
Quiver Quant API client (research only — never execution).
Auth: Authorization: Bearer <token>
Base: https://api.quiverquant.com
Documented paths only; 403 = plan does not include dataset.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from app.config import Settings, get_settings

BASE = "https://api.quiverquant.com"

# Documented endpoints (verify plan access at runtime)
PATHS = {
    "congress_live": "/beta/live/congresstrading",
    "congress_hist": "/beta/historical/congresstrading/{ticker}",
    "gov_contracts_live": "/beta/live/governmentcontracts",
    "lobbying_live": "/beta/live/lobbying",
    "lobbying_hist": "/beta/historical/lobbying/{ticker}",
    "insiders_hist": "/beta/historical/insiders/{ticker}",
    "politicians": "/beta/live/congress/politicians",
    "holdings": "/beta/live/congress_stock_holdings",
}


class QuiverClient:
    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
        self.api_key = self.settings.quiver_api_key

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
                "role": "research_only",
            }
        try:
            async with httpx.AsyncClient(timeout=20.0) as client:
                r = await client.get(f"{BASE}{PATHS['congress_live']}", headers=self._headers())
            if r.status_code == 200:
                return {
                    "provider": "quiver_quant",
                    "status": "ok",
                    "http_status": 200,
                    "retrieved_at": datetime.now(timezone.utc).isoformat(),
                    "role": "research_only",
                }
            if r.status_code == 401:
                return {"provider": "quiver_quant", "status": "auth_failed", "http_status": 401, "detail": r.text[:200]}
            if r.status_code == 403:
                return {
                    "provider": "quiver_quant",
                    "status": "plan_restricted",
                    "http_status": 403,
                    "detail": "Valid key but dataset/plan not included",
                }
            return {"provider": "quiver_quant", "status": "error", "http_status": r.status_code, "detail": r.text[:200]}
        except Exception as e:
            return {"provider": "quiver_quant", "status": "error", "error": str(e)}

    async def _get(self, path: str, params: Optional[dict] = None) -> dict[str, Any]:
        if not self.configured:
            return {"status": "not_configured", "path": path, "data": []}
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
            return {"status": "plan_restricted", "detail": r.text[:300], "data": [], **meta}
        if r.status_code == 401:
            return {"status": "auth_failed", "detail": r.text[:300], "data": [], **meta}
        return {"status": "error", "detail": r.text[:300], "data": [], **meta}

    async def congress_trading_live(self) -> dict[str, Any]:
        return await self._get(PATHS["congress_live"])

    async def congress_trading_ticker(self, ticker: str) -> dict[str, Any]:
        return await self._get(PATHS["congress_hist"].format(ticker=ticker.upper()))

    async def government_contracts_live(self) -> dict[str, Any]:
        return await self._get(PATHS["gov_contracts_live"])

    async def lobbying_live(self) -> dict[str, Any]:
        return await self._get(PATHS["lobbying_live"])

    async def lobbying_ticker(self, ticker: str) -> dict[str, Any]:
        return await self._get(PATHS["lobbying_hist"].format(ticker=ticker.upper()))

    async def insiders_ticker(self, ticker: str) -> dict[str, Any]:
        """Requires plan that includes insider data (often Trader+)."""
        return await self._get(PATHS["insiders_hist"].format(ticker=ticker.upper()))

    async def congress_politicians(self) -> dict[str, Any]:
        return await self._get(PATHS["politicians"])

    async def congress_holdings(self, ticker: Optional[str] = None) -> dict[str, Any]:
        params = {"ticker": ticker} if ticker else None
        return await self._get(PATHS["holdings"], params)

    async def dataset_availability_probe(self) -> dict[str, Any]:
        """Probe key datasets; report ok / plan_restricted / error without inventing data."""
        results = {}
        for name, coro in [
            ("congress_live", self.congress_trading_live()),
            ("gov_contracts_live", self.government_contracts_live()),
            ("lobbying_live", self.lobbying_live()),
        ]:
            results[name] = await coro
        return {
            "provider": "quiver_quant",
            "configured": self.configured,
            "datasets": {k: {"status": v.get("status"), "http_status": v.get("http_status")} for k, v in results.items()},
            "note": "Insider/13F endpoints need higher plans — probe per ticker when needed",
            "role": "research_only",
        }
