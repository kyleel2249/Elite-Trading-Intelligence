"""Builds provider clients from environment settings and groups them by capability (primary first)."""
from __future__ import annotations

from functools import lru_cache
from typing import Any, Optional

from pydantic_settings import BaseSettings, SettingsConfigDict

from .base import Capability, ProviderClient
from .fmp import FMPClient
from .tokenomist import TokenomistClient


class ProviderSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", case_sensitive=False, extra="ignore",
                                      env_ignore_empty=True)
    fmp_api_key: Optional[str] = None
    tokenomist_api_key: Optional[str] = None
    whale_alert_api_key: Optional[str] = None  # adapter not built yet; reported as such
    tokenomist_credit_reserve: float = 0.10
    event_feed_token: Optional[str] = None  # bearer token the Worker sends to /calendar/feed (ETI_EVENT_FEED_TOKEN)


class Registry:
    def __init__(self, s: ProviderSettings):
        self.fmp = FMPClient(s.fmp_api_key)
        self.tokenomist = TokenomistClient(s.tokenomist_api_key, credit_reserve=s.tokenomist_credit_reserve)
        self.capabilities: dict[str, Capability] = {
            "calendar": Capability("calendar", [self.fmp]),            # add a second calendar provider here
            "token_unlocks": Capability("token_unlocks", [self.tokenomist]),
        }
        self.whale_key_present = bool((s.whale_alert_api_key or "").strip())
        self.event_feed_token = (s.event_feed_token or "").strip() or None

    def clients(self) -> list[ProviderClient]:
        return [p for c in self.capabilities.values() for p in c.providers]

    def status(self) -> dict[str, Any]:
        providers = [p.health_snapshot(stale_after_seconds=24 * 3600) for p in self.clients()]
        providers.append({"provider": "whale_alert", "capability": "whale_activity", "configured": self.whale_key_present,
                          "status": "not_built", "detail": "Optional Whale Alert adapter not built; on-chain whale analysis already exists in app/alpha/whales.py"})
        missing = [{"provider": p["provider"], "env": {"fmp": "FMP_API_KEY", "tokenomist": "TOKENOMIST_API_KEY"}[p["provider"]]}
                   for p in providers if p["status"] == "unconfigured"]
        return {"providers": providers, "missing_credentials": missing,
                "degraded": [p["provider"] for p in providers if p["status"] in ("degraded", "down")]}


@lru_cache
def get_registry() -> Registry:
    return Registry(ProviderSettings())
