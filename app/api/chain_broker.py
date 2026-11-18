"""Broker-wallet API: funding verification, fee ledger and fee settlement. Needs the ETI API key when the server enforces one."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.chain import SendIn, _enabled, guarded
from app.chain.broker import BrokerService
from app.config import Settings, get_settings
from app.database import get_db
from app.security.auth import require_api_key

router = APIRouter(prefix="/api/chain/broker", tags=["chain-broker"], dependencies=[Depends(require_api_key), Depends(_enabled)])


class FundingIn(BaseModel):
    network: str = Field(..., max_length=24)
    tx_hash: str = Field(..., pattern=r"^0x[0-9a-fA-F]{64}$")


class SettleIn(BaseModel):
    network: str = Field(..., max_length=24)


@router.get("")
@guarded
async def broker_status(db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return await BrokerService(db, settings).status()


@router.get("/funding")
@guarded
async def funding_list(db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return {"funding": BrokerService(db, settings).funding_list()}


@router.post("/funding", status_code=201)
@guarded
async def record_funding(body: FundingIn, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return {"funding": await BrokerService(db, settings).record_funding(body.network, body.tx_hash)}


@router.get("/fees")
@guarded
async def fees(db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return BrokerService(db, settings).fees()


@router.post("/fees/settle/preview")
@guarded
async def settle_preview(body: SettleIn, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return await BrokerService(db, settings).preview_fee_settlement(body.network)


@router.post("/fees/settle/send")
@guarded
async def settle_send(body: SendIn, db: Session = Depends(get_db), settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    return await BrokerService(db, settings).send_fee_settlement(body.quote_id, body.confirm)
