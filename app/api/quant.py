"""Global market intelligence API (scanner, valuation, mispricing, Kelly sizing, execution)."""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.database import get_db
from app.quant import db_models as dbm
from app.quant.controls import controls
from app.quant.execution import ExecutionSignal, PortfolioContext
from app.quant.kelly import KellyInput, KellyLimits, size_position
from app.quant.runtime import get_engine, get_scanner, scan_job, load_universe
from app.quant.sentiment import SentimentItem
from app.quant.service import QuantStore, evaluate_opportunity
from app.security.auth import require_api_key
from app.trading.risk_context import build_risk_context

router = APIRouter(prefix="/api/quant", tags=["quant"])

_SYMBOL_RE = re.compile(r"[A-Za-z0-9./_-]{1,32}")


def _limits(s: Settings) -> KellyLimits:
    return KellyLimits(max_position_pct=s.max_position_allocation_pct,
                       max_risk_per_trade_pct=s.default_risk_per_trade_pct, kelly_fraction=s.kelly_fraction,
                       max_total_exposure_pct=s.max_total_exposure_pct,
                       max_sector_exposure_pct=s.max_sector_exposure_pct,
                       max_correlated_exposure_pct=s.max_correlated_exposure_pct)


class KellyRequest(BaseModel):
    symbol: Optional[str] = None
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
async def kelly(req: KellyRequest, settings: Settings = Depends(get_settings), db: Session = Depends(get_db)):
    data = req.model_dump()
    symbol = data.pop("symbol")
    res = size_position(KellyInput(**data), _limits(settings)).to_dict()
    QuantStore(db).save_kelly(symbol, req.model_dump(), res)
    return res


class SentimentIn(BaseModel):
    source: str
    verification: Literal["verified", "credible", "unverified", "social"]
    score: float = Field(ge=-1, le=1)
    ts: datetime
    text: str = ""
    author: Optional[str] = None
    engagement: float = 0.0
    sponsored: bool = False


class EvaluateRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9./_-]+$")
    asset_class: Literal["equity", "etf", "crypto", "commodity", "futures", "forex"]
    # Model inputs must come from a licensed/real data source chosen by the caller.
    fair_value_inputs: dict[str, dict] = {}
    auto_fundamentals: bool = False  # equities: add DCF/DDM inputs derived from SEC EDGAR 10-K facts
    sentiment: list[SentimentIn] = []
    use_news: bool = False          # pull headlines from NewsAPI when no sentiment items are supplied
    components: dict[str, float] = {}
    engine_votes: dict[str, Literal["bullish", "bearish", "neutral"]] = {}
    win_probability: Optional[float] = Field(None, ge=0, le=1)
    sample_size: int = 0
    stop_pct: float = Field(5.0, gt=0, lt=50)
    round_trip_cost_pct: float = Field(0.30, ge=0)
    verification: dict = {}
    bankroll: Optional[float] = Field(None, gt=0)
    persist_prediction: bool = True


