"""Integration Health Center: honest, evidence-based status for every external dependency.

Rules: a secret being present is only ``unverified``. ``ok`` requires a real provider request that succeeded. Secret values are
never read here, only whether they exist. Error detail is limited to the error *kind* (no provider text, URLs or keys).
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Optional

from .base import ProviderClient, utcnow

STATUS_TEXT = {
    "ok": "Operational: a real provider request succeeded.",
    "unconfigured": "Credential missing: set the environment variable on the backend.",
    "unverified": "Credential present but no successful provider request yet. Run verification.",
    "unauthorized": "Provider rejected the credential (invalid, expired or revoked).",
    "plan_restricted": "Credential accepted but the subscription does not allow the endpoint.",
    "degraded": "Recent requests failed; earlier requests succeeded.",
    "down": "Repeated failures; the client is backing off (circuit open).",
    "stale": "Operational earlier, but no successful request for over 24 hours.",
    "not_verified_by_worker": "Token configured, but the Worker has not yet fetched the feed successfully.",
}
ENV = {"fmp": "FMP_API_KEY", "tokenomist": "TOKENOMIST_API_KEY", "whale_alert": "WHALE_ALERT_API_KEY", "event_feed": "EVENT_FEED_TOKEN"}
USED_FOR = {"fmp": ["economic calendar", "earnings calendar", "company profile", "quote", "income statement", "key metrics"],
            "tokenomist": ["token list", "unlock events"], "whale_alert": ["blockchain status", "transactions (Enterprise REST)"],
            "event_feed": ["Worker readiness engine calendar (Authorization: Bearer)"]}
FEED_STALE_SECONDS = 24 * 3600


@dataclass
class FeedStats:
    """Requests received on /calendar/feed. The only proof the Worker is authenticated and pulling events."""
    ok: int = 0
    rejected: int = 0
    last_ok_at: Optional[datetime] = None
    last_rejected_at: Optional[datetime] = None
    last_event_count: Optional[int] = None

    def record_ok(self, events: int) -> None:
        self.ok += 1
        self.last_ok_at, self.last_event_count = utcnow(), events

    def record_rejected(self) -> None:
        self.rejected += 1
        self.last_rejected_at = utcnow()


def access_summary(verification: Optional[dict[str, Any]]) -> dict[str, Any]:
    if not verification:
        return {"level": "unknown", "endpoints": {}, "verified_at": None}
    eps = {k: v.get("status") for k, v in (verification.get("endpoints") or {}).items()}
    ok = [k for k, s in eps.items() if s == "ok"]
    level = "unknown" if not eps else "full" if len(ok) == len(eps) else "none" if not ok else "partial"
    return {"level": level, "endpoints": eps, "verified_at": verification.get("verified_at")}


def _provider_entry(client: ProviderClient, key: str) -> dict[str, Any]:
    snap = client.health_snapshot(stale_after_seconds=FEED_STALE_SECONDS)
    status = snap["status"]
    if status == "ok" and snap["sync_stale"]:
        status = "stale"
    q = snap["quota"]
    quota = None
    if q and q.get("limit"):
        used = q.get("used") or 0
        quota = {"used": used, "limit": q["limit"], "remaining": q["limit"] - used, "resets_at": q.get("resetAt"), "reported_by_provider": True}
    return {"id": key, "name": {"fmp": "Financial Modeling Prep", "tokenomist": "Tokenomist", "whale_alert": "Whale Alert"}[key],
            "capability": snap["capability"], "env": ENV[key], "used_for": USED_FOR[key], "configured": snap["configured"],
            "status": status, "status_text": STATUS_TEXT.get(status, ""), "last_success": snap["last_success"],
            "last_error": snap["last_error"], "data_age_seconds": snap["data_age_seconds"], "latest_data_timestamp": snap["latest_data_timestamp"],
            "subscription_access": access_summary(snap["verification"]), "verifying": snap["verifying"],
            "quota": quota or {"reported_by_provider": False, "local_rate_limit_per_minute": snap["rate_per_minute"]},
            "requests": snap["requests"], "failures": snap["failures"], "retries": snap["retries"], "avg_latency_ms": snap["avg_latency_ms"],
            "circuit_open": snap["circuit_open"]}


def _feed_entry(reg: Any) -> dict[str, Any]:
    fs: FeedStats = reg.feed
    now = utcnow()
    configured = bool(reg.event_feed_token)
    age = (now - fs.last_ok_at).total_seconds() if fs.last_ok_at else None
    if not configured:
        status = "unconfigured"
    elif fs.last_ok_at is None:
        status = "not_verified_by_worker"
    elif age is not None and age > FEED_STALE_SECONDS:
        status = "stale"
    elif fs.last_rejected_at and fs.last_rejected_at > fs.last_ok_at:
        status = "degraded"
    else:
        status = "ok"
    return {"id": "event_feed", "name": "ETI event feed (Worker readiness engine)", "capability": "event_feed", "env": ENV["event_feed"],
            "used_for": USED_FOR["event_feed"], "configured": configured, "status": status, "status_text": STATUS_TEXT.get(status, ""),
            "last_success": fs.last_ok_at.isoformat() if fs.last_ok_at else None,
            "last_error": {"kind": "rejected_request", "at": fs.last_rejected_at.isoformat()} if fs.last_rejected_at else None,
            "data_age_seconds": None if age is None else round(age, 1), "latest_data_timestamp": None,
            "subscription_access": {"level": "n/a", "endpoints": {}, "verified_at": None},
            "verifying": False, "quota": {"reported_by_provider": False}, "requests": fs.ok + fs.rejected, "failures": fs.rejected, "retries": 0,
            "avg_latency_ms": None, "circuit_open": False, "last_event_count": fs.last_event_count,
            "depends_on": "fmp", "note": "Operational only after the Worker (ETI_EVENT_FEED_URL + ETI_EVENT_FEED_TOKEN) has fetched the feed with a valid token."}


def build_health_center(reg: Any) -> dict[str, Any]:
    items = [_provider_entry(reg.fmp, "fmp"), _provider_entry(reg.tokenomist, "tokenomist"), _provider_entry(reg.whale, "whale_alert"), _feed_entry(reg)]
    counts: dict[str, int] = {}
    for i in items:
        counts[i["status"]] = counts.get(i["status"], 0) + 1
    configured = [i for i in items if i["configured"]]
    return {"generated_at": utcnow().isoformat(), "integrations": items, "summary": {"counts": counts, "configured": len(configured),
            "operational": sum(1 for i in configured if i["status"] == "ok"),
            "all_configured_operational": bool(configured) and all(i["status"] == "ok" for i in configured),
            "missing_credentials": [{"integration": i["id"], "env": i["env"], "required": i["id"] != "whale_alert"} for i in items if not i["configured"]]},
            "notes": ["State is in-process: it resets on restart and is per instance.", "Statuses come from real provider requests, never from the presence of a secret."]}


async def verify_all(reg: Any, only: Optional[list[str]] = None) -> dict[str, Any]:
    clients = {"fmp": reg.fmp, "tokenomist": reg.tokenomist, "whale_alert": reg.whale}
    chosen = {k: c for k, c in clients.items() if (not only or k in only) and c.configured}
    results = await asyncio.gather(*(c.verify() for c in chosen.values()), return_exceptions=True)
    return {k: ({"error": type(r).__name__} if isinstance(r, Exception) else r) for k, r in zip(chosen, results)}


_TASKS: set = set()


def schedule_auto_verification(reg: Any) -> list[str]:
    """Start background verification for configured providers that were never verified or whose result is older than their TTL."""
    names = []
    for key, c in (("fmp", reg.fmp), ("tokenomist", reg.tokenomist), ("whale_alert", reg.whale)):
        if c.needs_verification():
            names.append(key)
            t = asyncio.get_running_loop().create_task(c.verify())
            _TASKS.add(t)
            t.add_done_callback(_TASKS.discard)
    return names
