"""Tradable-symbol discovery: every Binance spot pair and every Bitget spot pair (public, no keys), plus Alpaca US
equities (needs keys).

Sync model
* The exchange lists are the source of truth. The cache expires after 60 seconds and a background task (started on first
  use) re-reads Binance and Bitget every minute, so a newly listed pair appears within about a minute of the exchange
  publishing it. Nothing is hard-coded or invented.
* "New" is relative to this server: the first successful load of a provider is the baseline; any symbol that appears in a
  LATER load is stamped with `first_seen_at` and reported as new for 24 hours. We cannot know a pair's real listing time.
* If a source cannot be reached its status says so, and a stale list is labelled stale rather than passed off as current.
Binance is read through app.market.binance_hosts (official global hosts with failover, never Binance.US).
"""
from __future__ import annotations

import asyncio
import logging
import math
import time
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from app.config import Settings, get_settings
from app.market import binance_hosts

logger = logging.getLogger("eti.symbols")

CACHE_TTL_SECONDS = 60
MIN_REFRESH_SECONDS = 30
SYNC_INTERVAL_SECONDS = 60
NEW_WINDOW_SECONDS = 24 * 3600
BITGET_BASE = "https://api.bitget.com"

_cache: dict[str, dict[str, Any]] = {}
_first_seen: dict[tuple[str, str], float] = {}     # (provider, symbol) -> epoch seconds, only for post-baseline listings
_baseline: set[str] = set()                        # providers whose first successful load has happened
_sync: dict[str, Any] = {"task": None, "runs": 0, "last_run_at": None, "last_error": None}


async def _fetch_binance(transport: Optional[httpx.AsyncBaseTransport] = None) -> list[dict[str, Any]]:
    data, _host = await binance_hosts.get_json("/api/v3/exchangeInfo", transport=transport, timeout=30.0)
    out = []
    for s in (data.get("symbols", []) if isinstance(data, dict) else []):
        if s.get("status") != "TRADING" or not s.get("isSpotTradingAllowed", True):
            continue
        sym = str(s.get("symbol") or "").upper()
        if not sym:
            continue
        out.append({"provider": "binance", "symbol": sym, "base": s.get("baseAsset"), "quote": s.get("quoteAsset"),
                    "name": None, "asset_class": "crypto", "exchange": "BINANCE"})
    return out


async def _fetch_bitget(transport: Optional[httpx.AsyncBaseTransport] = None) -> list[dict[str, Any]]:
    """Bitget v2 public spot symbols. An invalid or error payload is a failure, never an empty list."""
    async with httpx.AsyncClient(timeout=30.0, transport=transport) as c:
        r = await c.get(f"{BITGET_BASE}/api/v2/spot/public/symbols")
        r.raise_for_status()
        body = r.json()
    if not isinstance(body, dict) or str(body.get("code")) != "00000" or not isinstance(body.get("data"), list):
        raise ValueError("unexpected Bitget symbols payload")
    out = []
    for s in body["data"]:
        if not isinstance(s, dict) or str(s.get("status", "")).lower() != "online":
            continue
        sym = str(s.get("symbol") or "").upper()
        if not sym:
            continue
        out.append({"provider": "bitget", "symbol": sym, "base": s.get("baseCoin"), "quote": s.get("quoteCoin"),
                    "name": None, "asset_class": "crypto", "exchange": "BITGET"})
    if not out:
        raise ValueError("Bitget returned no online symbols")
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


def _stamp_new(provider: str, items: list[dict[str, Any]], previous: Optional[list[dict[str, Any]]], now: float) -> None:
    """Record first-seen times for symbols that appear after the baseline load of this provider."""
    current = {i["symbol"] for i in items}
    if provider not in _baseline:
        _baseline.add(provider)          # first successful load: everything is existing, nothing is "new"
        return
    before = {i["symbol"] for i in previous} if previous is not None else set()
    for sym in current - before:
        _first_seen.setdefault((provider, sym), now)


def _annotate(provider: str, items: list[dict[str, Any]], now: float) -> list[dict[str, Any]]:
    out = []
    for i in items:
        seen = _first_seen.get((provider, i["symbol"]))
        new = seen is not None and now - seen <= NEW_WINDOW_SECONDS
        out.append({**i, "is_new": new, "first_seen_at": datetime.fromtimestamp(seen, timezone.utc).isoformat() if seen else None})
    return out


def _meta(entry: Optional[dict[str, Any]], status: str, message: Optional[str] = None) -> dict[str, Any]:
    return {"status": status, "count": len(entry["items"]) if entry else 0, "message": message,
            "host": entry.get("host") if entry else None,
            "fetched_at": datetime.fromtimestamp(entry["at"], timezone.utc).isoformat() if entry else None}


