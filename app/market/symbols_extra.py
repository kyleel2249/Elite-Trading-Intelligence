"""Symbol lists that need credentials: OANDA (forex, metals, index/commodity CFDs) and Twelve Data (non-US stocks + forex).

Nothing is invented. Without credentials a source reports `not_configured`; if it cannot be reached it reports
`unavailable`, or `stale` when an older successful list is being shown. Twelve Data is read exchange by exchange, so a
rate limit or plan restriction can fail some exchanges: the successful ones are shown and the failed ones are named in
`message` (a free plan allows very few calls per minute).

Twelve Data symbols are listed as `TICKER:MIC` (for example `SAP:XETR`) because a ticker alone is ambiguous across
exchanges; forex pairs as `EUR/USD`. Configure with TWELVEDATA_API_KEY and optionally TWELVEDATA_EXCHANGES
(comma-separated MIC codes). Response shapes follow Twelve Data's documented REST API and are covered by mocked tests,
not by a live call from this repository.
"""
from __future__ import annotations

import logging
import os
import re
import time
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from app.config import Settings, get_settings
from app.integrations.oanda import OandaClient

logger = logging.getLogger("eti.symbols_extra")

TD_BASE = "https://api.twelvedata.com"
CACHE_TTL_SECONDS = 600
MIN_REFRESH_SECONDS = 60
DEFAULT_EXCHANGES = ("XLON", "XETR", "XPAR", "XAMS", "XSWX", "XMIL", "XSTO", "XTKS", "XHKG", "XASX", "XTSE", "XNSE")
EXTRA_PROVIDERS = ("oanda", "twelvedata")
_MIC = re.compile(r"^[A-Z0-9]{3,6}$")

_cache: dict[str, dict[str, Any]] = {}


def twelvedata_key() -> str:
    return os.environ.get("TWELVEDATA_API_KEY", "").strip()


def twelvedata_exchanges() -> list[str]:
    raw = os.environ.get("TWELVEDATA_EXCHANGES", "")
    wanted = [x.strip().upper() for x in raw.split(",") if x.strip()] or list(DEFAULT_EXCHANGES)
    out: list[str] = []
    for m in wanted:
        if _MIC.match(m) and m not in out:
            out.append(m)
    return out or list(DEFAULT_EXCHANGES)


def _meta(entry: Optional[dict[str, Any]], status: str, message: Optional[str] = None) -> dict[str, Any]:
    return {"status": status, "count": len(entry["items"]) if entry else 0, "message": message, "host": None,
            "fetched_at": datetime.fromtimestamp(entry["at"], timezone.utc).isoformat() if entry else None}


async def _fetch_oanda(settings: Settings, transport: Optional[httpx.AsyncBaseTransport] = None) -> list[dict[str, Any]]:
    client = OandaClient(settings, transport=transport)
    instruments = await client.instruments(refresh=True)
    out = []
    for name, meta in sorted(instruments.items()):
        kind = str(meta.get("type") or "").upper()
        base, _, quote = name.partition("_")
        out.append({"provider": "oanda", "symbol": name, "base": base or None, "quote": quote or None,
                    "name": meta.get("displayName"),
                    "asset_class": {"CURRENCY": "forex", "METAL": "metal", "CFD": "cfd"}.get(kind, kind.lower() or "other"),
                    "exchange": "OANDA"})
    if not out:
        raise ValueError("OANDA returned no instruments for this account")
    return out


class _TdError(Exception):
    pass


async def _td_get(client: httpx.AsyncClient, path: str, params: dict[str, str], key: str) -> list[dict[str, Any]]:
    r = await client.get(f"{TD_BASE}{path}", params={**params, "apikey": key})
    if r.status_code != 200:
        raise _TdError(f"HTTP {r.status_code}")
    body = r.json()
    if not isinstance(body, dict) or body.get("status") == "error" or not isinstance(body.get("data"), list):
        msg = str(body.get("message", "unexpected payload")) if isinstance(body, dict) else "unexpected payload"
        raise _TdError(msg.replace(key, "***")[:160])
    return body["data"]


async def _fetch_twelvedata(key: str, transport: Optional[httpx.AsyncBaseTransport] = None) -> tuple[list[dict[str, Any]], list[str]]:
    items: list[dict[str, Any]] = []
    failed: list[str] = []
    async with httpx.AsyncClient(timeout=30.0, transport=transport) as c:
        for mic in twelvedata_exchanges():
            try:
                rows = await _td_get(c, "/stocks", {"exchange": mic}, key)
            except (_TdError, httpx.HTTPError, ValueError) as exc:
                failed.append(f"{mic} ({str(exc)[:60]})")
                continue
            for s in rows:
                tick = str(s.get("symbol") or "").upper()
                if not tick:
                    continue
                items.append({"provider": "twelvedata", "symbol": f"{tick}:{mic}", "base": tick, "quote": s.get("currency"),
                              "name": s.get("name"), "asset_class": "equity", "exchange": mic, "country": s.get("country")})
        try:
            for p in await _td_get(c, "/forex_pairs", {}, key):
                pair = str(p.get("symbol") or "").upper()
                if pair:
                    items.append({"provider": "twelvedata", "symbol": pair, "base": p.get("currency_base"),
                                  "quote": p.get("currency_quote"), "name": None, "asset_class": "forex", "exchange": "FOREX"})
        except (_TdError, httpx.HTTPError, ValueError) as exc:
            failed.append(f"forex pairs ({str(exc)[:60]})")
    return items, failed


async def get_source(provider: str, settings: Optional[Settings] = None, refresh: bool = False,
                     transport: Optional[httpx.AsyncBaseTransport] = None) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Return (items, meta) for oanda or twelvedata. meta.status: ok | stale | unavailable | not_configured."""
    settings = settings or get_settings()
    if provider == "oanda" and not settings.oanda_configured:
        return [], _meta(None, "not_configured", "OANDA_API_TOKEN / OANDA_ACCOUNT_ID are not set, so forex and CFDs cannot be listed")
    key = twelvedata_key()
    if provider == "twelvedata" and not key:
        return [], _meta(None, "not_configured", "TWELVEDATA_API_KEY is not set, so non-US stocks and forex pairs cannot be listed")
    if provider not in EXTRA_PROVIDERS:
        return [], _meta(None, "unavailable", f"unknown provider '{provider}'")
    entry = _cache.get(provider)
    age = time.time() - entry["at"] if entry else None
    if entry and age is not None and age < CACHE_TTL_SECONDS and not (refresh and age >= MIN_REFRESH_SECONDS):
        return entry["items"], _meta(entry, "ok", entry.get("message"))
    message: Optional[str] = None
    try:
        if provider == "oanda":
            items = await _fetch_oanda(settings, transport)
        else:
            items, failed = await _fetch_twelvedata(key, transport)
            if not items:
                raise ValueError("no symbols could be loaded: " + "; ".join(failed or ["empty response"]))
            if failed:
                message = "partial list; could not load: " + ", ".join(failed)
    except Exception as exc:
        logger.warning("symbol list for %s failed: %s", provider, type(exc).__name__, exc_info=True)
        why = f"could not load the {provider} symbol list ({type(exc).__name__}: {str(exc)[:120].replace(key, '***') if key else str(exc)[:120]})"
        if entry:
            return entry["items"], _meta(entry, "stale", f"refresh failed; showing the last list we successfully fetched. {why}")
        return [], _meta(None, "unavailable", why)
    entry = {"items": items, "at": time.time(), "message": message}
    _cache[provider] = entry
    return items, _meta(entry, "ok", message)


def _reset_for_tests() -> None:
    _cache.clear()