@router.post("/evaluate")
async def evaluate(req: EvaluateRequest, settings: Settings = Depends(get_settings), db: Session = Depends(get_db),
                   _auth=Depends(require_api_key)):
    sc = get_scanner(settings)
    cov = sc.coverage.get(req.symbol.upper())
    items = [SentimentItem(**{**i.model_dump(), "ts": i.ts if i.ts.tzinfo else i.ts.replace(tzinfo=timezone.utc)})
             for i in req.sentiment]
    if not items and req.use_news:
        from app.quant.news_sentiment import news_items
        items = await news_items(req.symbol, settings)
    fv_inputs = dict(req.fair_value_inputs)
    fundamentals = None
    if req.auto_fundamentals and req.asset_class == "equity":
        from app.quant.fundamentals import fundamentals_for
        fundamentals = await fundamentals_for(req.symbol)
        for model, data in fundamentals.get("inputs", {}).items():
            fv_inputs.setdefault(model, data)       # caller-supplied inputs always win
    bankroll = req.bankroll
    if bankroll is None:
        try:
            bankroll = build_risk_context(db, settings, environment="paper", snapshot=None).equity
        except Exception:
            bankroll = None
    out = evaluate_opportunity(
        symbol=req.symbol.upper(), asset_class=req.asset_class, coverage=cov,
        fair_value_inputs=fv_inputs, sentiment_items=items, components=req.components,
        engine_votes=req.engine_votes, win_probability=req.win_probability, sample_size=req.sample_size,
        bankroll=bankroll, stop_pct=req.stop_pct, round_trip_cost_pct=req.round_trip_cost_pct,
        kelly_limits=_limits(settings), sizing_context=req.verification, max_age_seconds=settings.data_max_age_seconds)
    if fundamentals is not None:
        out["fundamentals"] = fundamentals
    store = QuantStore(db)
    fv = out.get("fair_value")
    if fv and fv.get("supported"):
        from app.quant.fair_value import FairValueResult
        store.save_fair_value(FairValueResult(**fv))
        mp = out.get("mispricing") or {}
        if mp.get("flagged"):
            from app.quant.mispricing import MispricingResult
            store.record_mispricing(req.symbol.upper(), MispricingResult(**mp))
            if req.persist_prediction and mp.get("mispricing_pct") is not None:
                store.record_prediction(
                    symbol=req.symbol.upper(), market_price=mp["market_price"], fair_value=mp["fair_value"],
                    mispricing_pct=mp["mispricing_pct"], confidence=fv["confidence"],
                    horizon_days=float((req.verification or {}).get("convergence_horizon_days") or 90),
                    direction=mp["direction"], invalidation=["stop hit", "re-valuation below entry", "stale data"],
                    asset_class=req.asset_class)
    if out.get("sizing"):
        store.save_kelly(req.symbol.upper(), {"bankroll": bankroll}, out["sizing"])
    return out


@router.get("/fundamentals/{ticker}")
async def fundamentals(ticker: str, discount_rate: float = Query(0.10, gt=0, lt=0.5),
                       terminal_growth: float = Query(0.025, ge=0, lt=0.06)):
    """DCF/DDM inputs from SEC EDGAR 10-K facts. Assumptions (discount/terminal growth) are echoed back."""
    if not _SYMBOL_RE.fullmatch(ticker):
        raise HTTPException(422, "invalid ticker")
    from app.quant.fundamentals import fundamentals_for
    try:
        return await fundamentals_for(ticker, discount_rate=discount_rate, terminal_growth=terminal_growth)
    except Exception:
        raise HTTPException(502, "SEC EDGAR request failed")


@router.get("/sentiment/{symbol}")
async def sentiment(symbol: str, settings: Settings = Depends(get_settings)):
    """News sentiment from NewsAPI. Reports 'unavailable' honestly when the key is missing or the feed fails."""
    if not _SYMBOL_RE.fullmatch(symbol):
        raise HTTPException(422, "invalid symbol")
    from app.quant.news_sentiment import news_sentiment
    return (await news_sentiment(symbol.upper(), settings)).to_dict()


@router.post("/convergence/run")
async def convergence_run(db: Session = Depends(get_db), settings: Settings = Depends(get_settings),
                          _auth=Depends(require_api_key)):
    from app.quant.convergence import track_open_alerts
    return track_open_alerts(db, get_scanner(settings))


@router.get("/overview")
async def overview(settings: Settings = Depends(get_settings), db: Session = Depends(get_db)):
    sc = get_scanner(settings)
    st = sc.status()
    cov = list(sc.coverage.values())
    open_alerts = db.query(dbm.MispricingAlert).filter_by(status="open").all()
    running = scan_job.status()["running"]
    return {
        "markets_monitored": st["monitored_universe"],
        "markets_actively_scanned": st["status_counts"].get("ACTIVE", 0),
        "status_counts": st["status_counts"],
        "scan_completion_pct": st["last_metrics"]["completion_pct"] if st["last_metrics"] else 0.0,
        "last_full_scan": st["last_full_scan"],
        "next_scan_due_seconds": scan_job.interval_seconds if running else None,
        "scan_job_running": running, "scan_enabled": settings.scan_enabled,
        "provider_health": st["provider_health"], "last_scan_metrics": st["last_metrics"],
        "freshness": {"fresh_ratio": st["fresh_ratio"], "max_age_seconds": settings.data_max_age_seconds},
        "asset_classes": {ac: sum(1 for c in cov if c.asset_class == ac) for ac in {c.asset_class for c in cov}},
        "mispricing_open_above_8pct": len(open_alerts),
        "mispricing_confirmed": sum(1 for a in open_alerts if a.confirmed),
        "undervalued": sum(1 for a in open_alerts if a.direction == "undervalued"),
        "overvalued": sum(1 for a in open_alerts if a.direction == "overvalued"),
        "controls": controls.status(), "live_trading_enabled": settings.live_trading_enabled,
        "position_cap_pct": settings.max_position_allocation_pct, "kelly_fraction": settings.kelly_fraction,
    }


