"""Tradable-symbol discovery: every Binance spot pair (public, no keys) and Alpaca US equities (needs keys).

Binance's exchangeInfo is the source of truth, so newly listed pairs appear automatically when the cache
refreshes (10 minutes, or on demand at most once a minute). Nothing is hard-coded or invented: if a source cannot
be reached its status says so, and a stale cached list is labelled stale rather than passed off as current.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from app.config import Settings, get_settings

logger = logging.getLogger("eti.symbols")

BINANCE_PUBLIC_URL = "https://api.binance.com"   # market data only; never used for orders
CACHE_TTL_SECONDS = 600
MIN_REFRESH_SECONDS = 60

_cache: dict[str, dict[str, Any]] = {}


async def _fetch_binance(transport: Optional[httpx.AsyncBaseTransport] = None) -> list[dict[str, Any]]:
    async with httpx.AsyncClient(timeout=30.0, transport=transport) as c:
        r = await c.get(f"{BINANCE_PUBLIC_URL}/api/v3/exchangeInfo")
        r.raise_for_status()
        data = r.json()
    out = []
    for s in data.get("symbols", []):
        if s.get("status") != "TRADING" or not s.get("isSpotTradingAllowed", True):
            continue
        sym = str(s.get("symbol") or "").upper()
        if not sym:
            continue
        out.append({"provider": "binance", "symbol": sym, "base": s.get("baseAsset"), "quote": s.get("quoteAsset"),
                    "name": None, "asset_class": "crypto", "exchange": "BINANCE"})
    return out


async def _fetch_alpaca(settings: Settings, transport: Optional[httpx.AsyncBaseTransport] = None) -> list[dict[str, Any]]:
    base = settings.alpaca_base_url.rstrip("/")
    headers = {"APCA-API-KEY-ID": settings.alpaca_api_key or "", "APCA-API-SECRET-KEY": settings.alpaca_secret_key or ""}
    async with httpx.AsyncClient(timeout=30.0, transport=transport) as c:
        r = await c.get(f"{base}/v2/assets", headers=headers, params={"status": "active", "asset_class": "us_equity"})
        r.raise_for_status()
        rows = r.json()
    out = []
    for a in rows if isinstance(rows, list) else []:
        if not a.get("tradable"):
            continue
        sym = str(a.get("symbol") or "").upper()
        if sym:
            out.append({"provider": "alpaca", "symbol": sym, "base": sym, "quote": "USD", "name": a.get("name"),
                        "asset_class": "equity", "exchange": a.get("exchange")})
    return out


def _meta(entry: Optional[dict[str, Any]], status: str, message: Optional[str] = None) -> dict[str, Any]:
    return {"status": status, "count": len(entry["items"]) if entry else 0, "message": message,
            "fetched_at": datetime.fromtimestamp(entry["at"], timezone.utc).isoformat() if entry else None}


async def get_source(provider: str, settings: Optional[Settings] = None, refresh: bool = False,
                     transport: Optional[httpx.AsyncBaseTransport] = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Return (items, meta) for one provider. meta.status: ok | stale | unavailable | not_configured."""
    settings = settings or get_settings()
    if provider == "alpaca" and not (settings.alpaca_api_key and settings.alpaca_secret_key):
        return [], _meta(None, "not_configured", "ALPACA_API_KEY / ALPACA_SECRET_KEY are not set, so stocks cannot be listed")
    entry = _cache.get(provider)
    age = time.time() - entry["at"] if entry else None
    if entry and age is not None and age < CACHE_TTL_SECONDS and not (refresh and age >= MIN_REFRESH_SECONDS):
        return entry["items"], _meta(entry, "ok")
    try:
        items = await (_fetch_binance(transport) if provider == "binance" else _fetch_alpaca(settings, transport))
    except Exception as exc:
        logger.warning("symbol list for %s failed: %s", provider, type(exc).__name__, exc_info=True)
        if entry:
            return entry["items"], _meta(entry, "stale", "refresh failed; showing the last list we successfully fetched")
        return [], _meta(None, "unavailable", f"could not load the {provider} symbol list ({type(exc).__name__})")
    entry = {"items": items, "at": time.time()}
    _cache[provider] = entry
    return items, _meta(entry, "ok")


def search(items: list[dict[str, Any]], q: str = "", quote: str = "") -> list[dict[str, Any]]:
    q, quote = (q or "").strip().upper(), (quote or "").strip().upper()
    rows = items
    if quote:
        rows = [i for i in rows if (i.get("quote") or "").upper() == quote]
    if q:
        rows = [i for i in rows if q in i["symbol"] or q in (i.get("name") or "").upper()]
        rows = sorted(rows, key=lambda i: (not i["symbol"].startswith(q), i["symbol"]))
    else:
        rows = sorted(rows, key=lambda i: i["symbol"])
    return rows
