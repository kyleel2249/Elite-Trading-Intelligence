"""Symbol discovery and chart history across markets. Read-only: nothing here places or signs an order."""
from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from app.config import Settings, get_settings
from app.integrations.alpaca import AlpacaClient
from app.integrations.oanda import OandaClient
from app.market import binance_hosts as bh
from app.market import history_extra as hx
from app.market import symbols as sym_mod
from app.market import symbols_extra as extra
from app.market.data_quality import assess_kline
from app.market.normalization import normalize_binance_kline
from app.market.service import MarketService

logger = logging.getLogger("eti.market_symbols")
router = APIRouter(tags=["market-symbols"])

Provider = Literal["binance", "bitget", "alpaca", "oanda", "twelvedata"]


async def _source(provider: str, settings: Settings, refresh: bool):
    if provider in extra.EXTRA_PROVIDERS:
        return await extra.get_source(provider, settings, refresh=refresh)
    return await sym_mod.get_source(provider, settings, refresh=refresh)


@router.get("/api/market/symbols")
async def list_symbols(
    provider: Literal["binance", "bitget", "alpaca", "oanda", "twelvedata", "all"] = "all",
    q: str = Query("", max_length=32),
    quote: str = Query("", max_length=12),
    exchange: str = Query("", max_length=12, description="Filter by exchange / MIC, e.g. XETR or FOREX"),
    new_only: bool = False,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0, le=100000),
    refresh: bool = False,
    settings: Settings = Depends(get_settings),
):
    """Tradable pairs/instruments: Binance and Bitget spot (public), US stocks (Alpaca keys), forex/CFDs (OANDA keys),
    non-US stocks and forex pairs (Twelve Data key). Each source reports ok / stale / unavailable / not_configured.
    `refresh=true` re-reads the lists (rate limited) so newly listed tokens appear; `new_only=true` shows only pairs this
    server first saw after its first load of that exchange."""
    wanted = ["binance", "bitget", "alpaca", "oanda", "twelvedata"] if provider == "all" else [provider]
    items, sources = [], {}
    for p in wanted:
        rows, meta = await _source(p, settings, refresh)
        items.extend(rows)
        sources[p] = meta
    ex = (exchange or "").strip().upper()
    if ex:
        items = [i for i in items if (i.get("exchange") or "").upper() == ex]
    matched = sym_mod.search(items, q, quote, new_only)
    return {"total": len(matched), "limit": limit, "offset": offset, "items": matched[offset:offset + limit],
            "sources": sources}


@router.get("/api/market/binance-hosts")
async def binance_hosts_status():
    """Which official Binance hosts ETI uses for public data, which one last worked and what the last failures were."""
    return bh.status()


def _normalise(rows: list[dict], symbol: str, interval: str) -> list[dict]:
    return [assess_kline(normalize_binance_kline(row, symbol, interval)) for row in rows]


@router.get("/api/market/public-history")
async def public_history(
    response: Response,
    symbol: str = Query(..., pattern=r"^[A-Za-z0-9:/._-]{1,32}$"),
    interval: str = Query("1h", pattern=r"^[0-9]{1,2}[smhdwM]$"),
    limit: int = Query(100, ge=1, le=1000),
    provider: Provider = "binance",
    settings: Settings = Depends(get_settings),
):
    """Candles for any listed market, read-only. Binance uses Binance's public production market-data API (official global
    hosts with failover) so any listed pair can be charted even when ETI's trading client points at the testnet. Other
    markets use their own provider; ones that need credentials answer 503 when those are not configured."""
    sym = symbol.upper()
    if provider in ("binance", "bitget") and not sym.isalnum():
        raise HTTPException(status_code=422, detail="symbol must be letters and digits, e.g. BTCUSDT")
    try:
        if provider == "binance":
            try:
                rows, host = await bh.get_json("/api/v3/klines", {"symbol": sym, "interval": interval, "limit": limit})
            except bh.BinanceBadRequest:
                raise HTTPException(status_code=404, detail="unknown symbol or interval on Binance")
            except bh.BinanceUnavailable as exc:
                raise HTTPException(status_code=502, detail=exc.public_message)
            if not isinstance(rows, list):
                raise ValueError("unexpected payload")
            raw = [{"open_time": k[0], "open": float(k[1]), "high": float(k[2]), "low": float(k[3]),
                    "close": float(k[4]), "volume": float(k[5]), "close_time": k[6]} for k in rows]
            response.headers["X-Binance-Host"] = host.replace("https://", "")
            response.headers["X-Data-Source"] = "binance"
            return _normalise(raw, sym, interval)
        if provider == "bitget":
            raw = await hx.fetch_bitget(sym, interval, limit)
        elif provider == "twelvedata":
            raw = await hx.fetch_twelvedata(sym, interval, limit, extra.twelvedata_key())
        else:
            client = OandaClient(settings) if provider == "oanda" else AlpacaClient(settings)
            if not client.configured:
                raise HTTPException(status_code=503, detail=f"{provider.upper()} is not configured (credentials missing), so it cannot be charted")
            return _normalise_service(await MarketService(settings).get_history(provider, sym, interval=interval, limit=limit),
                                      response, provider)
    except HTTPException:
        raise
    except hx.HistoryError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message)
    except (TypeError, ValueError, IndexError, KeyError):
        logger.warning("public history: malformed payload from %s", provider, exc_info=True)
        raise HTTPException(status_code=502, detail="Market history failed upstream")
    except Exception as exc:
        logger.warning("public history failed: %s", type(exc).__name__, exc_info=True)
        raise HTTPException(status_code=502, detail="Market history failed upstream")
    response.headers["X-Data-Source"] = provider
    return _normalise(raw, sym, interval)


def _normalise_service(rows: list[dict], response: Response, provider: str) -> list[dict]:
    """MarketService already returns assessed candles; pass them through, labelling the source."""
    response.headers["X-Data-Source"] = provider
    return rows
