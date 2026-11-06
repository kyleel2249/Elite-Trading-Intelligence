"""ETI FastAPI application entrypoint."""
from contextlib import asynccontextmanager

from fastapi import FastAPI, Depends
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from starlette.requests import Request

from app import __version__
from app.config import get_settings, Settings
from app.database import init_db
from app.schemas import HealthResponse
from app.risk.engine import RiskEngine, OrderProposal


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
    pass  # static dir may not exist yet in early bootstrap


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


@app.get("/api/risk/evaluate")
async def evaluate_risk_demo(
    symbol: str = "BTCUSDT",
    side: str = "buy",
    qty: float = 0.01,
    environment: str = "paper",
    equity: float = 10000.0,
):
    """Demo endpoint to exercise the RiskEngine."""
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
