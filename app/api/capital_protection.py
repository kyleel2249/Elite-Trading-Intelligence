"""ETI CAPITAL PROTECTION SYSTEM — API.

Two tiers of authority:
- ``X-API-Key`` (the general key an automation or agent may hold): read state, dry-run an order, run a sweep,
  evaluate or quarantine a strategy, latch a halt. These can only TIGHTEN protection.
- ``X-CPS-Admin-Key`` (separate secret held by a human operator): release a halt, register a strategy, run the
  review / revalidation workflow, refresh the news calendar. These are the only routes that can LOOSEN
  protection, and they are disabled unless CPS_ADMIN_KEY is configured and differs from API_KEY.
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.database import get_db
from app.risk.protection import OrderIntent, size_position
from app.risk.protection_service import CapitalProtectionService, authorize_admin
from app.risk.quarantine import HumanAuthorization, StrategyExpectations
from app.security.auth import require_api_key
from app.trading.protection_runner import run_protection_sweep

router = APIRouter(prefix="/api/capital-protection", tags=["capital-protection"])


async def require_admin(
    x_cps_admin_key: Optional[str] = Header(default=None),
    settings: Settings = Depends(get_settings),
) -> HumanAuthorization:
    if not (settings.cps_admin_key or "").strip():
        raise HTTPException(status_code=503, detail="CPS_ADMIN_KEY is not configured; releases are disabled")
    auth = authorize_admin(settings, x_cps_admin_key)
    if auth is None:
        raise HTTPException(status_code=403, detail="Invalid admin key (it must be set, >=16 chars and differ from API_KEY)")
    return auth


class OrderCheck(BaseModel):
    provider: Literal["alpaca", "binance"]
    environment: Literal["paper", "testnet", "live"]
    symbol: str = Field(min_length=1, max_length=32, pattern=r"^[A-Za-z0-9./_-]+$")
    side: Literal["buy", "sell"]
    quantity: float = Field(gt=0, allow_inf_nan=False)
    price: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)
    stop_loss: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)
    take_profit: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)
    strategy_id: Optional[str] = Field(default=None, max_length=128)
    atr_pct: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)

    def intent(self) -> OrderIntent:
        return OrderIntent(
            provider=self.provider, environment=self.environment, symbol=self.symbol.upper(), side=self.side,
            qty=self.quantity, price=self.price, stop_loss=self.stop_loss, take_profit=self.take_profit,
            strategy_id=self.strategy_id, atr_pct=self.atr_pct, source="api_dry_run",
        )


class ExpectationsBody(BaseModel):
    win_rate: float = Field(gt=0, lt=1)
    profit_factor: float = Field(gt=0, allow_inf_nan=False)
    expected_max_drawdown_pct: float = Field(ge=0, allow_inf_nan=False)
    max_drawdown_threshold_pct: float = Field(gt=0, le=50, allow_inf_nan=False)
    expected_slippage_bps: float = Field(default=2.0, ge=0, allow_inf_nan=False)
    max_slippage_bps: float = Field(default=25.0, gt=0, allow_inf_nan=False)
    max_reject_rate: float = Field(default=0.25, gt=0, le=1)
    validated_regimes: list[str] = Field(default_factory=list)
    validated_atr_pct_range: Optional[list[float]] = Field(default=None, min_length=2, max_length=2)
    validation_evidence: str = Field(min_length=5, max_length=2000)

    def to_expectations(self) -> StrategyExpectations:
        return StrategyExpectations.from_dict(self.model_dump())


class RegisterBody(BaseModel):
    strategy_id: str = Field(min_length=2, max_length=128, pattern=r"^[A-Za-z0-9._:-]+$")
    expectations: ExpectationsBody


class ReasonBody(BaseModel):
    reason: str = Field(min_length=5, max_length=500)


class RevalidationApproval(BaseModel):
    root_cause: str = Field(min_length=20, max_length=2000)
    notes: str = Field(min_length=20, max_length=4000)


class ResetBody(BaseModel):
    note: str = Field(min_length=10, max_length=2000)


class CalendarEvent(BaseModel):
    title: str = Field(min_length=1, max_length=256)
    at: str
    impact: Literal["high", "medium", "low"] = "high"
    scope: list[str] = Field(default_factory=lambda: ["*"])

    @field_validator("at")
    @classmethod
    def _iso(cls, v: str) -> str:
        from datetime import datetime

        datetime.fromisoformat(v.replace("Z", "+00:00"))
        return v


class CalendarBody(BaseModel):
    events: list[CalendarEvent] = Field(max_length=500)


def _svc(db: Session, settings: Settings) -> CapitalProtectionService:
    return CapitalProtectionService(db, settings)


# ----------------------------------------------------------------------------- read / tighten
@router.get("/status")
async def status(environment: Literal["paper", "testnet", "live"] = "paper",
                 settings: Settings = Depends(get_settings), db: Session = Depends(get_db)):
    return _svc(db, settings).status(environment)


@router.post("/evaluate")
async def evaluate(body: OrderCheck, settings: Settings = Depends(get_settings), db: Session = Depends(get_db),
                   _auth=Depends(require_api_key)):
    """Dry run: returns the verdict and the maximum permitted size. Never submits an order."""
    verdict = _svc(db, settings).check_order(body.intent())
    return {"submits_order": False, **verdict.to_dict()}


@router.post("/size")
async def size(body: OrderCheck, settings: Settings = Depends(get_settings), db: Session = Depends(get_db),
               _auth=Depends(require_api_key)):
    """Volatility-adjusted maximum quantity for a proposed entry (needs price and stop_loss)."""
    if body.price is None or body.stop_loss is None:
        raise HTTPException(status_code=422, detail="price and stop_loss are required for sizing")
    svc = _svc(db, settings)
    account = svc.build_account_snapshot(body.environment, persist_peak=False)
    return size_position(intent=body.intent(), price=body.price, account=account, policy=svc.policy)


@router.post("/sweep")
async def sweep(environment: Optional[Literal["paper", "testnet", "live"]] = None,
                settings: Settings = Depends(get_settings), db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    envs = (environment,) if environment else ("paper", "testnet", "live")
    return {"reports": await run_protection_sweep(db, settings, envs)}


@router.post("/halt")
async def halt(environment: Literal["paper", "testnet", "live"], body: ReasonBody,
               settings: Settings = Depends(get_settings), db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    """Latch a manual halt. Tightening is always allowed; only the admin key can release it."""
    svc = _svc(db, settings)
    svc.halt(environment, f"manual halt: {body.reason}", actor="api_key")
    return svc.halt_state(environment)


@router.get("/strategies")
async def strategies(settings: Settings = Depends(get_settings), db: Session = Depends(get_db)):
    svc = _svc(db, settings)
    return {"strategies": [svc.strategy_view(sid) for sid in svc.strategy_gate().statuses]}


@router.get("/strategies/{strategy_id}")
async def strategy(strategy_id: str, settings: Settings = Depends(get_settings), db: Session = Depends(get_db)):
    try:
        return _svc(db, settings).strategy_view(strategy_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Unknown strategy")


@router.post("/strategies/{strategy_id}/evaluate")
async def evaluate_strategy(strategy_id: str, settings: Settings = Depends(get_settings), db: Session = Depends(get_db),
                            _auth=Depends(require_api_key)):
    try:
        return _svc(db, settings).evaluate_strategy(strategy_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Unknown strategy")


@router.post("/strategies/{strategy_id}/quarantine")
async def quarantine_strategy(strategy_id: str, body: ReasonBody, settings: Settings = Depends(get_settings),
                              db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    svc = _svc(db, settings)
    try:
        svc.strategy_view(strategy_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Unknown strategy")
    svc.quarantine(strategy_id, [{"reason": "MANUAL", "detail": body.reason}], actor="api_key")
    return svc.strategy_view(strategy_id)


@router.get("/audit")
async def audit(limit: int = Query(50, ge=1, le=500), settings: Settings = Depends(get_settings),
                db: Session = Depends(get_db)):
    from app.models import ProtectionAuditRecord

    rows = db.query(ProtectionAuditRecord).order_by(ProtectionAuditRecord.id.desc()).limit(limit).all()
    return {
        "chain": _svc(db, settings).verify_audit_chain(),
        "events": [{"id": r.id, "event": r.event_type, "actor": r.actor, "detail": r.detail, "hash": r.hash[:16],
                    "at": r.created_at.isoformat()} for r in rows],
    }


# ----------------------------------------------------------------------------- human-only (admin key)
@router.post("/halt/reset")
async def reset_halt(environment: Literal["paper", "testnet", "live"], body: ResetBody,
                     settings: Settings = Depends(get_settings), db: Session = Depends(get_db),
                     auth: HumanAuthorization = Depends(require_admin)):
    try:
        return _svc(db, settings).reset_halt(environment, auth, body.note)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/news-calendar")
async def replace_calendar(body: CalendarBody, settings: Settings = Depends(get_settings), db: Session = Depends(get_db),
                           auth: HumanAuthorization = Depends(require_admin)):
    n = _svc(db, settings).replace_news_calendar([e.model_dump() for e in body.events], auth)
    return {"events": n}


@router.post("/strategies")
async def register_strategy(body: RegisterBody, settings: Settings = Depends(get_settings), db: Session = Depends(get_db),
                            auth: HumanAuthorization = Depends(require_admin)):
    try:
        return _svc(db, settings).register_strategy(body.strategy_id, body.expectations.to_expectations(), auth)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/strategies/{strategy_id}/review")
async def begin_review(strategy_id: str, settings: Settings = Depends(get_settings), db: Session = Depends(get_db),
                       auth: HumanAuthorization = Depends(require_admin)):
    try:
        return _svc(db, settings).begin_review(strategy_id, auth)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.post("/strategies/{strategy_id}/approve-revalidation")
async def approve_revalidation(strategy_id: str, body: RevalidationApproval, settings: Settings = Depends(get_settings),
                               db: Session = Depends(get_db), auth: HumanAuthorization = Depends(require_admin)):
    try:
        return _svc(db, settings).approve_revalidation(strategy_id, auth, body.root_cause, body.notes)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


@router.post("/strategies/{strategy_id}/complete-revalidation")
async def complete_revalidation(strategy_id: str, settings: Settings = Depends(get_settings), db: Session = Depends(get_db),
                                auth: HumanAuthorization = Depends(require_admin)):
    try:
        return _svc(db, settings).complete_revalidation(strategy_id, auth)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
