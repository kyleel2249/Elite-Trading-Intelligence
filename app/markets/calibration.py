"""Live calibration: replace static planning baselines with measured inputs where a real data route exists.

Derived from a real quote and recent daily candles of the chosen route:
  * ATR(14, Wilder) in price units          -> volatility-aware stop distance and sizing
  * spread_bps from best bid/ask            -> measured cost instead of the static baseline
  * average daily USD volume (crypto/stocks) -> liquidity participation limits
Not derived (reported as skipped, never guessed): volume for forex/CFDs (OANDA volume is tick count, not turnover),
anything on an ETF-proxy route (the ETF's volatility/liquidity is not the underlying's), and any route whose
provider is not configured.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from app.markets.assessment import assess
from app.markets.providers import routes_for
from app.markets.registry import classify
from app.markets.types import AssetClass

logger = logging.getLogger("eti.markets.calibration")
MIN_BARS = 15            # ATR(14) needs 14 true ranges = 15 bars


def atr_wilder(rows: list[dict], period: int = 14) -> Optional[float]:
    rows = [r for r in rows if all(k in r for k in ("high", "low", "close"))]
    if len(rows) < period + 1:
        return None
    trs = [max(r["high"] - r["low"], abs(r["high"] - p["close"]), abs(r["low"] - p["close"])) for p, r in zip(rows, rows[1:])]
    atr = sum(trs[:period]) / period
    for tr in trs[period:]:
        atr = (atr * (period - 1) + tr) / period
    return atr if atr > 0 else None


def spread_bps(bid: Optional[float], ask: Optional[float]) -> Optional[float]:
    if not bid or not ask or bid <= 0 or ask < bid:
        return None
    return (ask - bid) / ((ask + bid) / 2) * 1e4


def adv_usd(rows: list[dict]) -> Optional[float]:
    vals = [r["close"] * r["volume"] for r in rows if r.get("volume") and r.get("close")]
    return sum(vals) / len(vals) if len(vals) >= 5 else None


def pick_route(symbol: str, provider: Optional[str], settings: Any) -> tuple[Optional[dict], Any]:
    inst = classify(symbol, provider_hint=provider)
    routes = [r for r in routes_for(inst, settings) if not provider or r["provider"] == provider.lower()]
    configured = [r for r in routes if (r.get("setup") or {}).get("configured")]
    return (configured[0] if configured else None), inst


async def calibrated_assess(symbol: str, *, market_service: Any, settings: Any = None, provider: Optional[str] = None, **kw) -> dict:
    """assess() fed with measured inputs. Caller-supplied values always win over measured ones."""
    route, inst = pick_route(symbol, provider, settings)
    cal: dict[str, Any] = {"route": None, "used": {}, "skipped": {}, "errors": []}
    inputs: dict[str, Any] = {}
    if inst.asset_class == AssetClass.UNKNOWN:
        cal["skipped"]["all"] = "unclassified symbol"
    elif route is None:
        cal["skipped"]["all"] = "no configured data route (see needs_setup / provider_not_integrated)"
    else:
        cal["route"] = {k: route.get(k) for k in ("provider", "symbol", "kind")}
        if route["kind"] == "etf_proxy":
            cal["skipped"]["all"] = "route is an ETF proxy; its price, volatility and liquidity are not the underlying's"
        else:
            snap: dict = {}
            rows: list[dict] = []
            try:
                snap = await market_service.get_snapshot(route["provider"], route["symbol"])
            except Exception as e:
                cal["errors"].append(f"quote: {e}")
            try:
                rows = await market_service.get_history(route["provider"], route["symbol"], interval="1d", limit=30)
            except Exception as e:
                cal["errors"].append(f"history: {e}")
            if snap.get("data_status") in ("fresh", "delayed", "market_closed") and snap.get("price"):
                inputs["price"] = float(snap["price"])
                cal["used"]["price"] = {"value": inputs["price"], "status": snap["data_status"]}
            elif snap:
                cal["skipped"]["price"] = f"quote status {snap.get('data_status')}"
            sp = spread_bps(snap.get("bid"), snap.get("ask"))
            if sp is not None:
                inputs["measured_spread_bps"] = sp
                cal["used"]["measured_spread_bps"] = round(sp, 3)
            else:
                cal["skipped"]["measured_spread_bps"] = "no bid/ask from provider"
            good = [r for r in rows if r.get("data_status") != "invalid"]
            atr = atr_wilder(good)
            if atr:
                inputs["atr"] = atr
                cal["used"]["atr"] = {"value": round(atr, 8), "basis": "ATR(14) Wilder on daily candles", "bars": len(good)}
            else:
                cal["skipped"]["atr"] = f"need {MIN_BARS}+ valid daily candles, got {len(good)}"
            if inst.asset_class in (AssetClass.CRYPTO, AssetClass.STOCK):
                adv = adv_usd(good)
                if adv:
                    inputs["avg_daily_volume_usd"] = adv
                    cal["used"]["avg_daily_volume_usd"] = {"value": round(adv, 2),
                                                           "basis": "mean(close x volume), daily" + (" (IEX feed: partial market volume)" if route["provider"] == "alpaca" else "")}
                else:
                    cal["skipped"]["avg_daily_volume_usd"] = "no usable volume history"
            else:
                cal["skipped"]["avg_daily_volume_usd"] = "provider volume for this asset class is not USD turnover"
    merged = {**inputs, **{k: v for k, v in kw.items() if v is not None}}
    for k in list(cal["used"]):
        if kw.get(k) is not None:
            cal["skipped"][k] = "overridden by caller-supplied value"
            cal["used"].pop(k)
    result = assess(symbol, provider=provider, settings=settings, **merged)
    result["calibration"] = cal
    return result
