"""ETI wallet REST API (/api/chain). Every route needs the ETI API key when the server enforces one; secrets never leave
the server (there is no endpoint that returns or exports key material)."""
from __future__ import annotations

import functools
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.chain.models import ChainEvent
from app.chain.networks import NETWORKS, chain_enabled, load_limits, rpc_url
from app.chain.policy import fmt_units
from app.chain.service import ChainError, ChainService
from app.config import Settings, get_settings
from app.database import get_db
from app.security.auth import require_api_key


def _enabled() -> None:
    if not chain_enabled():
        raise HTTPException(status_code=503, detail="On-chain wallet is disabled (CHAIN_ENABLED=false)")


router = APIRouter(prefix="/api/chain", tags=["chain-wallet"], dependencies=[Depends(require_api_key), Depends(_enabled)])
ADDR, AMT = r"^0x[0-9a-fA-F]{40}$", r"^\d{1,30}(\.\d{1,18})?$"


def guarded(fn):
    @functools.wraps(fn)
    async def wrapper(*a, **k):
        try:
            return await fn(*a, **k)
        except ChainError as e:
            raise HTTPException(status_code=e.status, detail=e.message)
    return wrapper


class WalletIn(BaseModel):
    label: str = Field("ETI wallet", max_length=64)


class AllowIn(BaseModel):
    network: str = Field("*", max_length=24)
    address: str = Field(..., pattern=ADDR)
    kind: Literal["destination", "token", "watch"]
    label: Optional[str] = Field(None, max_length=64)
    symbol: Optional[str] = Field(None, max_length=16)
    decimals: Optional[int] = Field(None, ge=0, le=36)


class TransferIn(BaseModel):
    network: str = Field(..., max_length=24)
    to: str = Field(..., pattern=ADDR)
    amount: str = Field(..., pattern=AMT)


class SwapIn(BaseModel):
    network: str = Field(..., max_length=24)
    side: Literal["buy", "sell"]
    token: str = Field(..., pattern=ADDR)
    amount: str = Field(..., pattern=AMT)
    slippage_bps: int = Field(50, ge=1, le=1000)


class ApproveIn(BaseModel):
    network: str = Field(..., max_length=24)
    token: str = Field(..., pattern=ADDR)
    amount: str = Field(..., pattern=AMT)


class SendIn(BaseModel):
    quote_id: str = Field(..., max_length=4000)
    confirm: str = Field(..., max_length=8)


@router.get("/networks")
async def networks() -> dict[str, Any]:
    lim = load_limits()
    return {"networks": [{"key": n.key, "label": n.label, "chain_id": n.chain_id, "native": n.native, "mainnet": n.mainnet,
                          "configured": bool(rpc_url(n.key))} for n in NETWORKS.values()],
            "limits": {"max_tx": fmt_units(lim.max_tx_wei), "max_daily": fmt_units(lim.max_daily_wei), "max_slippage_bps": lim.max_slippage_bps,
                       "require_allowlist": lim.require_allowlist, "mainnet_send_enabled": lim.mainnet_send_enabled}}


@router.get("/status")
@guarded
async def status(db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    import asyncio
    svc = ChainService(db, settings)
    w = svc.wallet()
    nets = await asyncio.gather(*[svc.network_status(n) for n in NETWORKS.values() if rpc_url(n.key)])
    return {"wallet": svc.wallet_dict(w) if w else None, "kill_switch": bool(settings.kill_switch), "networks": nets}


@router.post("/wallet", status_code=201)
@guarded
async def create_wallet(body: WalletIn, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return ChainService.wallet_dict(ChainService(db, settings).create_wallet(body.label))


@router.get("/wallet")
@guarded
async def get_wallet(db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    w = ChainService(db, settings).wallet()
    return {"wallet": ChainService.wallet_dict(w) if w else None}


@router.get("/allowlist")
@guarded
async def allow_list(db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return {"entries": ChainService(db, settings).allow_list()}


@router.post("/allowlist", status_code=201)
@guarded
async def allow_add(body: AllowIn, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    r = ChainService(db, settings).allow_add(**body.model_dump())
    return {"id": r.id, "network": r.network, "address": r.address, "kind": r.kind, "label": r.label, "symbol": r.symbol, "decimals": r.decimals}


@router.delete("/allowlist/{entry_id}")
@guarded
async def allow_remove(entry_id: int, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    ChainService(db, settings).allow_remove(entry_id)
    return {"removed": entry_id}


@router.get("/tokens")
@guarded
async def tokens(network: str = Query(..., max_length=24), db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    svc = ChainService(db, settings)
    return {"balances": await svc.token_balances(svc._net(network))}


@router.post("/transfer/preview")
@guarded
async def transfer_preview(body: TransferIn, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return await ChainService(db, settings).preview_transfer(body.network, body.to, body.amount)


@router.post("/swap/preview")
@guarded
async def swap_preview(body: SwapIn, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return await ChainService(db, settings).preview_swap(body.network, body.side, body.token, body.amount, body.slippage_bps)


@router.post("/approve/preview")
@guarded
async def approve_preview(body: ApproveIn, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return await ChainService(db, settings).preview_approval(body.network, body.token, body.amount)


@router.post("/send")
@guarded
async def send(body: SendIn, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return {"transaction": await ChainService(db, settings).send(body.quote_id, body.confirm),
            "note": "Broadcast accepted by the node. It is not confirmed until a receipt says so (refresh the transaction)."}


@router.get("/txs")
@guarded
async def txs(limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return {"transactions": ChainService(db, settings).txs(limit)}


@router.post("/txs/refresh")
@guarded
async def txs_refresh(db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return {"transactions": await ChainService(db, settings).refresh_pending()}


@router.post("/txs/{tx_id}/refresh")
@guarded
async def tx_refresh(tx_id: int, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return {"transaction": await ChainService(db, settings).refresh_tx(tx_id)}


@router.get("/events")
@guarded
async def events(limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db)) -> dict[str, Any]:
    rows = db.execute(select(ChainEvent).order_by(ChainEvent.id.desc()).limit(limit)).scalars().all()
    return {"events": [{"ts": r.ts.isoformat() + "Z", "event": r.event, "network": r.network, "tx_hash": r.tx_hash, "detail": r.detail} for r in rows]}


@router.get("/intel/contract")
@guarded
async def intel_contract(network: str = Query(..., max_length=24), address: str = Query(..., pattern=ADDR), db: Session = Depends(get_db),
                         settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return await ChainService(db, settings).inspect_contract(network, address)


@router.get("/intel/blocks")
@guarded
async def intel_blocks(network: str = Query(..., max_length=24), count: int = Query(5, ge=1, le=20), threshold: str = Query("10", pattern=AMT),
                       db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return await ChainService(db, settings).scan_blocks(network, count, threshold)
