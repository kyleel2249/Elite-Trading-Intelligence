"""ETI FastAPI application entrypoint."""
import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Literal, Optional

from pathlib import Path

from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy.orm import Session
from starlette.requests import Request

from app import __version__
from app.config import get_settings, Settings
from app.database import init_db, get_db
from app.schemas import HealthResponse
from app.risk.engine import RiskEngine, OrderProposal
from app.integrations.alpaca import AlpacaClient
from app.integrations.binance import BinanceClient
from app.integrations.quiver.client import QuiverClient
from app.integrations.liquid.client import LiquidClient
from app.trading.service import TradingService
from app.trading.portfolio import PortfolioService
from app.trading.reconciliation import OrderReconciler
from app.trading.risk_context import build_risk_context
from app.market.service import MarketService
from app.intelligence.council import TradingCouncil
from app.intelligence.traders import list_trader_profiles
from app.intelligence.predictive import PredictiveEngine
from app.intelligence.forecast_accuracy import ForecastAccuracyService
from app.intelligence.feeds import fetch_fred_series, fetch_news_headlines
from app.knowledge.registry import attribution_for_decision
from app.streaming.manager import stream_hub
from app.jobs.mark_to_market import mtm_job
from app.jobs.reconcile import reconcile_job
from app.jobs.investor_monitor import investor_monitor_job
from app.jobs.execution_supervisor import execution_supervisor_job
from app.services.persistence import save_snapshot, save_council_decision, save_forecast
from app.models import CouncilDecisionRecord
from app.api.knowledge import router as knowledge_router
from app.api.backtest import router as backtest_router
from app.api.intelligence_data import router as intelligence_data_router
from app.api.stream import router as stream_router
from app.api.risk_gateway import router as risk_gateway_router
from app.api.execution import router as execution_router
from app.api.markets import router as markets_router
from app.api.analytics import router as analytics_router
from app.api.strategies import router as strategies_router
from app.prediction_ledger.api import router as predictions_router
from app.prediction_ledger.job import prediction_resolver_job
from app.prediction_ledger.service import record_from_forecast
from app.security.auth import PROTECTED_ENVS, require_api_key

logger = logging.getLogger("eti")

BASE_DIR = Path(__file__).resolve().parent


def _upstream_error(exc: Exception, what: str) -> HTTPException:
    """Log the real error server-side; never echo upstream exception text (URLs, keys) to clients."""
    logger.warning("%s failed: %s", what, type(exc).__name__, exc_info=True)
    return HTTPException(status_code=502, detail=f"{what} failed upstream")


async def _start_component(name: str, starter) -> None:
    try:
        await starter()
    except Exception:
        logger.warning("startup: %s failed to start; continuing without it", name, exc_info=True)


def _warn_insecure_config(settings: Settings) -> None:
    if (settings.app_env or "").strip().lower() not in PROTECTED_ENVS:
        return
    if settings.secret_key in ("change-me", "change-me-to-a-long-random-string"):
        logger.warning("SECRET_KEY is still the default; set a long random value in production")
    if not (settings.api_key or "").strip():
        logger.warning("API_KEY is not set; protected routes will return 503 in this environment")


def _seed_memory(settings: Settings) -> None:
    """Snapshot documented profiles/methodologies/risk limits into versioned memory (idempotent)."""
    from app.database import SessionLocal
    from app.memory.store import MemoryStore

    db = SessionLocal()
    try:
        store = MemoryStore(db)
        store.seed_static_knowledge()
        store.snapshot_risk_limits(settings)
    except Exception:
        db.rollback()
        logger.warning("startup: memory seeding failed; continuing", exc_info=True)
    finally:
        db.close()


