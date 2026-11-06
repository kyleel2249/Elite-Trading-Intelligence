"""Backtest & strategy runner API."""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import get_settings, Settings
from app.database import get_db
from app.backtest.runner import StrategyRunner
from app.security.auth import require_api_key

router = APIRouter(prefix="/api/backtest", tags=["backtest"])


class RunRequest(BaseModel):
    module_id: str = Field(..., examples=["turtle_trend"])
    symbol: str = "BTCUSDT"
    provider: str = "binance"
    lookback: int = 20
    limit: int = 200
    walk_forward: bool = False


class ExecuteRequest(BaseModel):
    module_id: str
    symbol: str = "BTCUSDT"
    provider: str = "binance"
    environment: str = Field("paper", examples=["paper", "testnet", "live"])
    qty: float = 0.01
    equity: float = 10000.0
    execute: bool = False


@router.post("/run")
async def backtest_run(body: RunRequest, settings: Settings = Depends(get_settings)):
    runner = StrategyRunner(settings)
    try:
        return await runner.backtest_module(
            module_id=body.module_id,
            symbol=body.symbol,
            provider=body.provider,
            lookback=body.lookback,
            limit=body.limit,
            walk_forward_mode=body.walk_forward,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/signal")
async def strategy_signal(
    body: ExecuteRequest,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
    _auth: None = Depends(require_api_key),
):
    """Generate signal; set execute=true to send risk-gated paper/live order."""
    runner = StrategyRunner(settings, db=db)
    return await runner.signal_and_maybe_trade(
        module_id=body.module_id,
        symbol=body.symbol,
        provider=body.provider,
        environment=body.environment,
        qty=body.qty,
        equity=body.equity,
        execute=body.execute,
    )
