"""Execution engine API. Every route requires X-API-Key; nothing here ever returns credentials."""
from __future__ import annotations

import re
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from app.config import Settings, get_settings
from app.execution.adapters.registry import INFO
from app.execution.domain import AccountPolicy, Mode, OrderIntent, OrderType, Side, utcnow
from app.execution.errors import ExecutionError, PermissionPolicyError
from app.execution.service import (REQUIRED_CREDENTIALS, SUPPORTED_ENVIRONMENTS, adapter_for, get_engine, get_store,
                                   get_vault, vault_configured)
from app.execution.store import AccountRecord
from app.execution.vault import CredentialVault, VaultError
from app.security.auth import require_api_key

router = APIRouter(prefix="/api/execution", tags=["execution"], dependencies=[Depends(require_api_key)])

ID = r"^[A-Za-z0-9_.-]{1,64}$"


def operator(x_operator: Optional[str] = Header(default=None)) -> str:
    return (x_operator or "operator")[:64]


def _public(a: AccountRecord) -> dict:
    return {"account_id": a.account_id, "provider": a.provider, "environment": a.environment, "label": a.label,
            "policy": a.policy.to_dict(), "halted": a.halted, "halted_reason": a.halted_reason,
            "has_credentials": bool(a.credentials_ciphertext), "created_at": a.created_at.isoformat()}


def _account(account_id: str) -> AccountRecord:
    a = get_store().get_account(account_id)
    if a is None:
        raise HTTPException(404, "Unknown account")
    return a


class CredentialsBody(BaseModel):
    credentials: dict = Field(..., description="Provider keys. Never include withdrawal-capable keys.")

    @field_validator("credentials")
    @classmethod
    def _strings(cls, v):
        if not v or not all(isinstance(x, str) and x.strip() for x in v.values()):
            raise ValueError("credentials must be non-empty strings")
        return v


class AccountCreate(CredentialsBody):
    account_id: str = Field(..., pattern=ID)
    provider: Literal["alpaca", "binance", "oanda"]
    environment: Literal["paper", "live"] = "paper"
    label: str = Field("", max_length=128)


class PolicyBody(BaseModel):
    """Everything the user approves for one account. Defaults are restrictive; autonomous flag is NOT settable here."""
    mode: Mode = Mode.INTELLIGENCE_ONLY
    allowed_symbols: list[str] = Field(default_factory=list, max_length=200)
    allowed_strategies: list[str] = Field(default_factory=list, max_length=50)
    max_order_notional: float = Field(0.0, ge=0, allow_inf_nan=False)
    max_total_notional: float = Field(0.0, ge=0, allow_inf_nan=False)
    max_daily_orders: int = Field(20, ge=1, le=10_000)
    max_quote_age_seconds: float = Field(5.0, gt=0, le=60)
    max_spread_bps: float = Field(25.0, gt=0, le=500)
    max_slippage_bps: float = Field(10.0, gt=0, le=200)
    min_depth_ratio: float = Field(1.5, ge=1.0, le=20)
    allow_shorting: bool = False
    duplicate_window_seconds: int = Field(30, ge=1, le=3600)
    order_ttl_seconds: int = Field(60, ge=5, le=3600)
    proposal_ttl_seconds: int = Field(300, ge=10, le=86_400)
    reconcile_tolerance_pct: float = Field(0.25, ge=0, le=5)
    emergency_use_market: bool = True


class TakeProfit(BaseModel):
    price: float = Field(..., gt=0, allow_inf_nan=False)
    fraction: float = Field(..., gt=0, le=1, allow_inf_nan=False)


class SignalBody(BaseModel):
    account_id: str = Field(..., pattern=ID)
    symbol: str = Field(..., min_length=1, max_length=32, pattern=r"^[A-Za-z0-9./_-]+$")
    side: Side
    qty: float = Field(..., gt=0, allow_inf_nan=False)
    order_type: OrderType = OrderType.MARKET
    limit_price: Optional[float] = Field(None, gt=0, allow_inf_nan=False)
    strategy: str = Field("manual", max_length=64)
    thesis: Optional[str] = Field(None, max_length=2000)
    signal_id: Optional[str] = Field(None, max_length=96)
    reduce_only: bool = False
    stop_loss: Optional[float] = Field(None, gt=0, allow_inf_nan=False)
    take_profits: list[TakeProfit] = Field(default_factory=list, max_length=3)


class CloseBody(BaseModel):
    reason: str = Field(..., min_length=3, max_length=300)


class EmergencyBody(BaseModel):
    reason: str = Field(..., min_length=3, max_length=300)
    scope: Literal["eti_managed", "all"] = "eti_managed"
    confirm: str


@router.get("/providers")
async def providers():
    return [dict(name=i.name, asset_classes=i.asset_classes, supports_order_book=i.supports_order_book,
                 supports_short=i.supports_short, status=i.status, notes=i.notes) for i in INFO.values()
            if i.name != "paper"]