def _record_council_signal(db: Session, settings: Settings, symbol: str, provider: str, payload: dict, snap: dict, klines) -> None:
    """Remember the council's call exactly as made, with a point-in-time regime label."""
    from app.memory.regimes import RegimeMemoryService
    from app.memory.signals import SignalMemoryService

    regime = None
    regimes = RegimeMemoryService(db, settings)
    recent = regimes.latest_as_of(symbol, provider, max_age_seconds=300)
    if recent is not None:
        regime = recent.primary_regime
    else:
        closes = [float(k["close"]) for k in (klines or []) if k.get("close") is not None]
        if len(closes) >= 20:
            obs = regimes.classify_from_closes(symbol, provider, closes, source="council")
            regime = obs.primary_regime if obs else None
    SignalMemoryService(db, settings).record(
        source="council",
        symbol=symbol,
        provider=provider,
        action=payload.get("action"),
        confidence=payload.get("confidence"),
        reference_price=snap.get("price"),
        regime=regime,
        analysis={
            "summary": payload.get("summary"),
            "risk_veto": payload.get("risk_veto"),
            "data_quality": payload.get("data_quality"),
            "contradictory_signals": payload.get("contradictory_signals"),
            "specialists": [
                {"trader_id": s.get("trader_id"), "bias": s.get("bias"), "confidence": s.get("confidence")}
                for s in payload.get("specialists", [])
            ],
        },
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    settings = get_settings()
    _warn_insecure_config(settings)
    await asyncio.to_thread(_seed_memory, settings)
    mtm_job.interval_seconds = settings.mtm_interval_seconds
    reconcile_job.interval_seconds = settings.reconcile_interval_seconds
    investor_monitor_job.interval_seconds = settings.investor_monitor_interval_seconds
    execution_supervisor_job.interval_seconds = settings.execution_supervisor_interval_seconds
    adaptive_job = None
    try:
        from app.jobs.adaptive_edge_job import adaptive_edge_job as adaptive_job

        adaptive_job.interval_seconds = settings.adaptive_edge_interval_seconds
    except Exception:
        logger.exception("startup: adaptive_edge_job could not be imported")
    await _start_component("stream_hub", lambda: stream_hub.start(["btcusdt", "ethusdt"]))
    await _start_component("mtm_job", mtm_job.start)
    await _start_component("reconcile_job", reconcile_job.start)
    await _start_component("prediction_resolver_job", prediction_resolver_job.start)
    if adaptive_job is not None:
        await _start_component("adaptive_edge_job", adaptive_job.start)
    if settings.quiver_configured:
        await _start_component("investor_monitor_job", investor_monitor_job.start)
    if settings.execution_enabled:
        await _start_component("execution_supervisor_job", execution_supervisor_job.start)
    yield
    await execution_supervisor_job.stop()
    await investor_monitor_job.stop()
    if adaptive_job is not None:
        await adaptive_job.stop()
    await prediction_resolver_job.stop()
    await reconcile_job.stop()
    await mtm_job.stop()
    await stream_hub.stop()


app = FastAPI(
    title="Elite Trading Intelligence",
    description="ETI — Research, intelligence, risk-gated paper & live trading",
    version=__version__,
    lifespan=lifespan,
)

app.include_router(knowledge_router)
app.include_router(backtest_router)
app.include_router(intelligence_data_router)
app.include_router(stream_router)
app.include_router(risk_gateway_router)
app.include_router(execution_router)
app.include_router(markets_router)
app.include_router(analytics_router)
app.include_router(strategies_router)
app.include_router(predictions_router)

# ETI persistent memory & learning, and the adaptive-edge API that feeds on it. Imported defensively
# so an unexpected import problem is logged loudly instead of taking the whole service down.
for _module_path, _label in (("app.api.memory", "memory"), ("app.api.adaptive_edge", "adaptive_edge")):
    try:
        _mod = __import__(_module_path, fromlist=["router"])
        app.include_router(_mod.router)
    except Exception:
        logger.exception("router %s failed to load; its endpoints are unavailable", _label)

templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

try:
    app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")
except RuntimeError:
    logger.info("app/static not present; static files are not mounted")


class OrderRequest(BaseModel):
    provider: Literal["binance", "alpaca"] = Field(..., examples=["binance", "alpaca"])
    environment: Literal["paper", "testnet", "live"] = Field(..., examples=["paper", "testnet", "live"])
    symbol: str = Field(..., min_length=1, max_length=32, pattern=r"^[A-Za-z0-9./_-]+$")
    side: Literal["buy", "sell"]
    qty: float = Field(..., gt=0, allow_inf_nan=False)
    order_type: str = Field("market", pattern=r"^[a-z_]{1,24}$")
    limit_price: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)
    thesis: Optional[str] = Field(default=None, max_length=2000)
    council_action: Optional[str] = Field(default=None, max_length=32)

    # Deprecated: accepted so existing clients keep working, but IGNORED. The server
    # derives equity, positions, PnL, drawdown and data freshness itself.
    equity: Optional[float] = Field(default=None, description="Deprecated; ignored (server-derived).")
    current_open_positions: Optional[int] = Field(default=None, description="Deprecated; ignored.")
    daily_realized_pnl_pct: Optional[float] = Field(default=None, description="Deprecated; ignored.")
    current_drawdown_pct: Optional[float] = Field(default=None, description="Deprecated; ignored.")
    data_age_seconds: Optional[float] = Field(default=None, description="Deprecated; ignored.")
    data_status: Optional[str] = Field(default=None, description="Deprecated; ignored.")

    @field_validator("provider", "environment", "side", "order_type", mode="before")
    @classmethod
    def _normalize(cls, v):
        return v.strip().lower() if isinstance(v, str) else v

    @model_validator(mode="after")
    def _limit_needs_price(self):
        if self.order_type == "limit" and self.limit_price is None:
            raise ValueError("limit_price is required for limit orders")
        return self


