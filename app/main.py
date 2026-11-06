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


@app.get("/api/providers/binance/ticker")
async def binance_ticker(symbol: str = "BTCUSDT", settings: Settings = Depends(get_settings)):
    client = BinanceClient(settings)
    try:
        quote = await client.get_quote(symbol)
        return {
            "provider": quote.provider,
            "symbol": quote.symbol,
            "price": quote.price,
            "bid": quote.bid,
            "ask": quote.ask,
            "data_status": quote.data_status,
            "ts_utc": quote.ts_utc.isoformat(),
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
    """
    Risk-gated order endpoint.
    Live orders require LIVE_TRADING_ENABLED + provider flags + RiskEngine approval.
    """
    service = TradingService(settings)
    result = await service.place_order(
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
    return result