@router.get("/status")
async def status(settings: Settings = Depends(get_settings)):
    return {"enabled": settings.execution_enabled, "vault_configured": vault_configured(),
            "live_trading_enabled": settings.live_trading_enabled, "kill_switch": settings.kill_switch,
            **get_engine().status()}


@router.post("/accounts", status_code=201)
async def create_account(body: AccountCreate, who: str = Depends(operator)):
    missing = [k for k in REQUIRED_CREDENTIALS[body.provider] if k not in body.credentials]
    if missing:
        raise HTTPException(422, f"Missing credential fields: {', '.join(missing)}")
    if get_store().get_account(body.account_id):
        raise HTTPException(409, "Account already exists")
    try:
        sealed = get_vault().seal(body.credentials)
    except VaultError as e:
        raise HTTPException(503, str(e))
    rec = AccountRecord(body.account_id, body.provider, body.environment, body.label, AccountPolicy(),
                        credentials_ciphertext=sealed)
    get_store().save_account(rec)
    get_store().append_log(rec.account_id, "account_registered", details={"by": who, "provider": rec.provider,
                                                                          "environment": rec.environment,
                                                                          "credentials": CredentialVault.mask(body.credentials)})
    return _public(rec)


@router.get("/accounts")
async def list_accounts():
    return [_public(a) for a in get_store().list_accounts()]


@router.get("/accounts/{account_id}")
async def get_account(account_id: str):
    return _public(_account(account_id))


@router.put("/accounts/{account_id}/credentials")
async def rotate_credentials(account_id: str, body: CredentialsBody, who: str = Depends(operator)):
    a = _account(account_id)
    missing = [k for k in REQUIRED_CREDENTIALS[a.provider] if k not in body.credentials]
    if missing:
        raise HTTPException(422, f"Missing credential fields: {', '.join(missing)}")
    try:
        a.credentials_ciphertext = get_vault().seal(body.credentials)
    except VaultError as e:
        raise HTTPException(503, str(e))
    get_store().save_account(a)
    get_engine().drop_adapter(account_id)
    get_store().append_log(account_id, "credentials_rotated", details={"by": who})
    return _public(a)


@router.post("/accounts/{account_id}/verify")
async def verify_account(account_id: str):
    """Connectivity + permission check. Refuses withdrawal-capable keys where the venue exposes that flag."""
    a = _account(account_id)
    try:
        adapter = adapter_for(a)
        await adapter.verify_permissions()
        equity = await adapter.get_equity()
    except PermissionPolicyError as e:
        raise HTTPException(409, str(e))
    except (ExecutionError, VaultError) as e:
        raise HTTPException(502, f"Verification failed: {type(e).__name__}: {e}")
    return {"ok": True, "environment": adapter.environment, "equity": equity}


@router.put("/accounts/{account_id}/policy")
async def set_policy(account_id: str, body: PolicyBody, who: str = Depends(operator),
                     settings: Settings = Depends(get_settings)):
    a = _account(account_id)
    pol = AccountPolicy(**{**body.model_dump(), "mode": body.mode,
                           "allowed_symbols": [s.upper() for s in body.allowed_symbols]})
    pol.autonomous_enabled = False            # any policy change revokes autonomous authority; re-enable explicitly
    if pol.mode != Mode.INTELLIGENCE_ONLY:
        if a.environment == "live" and not settings.live_trading_enabled:
            raise HTTPException(409, "LIVE_TRADING_ENABLED is false; live accounts stay intelligence-only")
        try:                                  # must prove the connection and key permissions first
            adapter = adapter_for(a)
            await adapter.verify_permissions()
            await adapter.get_equity()
        except PermissionPolicyError as e:
            raise HTTPException(409, str(e))
        except (ExecutionError, VaultError) as e:
            raise HTTPException(502, f"Cannot enable execution: {type(e).__name__}: {e}")
    a.policy = pol
    get_store().save_account(a)
    get_store().append_log(account_id, "policy_updated", details={"by": who, "policy": pol.to_dict()})
    return _public(a)


@router.post("/accounts/{account_id}/autonomous/enable")
async def enable_autonomous(account_id: str, confirm: str = Query(...), who: str = Depends(operator)):
    a = _account(account_id)
    expected = f"ENABLE AUTONOMOUS TRADING ON {account_id}"
    if confirm != expected:
        raise HTTPException(422, f"confirm must equal: {expected}")
    p = a.policy
    if p.mode != Mode.AUTONOMOUS:
        raise HTTPException(409, "Set policy mode to 'autonomous' first")
    if not p.allowed_symbols or p.max_order_notional <= 0 or p.max_total_notional <= 0:
        raise HTTPException(422, "Approve instruments plus per-order and total capital limits before enabling")
    if a.halted:
        raise HTTPException(409, f"Account is halted: {a.halted_reason}")
    p.autonomous_enabled, p.autonomous_enabled_by, p.autonomous_enabled_at = True, who, utcnow().isoformat()
    get_store().save_account(a)
    get_store().append_log(account_id, "autonomous_enabled", details={"by": who, "policy": p.to_dict()})
    return _public(a)


