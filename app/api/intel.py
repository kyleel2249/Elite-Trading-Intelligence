"""Provider-backed intelligence: economic/earnings calendar, token unlocks, provider health.

Mounted under /api/analytics/intel. Read-only; nothing here can place an order. Provider failures are reported
as structured errors (never a fabricated empty success).
"""
import hmac
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query

from app.config import get_settings
from app.providers import intel as intel_logic
from app.providers.feed import to_readiness_events
from app.providers.base import ProviderError
from app.providers.registry import Registry, get_registry
from app.security.auth import PROTECTED_ENVS, require_api_key

logger = logging.getLogger("eti.api.intel")
router = APIRouter(prefix="/intel", tags=["analytics-intel"])

_STATUS = {"not_configured": 503, "auth": 502, "plan_restricted": 502, "rate_limited": 429, "circuit_open": 503,
           "bad_request": 422, "bad_response": 502, "upstream": 502}


def _http(e: ProviderError) -> HTTPException:
    logger.warning("provider error %s", e)
    return HTTPException(status_code=_STATUS.get(e.kind, 502), detail={"provider": e.provider, "error": e.kind, "message": e.detail})


@router.get("/providers")
async def provider_status(reg: Registry = Depends(get_registry)):
    """Health of every intelligence provider: configured?, status, latency, last sync, quota, missing credentials."""
    return reg.status()


@router.get("/providers/health-log")
async def provider_health_log(limit: int = Query(100, ge=1, le=200), reg: Registry = Depends(get_registry)):
    return {p.name: p.health.history[-limit:] for p in reg.clients()}


@router.post("/providers/probe")
async def provider_probe(reg: Registry = Depends(get_registry), _auth=Depends(require_api_key)):
    """Real, read-only request per provider (spends a small amount of quota). Authenticated."""
    return {"fmp": await reg.fmp.probe() if reg.fmp.configured else {"status": "not_configured"},
            "tokenomist": await reg.tokenomist.probe() if reg.tokenomist.configured else {"status": "not_configured"}}


@router.get("/calendar/economic")
async def economic_calendar(days: int = Query(7, ge=1, le=90), currencies: Optional[str] = None,
                            min_impact: str = Query("low", pattern="^(low|medium|high)$"), reg: Registry = Depends(get_registry)):
    start = datetime.now(timezone.utc).date()
    try:
        res, attempts = await reg.capabilities["calendar"].call("economic_calendar", start, start + timedelta(days=days))
    except ProviderError as e:
        raise _http(e)
    order = {"low": 0, "medium": 1, "high": 2}
    wanted = {c.strip().upper() for c in currencies.split(",")} if currencies else None
    rows = [r for r in res.data if order.get(r["impact"], 0) >= order[min_impact] and (not wanted or (r["currency"] or "").upper() in wanted)]
    return {"count": len(rows), "events": rows, "provenance": res.provenance(), "failover_attempts": attempts}


def _feed_auth(authorization: Optional[str] = Header(default=None), reg: Registry = Depends(get_registry)) -> None:
    """Bearer check for the Worker's ETI_EVENT_FEED_TOKEN. Fails closed in production when no token is configured."""
    if not reg.event_feed_token:
        if (get_settings().app_env or "").strip().lower() in PROTECTED_ENVS:
            raise HTTPException(status_code=503, detail="EVENT_FEED_TOKEN is not configured")
        return
    supplied = authorization[7:] if authorization and authorization.startswith("Bearer ") else ""
    if not hmac.compare_digest(supplied.encode(), reg.event_feed_token.encode()):
        raise HTTPException(status_code=401, detail="invalid feed token")


@router.get("/calendar/feed")
async def readiness_event_feed(days: int = Query(14, ge=1, le=30), reg: Registry = Depends(get_registry), _=Depends(_feed_auth)):
    """Economic calendar in the Worker readiness engine's feed format. Point the Worker's ETI_EVENT_FEED_URL here."""
    start = datetime.now(timezone.utc).date()
    try:
        res, attempts = await reg.capabilities["calendar"].call("economic_calendar", start - timedelta(days=1), start + timedelta(days=days))
    except ProviderError as e:
        raise _http(e)
    return {**to_readiness_events(res.data), "source": res.provider, "generated_at": res.fetched_at.isoformat(),
            "failover_attempts": attempts}


@router.get("/calendar/earnings")
async def earnings_calendar(days: int = Query(7, ge=1, le=90), symbols: Optional[str] = None, reg: Registry = Depends(get_registry)):
    start = datetime.now(timezone.utc).date()
    try:
        res, attempts = await reg.capabilities["calendar"].call("earnings_calendar", start, start + timedelta(days=days))
    except ProviderError as e:
        raise _http(e)
    wanted = {s.strip().upper() for s in symbols.split(",")} if symbols else None
    rows = [r for r in res.data if not wanted or r["symbol"] in wanted]
    return {"count": len(rows), "earnings": rows, "provenance": res.provenance(), "failover_attempts": attempts}


@router.get("/event-risk")
async def event_risk(symbol: str = "BTCUSDT", horizon_hours: float = Query(48, ge=1, le=168), reg: Registry = Depends(get_registry)):
    """Event-aware volatility warning for a symbol, based on the economic calendar for its currencies."""
    now = datetime.now(timezone.utc)
    try:
        res, attempts = await reg.capabilities["calendar"].call("economic_calendar", (now - timedelta(days=1)).date(),
                                                                (now + timedelta(hours=horizon_hours)).date() + timedelta(days=1))
    except ProviderError as e:
        raise _http(e)
    currs = intel_logic.currencies_for_symbol(symbol)
    out = intel_logic.event_risk(res.data, now, horizon_hours, currs or None)
    return {"symbol": symbol.upper(), "currencies_considered": currs, **out, "provenance": res.provenance(),
            "corroboration": intel_logic.corroborate([{"provider": res.provider}])}


@router.get("/unlocks/{token_id}")
async def token_unlocks(token_id: str, days: int = Query(30, ge=1, le=365), reg: Registry = Depends(get_registry)):
    """Upcoming cliff unlocks and supply-pressure metrics for one token slug (e.g. 'arbitrum'). Spends 2+ API credits."""
    now = datetime.now(timezone.utc)
    try:
        meta, _ = await reg.capabilities["token_unlocks"].call("token_list", [token_id])
        ev, attempts = await reg.capabilities["token_unlocks"].call("unlock_events", token_id, now.date(), now.date() + timedelta(days=days))
    except ProviderError as e:
        raise _http(e)
    if not meta.data:
        raise HTTPException(status_code=404, detail="token not found at provider")
    out = intel_logic.unlock_risk(ev.data, meta.data[0], now, horizon_days=days)
    return {"token_id": token_id, **out, "provenance": ev.provenance(), "failover_attempts": attempts,
            "corroboration": intel_logic.corroborate([{"provider": ev.provider}])}
