"""Independent valuation API: fair value, >8% mispricing, sentiment evidence and Kelly sizing.

Builds on existing ETI services (it does not replace them): live price and freshness come from MarketService,
bankroll from the server-side risk context, SEC facts from Global Alpha's cached SEC client, and every flagged
mispricing is written to the existing append-only prediction ledger. Nothing here places an order: a confirmed
opportunity still has to pass Global Alpha validation and the RiskEngine before execution.
"""
from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.database import get_db
from app.market.service import MarketService
from app.quant.evaluate import evaluate_instrument
from app.quant.kelly import KellyInput, KellyLimits, size_position
from app.quant.sentiment import SentimentItem, aggregate
from app.security.auth import require_api_key
from app.trading.risk_context import build_risk_context

logger = logging.getLogger("eti.valuation")
router = APIRouter(prefix="/api/valuation", tags=["valuation"])

LEDGER_STRATEGY = "mispricing_gt_8pct"
_SYMBOL = re.compile(r"[A-Za-z0-9./_-]{1,32}")


def kelly_limits(s: Settings) -> KellyLimits:
    """Config can lower the 6% single-position ceiling, never raise it (KellyLimits clamps)."""
    return KellyLimits(max_position_pct=s.max_position_notional_pct, max_risk_per_trade_pct=s.default_risk_per_trade_pct,
                       kelly_fraction=getattr(s, "kelly_fraction", 0.25),
                       max_correlated_exposure_pct=s.max_correlated_exposure_pct)


class KellyRequest(BaseModel):
    bankroll: float = Field(gt=0, allow_inf_nan=False)
    entry_price: float = Field(gt=0, allow_inf_nan=False)
    stop_price: float = Field(gt=0, allow_inf_nan=False)
    target_price: float = Field(gt=0, allow_inf_nan=False)
    win_probability: float = Field(ge=0, le=1)
    sample_size: int = Field(ge=0)
    side: Literal["buy", "sell"] = "buy"
    fee_bps: float = Field(10.0, ge=0)
    slippage_bps: float = Field(5.0, ge=0)
    funding_cost_pct: float = Field(0.0, ge=0)
    current_exposure_pct: float = Field(0.0, ge=0)
    sector_exposure_pct: float = Field(0.0, ge=0)
    correlated_exposure_pct: float = Field(0.0, ge=0)
    liquidity_capacity_notional: Optional[float] = Field(None, ge=0)
    realized_daily_vol_pct: Optional[float] = Field(None, gt=0)


@router.post("/kelly")
async def kelly(req: KellyRequest, settings: Settings = Depends(get_settings)):
    """Pure calculation (no I/O, no orders). The 6% allocation cap and separate stop-risk cap always apply."""
    return size_position(KellyInput(**req.model_dump()), kelly_limits(settings)).to_dict()


class SentimentIn(BaseModel):
    source: str = Field(max_length=64)
    verification: Literal["verified", "credible", "unverified", "social"]
    score: float = Field(ge=-1, le=1)
    ts: datetime
    text: str = Field("", max_length=500)
    author: Optional[str] = Field(None, max_length=64)
    engagement: float = Field(0.0, ge=0)
    sponsored: bool = False


class EvaluateRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9./_-]+$")
    provider: Literal["binance", "alpaca"]
    asset_class: Literal["equity", "etf", "crypto", "commodity", "futures", "forex"]
    # Model inputs must come from a real data source; nothing is assumed when a model's inputs are missing.
    fair_value_inputs: dict[str, dict] = Field(default_factory=dict)
    auto_fundamentals: bool = False       # equities: add DCF/DDM inputs derived from SEC 10-K facts
    use_news: bool = False                # add NewsAPI headlines as sentiment evidence (needs NEWSAPI_KEY)
    sentiment: list[SentimentIn] = Field(default_factory=list, max_length=200)
    win_probability: Optional[float] = Field(None, ge=0, le=1)
    sample_size: int = Field(0, ge=0)
    stop_pct: float = Field(5.0, gt=0, lt=50)
    round_trip_cost_pct: float = Field(0.30, ge=0)
    verification: dict = Field(default_factory=dict)
    persist_prediction: bool = True


def _ledger_market(asset_class: str) -> Optional[str]:
    return {"crypto": "crypto", "equity": "equity", "etf": "equity"}.get(asset_class)