@router.get("/coverage")
async def coverage(status: Optional[str] = None, asset_class: Optional[str] = None, exchange: Optional[str] = None,
                   provider: Optional[str] = None, limit: int = Query(200, ge=1, le=2000), offset: int = 0,
                   settings: Settings = Depends(get_settings)):
    rows = list(get_scanner(settings).coverage.values())
    if status:
        rows = [r for r in rows if r.status == status.upper()]
    if asset_class:
        rows = [r for r in rows if r.asset_class == asset_class]
    if exchange:
        rows = [r for r in rows if r.exchange == exchange]
    if provider:
        rows = [r for r in rows if r.provider == provider]
    return {"total": len(rows), "items": [r.to_dict() for r in rows[offset:offset + limit]]}


@router.post("/scan/run")
async def scan_run(_auth=Depends(require_api_key)):
    return await scan_job.run_once()


@router.get("/scan/status")
async def scan_status():
    return scan_job.status()


@router.get("/mispricing")
async def mispricing(status: str = "open", direction: Optional[str] = None, confirmed: Optional[bool] = None,
                     limit: int = Query(100, ge=1, le=500), db: Session = Depends(get_db)):
    q = db.query(dbm.MispricingAlert).filter(dbm.MispricingAlert.status == status)
    if direction:
        q = q.filter(dbm.MispricingAlert.direction == direction)
    if confirmed is not None:
        q = q.filter(dbm.MispricingAlert.confirmed == confirmed)
    rows = q.order_by(dbm.MispricingAlert.created_at.desc()).limit(limit).all()
    return [{"symbol": r.symbol, "direction": r.direction, "mispricing_pct": r.mispricing_pct, "band": r.band,
             "confirmed": r.confirmed, "market_price_at_discovery": r.market_price_at_discovery,
             "fair_value_at_discovery": r.fair_value_at_discovery, "failed_checks": r.failed_checks,
             "unverified_checks": r.unverified_checks, "status": r.status,
             "created_at": r.created_at.isoformat()} for r in rows]


@router.get("/fair-values")
async def fair_values(limit: int = Query(50, ge=1, le=500), db: Session = Depends(get_db)):
    rows = db.query(dbm.FairValueEstimate).order_by(dbm.FairValueEstimate.created_at.desc()).limit(limit).all()
    return [{"symbol": r.symbol, "asset_class": r.asset_class, "market_price": r.market_price,
             "fair_value": r.fair_value, "lower": r.lower_bound, "upper": r.upper_bound, "confidence": r.confidence,
             "methodology": (r.payload or {}).get("methodology"), "ts": r.created_at.isoformat()} for r in rows]


@router.get("/ledger")
async def ledger(limit: int = Query(100, ge=1, le=500), db: Session = Depends(get_db)):
    """Mispricing predictions from the existing append-only prediction ledger (resolved by its resolver job)."""
    rows = QuantStore(db).ledger_rows(include_pending=True)
    return list(reversed(rows))[:limit]


@router.get("/performance")
async def performance(db: Session = Depends(get_db)):
    return QuantStore(db).performance_summary()


