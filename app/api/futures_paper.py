"""Futures paper-simulation API. Simulation only: nothing here reaches an exchange account. X-API-Key required."""
from __future__ import annotations

from decimal import Decimal
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.futures import paper
from app.futures.models import FuturesAccount, FuturesEvent, FuturesPosition
from app.security.auth import require_api_key

router = APIRouter(prefix="/api/futures-paper", tags=["futures-paper"], dependencies=[Depends(require_api_key)])

ID = r"^[A-Za-z0-9_.-]{1,64}$"


class _S(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AccountIn(_S):
    account_id: str = Field(..., pattern=ID)
    starting_balance: Decimal = Field(..., gt=0, le=10_000_000)


class OrderIn(_S):
    symbol: str = Field(..., pattern=r"^[A-Za-z0-9]{3,20}$")
    direction: Literal["long", "short"]
    capital_usdt: Decimal = Field(..., gt=0, description="USDT of the account to commit as margin; notional = capital x leverage")
    leverage: int = Field(..., ge=1, le=150)
    stop_price: Optional[Decimal] = Field(None, gt=0)
    take_profit_price: Optional[Decimal] = Field(None, gt=0)


def _call_error(exc: Exception):
    if isinstance(exc, paper.PaperError):
        detail = {"message": exc.message, "violations": exc.violations} if exc.violations else exc.message
        return HTTPException(status_code=exc.status, detail=detail)
    if isinstance(exc, paper.FeedError):
        return HTTPException(status_code=exc.status, detail=exc.message)
    raise exc


@router.post("/accounts", status_code=201)
async def create_account(body: AccountIn, db: Session = Depends(get_db)):
    try:
        acct = paper.create_account(db, body.account_id, body.starting_balance)
    except paper.PaperError as exc:
        raise _call_error(exc)
    return paper.account_summary(db, acct)


@router.get("/accounts")
async def list_accounts(db: Session = Depends(get_db)):
    return [{"account_id": a.account_id, "currency": a.currency, "wallet_balance": a.wallet_balance, "simulated": True}
            for a in db.scalars(select(FuturesAccount).order_by(FuturesAccount.created_at))]


@router.get("/accounts/{account_id}")
async def get_account(account_id: str, db: Session = Depends(get_db)):
    try:
        acct = paper._get_account(db, account_id)
    except paper.PaperError as exc:
        raise _call_error(exc)
    symbols = [p.symbol for p in paper._open_positions(db, account_id)]
    prices = await paper.current_prices(symbols)
    return paper.account_summary(db, acct, prices)


@router.post("/accounts/{account_id}/orders")
async def place_order(account_id: str, body: OrderIn, db: Session = Depends(get_db)):
    try:
        return await paper.open_position(db, account_id, body.symbol, body.direction, body.capital_usdt, body.leverage,
                                         body.stop_price, body.take_profit_price, kill_switch=get_settings().kill_switch)
    except (paper.PaperError, paper.FeedError) as exc:
        raise _call_error(exc)


@router.post("/accounts/{account_id}/positions/{symbol}/close")
async def close(account_id: str, symbol: str, db: Session = Depends(get_db)):
    try:
        return await paper.close_position(db, account_id, symbol)
    except (paper.PaperError, paper.FeedError) as exc:
        raise _call_error(exc)


@router.post("/accounts/{account_id}/mark")
async def mark(account_id: str, db: Session = Depends(get_db)):
    """Re-price open positions now: charges funding and triggers stops / take-profits / liquidations."""
    try:
        return await paper.mark_account(db, account_id)
    except (paper.PaperError, paper.FeedError) as exc:
        raise _call_error(exc)


@router.get("/accounts/{account_id}/positions")
async def positions(account_id: str, status: Literal["open", "closed", "all"] = "all", limit: int = Query(100, ge=1, le=500),
                    db: Session = Depends(get_db)):
    try:
        paper._get_account(db, account_id)
    except paper.PaperError as exc:
        raise _call_error(exc)
    q = select(FuturesPosition).where(FuturesPosition.account_id == account_id)
    if status == "open":
        q = q.where(FuturesPosition.status == "open")
    elif status == "closed":
        q = q.where(FuturesPosition.status != "open")
    return [paper.position_dict(p) for p in db.scalars(q.order_by(FuturesPosition.id.desc()).limit(limit))]


@router.get("/accounts/{account_id}/events")
async def events(account_id: str, limit: int = Query(200, ge=1, le=1000), db: Session = Depends(get_db)):
    try:
        paper._get_account(db, account_id)
    except paper.PaperError as exc:
        raise _call_error(exc)
    rows = db.scalars(select(FuturesEvent).where(FuturesEvent.account_id == account_id).order_by(FuturesEvent.id.desc()).limit(limit))
    return [{"id": e.id, "ts": e.ts.isoformat(), "event": e.event, "position_id": e.position_id, "detail": e.detail} for e in rows]
