"""Internal paper exchange API. No exchange credentials, no real money; every reply states INTERNAL_PAPER."""
from __future__ import annotations

import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.paper import mode as M
from app.paper.runtime import get_exchange, get_tick_job, shape_result
from app.security.auth import require_api_key

logger = logging.getLogger("eti.api.paper")
router = APIRouter(prefix="/api/paper", tags=["internal-paper"])

_SYM = r"^[A-Za-z0-9._/-]{1,32}$"
_LABEL = M.LABELS[M.INTERNAL_PAPER]


class PaperOrderIn(BaseModel):
    symbol: str = Field(..., pattern=_SYM)
    side: Literal["buy", "sell"]
    type: Literal["market", "limit", "stop", "take_profit"] = "market"
    qty: float = Field(..., gt=0, allow_inf_nan=False)
    limit_price: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)
    trigger_price: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)
    time_in_force: Optional[Literal["gtc", "ioc"]] = None
    client_order_id: Optional[str] = Field(default=None, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")
    expire_seconds: Optional[float] = Field(default=None, gt=0, le=7 * 86400, allow_inf_nan=False)
    strategy: str = Field(default="manual", max_length=40)
    thesis: Optional[str] = Field(default=None, max_length=2000)

    def engine_kwargs(self) -> dict:
        return {"symbol": self.symbol, "side": self.side, "qty": self.qty, "order_type": self.type, "limit_price": self.limit_price,
                "trigger_price": self.trigger_price, "tif": self.time_in_force, "client_order_id": self.client_order_id,
                "expire_seconds": self.expire_seconds, "strategy": self.strategy, "thesis": self.thesis}


class OcoIn(BaseModel):
    symbol: str = Field(..., pattern=_SYM)
    qty: float = Field(..., gt=0, allow_inf_nan=False)
    stop_price: float = Field(..., gt=0, allow_inf_nan=False)
    take_profit_price: float = Field(..., gt=0, allow_inf_nan=False)
    client_order_id: Optional[str] = Field(default=None, max_length=48, pattern=r"^[A-Za-z0-9_-]+$")
    thesis: Optional[str] = Field(default=None, max_length=2000)


class ResetIn(BaseModel):
    confirm: Literal["RESET"]
    starting_cash: Optional[float] = Field(default=None, gt=0, le=1e9, allow_inf_nan=False)


@router.get("/status")
async def status(settings: Settings = Depends(get_settings)):
    ex = get_exchange(); cfg = ex.cfg
    return {
        "default_mode": M.INTERNAL_PAPER, "labels": M.LABELS,
        "modes": {
            M.INTERNAL_PAPER: {"available": True, "needs_credentials": False},
            M.EXCHANGE_TESTNET: {"available": bool(settings.binance_configured or settings.alpaca_configured), "needs_credentials": True,
                                 "binance": bool(settings.binance_configured), "alpaca": bool(settings.alpaca_configured)},
            M.EXCHANGE_LIVE: {"available": False, "reason": "live trading is not reachable from the internal paper engine; it stays disabled unless explicitly enabled and risk-gated elsewhere",
                              "live_trading_enabled": bool(settings.live_trading_enabled)},
        },
        "kill_switch": bool(settings.kill_switch), "tick_job": get_tick_job().status(),
        "simulation": {"taker_fee_bps": cfg.taker_fee_bps, "maker_fee_bps": cfg.maker_fee_bps, "base_slippage_bps": cfg.base_slippage_bps,
                       "participation": cfg.participation, "max_quote_age_s": cfg.max_quote_age_s, "max_spread_bps": cfg.max_spread_bps,
                       "max_order_pct": cfg.max_order_pct, "max_position_pct": cfg.max_position_pct, "max_open_positions": cfg.max_open_positions,
                       "min_notional": cfg.min_notional, "starting_cash": cfg.starting_cash},
    }


@router.get("/account")
async def account(tick: bool = True):
    return await get_exchange().account(tick=tick)


@router.get("/positions")
async def positions():
    a = await get_exchange().account()
    return {"execution_mode": "INTERNAL_PAPER", "positions": [p for p in a["positions"] if p["open"]]}


@router.get("/orders")
async def orders(status: Literal["all", "open", "closed"] = "all"):
    return {"execution_mode": "INTERNAL_PAPER", "orders": await get_exchange().orders(status)}


@router.get("/fills")
async def fills(limit: int = Query(100, ge=1, le=1000)):
    return {"execution_mode": "INTERNAL_PAPER", "fills": await get_exchange().fills(limit)}


@router.get("/audit")
async def audit(limit: int = Query(100, ge=1, le=1000)):
    return {"execution_mode": "INTERNAL_PAPER", "events": await get_exchange().audit(limit)}


@router.post("/orders/preview")
async def preview(body: PaperOrderIn):
    kw = body.engine_kwargs(); kw.pop("client_order_id", None)
    return {"execution_mode": "INTERNAL_PAPER", "mode_label": _LABEL, **await get_exchange().preview(**kw)}


@router.post("/orders")
async def submit(body: PaperOrderIn, _auth=Depends(require_api_key)):
    try:
        res = await get_exchange().submit(**body.engine_kwargs())
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return shape_result(res, _LABEL)


@router.post("/orders/oco")
async def submit_oco(body: OcoIn, _auth=Depends(require_api_key)):
    res = await get_exchange().submit_oco(symbol=body.symbol, qty=body.qty, stop_price=body.stop_price, take_profit_price=body.take_profit_price,
                                           client_order_id=body.client_order_id, thesis=body.thesis)
    return {"execution_mode": "INTERNAL_PAPER", "mode_label": _LABEL, **res}


@router.post("/orders/{order_id}/cancel")
async def cancel(order_id: str, _auth=Depends(require_api_key)):
    if not order_id.startswith("ord-") or len(order_id) > 20:
        raise HTTPException(status_code=422, detail="invalid order id")
    res = await get_exchange().cancel(order_id)
    if not res["ok"] and res["reason"] == "unknown_order":
        raise HTTPException(status_code=404, detail="unknown order")
    return {"execution_mode": "INTERNAL_PAPER", **res}


@router.post("/orders/cancel-all")
async def cancel_all(symbol: Optional[str] = Query(default=None, pattern=_SYM), _auth=Depends(require_api_key)):
    return {"execution_mode": "INTERNAL_PAPER", **await get_exchange().cancel_all(symbol)}


@router.post("/account/reset")
async def reset(body: ResetIn, _auth=Depends(require_api_key)):
    return {"execution_mode": "INTERNAL_PAPER", **await get_exchange().reset(body.starting_cash)}


@router.post("/tick")
async def tick(_auth=Depends(require_api_key)):
    return {"execution_mode": "INTERNAL_PAPER", **await get_exchange().tick()}
