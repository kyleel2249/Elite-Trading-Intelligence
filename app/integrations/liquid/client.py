"""
Liquid integration status probe.

IMPORTANT (verified research):
- The historical Quoine/Liquid *crypto exchange* (liquid.com) is NOT confirmed
  as an operational trading API for ETI in current public documentation.
- Current public "Liquid" products include: Liquid Network (Blockstream),
  Liquid AI (LLM API at api.liquid.ai), and unrelated DeFi aggregators.
- ETI will NOT fabricate exchange order/book endpoints.

This connector reports operational status honestly. Optional LIQUID_API_BASE_URL
+ LIQUID_API_KEY allow a user-supplied verified base URL probe only.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from app.config import Settings, get_settings


class LiquidClient:
    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()
        self.api_key = getattr(self.settings, "liquid_api_key", None)
        self.base_url = (getattr(self.settings, "liquid_api_base_url", None) or "").rstrip("/")

    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.base_url)

    async def health(self) -> dict[str, Any]:
        note = (
            "No verified public Liquid *exchange* trading API is assumed by ETI. "
            "Set LIQUID_API_BASE_URL + LIQUID_API_KEY only for a provider you have validated. "
            "Withdrawals are never requested."
        )
        if not self.configured:
            return {
                "provider": "liquid",
                "status": "not_configured",
                "trading_supported": False,
                "message": note,
                "research_note": (
                    "Do not confuse with Liquid AI (api.liquid.ai) or Blockstream Liquid Network."
                ),
            }
        # Probe only the user-supplied base URL root or /health if present — no invented paths
        try:
            headers = {"Authorization": f"Bearer {self.api_key}", "Accept": "application/json"}
            async with httpx.AsyncClient(timeout=15.0) as client:
                r = await client.get(self.base_url, headers=headers)
            return {
                "provider": "liquid",
                "status": "reachable" if r.status_code < 500 else "error",
                "http_status": r.status_code,
                "trading_supported": False,  # until user verifies order endpoints in docs
                "message": "Base URL responded; trading endpoints not assumed",
                "retrieved_at": datetime.now(timezone.utc).isoformat(),
                "note": note,
            }
        except Exception as e:
            return {
                "provider": "liquid",
                "status": "unreachable",
                "error": str(e),
                "trading_supported": False,
                "message": note,
            }
