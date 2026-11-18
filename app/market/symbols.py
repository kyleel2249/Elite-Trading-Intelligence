"""Tradable-symbol discovery: Bybit spot, linear perpetual and inverse perpetual instruments and Bitget spot plus USDT-, USDC-
and coin-margined futures (public, no keys), plus Alpaca US equities (needs keys). A legacy Binance fetch helper remains.

Sync model
* The exchange lists are the source of truth. The cache expires after 60 seconds and a background task (started on first
  use) re-reads Bybit, Bitget and Alpaca every minute, so a newly listed pair appears within about a minute of the exchange
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
BITGET_PRODUCT_TYPES = ("USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES")
BITGET_OK_STATUS = {"online", "normal", "listed", "limit_open", "restrictedapi"}
PARTIAL_RETRY_SECONDS = 10      # a partially failed list is retried on the next read, but not more often than this
MAX_REMOVALS_KEPT = 200

_cache: dict[str, dict[str, Any]] = {}
_first_seen: dict[tuple[str, str], float] = {}     # (provider, symbol) -> epoch seconds, only for post-baseline listings
_baseline: set[str] = set()                        # providers whose first successful load has happened
_sync: dict[str, Any] = {"task": None, "runs": 0, "last_run_at": None, "last_error": None}
_removed: list[dict[str, Any]] = []                  # recent delistings seen between two successful loads (newest last)


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


def _bitget_category(row: dict[str, Any]) -> str:
    return row.get("product_type") or "SPOT"


async def _bitget_list(client: httpx.AsyncClient, path: str) -> list[dict[str, Any]]:
    r = await client.get(f"{BITGET_BASE}{path}")
    r.raise_for_status()
    body = r.json()
    if not isinstance(body, dict) or str(body.get("code")) != "00000" or not isinstance(body.get("data"), list):
        raise ValueError("unexpected Bitget symbols payload")
    return body["data"]


def _bitget_rows(category: str, data: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out = []
    for s in data:
        if not isinstance(s, dict):
            continue
        status = str(s.get("status") or s.get("symbolStatus") or "").lower()
        sym, base, quote = str(s.get("symbol") or "").upper(), str(s.get("baseCoin") or "").upper(), str(s.get("quoteCoin") or "").upper()
        if status not in BITGET_OK_STATUS or not sym or not base or not quote:
            continue
        row = {"provider": "bitget", "symbol": sym, "base": base, "quote": quote, "name": None, "asset_class": "crypto",
               "exchange": "BITGET", "market": "spot" if category == "SPOT" else "futures"}
        if category != "SPOT":
            kind = str(s.get("symbolType") or s.get("type") or "perpetual").lower()
            if kind not in ("perpetual", "delivery"):
                continue
            row["product_type"], row["contract_type"] = category, kind
        out.append(row)
    return out


async def _fetch_bitget_detailed(transport: Optional[httpx.AsyncBaseTransport] = None,
                                previous: Optional[list[dict[str, Any]]] = None) -> tuple[list[dict[str, Any]], list[str]]:
    """Bitget public spot plus USDT-, USDC- and coin-margined futures (Classic V2 public lists, no keys).

    Each category is fetched on its own. If one fails while another succeeds, the failed category's previously known pairs are
    carried forward (never dropped) and the category is returned in the failed list. If every category fails this raises, so
    the caller keeps the whole previous list labelled stale. An invalid payload is a failure, never an empty list."""
    paths = {"SPOT": "/api/v2/spot/public/symbols",
             **{pt: f"/api/v2/mix/market/contracts?productType={pt}" for pt in BITGET_PRODUCT_TYPES}}
    async with httpx.AsyncClient(timeout=30.0, transport=transport) as c:
        results = await asyncio.gather(*(_bitget_list(c, path) for path in paths.values()), return_exceptions=True)
    out: list[dict[str, Any]] = []
    failed: list[str] = []
    first_error: Optional[BaseException] = None
    for category, res in zip(paths, results):
        if isinstance(res, BaseException):
            if isinstance(res, asyncio.CancelledError):
                raise res
            failed.append(category)
            first_error = first_error or res
            continue
        out.extend(_bitget_rows(category, res))
    if len(failed) == len(paths):
        raise first_error if first_error else ValueError("Bitget returned no data")
    if failed and previous:
        out.extend(r for r in previous if _bitget_category(r) in failed)
    if not out:
        raise ValueError("Bitget returned no online symbols")
    return out, failed


async def _fetch_bitget(transport: Optional[httpx.AsyncBaseTransport] = None) -> list[dict[str, Any]]:
    """Bitget pairs as a plain list (spot plus all futures products); see _fetch_bitget_detailed for per-category failures."""
    items, _failed = await _fetch_bitget_detailed(transport)
    return items


async def _fetch_bybit(transport: Optional[httpx.AsyncBaseTransport] = None) -> list[dict[str, Any]]:
    """Bybit V5 tradable spot, linear and inverse instruments, with cursor pagination."""
    out: list[dict[str, Any]] = []
    async with httpx.AsyncClient(timeout=30.0, transport=transport) as client:
        for category in ("spot", "linear", "inverse"):
            cursor = ""
            for _page in range(20):
                params = {"category": category, "limit": "1000"}
                if cursor:
                    params["cursor"] = cursor
                response = await client.get("https://api.bybit.com/v5/market/instruments-info", params=params)
                response.raise_for_status()
                body = response.json()
                if not isinstance(body, dict) or body.get("retCode") != 0 or not isinstance(body.get("result", {}).get("list"), list):
                    raise ValueError("unexpected Bybit instruments payload")
                for row in body["result"]["list"]:
                    if not isinstance(row, dict) or row.get("status") != "Trading":
                        continue
                    symbol = str(row.get("symbol") or "").upper()
                    base, quote = str(row.get("baseCoin") or "").upper(), str(row.get("quoteCoin") or "").upper()
                    if not symbol or not base or not quote:
                        continue
                    if category != "spot" and "Perpetual" not in str(row.get("contractType") or ""):
                        continue
                    out.append({"provider": "bybit", "symbol": symbol, "base": base, "quote": quote,
                                "name": None, "asset_class": "crypto", "exchange": "BYBIT",
                                "market": category, "margin_eligible": category == "spot" and str(row.get("marginTrading") or "none").lower() != "none"})
                cursor = str(body["result"].get("nextPageCursor") or "")
                if not cursor:
                    break
            else:
                raise RuntimeError(f"Bybit {category} instrument pagination exceeded the 20-page safety limit")
    if not out:
        raise ValueError("Bybit returned no tradable instruments")
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


def _ident(i: dict[str, Any]) -> str:
    """Spot BTCUSDT and futures BTCUSDT are different instruments; key them apart where a market is known."""
    market = i.get("product_type") or i.get("market")
    return f"{i['symbol']}|{market}" if market else i["symbol"]


def _stamp_new(provider: str, items: list[dict[str, Any]], previous: Optional[list[dict[str, Any]]], now: float) -> None:
    """Record first-seen times for symbols that appear after the baseline load of this provider, and delistings."""
    current = {_ident(i) for i in items}
    if provider not in _baseline:
        _baseline.add(provider)          # first successful load: everything is existing, nothing is "new"
        return
    before = {_ident(i) for i in previous} if previous is not None else set()
    for ident in current - before:
        _first_seen.setdefault((provider, ident), now)
    gone = {_ident(i): i for i in (previous or [])}
    for ident in before - current:
        i = gone[ident]
        _removed.append({"provider": provider, "symbol": i["symbol"], "market": i.get("product_type") or i.get("market"),
                         "removed_at": datetime.fromtimestamp(now, timezone.utc).isoformat()})
    del _removed[:-MAX_REMOVALS_KEPT]


def _annotate(provider: str, items: list[dict[str, Any]], now: float) -> list[dict[str, Any]]:
    out = []
    for i in items:
        seen = _first_seen.get((provider, _ident(i)))
        new = seen is not None and now - seen <= NEW_WINDOW_SECONDS
        out.append({**i, "is_new": new, "first_seen_at": datetime.fromtimestamp(seen, timezone.utc).isoformat() if seen else None})
    return out


def _meta(entry: Optional[dict[str, Any]], status: str, message: Optional[str] = None) -> dict[str, Any]:
    return {"status": status, "count": len(entry["items"]) if entry else 0, "message": message,
            "partial_categories": list(entry.get("failed") or []) if entry else [],
            "host": entry.get("host") if entry else None,
            "fetched_at": datetime.fromtimestamp(entry["at"], timezone.utc).isoformat() if entry else None}


async def get_source(provider: str, settings: Optional[Settings] = None, refresh: bool = False,
                     transport: Optional[httpx.AsyncBaseTransport] = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Return (items, meta) for one provider. meta.status: ok | stale | unavailable | not_configured."""
    settings = settings or get_settings()
    if provider == "alpaca" and not (settings.alpaca_api_key and settings.alpaca_secret_key):
        return [], _meta(None, "not_configured", "ALPACA_API_KEY / ALPACA_SECRET_KEY are not set, so stocks cannot be listed")
    if provider not in ("binance", "bitget", "bybit", "alpaca"):
        return [], _meta(None, "unavailable", f"unknown provider '{provider}'")
    entry = _cache.get(provider)
    age = time.time() - entry["at"] if entry else None
    partial = bool(entry and entry.get("failed"))
    if (entry and age is not None and age < CACHE_TTL_SECONDS and not (refresh and age >= MIN_REFRESH_SECONDS)
            and not (partial and age >= PARTIAL_RETRY_SECONDS)):
        return _annotate(provider, entry["items"], time.time()), _meta(entry, "stale" if partial else "ok",
                                                                         "some categories could not be refreshed; their last known pairs are shown" if partial else None)
    failed: list[str] = []
    try:
        if provider == "bybit":
            items = await _fetch_bybit(transport)
        elif provider == "binance":
            items = await _fetch_binance(transport)
        elif provider == "bitget":
            items, failed = await _fetch_bitget_detailed(transport, entry["items"] if entry else None)
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
    entry = {"items": items, "at": now, "host": binance_hosts.last_good() if provider == "binance" else None, "failed": failed}
    _cache[provider] = entry
    if failed:
        logger.warning("bitget categories failed to refresh, kept last known pairs: %s", ", ".join(failed))
        return _annotate(provider, items, now), _meta(entry, "stale", "some categories could not be refreshed; their last known pairs are shown")
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
    """Force-refresh Bybit, Bitget (spot + all futures) and Alpaca when configured. Failures are recorded, never raised."""
    settings = settings or get_settings()
    result: dict[str, Any] = {}
    for p in ("bybit", "bitget", "alpaca"):
        _items, meta = await get_source(p, settings, refresh=True)
        result[p] = {"status": meta["status"], "count": meta["count"]}
    _sync["runs"] += 1
    _sync["last_run_at"] = datetime.now(timezone.utc).isoformat()
    _sync["last_error"] = None if all(v["status"] in ("ok", "not_configured") for v in result.values()) else "one or more sources failed or are stale"
    _sync["last_result"] = result
    return result


async def _sync_loop(settings: Settings) -> None:
    while True:
        started = time.monotonic()
        try:
            await sync_once(settings)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # keep the loop alive
            _sync["last_error"] = type(exc).__name__
            logger.warning("symbol sync failed", exc_info=True)
        # Sleep the remainder of the minute so the period does not drift by the duration of each run.
        await asyncio.sleep(max(1.0, SYNC_INTERVAL_SECONDS - (time.monotonic() - started)))


async def stop_sync() -> None:
    """Cancel the background refresher (application shutdown)."""
    task = _sync.get("task")
    if task is not None and not task.done():
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    _sync["task"] = None


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
            "baseline_providers": sorted(_baseline), "last_result": _sync.get("last_result"),
            "recent_removals": list(_removed[-50:]),
            "note": "New = first seen by this server after its first load of that exchange; it is not the exchange's listing time."}


def _reset_for_tests() -> None:
    _cache.clear(); _first_seen.clear(); _baseline.clear(); _removed.clear()
    _sync.update(task=None, runs=0, last_run_at=None, last_error=None, last_result=None)


def _finite(x: Any) -> Optional[float]:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None
