"""ETI FastAPI application entrypoint."""
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Depends, HTTPException
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from starlette.requests import Request

from app import __version__
from app.config import get_settings, Settings
from app.database import init_db, get_db
from app.schemas import HealthResponse
from app.risk.engine import RiskEngine, OrderProposal
from app.integrations.alpaca import AlpacaClient
from app.integrations.binance import BinanceClient
from app.trading.service import TradingService
from app.market.service import MarketService
from app.intelligence.council import TradingCouncil
from app.intelligence.traders import list_trader_profiles
from app.streaming.manager import stream_hub
from app.services.persistence import save_snapshot, save_council_decision, save_order
from app.models import CouncilDecisionRecord, OrderRecord, MarketSnapshot


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    # Start public Binance streams; Alpaca only if configured
    try:
        await stream_hub.start(["btcusdt", "ethusdt"])
    except Exception:
        # Non-fatal: REST paths still work
        pass
    yield
    await stream_hub.stop()


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
        "streams": stream_hub.status(),
    }


@app.get("/api/providers/binance/stream/status")
async def binance_stream_status():
    return stream_hub.binance.status()


@app.get("/api/providers/alpaca/stream/status")
async def alpaca_stream_status():
    return stream_hub.alpaca.status()


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


@app.get("/api/intelligence/traders")
async def intelligence_traders():
    """Named elite trader profiles and methodologies."""
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
        payload = {
            "action": decision.action.value,
            "confidence": decision.confidence,
            "summary": decision.summary,
            "risk_veto": decision.risk_veto,
            "risk_notes": decision.risk_notes,
            "risk_officer": decision.risk_officer,
            "contradictory_signals": decision.contradictory_signals,
            "data_quality": decision.data_quality,
            "methodology_notes": decision.methodology_notes,
            "timestamp": decision.timestamp,
            "specialists": [
                {
                    "trader_id": r.trader_id,
                    "trader_name": r.trader_name,
                    "role": r.role,
                    "bias": r.bias,
                    "confidence": r.confidence,
                    "analysis": r.analysis,
                    "evidence": r.evidence,
                    "methods_applied": r.methods_applied,
                    "limitations": r.limitations,
                }
                for r in decision.specialist_reports
            ],
        }
        if persist:
            save_council_decision(db, symbol, provider, payload)
            if snap.get("price") is not None:
                save_snapshot(db, snap)
        return payload
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/intelligence/decisions")
async def list_decisions(limit: int = 20, db: Session = Depends(get_db)):
    rows = (
        db.query(CouncilDecisionRecord)
        .order_by(CouncilDecisionRecord.created_at.desc())
        .limit(min(limit, 100))
        .all()
    )
    return [
        {
            "id": r.id,
            "symbol": r.symbol,
            "provider": r.provider,
            "action": r.action,
            "confidence": r.confidence,
            "summary": r.summary,
            "risk_veto": r.risk_veto,
            "data_quality": r.data_quality,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


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
async def place_order(
    req: OrderRequest,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
):
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
    # Persist attempt
    try:
        save_order(
            db,
            {
                **result,
                "provider": req.provider,
                "environment": req.environment,
                "symbol": req.symbol,
                "side": req.side,
                "qty": req.qty,
                "order_type": req.order_type,
                "limit_price": req.limit_price,
            },
        )
    except Exception:
        pass
    return result


@app.get("/api/paper-trading/history")
async def paper_history(limit: int = 50, db: Session = Depends(get_db)):
    rows = db.query(OrderRecord).order_by(OrderRecord.created_at.desc()).limit(min(limit, 200)).all()
    return [
        {
            "client_order_id": r.client_order_id,
            "provider": r.provider,
            "environment": r.environment,
            "symbol": r.symbol,
            "side": r.side,
            "qty": r.qty,
            "status": r.status,
            "risk_approved": r.risk_approved,
            "risk_notes": r.risk_notes,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]