class ForecastScoreRequest(BaseModel):
    symbol: str = "BTCUSDT"
    provider: str = "binance"
    realized_price: Optional[float] = None


@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request, settings: Settings = Depends(get_settings)):
    return templates.TemplateResponse(
        request,
        "index.html",
        {
            "version": __version__,
            "live_trading_enabled": settings.live_trading_enabled,
            "alpaca_paper": settings.alpaca_paper,
            "binance_testnet": settings.binance_testnet_enabled,
        },
    )


@app.get("/data-intel", response_class=HTMLResponse)
async def data_intel_dashboard(request: Request):
    return templates.TemplateResponse(
        request,
        "data_intel.html",
        {"version": __version__},
    )


@app.get("/alerts", response_class=HTMLResponse)
async def alerts_page(request: Request):
    return templates.TemplateResponse(
        request,
        "alerts.html",
        {"version": __version__},
    )


@app.get("/predictions", response_class=HTMLResponse)
async def predictions_page(request: Request):
    return templates.TemplateResponse(
        request,
        "predictions.html",
        {"version": __version__},
    )


@app.get("/api/system/health", response_model=HealthResponse)
async def health(settings: Settings = Depends(get_settings)):
    return HealthResponse(
        status="ok",
        version=__version__,
        live_trading_enabled=settings.live_trading_enabled,
        alpaca_configured=settings.alpaca_configured,
        binance_configured=settings.binance_configured,
    )


@app.get("/api/system/mtm-status")
async def mtm_status():
    return mtm_job.status()


@app.post("/api/system/mtm-run")
async def mtm_run(_auth=Depends(require_api_key)):
    n = await mtm_job.run_once()
    return {"marked": n, **mtm_job.status()}


@app.get("/api/system/reconcile-status")
async def reconcile_status():
    return reconcile_job.status()


@app.post("/api/system/reconcile-run")
async def reconcile_run(_auth=Depends(require_api_key)):
    return await reconcile_job.run_once()


@app.get("/api/providers/status")
async def providers_status(settings: Settings = Depends(get_settings)):
    alpaca = AlpacaClient(settings)
    binance = BinanceClient(settings)
    quiver = QuiverClient(settings)
    liquid = LiquidClient(settings)
    try:
        from app.jobs.adaptive_edge_job import adaptive_edge_job

        adaptive_status = adaptive_edge_job.status()
    except Exception:
        adaptive_status = {"running": False, "error": "unavailable"}
    return {
        "alpaca": await alpaca.health(),
        "binance": await binance.health(),
        "quiver": await quiver.health(),
        "liquid": await liquid.health(),
        "live_trading_enabled": settings.live_trading_enabled,
        "streams": stream_hub.status(),
        "mtm": mtm_job.status(),
        "reconcile": reconcile_job.status(),
        "investor_monitor": investor_monitor_job.status(),
        "execution_supervisor": execution_supervisor_job.status(),
        "prediction_resolver": prediction_resolver_job.status(),
        "adaptive_edge": adaptive_status,
        "fred_configured": settings.fred_configured,
        "news_configured": settings.news_configured,
        "quiver_configured": settings.quiver_configured,
        "liquid_configured": settings.liquid_configured,
    }


@app.get("/api/providers/binance/stream/status")
async def binance_stream_status():
    return stream_hub.binance.status()


@app.get("/api/providers/alpaca/stream/status")
async def alpaca_stream_status():
    return stream_hub.alpaca.status()


@app.get("/api/feeds/fred")
async def feeds_fred(series_id: str = "DFF", settings: Settings = Depends(get_settings)):
    return await fetch_fred_series(series_id=series_id, settings=settings)


