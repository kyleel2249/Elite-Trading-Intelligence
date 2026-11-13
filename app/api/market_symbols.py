"""Symbol discovery and public-data chart history. Read-only: nothing here places or signs an order."""
from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Response

from app.config import Settings, get_settings
from app.market import binance_hosts as bh
from app.market import symbols as sym_mod
from app.market.data_quality import assess_kline
from app.market.normalization import normalize_binance_kline

logger = logging.getLogger("eti.market_symbols")
router = APIRouter(tags=["market-symbols"])


@router.get("/api/market/symbols")
async def list_symbols(
    provider: Literal["binance", "alpaca", "all"] = "all",
    q: str = Query("", max_length=32),
    quote: str = Query("", max_length=12),
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0, le=100000),
    refresh: bool = False,
    settings: Settings = Depends(get_settings),
):
    """All tradable Binance spot pairs and (when Alpaca keys are configured) US stocks. `refresh=true` re-reads the
    exchange list (at most once a minute) so newly listed tokens appear."""
    wanted = ["binance", "alpaca"] if provider == "all" else [provider]
    items, sources = [], {}
    for p in wanted:
        rows, meta = await sym_mod.get_source(p, settings, refresh=refresh)
        items.extend(rows)
        sources[p] = meta
    matched = sym_mod.search(items, q, quote)
    return {"total": len(matched), "limit": limit, "offset": offset, "items": matched[offset:offset + limit],
            "sources": sources}


@router.get("/api/market/binance-hosts")
async def binance_hosts_status():
    """Which official Binance hosts ETI uses for public data, which one last worked and what the last failures were."""
    return bh.status()


@router.get("/api/market/public-history")
async def public_history(
    response: Response,
    symbol: str = Query(..., pattern=r"^[A-Za-z0-9]{3,20}$"),
    interval: str = Query("1h", pattern=r"^[0-9]{1,2}[smhdwM]$"),
    limit: int = Query(100, ge=1, le=1000),
):
    """Binance spot candles from Binance's public production market-data API (official global hosts with failover),
    so any listed pair can be charted even when ETI's trading client points at the testnet. Data only; no orders."""
    try:
        rows, host = await bh.get_json("/api/v3/klines", {"symbol": symbol.upper(), "interval": interval, "limit": limit})
    except bh.BinanceBadRequest:
        raise HTTPException(status_code=404, detail="unknown symbol or interval on Binance")
    except bh.BinanceUnavailable as exc:
        raise HTTPException(status_code=502, detail=exc.public_message)
    except Exception as exc:
        logger.warning("public history failed: %s", type(exc).__name__, exc_info=True)
        raise HTTPException(status_code=502, detail="Market history failed upstream")
    try:
        if not isinstance(rows, list):
            raise ValueError("unexpected payload")
        raw = [{"open_time": k[0], "open": float(k[1]), "high": float(k[2]), "low": float(k[3]),
                "close": float(k[4]), "volume": float(k[5]), "close_time": k[6]} for k in rows]
    except (TypeError, ValueError, IndexError, KeyError):
        logger.warning("public history: malformed kline payload from %s", host)
        raise HTTPException(status_code=502, detail="Market history failed upstream")
    response.headers["X-Binance-Host"] = host.replace("https://", "")
    return [assess_kline(normalize_binance_kline(row, symbol.upper(), interval)) for row in raw]
