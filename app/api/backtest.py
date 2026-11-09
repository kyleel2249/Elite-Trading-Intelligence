"""Backtest & strategy runner API.

Every successful backtest is remembered (``eti_backtests``) with its train/validation partition and a
leakage audit. A single-window run is in-sample by definition and is never eligible as validation
evidence; a walk-forward run uses fixed parameters on later folds and is recorded as validation.
"""
import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.config import get_settings, Settings
from app.database import get_db
from app.backtest.runner import StrategyRunner
from app.security.auth import require_api_key

logger = logging.getLogger("eti.api.backtest")

router = APIRouter(prefix="/api/backtest", tags=["backtest"])


class RunRequest(BaseModel):
    module_id: str = Field(..., examples=["turtle_trend"])
    symbol: str = "BTCUSDT"
    provider: str = "binance"
    lookback: int = 20
    limit: int = 200
    walk_forward: bool = False
    strategy_version: Optional[int] = Field(
        default=None, ge=1,
        description="Run with this stored strategy version's lookback and attribute the result to it.",
    )


class ExecuteRequest(BaseModel):
    module_id: str
    symbol: str = "BTCUSDT"
    provider: str = "binance"
    environment: str = Field("paper", examples=["paper", "testnet", "live"])
    qty: float = Field(0.01, gt=0, allow_inf_nan=False)
    equity: Optional[float] = Field(
        default=None,
        description="Deprecated and ignored. Equity is derived server-side from the portfolio.",
    )
    execute: bool = False


def _remember_backtest(db: Session, body: RunRequest, lookback: int, version: Optional[int], result: dict[str, Any]) -> dict[str, Any]:
    """Best-effort persistence; a memory failure never fails the backtest response."""
    try:
        from app.memory.backtests import BacktestMemoryService, normalize_result

        norm = normalize_result(result)
        bars = norm["bars"]
        params = {
            "lookback": lookback, "limit": body.limit, "fee_bps": 5.0,
            "applied_params": ["lookback"], "note": "runner applies lookback only; other config keys are not used by the engine",
        }
        if body.walk_forward:
            row = BacktestMemoryService(db).record(
                strategy_id=body.module_id, symbol=body.symbol, provider=body.provider, result=result,
                partition="validation", strategy_version=version, interval="1h",
                training_range=(0, 80), evaluation_range=(80, bars), parameters_fitted=False,
                universe_source="unknown", fee_bps=5.0, params={**params, "train_bars": 80, "test_bars": 20},
            )
        else:
            row = BacktestMemoryService(db).record(
                strategy_id=body.module_id, symbol=body.symbol, provider=body.provider, result=result,
                partition="train", strategy_version=version, interval="1h", parameters_fitted=True,
                universe_source="unknown", fee_bps=5.0, params=params,
            )
        return {
            "run_id": row.run_id, "partition": row.partition, "validation_eligible": row.validation_eligible,
            "leakage_audit": row.leakage_audit,
        }
    except Exception:
        db.rollback()
        logger.warning("backtest memory record failed", exc_info=True)
        return {"error": "memory_record_failed"}


@router.post("/run")
async def backtest_run(
    body: RunRequest,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
):
    lookback = body.lookback
    version: Optional[int] = None
    if body.strategy_version is not None:
        from app.memory.versions import StrategyVersionService

        v = StrategyVersionService(db, settings).get(body.module_id, body.strategy_version)
        if v is None:
            raise HTTPException(status_code=404, detail="strategy version not found")
        lookback = int((v.config or {}).get("lookback", lookback))
        version = v.version
    runner = StrategyRunner(settings)
    try:
        result = await runner.backtest_module(
            module_id=body.module_id,
            symbol=body.symbol,
            provider=body.provider,
            lookback=lookback,
            limit=body.limit,
            walk_forward_mode=body.walk_forward,
        )
    except Exception:
        logger.warning("backtest run failed", exc_info=True)
        raise HTTPException(status_code=400, detail="Backtest could not be completed for the given inputs")
    if isinstance(result, dict) and "error" not in result:
        result["memory"] = _remember_backtest(db, body, lookback, version, result)
    return result


@router.post("/signal")
async def strategy_signal(
    body: ExecuteRequest,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
    _auth: None = Depends(require_api_key),
):
    """Generate signal; set execute=true to send risk-gated paper/live order."""
    if body.execute and body.environment.lower() == "live" and not settings.api_key:
        raise HTTPException(status_code=403, detail="Live execution requires API_KEY to be configured")
    runner = StrategyRunner(settings, db=db)
    return await runner.signal_and_maybe_trade(
        module_id=body.module_id,
        symbol=body.symbol,
        provider=body.provider,
        environment=body.environment,
        qty=body.qty,
        execute=body.execute,
    )