@app.get("/api/feeds/news")
async def feeds_news(q: str = "markets OR bitcoin OR federal reserve", settings: Settings = Depends(get_settings)):
    return await fetch_news_headlines(query=q, settings=settings)


@app.get("/api/market/snapshot")
async def market_snapshot(
    provider: str = "binance",
    symbol: str = "BTCUSDT",
    persist: bool = True,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
):
    svc = MarketService(settings)
    try:
        snap = await svc.get_snapshot(provider, symbol)
        if persist and snap.get("price") is not None:
            save_snapshot(db, snap)
        return snap
    except Exception as e:
        raise _upstream_error(e, "Market snapshot")


@app.get("/api/market/order-book")
async def market_order_book(
    symbol: str = "BTCUSDT",
    depth: int = Query(20, ge=1, le=100),
    settings: Settings = Depends(get_settings),
):
    svc = MarketService(settings)
    try:
        return await svc.get_order_book(symbol, depth=depth)
    except Exception as e:
        raise _upstream_error(e, "Order book")


@app.get("/api/market/history")
async def market_history(
    provider: str = "binance",
    symbol: str = "BTCUSDT",
    interval: str = Query("1h", pattern=r"^[0-9]{1,2}[smhdwM]$"),
    limit: int = Query(100, ge=1, le=1000),
    settings: Settings = Depends(get_settings),
):
    svc = MarketService(settings)
    try:
        return await svc.get_history(provider, symbol, interval=interval, limit=limit)
    except Exception as e:
        raise _upstream_error(e, "Market history")


@app.get("/api/intelligence/traders")
async def intelligence_traders():
    return {"traders": list_trader_profiles()}


@app.get("/api/intelligence/council")
async def run_council(
    symbol: str = "BTCUSDT",
    provider: str = "binance",
    persist: bool = True,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
):
    mkt = MarketService(settings)
    try:
        snap = await mkt.get_snapshot(provider, symbol)
        book = None
        klines = None
        if provider == "binance":
            book = await mkt.get_order_book(symbol, depth=20)
            klines = await mkt.get_history("binance", symbol, interval="1h", limit=48)
        fred = await fetch_fred_series(settings=settings)
        news = await fetch_news_headlines(query=f"{symbol} OR markets", settings=settings)
        context = {"fred": fred, "news": news}
        if news.get("status") == "ok" and news.get("sentiment_score") is not None:
            context["sentiment_score"] = news["sentiment_score"]
        quiver_ctx = {}
        if settings.quiver_configured and len(symbol) <= 6:
            try:
                from app.intelligence.investor_activity import InvestorActivityEngine
                quiver_ctx = await InvestorActivityEngine(settings).ticker_context(symbol)
            except Exception:
                logger.warning("quiver ticker context failed for %s", symbol, exc_info=True)
                quiver_ctx = {"status": "error"}
        council = TradingCouncil()
        decision = council.analyse(
            symbol=symbol, provider=provider, price=snap.get("price"),
            bid=snap.get("bid"), ask=snap.get("ask"),
            data_status=snap.get("data_status", "unknown"),
            order_book=book, klines=klines, context=context,
        )
        evidence_blob, structured = [], []
        for r in decision.specialist_reports:
            evidence_blob.extend(r.evidence or [])
            evidence_blob.extend(r.methods_applied or [])
            if r.trader_id in ("ta", "liquidity") and r.bias != "neutral":
                structured.append("structure_level")
            if r.trader_id == "macro":
                structured.append("liquidity_regime")
            if r.trader_id == "fa":
                structured.append("value_quality")
            if "breakout" in " ".join(r.methods_applied or []).lower():
                structured.append("trend_breakout")
        attribution = attribution_for_decision(decision.summary, evidence_blob, structured_tags=structured)
        payload = {
            "action": decision.action.value, "confidence": decision.confidence,
            "summary": decision.summary, "risk_veto": decision.risk_veto,
            "risk_notes": decision.risk_notes, "risk_officer": decision.risk_officer,
            "contradictory_signals": decision.contradictory_signals,
            "data_quality": decision.data_quality, "methodology_notes": decision.methodology_notes,
            "timestamp": decision.timestamp,
            "feeds": {"fred_status": fred.get("status"), "news_status": news.get("status"),
                       "quiver_ticker_status": quiver_ctx.get("congress", {}).get("status") if quiver_ctx else "skipped"},
            "alt_data_context": quiver_ctx or None, "strategy_attribution": attribution,
            "structured_evidence_tags": structured,
            "specialists": [{
                "trader_id": r.trader_id, "trader_name": r.trader_name, "role": r.role,
                "bias": r.bias, "confidence": r.confidence, "analysis": r.analysis,
                "evidence": r.evidence, "methods_applied": r.methods_applied, "limitations": r.limitations,
            } for r in decision.specialist_reports],
        }
        if persist:
            save_council_decision(db, symbol, provider, payload)
            if snap.get("price") is not None:
                save_snapshot(db, snap)
            try:
                _record_council_signal(db, settings, symbol, provider, payload, snap, klines)
            except Exception:
                db.rollback()
                logger.warning("memory: council signal record failed for %s", symbol, exc_info=True)
        return payload
    except Exception as e:
        raise _upstream_error(e, "Council analysis")


