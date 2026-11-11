"""Internal paper-trading API. Works with no exchange credentials.

Authentication is automatic and server-side (see app/security/execution_auth.py): the dashboard gets an
HttpOnly session for INTERNAL PAPER with no manual token or key. Exchange-testnet orders additionally need
an operator-established session or the operator X-API-Key. Live is refused. Every order is authorized for
its exact environment and re-validated at the execution boundary. No exchange key is ever accepted here.
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.paper import wiring
from app.paper.core import OrderRequest, PaperError
from app.paper.modes import (EXCHANGE_TESTNET, INTERNAL_PAPER, LABELS, LIVE, LiveTradingDisabled, ModeResolution,
                             UnknownMode, resolve_mode)
from app.security.auth import require_api_key
from app.security.execution_auth import authorize, execution_gate

router = APIRouter(prefix="/api/paper", tags=["paper"])
ID = r"^[A-Za-z0-9_.-]{1,64}$"


def svc():
    return wiring.get_paper_service()


class OrderBody(BaseModel):
    account_id: str = Field("default", pattern=ID)
    symbol: str = Field(..., min_length=1, max_length=32, pattern=r"^[A-Za-z0-9./_-]+$")
    side: Literal["buy", "sell"]
    type: Literal["market", "limit", "stop_loss", "take_profit"] = "market"
    qty: float = Field(..., gt=0, allow_inf_nan=False)
    limit_price: Optional[float] = Field(None, gt=0, allow_inf_nan=False)
    stop_price: Optional[float] = Field(None, gt=0, allow_inf_nan=False)
    client_order_id: Optional[str] = Field(None, max_length=64, pattern=ID)
    mode: Optional[str] = Field(None, max_length=32, description="internal_paper (default) or exchange_testnet")
    provider: str = Field("binance", max_length=16)

    def to_request(self) -> OrderRequest:
        return OrderRequest(self.symbol, self.side, self.type, self.qty, self.limit_price, self.stop_price,
                            self.client_order_id)


class BracketBody(BaseModel):
    account_id: str = Field("default", pattern=ID)
    symbol: str = Field(..., min_length=1, max_length=32, pattern=r"^[A-Za-z0-9./_-]+$")
    qty: float = Field(..., gt=0, allow_inf_nan=False)
    stop_price: float = Field(..., gt=0, allow_inf_nan=False)
    take_profit_price: float = Field(..., gt=0, allow_inf_nan=False)
    client_order_id: Optional[str] = Field(None, max_length=48, pattern=ID)


class ConfirmBody(BaseModel):
    account_id: str = Field("default", pattern=ID)
    confirm: str
    starting_cash: Optional[float] = Field(None, gt=0, allow_inf_nan=False)


def _testnet_account(provider: str, settings: Settings):
    """A registered execution account on an exchange sandbox (credentials supplied by the user), or None."""
    if not settings.execution_enabled:
        return None
    try:
        from app.execution.domain import Mode
        from app.execution.service import get_store
        for a in get_store().list_accounts():
            if (a.provider == provider and a.environment == "paper" and a.credentials_ciphertext
                    and a.policy.mode != Mode.INTELLIGENCE_ONLY):
                return a
    except Exception:
        return None
    return None


def _resolve(mode: Optional[str], provider: str, settings: Settings) -> tuple:
    acct = _testnet_account(provider, settings)
    env_creds = bool((provider == "binance" and settings.binance_configured) or
                     (provider == "alpaca" and settings.alpaca_configured))
    try:
        return resolve_mode(mode, testnet_account_available=acct is not None, provider=provider,
                            env_credentials_present=env_creds), acct
    except LiveTradingDisabled as e:
        raise HTTPException(403, {"error": str(e), "mode": LIVE, "label": LABELS[LIVE]})
    except UnknownMode as e:
        raise HTTPException(422, str(e))


def _reject(e: PaperError, res: ModeResolution):
    raise HTTPException(422, {"error": str(e), **res.to_dict()})


@router.get("/mode")
async def mode(settings: Settings = Depends(get_settings)):
    acct = _testnet_account("binance", settings)
    return {
        "active_default": INTERNAL_PAPER, "labels": LABELS,
        "internal_paper": {"available": True, "needs_credentials": False,
                           "market_data": "Binance public order books (no API key); crypto spot symbols such as BTCUSDT"},
        "exchange_testnet": {"available": acct is not None,
                             "how_to_enable": None if acct else
                             "Provide Binance testnet credentials as server secrets (BINANCE_TESTNET_API_KEY / "
                             "BINANCE_TESTNET_SECRET_KEY) with EXECUTION_ENABLED=true, then approve an execution policy. "
                             "Without them ETI uses INTERNAL PAPER and says so."},
        "live": {"available": False, "reason": "Live trading is disabled in this path and is never a fallback.",
                 "live_trading_enabled_flag": settings.live_trading_enabled},
        "kill_switch": settings.kill_switch,
    }


@router.get("/account")
async def account(account_id: str = Query("default", pattern=ID)):
    s = await svc().ensure_account(account_id)
    return {**s, "mode": INTERNAL_PAPER, "label": LABELS[INTERNAL_PAPER]}


@router.get("/quote")
async def quote(symbol: str = Query(..., min_length=1, max_length=32)):
    try:
        return await svc().quote(symbol)
    except PaperError as e:
        raise HTTPException(422, str(e))


@router.post("/preview")
async def preview(body: OrderBody, settings: Settings = Depends(get_settings)):
    res, _ = _resolve(body.mode, body.provider, settings)
    if res.mode == EXCHANGE_TESTNET:
        raise HTTPException(422, "Order preview is available for INTERNAL PAPER only")
    try:
        p = await svc().preview(body.account_id, body.to_request())
    except PaperError as e:
        _reject(e, res)
    return {**res.to_dict(), "preview": p}


@router.post("/orders")
async def place_order(body: OrderBody, request: Request, response: Response, settings: Settings = Depends(get_settings)):
    res, acct = _resolve(body.mode, body.provider, settings)
    # 1) authenticate for the environment this order will really run in (a testnet request that fell
    #    back to INTERNAL PAPER is authorized, and executed, as INTERNAL PAPER).
    principal = await authorize(request, response, res.mode)
    # 2) re-validate at the execution boundary, bound to this exact order
    execution_gate(principal, res.mode, {**body.model_dump(), "resolved_mode": res.mode})
    if res.mode == EXCHANGE_TESTNET:
        if body.type not in ("market", "limit"):
            raise HTTPException(422, "Exchange testnet mode supports market and limit orders only; "
                                     "use INTERNAL PAPER for stop-loss/take-profit")
        from app.execution.domain import OrderIntent, OrderType, Side
        from app.execution.service import get_engine
        intent = OrderIntent(acct.account_id, body.symbol, Side(body.side), body.qty, OrderType(body.type),
                             body.limit_price, "dashboard", signal_id=body.client_order_id)
        result = await get_engine().submit_signal(intent)
        return {**res.to_dict(), "result": result.to_dict(), "exchange_account": acct.account_id}
    try:
        order = await svc().submit(body.account_id, body.to_request())
    except PaperError as e:
        _reject(e, res)
    return {**res.to_dict(), "order": order.to_dict(), "account": await svc().summary(body.account_id)}


@router.post("/orders/bracket")
async def place_bracket(body: BracketBody, request: Request, response: Response):
    res = ModeResolution(INTERNAL_PAPER, "internal_paper", False, "Simulated by ETI; no exchange credentials are used.")
    principal = await authorize(request, response, INTERNAL_PAPER)
    execution_gate(principal, INTERNAL_PAPER, {**body.model_dump(), "op": "bracket"})
    try:
        orders = await svc().submit_bracket(body.account_id, body.symbol, body.qty, body.stop_price,
                                            body.take_profit_price, body.client_order_id)
    except PaperError as e:
        _reject(e, res)
    return {**res.to_dict(), "orders": [o.to_dict() for o in orders]}


@router.delete("/orders/{order_id}")
async def cancel_order(order_id: str, request: Request, response: Response, account_id: str = Query("default", pattern=ID)):
    principal = await authorize(request, response, INTERNAL_PAPER)
    execution_gate(principal, INTERNAL_PAPER, {"op": "cancel", "order_id": order_id, "account_id": account_id})
    try:
        o = await svc().cancel(account_id, order_id)
    except PaperError as e:
        raise HTTPException(409, str(e))
    return {"order": o.to_dict()}


@router.post("/orders/cancel-all")
async def cancel_all(request: Request, response: Response, account_id: str = Query("default", pattern=ID)):
    principal = await authorize(request, response, INTERNAL_PAPER)
    execution_gate(principal, INTERNAL_PAPER, {"op": "cancel_all", "account_id": account_id})
    return {"canceled": await svc().cancel_all(account_id)}


@router.get("/orders")
async def orders(account_id: str = Query("default", pattern=ID), status: Literal["all", "open", "closed"] = "all",
                 limit: int = Query(100, ge=1, le=500)):
    return {"mode": INTERNAL_PAPER, "orders": svc().orders(account_id, status, limit)}


@router.get("/fills")
async def fills(account_id: str = Query("default", pattern=ID), limit: int = Query(100, ge=1, le=500)):
    return {"mode": INTERNAL_PAPER, "fills": svc().fills(account_id, limit)}


@router.get("/events")
async def events(account_id: str = Query("default", pattern=ID), event: Optional[str] = None,
                 limit: int = Query(100, ge=1, le=500)):
    return {"events": svc().events(account_id, limit, event)}


@router.post("/tick")
async def tick(request: Request, response: Response, account_id: str = Query("default", pattern=ID)):
    principal = await authorize(request, response, INTERNAL_PAPER)
    execution_gate(principal, INTERNAL_PAPER, {"op": "tick", "account_id": account_id})
    return await svc().tick(account_id)


@router.post("/flatten")
async def flatten(body: ConfirmBody, request: Request, response: Response):
    """Safety control (reduces exposure), so a paper session may use it; the typed confirmation still applies."""
    principal = await authorize(request, response, INTERNAL_PAPER)
    if body.confirm != f"FLATTEN {body.account_id}":
        raise HTTPException(422, f"confirm must equal: FLATTEN {body.account_id}")
    execution_gate(principal, INTERNAL_PAPER, {"op": "flatten", "account_id": body.account_id})
    return await svc().flatten(body.account_id)


@router.post("/reset")
async def reset(body: ConfirmBody, _auth=Depends(require_api_key)):
    """Destructive (wipes history): stays operator-only, it is not a paper-session action."""
    if body.confirm != f"RESET {body.account_id}":
        raise HTTPException(422, f"confirm must equal: RESET {body.account_id}")
    return await svc().reset(body.account_id, body.starting_cash)