@router.post("/accounts/{account_id}/autonomous/disable")
async def disable_autonomous(account_id: str, who: str = Depends(operator)):
    a = _account(account_id)
    a.policy.autonomous_enabled = False
    get_store().save_account(a)
    get_store().append_log(account_id, "autonomous_disabled", details={"by": who})
    return _public(a)


@router.post("/signals")
async def submit_signal(body: SignalBody, settings: Settings = Depends(get_settings)):
    if not settings.execution_enabled:
        raise HTTPException(503, "Execution engine is disabled (EXECUTION_ENABLED=false)")
    intent = OrderIntent(body.account_id, body.symbol, body.side, body.qty, body.order_type, body.limit_price,
                         body.strategy, body.thesis, body.signal_id, reduce_only=body.reduce_only)
    if body.stop_loss is not None or body.take_profits:
        if body.side != Side.BUY:
            raise HTTPException(422, "Protective stop-loss/take-profit orders are supported for long (buy) entries only")
        intent.meta["protective"] = {"stop_loss": body.stop_loss, "take_profits": [t.model_dump() for t in body.take_profits]}
    return (await get_engine().submit_signal(intent)).to_dict()


@router.get("/proposals")
async def proposals(account_id: Optional[str] = None, status: Optional[str] = None, limit: int = Query(50, ge=1, le=200)):
    return [p.to_dict() for p in get_store().list_proposals(account_id, status, limit)]


@router.post("/proposals/{proposal_id}/approve")
async def approve(proposal_id: str, who: str = Depends(operator), settings: Settings = Depends(get_settings)):
    if not settings.execution_enabled:
        raise HTTPException(503, "Execution engine is disabled (EXECUTION_ENABLED=false)")
    return (await get_engine().approve(proposal_id, who)).to_dict()


@router.post("/proposals/{proposal_id}/reject")
async def reject(proposal_id: str, who: str = Depends(operator)):
    if not get_engine().reject_proposal(proposal_id, who):
        raise HTTPException(409, "Proposal is not pending")
    return {"status": "rejected"}


@router.get("/orders")
async def orders(account_id: Optional[str] = None, limit: int = Query(100, ge=1, le=500)):
    return [o.to_dict() for o in get_store().list_orders(account_id, limit=limit)]


@router.get("/logs")
async def logs(account_id: Optional[str] = None, event: Optional[str] = None, limit: int = Query(200, ge=1, le=1000)):
    return [{**l, "ts": l["ts"].isoformat()} for l in get_store().list_logs(account_id, event, limit)]


@router.post("/accounts/{account_id}/halt")
async def halt(account_id: str, reason: str = Query("manual halt", max_length=300), who: str = Depends(operator)):
    _account(account_id)
    await get_engine().halt(account_id, reason, who)
    return {"halted": True}


@router.post("/accounts/{account_id}/resume")
async def resume(account_id: str, who: str = Depends(operator)):
    _account(account_id)
    await get_engine().clear_halt(account_id, who)
    return {"halted": False}


@router.post("/accounts/{account_id}/emergency-flatten")
async def emergency(account_id: str, body: EmergencyBody, who: str = Depends(operator)):
    _account(account_id)
    if body.confirm != f"FLATTEN {account_id}":
        raise HTTPException(422, f"confirm must equal: FLATTEN {account_id}")
    return await get_engine().emergency_flatten(account_id, body.reason, who, body.scope)


@router.get("/accounts/{account_id}/managed-positions")
async def managed_positions(account_id: str):
    _account(account_id)
    return {"account_id": account_id, "positions": get_engine().managed_positions(account_id)}


@router.post("/accounts/{account_id}/positions/{symbol}/close")
async def close_position(account_id: str, symbol: str, body: CloseBody, x_operator: Optional[str] = Header(default=None)):
    """Reduce-only close of an ETI-managed position whose thesis was invalidated. Cannot open or increase exposure."""
    _account(account_id)
    if not re.fullmatch(r"[A-Za-z0-9]{3,20}", symbol):
        raise HTTPException(422, "invalid symbol")
    return await get_engine().close_position(account_id, symbol, body.reason, x_operator or "api")


@router.post("/accounts/{account_id}/reconcile")
async def reconcile(account_id: str):
    _account(account_id)
    return await get_engine().reconcile_positions(account_id)


@router.post("/accounts/{account_id}/accept-broker-positions")
async def accept_positions(account_id: str, who: str = Depends(operator)):
    _account(account_id)
    return await get_engine().accept_broker_positions(account_id, who)


@router.post("/supervise")
async def supervise():
    return await get_engine().supervise_once()