@app.get("/api/intelligence/decisions")
async def list_decisions(limit: int = Query(20, ge=1, le=100), db: Session = Depends(get_db)):
    rows = db.query(CouncilDecisionRecord).order_by(CouncilDecisionRecord.created_at.desc()).limit(min(limit, 100)).all()
    return [{"id": r.id, "symbol": r.symbol, "provider": r.provider, "action": r.action,
             "confidence": r.confidence, "summary": r.summary, "risk_veto": r.risk_veto,
             "data_quality": r.data_quality,
             "created_at": r.created_at.isoformat() if r.created_at else None} for r in rows]


@app.get("/api/intelligence/forecast")
async def intelligence_forecast(
    symbol: str = "BTCUSDT", provider: str = "binance", horizon: str = "intraday",
    persist: bool = True, settings: Settings = Depends(get_settings), db: Session = Depends(get_db),
):
    mkt = MarketService(settings)
    try:
        klines = await mkt.get_history(provider, symbol, interval="1h", limit=48)
        engine = PredictiveEngine()
        fc = engine.forecast(symbol=symbol, provider=provider, klines=klines, horizon=horizon)
        if fc is None:
            raise HTTPException(status_code=422, detail="Insufficient history for forecast scaffold")
        payload = fc.to_dict()
        if persist:
            saved = save_forecast(db, payload)
            # Every persisted forecast is also written to the append-only prediction ledger.
            try:
                closes = [float(k["close"]) for k in klines if k.get("close") and k.get("data_status") != "invalid"]
                payload["ledger"] = record_from_forecast(db, payload, closes=closes, forecast_id=saved.id)
            except Exception:
                db.rollback()
                logger.warning("prediction ledger write failed for %s", symbol, exc_info=True)
                payload["ledger"] = {"error": "ledger_write_failed"}
        return payload
    except HTTPException:
        raise
    except Exception as e:
        raise _upstream_error(e, "Forecast")


@app.post("/api/intelligence/forecast/score")
async def forecast_score(body: ForecastScoreRequest, settings: Settings = Depends(get_settings), db: Session = Depends(get_db)):
    price = body.realized_price
    if price is None:
        snap = await MarketService(settings).get_snapshot(body.provider, body.symbol)
        price = snap.get("price")
        if price is None:
            raise HTTPException(status_code=422, detail="No realized price available")
    svc = ForecastAccuracyService(db)
    scored = svc.score_pending(body.symbol, float(price), provider=body.provider)
    return {"symbol": body.symbol.upper(), "realized_price": price, "scored": scored,
            "summary": svc.summary(symbol=body.symbol), "analyst": "Lars Hagen"}


@app.get("/api/intelligence/forecast/accuracy")
async def forecast_accuracy(symbol: Optional[str] = None, db: Session = Depends(get_db)):
    return ForecastAccuracyService(db).summary(symbol=symbol)


@app.get("/api/risk/evaluate")
async def evaluate_risk_demo(symbol: str = "BTCUSDT", side: str = "buy", qty: float = 0.01,
                             environment: str = "paper", equity: float = 10000.0):
    engine = RiskEngine()
    proposal = OrderProposal(provider="binance", environment=environment, symbol=symbol, side=side,
                             qty=qty, equity=equity, current_open_positions=0, daily_realized_pnl_pct=0.0,
                             current_drawdown_pct=0.0, data_age_seconds=10.0, data_status="fresh")
    decision = engine.evaluate(proposal)
    return {"decision": decision.decision.value, "approved": decision.approved, "reasons": decision.reasons,
            "risk_per_trade_pct": decision.risk_per_trade_pct, "notes": decision.notes, "officer": "Helena Frost"}


