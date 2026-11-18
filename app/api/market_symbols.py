"""Symbol discovery and chart history across markets. Read-only: nothing here places or signs an order."""
from __future__ import annotations

import logging
import os
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from app.config import Settings, get_settings
from app.integrations.alpaca import AlpacaClient
from app.integrations.bybit import BybitClient
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

Provider = Literal["bybit", "binance", "bitget", "alpaca", "oanda", "twelvedata"]


async def _source(provider: str, settings: Settings, refresh: bool):
    if provider in extra.EXTRA_PROVIDERS:
        return await extra.get_source(provider, settings, refresh=refresh)
    return await sym_mod.get_source(provider, settings, refresh=refresh)


@router.get("/api/market/symbols")
async def list_symbols(
    provider: Literal["bybit", "binance", "bitget", "alpaca", "oanda", "twelvedata", "all"] = "all",
    q: str = Query("", max_length=32),
    quote: str = Query("", max_length=12),
    exchange: str = Query("", max_length=12, description="Filter by exchange / MIC, e.g. XETR or FOREX"),
    market: Literal["", "spot", "futures", "linear", "inverse"] = Query("", description="Filter by market: spot or futures (Bitget), spot, linear or inverse (Bybit)"),
    product_type: Literal["", "USDT-FUTURES", "USDC-FUTURES", "COIN-FUTURES"] = Query("", description="Bitget futures product type"),
    new_only: bool = False,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0, le=100000),
    refresh: bool = False,
    settings: Settings = Depends(get_settings),
):
    """Tradable pairs/instruments: Bybit spot and perpetuals (public), US stocks (Alpaca keys), forex/CFDs (OANDA keys),
    non-US stocks and forex pairs (Twelve Data key). Each source reports ok / stale / unavailable / not_configured.
    Bybit, Bitget (spot and all futures) and other enabled lists re-sync every minute in the background (started at boot) and expire after 60 s on
    read, so newly listed pairs appear within about a minute. `refresh=true` forces a re-read (rate limited);
    `new_only=true` shows only pairs this server first saw after its first load of that exchange."""
    sym_mod.ensure_sync_started(settings)
    wanted = ["bybit", "alpaca", "oanda", "twelvedata"] if provider == "all" else [provider]
    items, sources = [], {}
    for p in wanted:
        rows, meta = await _source(p, settings, refresh)
        items.extend(rows)
        sources[p] = meta
    ex = (exchange or "").strip().upper()
    if ex:
        items = [i for i in items if (i.get("exchange") or "").upper() == ex]
    if market:
        items = [i for i in items if i.get("market") == market]
    if product_type:
        items = [i for i in items if i.get("product_type") == product_type]
    matched = sym_mod.search(items, q, quote, new_only)
    return {"total": len(matched), "limit": limit, "offset": offset, "items": matched[offset:offset + limit],
            "sources": sources, "sync": sym_mod.sync_status()}


@router.get("/api/market/symbols/sync-status")
async def symbols_sync_status(settings: Settings = Depends(get_settings)):
    """State of the one-minute pair sync (runs, last run and per-source result, last error, baseline providers, recent delistings)."""
    sym_mod.ensure_sync_started(settings)
    return sym_mod.sync_status()


@router.get("/api/market/bybit/region")
async def bybit_market_region():
    """Public diagnostic proving which Fly region performs Bybit upstream requests."""
    region = os.getenv("FLY_REGION", "").strip().lower()
    return {
        "service": "eti-bybit-market-egress",
        "provider": "bybit",
        "egress_region": region or "unknown",
        "api_hosts": ["api.bybit.com", "api.bytick.com"],
        "read_only": True,
        "account_residency_unchanged": True,
    }


@router.get("/api/market/bybit/proxy/{endpoint}")
async def bybit_public_market_proxy(
    endpoint: Literal["time", "instruments-info", "kline", "orderbook", "recent-trade", "tickers", "funding-history", "open-interest"],
    request: Request,
    settings: Settings = Depends(get_settings),
):
    """Allow-listed read-only Bybit V5 proxy. Requests originate from the ETI Frankfurt backend."""
    paths = {
        "time": "/v5/market/time",
        "instruments-info": "/v5/market/instruments-info",
        "kline": "/v5/market/kline",
        "orderbook": "/v5/market/orderbook",
        "recent-trade": "/v5/market/recent-trade",
        "tickers": "/v5/market/tickers",
        "funding-history": "/v5/market/funding/history",
        "open-interest": "/v5/market/open-interest",
    }
    allowed_params = {
        "time": set(),
        "instruments-info": {"category", "limit", "cursor"},
        "kline": {"category", "symbol", "interval", "limit", "start", "end"},
        "orderbook": {"category", "symbol", "limit"},
        "recent-trade": {"category", "symbol", "limit"},
        "tickers": {"category", "symbol"},
        "funding-history": {"category", "symbol", "limit"},
        "open-interest": {"category", "symbol", "intervalTime", "limit"},
    }
    params = dict(request.query_params)
    if set(params) - allowed_params[endpoint]:
        raise HTTPException(status_code=422, detail="Unsupported Bybit proxy query parameter")
    category = params.get("category")
    if category and category not in ("spot", "linear", "inverse"):
        raise HTTPException(status_code=422, detail="Invalid Bybit market category")
    symbol = params.get("symbol")
    if symbol and not re.fullmatch(r"[A-Za-z0-9]{2,32}", symbol):
        raise HTTPException(status_code=422, detail="Invalid Bybit symbol")
    try:
        if "limit" in params:
            limit = int(params["limit"])
            maximum = 1000 if endpoint in ("instruments-info", "kline") else 200
            if not 1 <= limit <= maximum:
                raise HTTPException(status_code=422, detail="Bybit proxy limit is out of range")
        return await BybitClient(settings).get_public_payload(paths[endpoint], params)
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.warning("Bybit regional proxy failed: %s", type(exc).__name__, exc_info=True)
        raise HTTPException(status_code=502, detail="Bybit public market data is unavailable from the configured egress region")


@router.get("/api/market/bybit/derivatives-context")
async def bybit_derivatives_context(
    symbol: str = Query(..., pattern=r"^[A-Za-z0-9]{2,32}$"),
    category: Literal["linear", "inverse"] = "linear",
    interval: Literal["5min", "15min", "30min", "1h", "4h", "1d"] = "1h",
    limit: int = Query(50, ge=1, le=200),
    settings: Settings = Depends(get_settings),
):
    """Latest funding rate and chronological open-interest observations for a Bybit perpetual contract."""
    try:
        return await MarketService(settings).get_derivatives_context(
            symbol=symbol, category=category, interval=interval, limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        logger.warning("Bybit derivatives context failed: %s", type(exc).__name__, exc_info=True)
        raise HTTPException(status_code=502, detail="Bybit derivatives context failed upstream")


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
    provider: Provider = "bybit",
    category: Literal["spot", "linear", "inverse"] = "spot",
    settings: Settings = Depends(get_settings),
):
    """Candles for any listed market, read-only. Binance uses Binance's public production market-data API (official global
    hosts with failover) so any listed pair can be charted even when ETI's trading client points at the testnet. Other
    markets use their own provider; ones that need credentials answer 503 when those are not configured."""
    sym = symbol.upper()
    if provider in ("bybit", "binance", "bitget") and not sym.isalnum():
        raise HTTPException(status_code=422, detail="symbol must be letters and digits, e.g. BTCUSDT")
    try:
        if provider == "bybit":
            return _normalise_service(await MarketService(settings).get_history("bybit", sym, interval=interval, limit=limit, category=category), response, "bybit")
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
