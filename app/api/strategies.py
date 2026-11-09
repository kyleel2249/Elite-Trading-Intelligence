"""Elite Strategy Intelligence API: 23 strategy modules, backtests, out-of-sample / walk-forward validation, research signals.

Nothing here places orders. Execution remains behind /api/risk-gateway and the promotion authority.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.database import get_db
from app.market.service import MarketService
from app.security.auth import require_api_key
from app.strategies import (CRITERIA, STRATEGY_CLASSES, Bars, CostModel, MissingData, RiskModel, latest_signal, run_backtest, validate)
from app.strategies import store
from app.strategies.data import align_bars, build_aux
from app.strategies.engine import bars_per_year
from app.strategies.validation import STATEMENT

logger = logging.getLogger("eti.api.strategies")
router = APIRouter(prefix="/api/strategies", tags=["strategy-library"])

SYMBOL_RE = re.compile(r"^[A-Za-z0-9._-]{1,32}$")
INTERVAL_PATTERN = r"^[0-9]{1,2}[mhdw]$"
MAX_SERIES, MAX_POINTS = 10, 5000


def _sym(v: Optional[str]) -> Optional[str]:
    if v is None:
        return v
    if not SYMBOL_RE.match(v):
        raise ValueError("invalid symbol")
    return v.upper()


class StrategyRunRequest(BaseModel):
    symbol: str = "BTCUSDT"
    provider: Literal["binance"] = "binance"  # historical candles are only implemented for Binance
    interval: Optional[str] = Field(default=None, pattern=INTERVAL_PATTERN)
    limit: int = Field(default=1000, ge=100, le=1000)
    calendar: Literal["24x7", "equity"] = "24x7"
    params: dict[str, Any] = Field(default_factory=dict)
    train_fraction: float = Field(default=0.7, ge=0.5, le=0.9)
    # market-derived supplementary data (fetched server-side and aligned on bar open time)
    pair_symbol: Optional[str] = None
    basket_symbols: list[str] = Field(default_factory=list, max_length=8)
    benchmark_symbol: Optional[str] = None
    # caller-supplied POINT-IN-TIME series: {name: [[effective_ts_ms, value], ...]}
    fundamentals: Optional[dict[str, list[list[Optional[float]]]]] = None
    macro: Optional[dict[str, list[list[Optional[float]]]]] = None
    sentiment: Optional[list[list[Optional[float]]]] = None
    events: Optional[list[dict[str, Any]]] = Field(default=None, max_length=MAX_POINTS)
    # overrides (basis points per side)
    fee_bps: Optional[float] = Field(default=None, ge=0, le=500, allow_inf_nan=False)
    slippage_bps: Optional[float] = Field(default=None, ge=0, le=500, allow_inf_nan=False)
    half_spread_bps: Optional[float] = Field(default=None, ge=0, le=500, allow_inf_nan=False)
    short_carry_bps_per_bar: Optional[float] = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    risk_pct: Optional[float] = Field(default=None, gt=0, le=5, allow_inf_nan=False)
    max_leverage: Optional[float] = Field(default=None, gt=0, le=3, allow_inf_nan=False)
    persist: bool = True

    @field_validator("symbol", "pair_symbol", "benchmark_symbol", mode="before")
    @classmethod
    def _v_symbol(cls, v):
        return _sym(v.strip()) if isinstance(v, str) else v

    @field_validator("basket_symbols")
    @classmethod
    def _v_basket(cls, v):
        return [_sym(s.strip()) for s in v]

    @field_validator("fundamentals", "macro")
    @classmethod
    def _v_series(cls, v):
        if v is None:
            return v
        if len(v) > MAX_SERIES or any(len(s) > MAX_POINTS for s in v.values()):
            raise ValueError(f"at most {MAX_SERIES} series of {MAX_POINTS} points")
        return v

    @field_validator("sentiment")
    @classmethod
    def _v_sent(cls, v):
        if v is not None and len(v) > MAX_POINTS:
            raise ValueError(f"at most {MAX_POINTS} points")
        return v


def _spec(strategy_id: str):
    cls = STRATEGY_CLASSES.get(strategy_id)
    if cls is None:
        raise HTTPException(status_code=404, detail=f"Unknown strategy '{strategy_id}'")
    return cls.spec


def _costs(strategy_id: str, body: StrategyRunRequest) -> CostModel:
    base = STRATEGY_CLASSES[strategy_id]().default_costs()
    return CostModel(
        body.fee_bps if body.fee_bps is not None else base.fee_bps,
        body.slippage_bps if body.slippage_bps is not None else base.slippage_bps,
        body.half_spread_bps if body.half_spread_bps is not None else base.half_spread_bps,
        body.short_carry_bps_per_bar if body.short_carry_bps_per_bar is not None else base.short_carry_bps_per_bar,
        base.long_carry_bps_per_bar,
    )


def _risk(body: StrategyRunRequest) -> RiskModel:
    r = RiskModel()
    if body.risk_pct is not None:
        r.risk_pct = body.risk_pct
    if body.max_leverage is not None:
        r.max_leverage = body.max_leverage
    return r


def _blocked(e: MissingData) -> HTTPException:
    return HTTPException(status_code=422, detail={"status": "blocked_missing_data", "missing": e.missing, "detail": e.detail})


async def _fetch(market: MarketService, body: StrategyRunRequest, symbol: str, interval: str) -> Bars:
    try:
        klines = await market.get_history(body.provider, symbol, interval=interval, limit=body.limit)
    except Exception:
        logger.warning("history failed for %s %s", body.provider, symbol, exc_info=True)
        raise HTTPException(status_code=502, detail=f"Market history for {symbol} failed upstream")
    bars = Bars.from_klines(klines, symbol=symbol, interval=interval)
    if len(bars) < 50:
        raise HTTPException(status_code=422, detail=f"Not enough valid completed candles for {symbol} ({len(bars)})")
    return bars


async def _load(strategy_id: str, body: StrategyRunRequest, settings: Settings) -> tuple[Bars, dict[str, Any], str]:
    spec = _spec(strategy_id)
    interval = body.interval or spec.default_interval
    market = MarketService(settings)
    main = await _fetch(market, body, body.symbol, interval)
    wanted: list[str] = []
    if "pair_close" in spec.required_aux and body.pair_symbol:
        wanted.append(body.pair_symbol)
    if "basket_closes" in spec.required_aux:
        wanted += body.basket_symbols
    if "benchmark_close" in spec.required_aux and body.benchmark_symbol:
        wanted.append(body.benchmark_symbol)
    others: dict[str, Bars] = {}
    for s in dict.fromkeys(wanted):  # de-duplicate, keep order
        others[s] = main if s == body.symbol else await _fetch(market, body, s, interval)
    closes: dict[str, list[float]] = {}
    if others:
        try:
            main, closes = align_bars(main, others)
        except MissingData as e:
            raise _blocked(e)
    aux = build_aux(
        main, closes=closes, pair_symbol=body.pair_symbol, basket_symbols=body.basket_symbols, benchmark_symbol=body.benchmark_symbol,
        fundamentals=body.fundamentals, macro=body.macro, events=body.events, sentiment=body.sentiment,
    )
    return main, aux, interval


@router.get("")
async def list_strategies(db: Session = Depends(get_db)):
    grades = store.latest_grades(db)
    items = []
    for sid, cls in STRATEGY_CLASSES.items():
        s = cls.spec
        items.append({
            "id": sid, "name": s.name, "family": s.family, "summary": s.summary, "timeframe": s.timeframe, "mode": s.mode,
            "fidelity": s.fidelity, "required_aux": s.required_aux, "default_interval": s.default_interval, "legacy_modules": s.legacy_modules,
            "latest_validation": grades.get(sid) or {"grade": "not_validated", "status": "not_run"},
        })
    return {"count": len(items), "strategies": items, "criteria": CRITERIA, "statement": STATEMENT}


@router.get("/{strategy_id}")
async def strategy_detail(strategy_id: str, symbol: Optional[str] = None, db: Session = Depends(get_db)):
    spec = _spec(strategy_id)
    if symbol is not None and not SYMBOL_RE.match(symbol):
        raise HTTPException(status_code=422, detail="invalid symbol")
    rec = store.latest_report(db, strategy_id, symbol)
    return {
        "spec": spec.to_dict(), "statement": STATEMENT,
        "latest_validation": rec.report if rec else None,
        "latest_validation_summary": store.summary(rec) or {"grade": "not_validated", "status": "not_run"},
    }


@router.get("/{strategy_id}/validation")
async def strategy_validation(strategy_id: str, symbol: Optional[str] = None, interval: Optional[str] = Query(None, pattern=INTERVAL_PATTERN),
                              db: Session = Depends(get_db)):
    _spec(strategy_id)
    if symbol is not None and not SYMBOL_RE.match(symbol):
        raise HTTPException(status_code=422, detail="invalid symbol")
    rec = store.latest_report(db, strategy_id, symbol, interval)
    if rec is None:
        raise HTTPException(status_code=404, detail={"status": "not_run", "message": "No validation has been run for this strategy yet. POST /validate."})
    return rec.report


@router.post("/{strategy_id}/backtest")
async def strategy_backtest(strategy_id: str, body: StrategyRunRequest, settings: Settings = Depends(get_settings)):
    """Single in-sample run with fixed parameters. Descriptive only; use /validate for evidence."""
    _spec(strategy_id)
    bars, aux, interval = await _load(strategy_id, body, settings)
    try:
        result = await run_in_threadpool(
            run_backtest, strategy_id, bars, aux, body.params, _costs(strategy_id, body), _risk(body), bars_per_year(interval, body.calendar))
    except MissingData as e:
        raise _blocked(e)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=422, detail=f"Invalid parameters: {e}")
    return store.clean_json({**result, "data": {"symbol": bars.symbol, "interval": interval, "bars": len(bars)}})


@router.post("/{strategy_id}/validate")
async def strategy_validate(strategy_id: str, body: StrategyRunRequest, settings: Settings = Depends(get_settings),
                            db: Session = Depends(get_db), _auth: None = Depends(require_api_key)):
    """Full validation (train/test, walk-forward, regimes, costs, significance). Persisted when persist=true."""
    _spec(strategy_id)
    bars, aux, interval = await _load(strategy_id, body, settings)
    try:
        report = await run_in_threadpool(
            lambda: validate(strategy_id, bars, aux, params=body.params or None, cost=_costs(strategy_id, body), risk=_risk(body),
                             bpy=bars_per_year(interval, body.calendar), train_frac=body.train_fraction))
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=422, detail=f"Invalid parameters: {e}")
    report = store.clean_json(report)
    if body.persist:
        rec = store.save_report(db, report, symbol=body.symbol, provider=body.provider, interval=interval)
        report["stored_id"] = rec.id
    return report


@router.get("/{strategy_id}/signal")
async def strategy_signal(
    strategy_id: str, symbol: str = "BTCUSDT", interval: Optional[str] = Query(None, pattern=INTERVAL_PATTERN),
    limit: int = Query(500, ge=100, le=1000), pair_symbol: Optional[str] = None, basket_symbols: Optional[str] = None,
    benchmark_symbol: Optional[str] = None, settings: Settings = Depends(get_settings), db: Session = Depends(get_db),
):
    """Research state at the last completed candle. Not an order. Always returns the strategy's evidence grade."""
    _spec(strategy_id)
    try:
        body = StrategyRunRequest(
            symbol=symbol, interval=interval, limit=limit, pair_symbol=pair_symbol, benchmark_symbol=benchmark_symbol,
            basket_symbols=[s for s in (basket_symbols or "").split(",") if s.strip()],
        )
    except ValueError:
        raise HTTPException(status_code=422, detail="invalid symbol or parameter")
    bars, aux, iv = await _load(strategy_id, body, settings)
    try:
        sig = await run_in_threadpool(latest_signal, strategy_id, bars, aux, None)
    except MissingData as e:
        raise _blocked(e)
    rec = store.latest_report(db, strategy_id, body.symbol, iv)
    grade = store.summary(rec) or {"grade": "not_validated", "status": "not_run"}
    return {
        "signal": sig, "symbol": body.symbol, "interval": iv, "evidence": grade, "execution_eligible": False,
        "disclaimer": "Research signal only. " + STATEMENT,
    }