@app.post("/api/trading/order")
async def place_order(req: OrderRequest, settings: Settings = Depends(get_settings),
                      db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    # Live orders are never allowed on an unauthenticated (no API_KEY) deployment.
    if req.environment == "live" and not settings.api_key:
        raise HTTPException(status_code=403, detail="Live orders require API_KEY to be configured")

    # Fetch the quote server-side: it drives data-freshness checks and paper fill prices.
    snapshot = None
    try:
        snapshot = await MarketService(settings).get_snapshot(req.provider, req.symbol)
    except Exception:
        logger.warning("snapshot failed for %s %s", req.provider, req.symbol, exc_info=True)

    # Risk inputs are derived from the database/market data, never from the request body.
    ctx = build_risk_context(db, settings, environment=req.environment, snapshot=snapshot)

    fill_hint = None
    if req.environment in ("paper", "testnet"):
        price = snapshot.get("price") if snapshot else None
        fill_hint = price if price is not None else req.limit_price

    service = TradingService(settings, db=db)
    result = await service.place_order(
        provider=req.provider, environment=req.environment, symbol=req.symbol, side=req.side,
        qty=req.qty, order_type=req.order_type, limit_price=req.limit_price, equity=ctx.equity,
        current_open_positions=ctx.current_open_positions, daily_realized_pnl_pct=ctx.daily_realized_pnl_pct,
        current_drawdown_pct=ctx.current_drawdown_pct, data_age_seconds=ctx.data_age_seconds,
        data_status=ctx.data_status, fill_price_hint=fill_hint, thesis=req.thesis,
        council_action=req.council_action,
    )
    result["risk_inputs"] = {"source": "server", **ctx.to_dict()}
    return result


@app.post("/api/trading/reconcile")
async def trading_reconcile(limit: int = Query(50, ge=1, le=200), settings: Settings = Depends(get_settings),
                            db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    return await OrderReconciler(db, settings).reconcile_open(limit=limit)


@app.get("/api/paper-trading/positions")
async def paper_positions(environment: str = "paper", status: str = "open", db: Session = Depends(get_db)):
    rows = PortfolioService(db).list_positions(environment=environment, status=status)
    return [{"symbol": p.symbol, "side": p.side, "qty": p.qty, "avg_entry": p.avg_entry,
             "mark_price": p.mark_price, "unrealized_pnl": p.unrealized_pnl, "realized_pnl": p.realized_pnl,
             "status": p.status, "provider": p.provider, "environment": p.environment} for p in rows]


@app.get("/api/paper-trading/portfolio")
async def paper_portfolio(environment: str = "paper", db: Session = Depends(get_db)):
    return PortfolioService(db).portfolio_summary(environment)


@app.get("/api/paper-trading/journal")
async def paper_journal(limit: int = Query(50, ge=1, le=500), symbol: Optional[str] = None, event: Optional[str] = None,
                        environment: Optional[str] = None, provider: Optional[str] = None,
                        side: Optional[str] = None, db: Session = Depends(get_db)):
    rows = PortfolioService(db).list_journal(limit=limit, symbol=symbol, event=event,
                                            environment=environment, provider=provider, side=side)
    return [{"id": r.id, "client_order_id": r.client_order_id, "provider": r.provider,
             "environment": r.environment, "symbol": r.symbol, "side": r.side, "qty": r.qty,
             "price": r.price, "event": r.event, "pnl": r.pnl, "thesis": r.thesis,
             "council_action": r.council_action, "risk_officer": r.risk_officer,
             "created_at": r.created_at.isoformat() if r.created_at else None} for r in rows]


@app.get("/api/paper-trading/history")
async def paper_history(limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db)):
    from app.models import OrderRecord
    rows = db.query(OrderRecord).order_by(OrderRecord.created_at.desc()).limit(min(limit, 200)).all()
    return [{"client_order_id": r.client_order_id, "provider": r.provider, "environment": r.environment,
             "symbol": r.symbol, "side": r.side, "qty": r.qty, "fill_price": r.fill_price,
             "status": r.status, "risk_approved": r.risk_approved, "risk_notes": r.risk_notes,
             "created_at": r.created_at.isoformat() if r.created_at else None} for r in rows]