def _record(db: Session, req: EvaluateRequest, out: dict) -> Optional[dict]:
    mp, fv = out.get("mispricing") or {}, out.get("fair_value") or {}
    market = _ledger_market(req.asset_class)
    if not (mp.get("flagged") and fv.get("supported") and market and out.get("price_fresh")):
        return None
    from app.prediction_ledger.service import create_prediction
    sym = req.symbol.upper()
    days = float((req.verification or {}).get("convergence_horizon_days") or 30)
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    try:
        row, created = create_prediction(
            db, asset=sym, market=market, provider=req.provider,
            direction="up" if mp["direction"] == "undervalued" else "down", entry_reference=mp["market_price"],
            horizon_seconds=int(max(1.0, days) * 86400), target_base=fv["fair_value"],
            target_low=min(fv["lower_bound"], mp["market_price"]), target_high=max(fv["upper_bound"], mp["market_price"]),
            probability=min(0.99, max(0.01, float(fv["confidence"]))),
            reasoning=(f"Independent fair value {fv['fair_value']:.6g} vs market {mp['market_price']:.6g} "
                       f"({mp['mispricing_pct']:+.2f}%). Probability field carries valuation-model confidence, "
                       f"not a calibrated win rate. Models: {', '.join(fv['methodology'])}."),
            sources=["internal:valuation:fv-1"] + [f"model:{m}" for m in fv["methodology"]],
            invalidation_criteria="Fair value re-estimated against the thesis; price data stale; stop level breached.",
            strategy=LEDGER_STRATEGY, model_version="fv-1",
            idempotency_key=f"fv:{sym}:{mp['direction']}:{round(fv['fair_value'], 4)}:{day}")
        return {"prediction_uid": row.prediction_uid, "created": created, "ledger": "/api/predictions"}
    except Exception:  # noqa: BLE001 - the valuation result is still valid; report the ledger failure
        db.rollback()
        logger.warning("ledger write failed for %s", sym, exc_info=True)
        return {"error": "ledger_write_failed"}


@router.post("/evaluate")
async def evaluate(req: EvaluateRequest, settings: Settings = Depends(get_settings), db: Session = Depends(get_db),
                   _auth=Depends(require_api_key)):
    snap = None
    try:
        snap = await MarketService(settings).get_snapshot(req.provider, req.symbol)
    except Exception:  # noqa: BLE001
        logger.warning("snapshot failed for %s %s", req.provider, req.symbol, exc_info=True)
    ctx = build_risk_context(db, settings, environment="paper", snapshot=snap)
    price = (snap or {}).get("price")
    fresh = bool(price) and str(ctx.data_status) == "fresh" and (ctx.data_age_seconds or 1e9) <= settings.data_max_age_seconds

    fv_inputs, fundamentals = dict(req.fair_value_inputs), None
    if req.auto_fundamentals and req.asset_class == "equity":
        from app.quant.fundamentals import valuation_inputs_for
        fundamentals = await valuation_inputs_for(db, settings, req.symbol)
        for model, data in fundamentals.get("inputs", {}).items():
            fv_inputs.setdefault(model, data)       # caller-supplied inputs always win

    items = [SentimentItem(**{**i.model_dump(), "ts": i.ts if i.ts.tzinfo else i.ts.replace(tzinfo=timezone.utc)})
             for i in req.sentiment]
    if not items and req.use_news:
        from app.quant.news_sentiment import news_items
        items = await news_items(req.symbol, settings)
    sent = aggregate(req.symbol.upper(), items, expected_sources=["newsapi"] if req.use_news else None) if (items or req.use_news) else None

    out = evaluate_instrument(
        symbol=req.symbol, asset_class=req.asset_class, price=price, price_fresh=fresh, fair_value_inputs=fv_inputs,
        sentiment=sent, win_probability=req.win_probability, sample_size=req.sample_size, bankroll=ctx.equity,
        stop_pct=req.stop_pct, round_trip_cost_pct=req.round_trip_cost_pct, verification=req.verification,
        kelly_limits=kelly_limits(settings))
    out["risk_inputs"] = {"source": "server", "equity": ctx.equity, "data_status": ctx.data_status,
                          "data_age_seconds": ctx.data_age_seconds}
    if fundamentals is not None:
        out["fundamentals"] = fundamentals
    if req.persist_prediction:
        out["ledger"] = _record(db, req, out)
    out["next_step"] = ("Not an order. A confirmed opportunity must still pass Global Alpha validation "
                        "(/api/alpha) and the RiskEngine before any execution.")
    return out


@router.get("/fundamentals-inputs/{ticker}")
async def fundamentals_inputs(ticker: str, settings: Settings = Depends(get_settings), db: Session = Depends(get_db),
                              _auth=Depends(require_api_key)):
    """DCF/DDM inputs from SEC 10-K facts (assumptions echoed back). /api/alpha/fundamentals/{ticker} holds the screens."""
    if not _SYMBOL.fullmatch(ticker):
        raise HTTPException(422, "invalid ticker")
    from app.quant.fundamentals import valuation_inputs_for
    return await valuation_inputs_for(db, settings, ticker)


@router.get("/sentiment/{symbol}")
async def sentiment(symbol: str, settings: Settings = Depends(get_settings), _auth=Depends(require_api_key)):
    """News sentiment evidence from NewsAPI; reports 'unavailable' when the key is missing. Never an order trigger."""
    if not _SYMBOL.fullmatch(symbol):
        raise HTTPException(422, "invalid symbol")
    from app.quant.news_sentiment import news_sentiment
    return (await news_sentiment(symbol.upper(), settings)).to_dict()