async def get_source(provider: str, settings: Optional[Settings] = None, refresh: bool = False,
                     transport: Optional[httpx.AsyncBaseTransport] = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Return (items, meta) for one provider. meta.status: ok | stale | unavailable | not_configured."""
    settings = settings or get_settings()
    if provider == "alpaca" and not (settings.alpaca_api_key and settings.alpaca_secret_key):
        return [], _meta(None, "not_configured", "ALPACA_API_KEY / ALPACA_SECRET_KEY are not set, so stocks cannot be listed")
    if provider not in ("binance", "bitget", "alpaca"):
        return [], _meta(None, "unavailable", f"unknown provider '{provider}'")
    entry = _cache.get(provider)
    age = time.time() - entry["at"] if entry else None
    if entry and age is not None and age < CACHE_TTL_SECONDS and not (refresh and age >= MIN_REFRESH_SECONDS):
        return _annotate(provider, entry["items"], time.time()), _meta(entry, "ok")
    try:
        if provider == "binance":
            items = await _fetch_binance(transport)
        elif provider == "bitget":
            items = await _fetch_bitget(transport)
        else:
            items = await _fetch_alpaca(settings, transport)
    except Exception as exc:
        logger.warning("symbol list for %s failed: %s", provider, type(exc).__name__, exc_info=True)
        why = exc.public_message if isinstance(exc, binance_hosts.BinanceUnavailable) else \
            f"could not load the {provider} symbol list ({type(exc).__name__})"
        if entry:
            return _annotate(provider, entry["items"], time.time()), _meta(entry, "stale", f"refresh failed; showing the last list we successfully fetched. {why}")
        return [], _meta(None, "unavailable", why)
    now = time.time()
    _stamp_new(provider, items, entry["items"] if entry else None, now)
    entry = {"items": items, "at": now, "host": binance_hosts.last_good() if provider == "binance" else None}
    _cache[provider] = entry
    return _annotate(provider, items, now), _meta(entry, "ok")


def search(items: list[dict[str, Any]], q: str = "", quote: str = "", new_only: bool = False) -> list[dict[str, Any]]:
    q, quote = (q or "").strip().upper(), (quote or "").strip().upper()
    rows = items
    if new_only:
        rows = [i for i in rows if i.get("is_new")]
    if quote:
        rows = [i for i in rows if (i.get("quote") or "").upper() == quote]
    if q:
        rows = [i for i in rows if q in i["symbol"] or q in (i.get("name") or "").upper()]
        rows = sorted(rows, key=lambda i: (not i["symbol"].startswith(q), i["symbol"]))
    elif new_only:
        rows = sorted(rows, key=lambda i: i.get("first_seen_at") or "", reverse=True)
    else:
        rows = sorted(rows, key=lambda i: i["symbol"])
    return rows


# ---------------------------------------------------------------- one-minute background sync
async def sync_once(settings: Optional[Settings] = None) -> dict[str, Any]:
    """Force-refresh Binance and Bitget (and Alpaca when configured). Failures are recorded, never raised."""
    settings = settings or get_settings()
    result: dict[str, Any] = {}
    for p in ("binance", "bitget", "alpaca"):
        _items, meta = await get_source(p, settings, refresh=True)
        result[p] = {"status": meta["status"], "count": meta["count"]}
    _sync["runs"] += 1
    _sync["last_run_at"] = datetime.now(timezone.utc).isoformat()
    _sync["last_error"] = None if all(v["status"] in ("ok", "not_configured") for v in result.values()) else "one or more sources failed or are stale"
    return result


async def _sync_loop(settings: Settings) -> None:
    while True:
        try:
            await sync_once(settings)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # keep the loop alive
            _sync["last_error"] = type(exc).__name__
            logger.warning("symbol sync failed", exc_info=True)
        await asyncio.sleep(SYNC_INTERVAL_SECONDS)


def ensure_sync_started(settings: Optional[Settings] = None) -> None:
    """Start the one-minute refresher once per process (idempotent). Called when the symbol API is first used."""
    t = _sync.get("task")
    if t is not None and not t.done():
        return
    try:
        _sync["task"] = asyncio.get_running_loop().create_task(_sync_loop(settings or get_settings()))
    except RuntimeError:
        logger.info("no running event loop; symbol sync not started")


def sync_status() -> dict[str, Any]:
    t = _sync.get("task")
    return {"running": bool(t is not None and not t.done()), "interval_seconds": SYNC_INTERVAL_SECONDS, "runs": _sync["runs"],
            "last_run_at": _sync["last_run_at"], "last_error": _sync["last_error"],
            "baseline_providers": sorted(_baseline),
            "note": "New = first seen by this server after its first load of that exchange; it is not the exchange's listing time."}


def _reset_for_tests() -> None:
    _cache.clear(); _first_seen.clear(); _baseline.clear()
    _sync.update(task=None, runs=0, last_run_at=None, last_error=None)


def _finite(x: Any) -> Optional[float]:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None