class ExecuteRequest(BaseModel):
    signal_id: Optional[str] = Field(None, max_length=80)      # idempotency key; generated if absent
    provider: Literal["alpaca", "binance"]
    environment: Literal["paper", "testnet", "live"]
    symbol: str = Field(pattern=r"^[A-Za-z0-9./_-]+$", max_length=32)
    side: Literal["buy", "sell"]
    quantity: float = Field(gt=0, allow_inf_nan=False)
    stop_price: float = Field(gt=0, allow_inf_nan=False)
    take_profits: list[float] = []


@router.post("/execute")
async def execute(req: ExecuteRequest, settings: Settings = Depends(get_settings), db: Session = Depends(get_db),
                  _auth=Depends(require_api_key)):
    """Price, freshness and equity are server-derived; the opportunity must be a confirmed open alert."""
    sym = req.symbol.upper()
    cov = get_scanner(settings).coverage.get(sym)
    if cov is None or cov.price is None or not cov.last_valid_data_ts:
        raise HTTPException(422, "no scanner data for symbol")
    alert = (db.query(dbm.MispricingAlert).filter_by(symbol=sym, status="open", confirmed=True)
             .order_by(dbm.MispricingAlert.created_at.desc()).first())
    expected = "undervalued" if req.side == "buy" else "overvalued"
    created = alert.created_at.replace(tzinfo=None) if alert is not None and alert.created_at else None
    verified = bool(alert and alert.direction == expected and created is not None
                    and (datetime.now(timezone.utc).replace(tzinfo=None) - created) < timedelta(days=7))
    snapshot = {"price": cov.price, "ts_utc": cov.last_valid_data_ts,
                "data_status": "fresh" if cov.status == "ACTIVE" else "stale", "provider": cov.provider, "symbol": sym}
    ctx = build_risk_context(db, settings, environment=req.environment, snapshot=snapshot)
    sig = ExecutionSignal(
        signal_id=req.signal_id or f"sig-{uuid.uuid4().hex[:24]}", provider=req.provider,
        environment=req.environment, symbol=sym, side=req.side, quantity=req.quantity, entry_price=cov.price,
        stop_price=req.stop_price, take_profits=req.take_profits, mispricing_confirmed=verified,
        data_age_seconds=ctx.data_age_seconds, data_status=str(ctx.data_status))
    # Duplicate guard that survives restarts.
    if db.query(dbm.ExecutionEventRecord).filter_by(signal_id=sig.signal_id).first():
        raise HTTPException(409, "duplicate signal_id: order already processed")
    rec = await get_engine(settings).execute(sig, PortfolioContext(
        equity=ctx.equity, current_open_positions=ctx.current_open_positions,
        daily_realized_pnl_pct=ctx.daily_realized_pnl_pct, current_drawdown_pct=ctx.current_drawdown_pct))
    store = QuantStore(db)
    store.save_execution(rec.to_dict(), sym, req.environment)
    store.audit("execution", detail={"signal_id": sig.signal_id, "state": rec.state.value, "symbol": sym})
    return rec.to_dict()


@router.get("/execution/metrics")
async def execution_metrics(settings: Settings = Depends(get_settings)):
    return get_engine(settings).metrics()


@router.get("/execution/orders")
async def execution_orders(limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db)):
    rows = db.query(dbm.ExecutionEventRecord).order_by(dbm.ExecutionEventRecord.created_at.desc()).limit(limit).all()
    return [{"signal_id": r.signal_id, "client_order_id": r.client_order_id, "symbol": r.symbol,
             "environment": r.environment, "state": r.state, "latency_ms": r.latency_ms,
             "ts": r.created_at.isoformat()} for r in rows]


class KillRequest(BaseModel):
    engage: bool
    reason: str = "manual"


@router.get("/controls")
async def get_controls():
    return controls.status()


@router.post("/controls/kill-switch")
async def kill_switch(req: KillRequest, db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    if req.engage:
        controls.engage_kill_switch(reason=req.reason)
    else:
        controls.release_kill_switch()
    QuantStore(db).audit("kill_switch", actor="api", detail={"engaged": req.engage, "reason": req.reason})
    return controls.status()


@router.post("/universe/reload")
async def universe_reload(settings: Settings = Depends(get_settings), _auth=Depends(require_api_key)):
    return {"instruments": await load_universe(settings)}
