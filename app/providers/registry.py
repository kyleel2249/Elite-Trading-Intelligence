"""Builds provider clients from environment settings and groups them by capability (primary first)."""
from __future__ import annotations

from functools import lru_cache
from typing import Any, Optional

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from .base import Capability, ProviderClient
from .fmp import FMPClient
from .health import FeedStats
from .tokenomist import TokenomistClient
from .whale_alert import WhaleAlertClient


class ProviderSettings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", case_sensitive=False, extra="ignore",
                                      env_ignore_empty=True, populate_by_name=True)
    fmp_api_key: Optional[str] = None
    tokenomist_api_key: Optional[str] = None
    whale_alert_api_key: Optional[str] = None
    tokenomist_credit_reserve: float = 0.10
    # Bearer token the Worker sends to /calendar/feed. The Worker names it ETI_EVENT_FEED_TOKEN; both names are accepted here.
    event_feed_token: Optional[str] = Field(default=None, validation_alias=AliasChoices("EVENT_FEED_TOKEN", "ETI_EVENT_FEED_TOKEN", "event_feed_token"))


class Registry:
    def __init__(self, s: ProviderSettings):
        self.fmp = FMPClient(s.fmp_api_key)
        self.tokenomist = TokenomistClient(s.tokenomist_api_key, credit_reserve=s.tokenomist_credit_reserve)
        self.whale = WhaleAlertClient(s.whale_alert_api_key)
        self.capabilities: dict[str, Capability] = {
            "calendar": Capability("calendar", [self.fmp]),            # add a second calendar provider here
            "fundamentals": Capability("fundamentals", [self.fmp]),
            "token_unlocks": Capability("token_unlocks", [self.tokenomist]),
            "whale_activity": Capability("whale_activity", [self.whale]),
        }
        self.event_feed_token = (s.event_feed_token or "").strip() or None
        self.whale_key_present = self.whale.configured
        self.feed = FeedStats()

    def clients(self) -> list[ProviderClient]:
        return [self.fmp, self.tokenomist, self.whale]

    def status(self) -> dict[str, Any]:
        providers = [p.health_snapshot(stale_after_seconds=24 * 3600) for p in self.clients()]
        envs = {"fmp": "FMP_API_KEY", "tokenomist": "TOKENOMIST_API_KEY", "whale_alert": "WHALE_ALERT_API_KEY"}
        unconfigured = [p for p in providers if p["status"] == "unconfigured"]
        missing = [{"provider": p["provider"], "env": envs[p["provider"]]} for p in unconfigured if p["provider"] != "whale_alert"]
        return {"providers": providers, "missing_credentials": missing,
                "optional_missing_credentials": [{"provider": p["provider"], "env": envs[p["provider"]]} for p in unconfigured if p["provider"] == "whale_alert"],
                "degraded": [p["provider"] for p in providers if p["status"] in ("degraded", "down")]}


@lru_cache
def get_registry() -> Registry:
    return Registry(ProviderSettings())
