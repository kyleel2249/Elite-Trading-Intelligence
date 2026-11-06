"""ETI FastAPI application entrypoint."""
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Depends, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field
from starlette.requests import Request

from app import __version__
from app.config import get_settings, Settings
from app.database import init_db
from app.schemas import HealthResponse
from app.risk.engine import RiskEngine, OrderProposal
from app.integrations.alpaca import AlpacaClient
from app.integrations.binance import BinanceClient
from app.trading.service import TradingService
from app.market.service import MarketService
from app.intelligence.council import TradingCouncil


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="Elite Trading Intelligence",
    description="ETI — Research, intelligence, risk-gated paper & live trading",
    version=__version__,
    lifespan=lifespan,
)

templates = Jinja2Templates(directory="app/templates")

try:
    app.mount("/static", StaticFiles(directory="app/static"), name="static")
except RuntimeError:
    pass


class OrderRequest(BaseModel):
    provider: str = Field(..., examples=["binance", "alpaca"])
    environment: str = Field(..., examples=["paper", "testnet", "live"])
    symbol: str
    side: str
    qty: float
    order_type: str = "market"
    limit_price: Optional[float] = None
    equity: float = 10000.0
    current_open_positions: int = 0
    daily_realized_pnl_pct: float = 0.0
    current_drawdown_pct: float = 0.0
    data_age_seconds: Optional[float] = 10.0
    data_status: str = "fresh"


@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request, settings: Settings = Depends(get_settings)):
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "version": __version__,
            "live_trading_enabled": settings.live_trading_enabled,
            "alpaca_paper": settings.alpaca_paper,
            "binance_testnet": settings.binance_testnet_enabled,
        },
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


@app.get("/api/providers/status")
async def providers_status(settings: Settings = Depends(get_settings)):
    alpaca = AlpacaClient(settings)
    binance = BinanceClient(settings)
    return {
        "alpaca": await alpaca.health(),
        "binance": await binance.health(),
        "live_trading_enabled": settings.live_trading_enabled,
    }


@app.get("/api/market/snapshot")
async def market_snapshot(
    provider: str = "binance",
    symbol: str = "BTCUSDT",
    settings: Settings = Depends(get_settings),
):
    svc = MarketService(settings)
    try:
        return await svc.get_snapshot(provider, symbol)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/market/order-book")
async def market_order_book(
    symbol: str = "BTCUSDT",
    depth: int = 20,
    settings: Settings = Depends(get_settings),
):
    svc = MarketService(settings)
    try:
        return await svc.get_order_book(symbol, depth=depth)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/market/history")
async def market_history(
    provider: str = "binance",
    symbol: str = "BTCUSDT",
    interval: str = "1h",
    limit: int = 100,
    settings: Settings = Depends(get_settings),
):
    svc = MarketService(settings)
    try:
        return await svc.get_history(provider, symbol, interval=interval, limit=limit)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/intelligence/council")
async def run_council(
    symbol: str = "BTCUSDT",
    provider: str = "binance",
    settings: Settings = Depends(get_settings),
):
    mkt = MarketService(settings)
    try:
        snap = await mkt.get_snapshot(provider, symbol)
        book = None
        klines = None
        if provider == "binance":
            book = await mkt.get_order_book(symbol, depth=20)
            klines = await mkt.get_history("binance", symbol, interval="1h", limit=30)
        council = TradingCouncil()
        decision = council.analyse(
            symbol=symbol,
            provider=provider,
            price=snap.get("price"),
            bid=snap.get("bid"),
            ask=snap.get("ask"),
            data_status=snap.get("data_status", "unknown"),
            order_book=book,
            klines=klines,
        )
        return {
            "action": decision.action.value,
            "confidence": decision.confidence,
            "summary": decision.summary,
            "risk_veto": decision.risk_veto,
            "risk_notes": decision.risk_notes,
            "contradictory_signals": decision.contradictory_signals,
            "data_quality": decision.data_quality,
            "timestamp": decision.timestamp,
            "specialists": [
                {
                    "role": r.role,
                    "bias": r.bias,
                    "confidence": r.confidence,
                    "analysis": r.analysis,
                    "evidence": r.evidence,
                    "limitations": r.limitations,
                }
                for r in decision.specialist_reports
            ],
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/risk/evaluate")
async def evaluate_risk_demo(
    symbol: str = "BTCUSDT",
    side: str = "buy",
    qty: float = 0.01,
    environment: str = "paper",
    equity: float = 10000.0,
):
    engine = RiskEngine()
    proposal = OrderProposal(
        provider="binance",
        environment=environment,
        symbol=symbol,
        side=side,
        qty=qty,
        equity=equity,
        current_open_positions=0,
        daily_realized_pnl_pct=0.0,
        current_drawdown_pct=0.0,
        data_age_seconds=10.0,
        data_status="fresh",
    )
    decision = engine.evaluate(proposal)
    return {
        "decision": decision.decision.value,
        "approved": decision.approved,
        "reasons": decision.reasons,
        "risk_per_trade_pct": decision.risk_per_trade_pct,
        "notes": decision.notes,
    }


@app.post("/api/trading/order")
async def place_order(req: OrderRequest, settings: Settings = Depends(get_settings)):
    service = TradingService(settings)
    return await service.place_order(
        provider=req.provider,
        environment=req.environment,
        symbol=req.symbol,
        side=req.side,
        qty=req.qty,
        order_type=req.order_type,
        limit_price=req.limit_price,
        equity=req.equity,
        current_open_positions=req.current_open_positions,
        daily_realized_pnl_pct=req.daily_realized_pnl_pct,
        current_drawdown_pct=req.current_drawdown_pct,
        data_age_seconds=req.data_age_seconds,
        data_status=req.data_status,
    )
