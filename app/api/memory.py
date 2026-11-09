"""ETI persistent memory & learning API.

Reads are open (like the other research endpoints); every mutation requires X-API-Key.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.database import get_db
from app.memory.backtests import BacktestMemoryService
from app.memory.learning import TradeLearningService
from app.memory.lessons import LessonService, PriorityService
from app.memory.models import MemoryTrade, StrategyRegistry
from app.memory.partition import Partition, audit_split, chronological_split
from app.memory.regimes import RegimeMemoryService
from app.memory.registry import get_or_create_registry
from app.memory.signals import SOURCES, SignalMemoryService
from app.memory.store import DOCUMENT_KINDS, EVENT_KINDS, MemoryStore
from app.memory.versions import STATUSES, StrategyVersionService
from app.security.auth import require_api_key

logger = logging.getLogger("eti.api.memory")

router = APIRouter(prefix="/api/memory", tags=["memory"])

MAX_CONTENT_BYTES = 64 * 1024


def _not_found(what: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"{what} not found")


def _bounded(obj: Any, name: str) -> Any:
    if len(json.dumps(obj, default=str)) > MAX_CONTENT_BYTES:
        raise ValueError(f"{name} exceeds {MAX_CONTENT_BYTES} bytes")
    return obj


# ---------------------------------------------------------------------------- overview / seed
@router.get("/overview")
def overview(db: Session = Depends(get_db)):
    """Counts for every memory domain plus the live trading performance summary."""
    data = MemoryStore(db).overview()
    data["performance"] = TradeLearningService(db).performance()
    return data


@router.post("/seed")
def seed_static_memory(settings: Settings = Depends(get_settings), db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    """Snapshot documented trader profiles + strategy modules + enforced risk limits (idempotent)."""
    store = MemoryStore(db)
    out = store.seed_static_knowledge()
    _, risk_changed = store.snapshot_risk_limits(settings)
    out["risk_limit"] = {"new_versions": 1 if risk_changed else 0}
    return out


# ---------------------------------------------------------------------------- generic entries
class EntryIn(BaseModel):
    kind: str
    key: Optional[str] = Field(default=None, max_length=128)
    content: dict[str, Any]
    title: Optional[str] = Field(default=None, max_length=256)
    tags: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("content")
    @classmethod
    def _size(cls, v: dict[str, Any]) -> dict[str, Any]:
        return _bounded(v, "content")


@router.post("/entries", status_code=201)
def create_entry(body: EntryIn, db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    store = MemoryStore(db)
    try:
        if body.kind in DOCUMENT_KINDS:
            if not body.key:
                raise HTTPException(status_code=422, detail="key is required for document kinds")
            if body.kind == "risk_limit" and body.key.strip() == "server_enforced":
                raise HTTPException(status_code=403, detail="'server_enforced' is system-managed from server configuration")
            row, created = store.put_document(body.kind, body.key, body.content, title=body.title, tags=body.tags, source="api")
            return {"entry": row.to_dict(), "new_version": created}
        if body.kind in EVENT_KINDS:
            row = store.add_event(body.kind, body.content, key=body.key, title=body.title, tags=body.tags, source="api")
            return {"entry": row.to_dict(), "new_version": True}
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    raise HTTPException(status_code=422, detail=f"kind must be one of {sorted(DOCUMENT_KINDS | EVENT_KINDS)}")


@router.get("/entries")
def list_entries(
    kind: Optional[str] = None,
    q: Optional[str] = Query(default=None, max_length=100),
    tag: Optional[str] = Query(default=None, max_length=64),
    status: Optional[str] = "active",
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    rows = MemoryStore(db).list_entries(kind=kind, q=q, tag=tag, status=status or None, limit=limit, offset=offset)
    return {"entries": [r.to_dict() for r in rows]}


@router.get("/entries/{kind}/{key:path}")
def get_entry(kind: str, key: str, version: Optional[int] = Query(default=None, ge=1), db: Session = Depends(get_db)):
    store = MemoryStore(db)
    row = store.get(kind, key, version)
    if row is None:
        raise _not_found("entry")
    return {
        "entry": row.to_dict(),
        "history": [{"version": h.version, "status": h.status, "created_at": h.created_at.isoformat() if h.created_at else None,
                     "content_sha256": h.content_sha256} for h in store.history(kind, key)],
    }


# ---------------------------------------------------------------------------- signals + accuracy
class SignalIn(BaseModel):
    source: Literal["council", "strategy_runner", "forecast", "manual"] = "manual"
    symbol: str = Field(..., min_length=1, max_length=64)
    provider: str = Field(..., min_length=1, max_length=32)
    direction: Optional[Literal["long", "short", "flat", "exit", "unknown"]] = None
    action: Optional[str] = Field(default=None, max_length=32)
    confidence: Optional[float] = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    reference_price: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)
    stop_price: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)
    target_price: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)
    horizon_seconds: Optional[int] = Field(default=None, gt=0, le=60 * 60 * 24 * 365)
    strategy_id: Optional[str] = Field(default=None, max_length=64)
    regime: Optional[str] = Field(default=None, max_length=64)
    assumptions: list[dict[str, Any]] = Field(default_factory=list, max_length=25)
    analysis: dict[str, Any] = Field(default_factory=dict)
    as_of: Optional[datetime] = None

    @field_validator("analysis")
    @classmethod
    def _size(cls, v: dict[str, Any]) -> dict[str, Any]:
        return _bounded(v, "analysis")


@router.post("/signals", status_code=201)
def record_signal(body: SignalIn, settings: Settings = Depends(get_settings), db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    try:
        row = SignalMemoryService(db, settings).record(**body.model_dump())
    except ValueError as exc:  # includes LeakageError (future-dated signal)
        raise HTTPException(status_code=422, detail=str(exc))
    return row.to_dict()


@router.get("/signals")
def list_signals(
    symbol: Optional[str] = None,
    strategy_id: Optional[str] = None,
    source: Optional[str] = None,
    outcome_status: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
):
    rows = SignalMemoryService(db, settings).list(
        symbol=symbol, strategy_id=strategy_id, source=source, outcome_status=outcome_status, limit=limit, offset=offset,
    )
    return {"signals": [r.to_dict() for r in rows], "valid_sources": sorted(SOURCES)}


@router.post("/signals/resolve")
async def resolve_due_signals(settings: Settings = Depends(get_settings), db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    """Score signals whose horizon has elapsed using a fresh quote (inside the tolerance window)."""
    from app.market.service import MarketService

    svc = SignalMemoryService(db, settings)
    ms = MarketService(settings)
    prices: dict[tuple[str, str], float] = {}
    for provider, symbol in svc.due_keys():
        try:
            snap = await ms.get_snapshot(provider, symbol)
            if snap.get("price") is not None:
                prices[(provider, symbol)] = float(snap["price"])
        except Exception:
            logger.info("no quote for %s %s while resolving signals", provider, symbol)
    return svc.resolve_due(prices)


class OutcomeIn(BaseModel):
    outcome_price: float = Field(..., gt=0, allow_inf_nan=False)
    outcome_ts: datetime


@router.post("/signals/{signal_id}/outcome")
def record_outcome(signal_id: str, body: OutcomeIn, settings: Settings = Depends(get_settings), db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    svc = SignalMemoryService(db, settings)
    sig = svc.get(signal_id)
    if sig is None:
        raise _not_found("signal")
    try:
        return svc.resolve_signal(sig, body.outcome_price, body.outcome_ts).to_dict()
    except ValueError as exc:  # premature/future outcome (LeakageError) or already resolved
        db.rollback()
        raise HTTPException(status_code=422, detail=str(exc))


@router.get("/signals/{signal_id}")
def get_signal(signal_id: str, settings: Settings = Depends(get_settings), db: Session = Depends(get_db)):
    sig = SignalMemoryService(db, settings).get(signal_id)
    if sig is None:
        raise _not_found("signal")
    return sig.to_dict()


@router.get("/accuracy")
def prediction_accuracy(
    strategy_id: Optional[str] = None,
    symbol: Optional[str] = None,
    regime: Optional[str] = None,
    source: Optional[str] = None,
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
):
    from app.intelligence.forecast_accuracy import ForecastAccuracyService

    return {
        "signals": SignalMemoryService(db, settings).accuracy(strategy_id=strategy_id, symbol=symbol, regime=regime, source=source),
        "forecasts": ForecastAccuracyService(db).summary(symbol=symbol),
    }


# ---------------------------------------------------------------------------- trades + learning
@router.get("/trades")
def list_trades(
    status: Optional[Literal["open", "closed"]] = None,
    strategy_id: Optional[str] = None,
    classification: Optional[Literal["win", "loss", "breakeven"]] = None,
    symbol: Optional[str] = None,
    environment: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    q = db.query(MemoryTrade)
    if status:
        q = q.filter(MemoryTrade.status == status)
    if strategy_id:
        q = q.filter(MemoryTrade.strategy_id == strategy_id)
    if classification:
        q = q.filter(MemoryTrade.classification == classification)
    if symbol:
        q = q.filter(MemoryTrade.symbol == symbol.strip().upper())
    if environment:
        q = q.filter(MemoryTrade.environment == environment.strip().lower())
    rows = q.order_by(MemoryTrade.opened_at.desc()).offset(offset).limit(limit).all()
    slim = []
    for r in rows:
        d = r.to_dict()
        for heavy in ("entry_fills", "exit_fills", "analysis_snapshot", "learning"):
            d.pop(heavy, None)
        slim.append(d)
    return {"trades": slim}


@router.get("/trades/{trade_id}")
def get_trade(trade_id: str, db: Session = Depends(get_db)):
    row = db.query(MemoryTrade).filter(MemoryTrade.trade_id == trade_id).one_or_none()
    if row is None:
        raise _not_found("trade")
    return row.to_dict()


@router.get("/performance")
def performance(strategy_id: Optional[str] = None, environment: Optional[str] = None, db: Session = Depends(get_db)):
    return TradeLearningService(db).performance(strategy_id=strategy_id, environment=environment)


@router.get("/learning/strategies/{strategy_id}/evaluation")
def strategy_evaluation(strategy_id: str, db: Session = Depends(get_db)):
    """Edge-health + regime breakdown over all closed trades of a strategy (read-only)."""
    return TradeLearningService(db).evaluate_strategy(strategy_id)


@router.get("/lessons")
def list_lessons(
    strategy_id: Optional[str] = None,
    category: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
):
    return {"lessons": [r.to_dict() for r in LessonService(db).list(strategy_id=strategy_id, category=category, status=status, limit=limit)]}


@router.get("/priorities")
def list_priorities(
    kind: Optional[Literal["research", "monitoring"]] = None,
    status: Optional[str] = "open",
    limit: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    return {"priorities": [r.to_dict() for r in PriorityService(db).list(kind=kind, status=status or None, limit=limit)]}


# ---------------------------------------------------------------------------- strategies
class VersionIn(BaseModel):
    config: dict[str, Any]
    reason: str = Field(..., min_length=3, max_length=2000)
    created_by: str = Field(..., min_length=1, max_length=64)
    parent_version: Optional[int] = Field(default=None, ge=1)


class TransitionIn(BaseModel):
    to_status: Literal["candidate", "validated", "active", "retired", "rejected"]
    actor: str = Field(..., min_length=1, max_length=64, description="Named human approver")
    note: Optional[str] = Field(default=None, max_length=500)


class RollbackIn(BaseModel):
    to_version: int = Field(..., ge=1)
    approved_by: str = Field(..., min_length=1, max_length=64)
    note: Optional[str] = Field(default=None, max_length=500)


class SuspensionIn(BaseModel):
    suspended: bool
    actor: str = Field(..., min_length=1, max_length=64)
    reason: str = Field(..., min_length=3, max_length=500)


@router.get("/strategies")
def list_strategies(settings: Settings = Depends(get_settings), db: Session = Depends(get_db)):
    svc = StrategyVersionService(db, settings)
    regs = {r.strategy_id: r for r in db.query(StrategyRegistry).all()}
    out = []
    for item in svc.list_strategies():
        reg = regs.get(item["strategy_id"])
        out.append({**item, "health_status": reg.health_status if reg else None, "suspended": bool(reg.suspended) if reg else False,
                    "allocation_pct": reg.allocation_pct if reg else None})
    return {"strategies": out, "statuses": list(STATUSES)}


@router.get("/strategies/{strategy_id}/versions")
def strategy_versions(strategy_id: str, settings: Settings = Depends(get_settings), db: Session = Depends(get_db)):
    hist = StrategyVersionService(db, settings).history(strategy_id)
    if not hist:
        raise _not_found("strategy")
    return {"strategy_id": strategy_id, "versions": [v.to_dict() for v in hist]}


@router.post("/strategies/{strategy_id}/versions", status_code=201)
def create_strategy_version(strategy_id: str, body: VersionIn, settings: Settings = Depends(get_settings), db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    try:
        row = StrategyVersionService(db, settings).create_version(
            strategy_id, body.config, reason=body.reason, created_by=body.created_by, actor_kind="user",
            parent_version=body.parent_version,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return row.to_dict()


@router.post("/strategies/{strategy_id}/versions/{version}/transition")
def transition_strategy_version(strategy_id: str, version: int, body: TransitionIn, settings: Settings = Depends(get_settings), db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    try:
        row = StrategyVersionService(db, settings).transition(
            strategy_id, version, body.to_status, actor=body.actor, actor_kind="user", note=body.note,
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc))
    return row.to_dict()


@router.post("/strategies/{strategy_id}/rollback")
def rollback_strategy(strategy_id: str, body: RollbackIn, settings: Settings = Depends(get_settings), db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    try:
        row = StrategyVersionService(db, settings).rollback(strategy_id, body.to_version, approved_by=body.approved_by, note=body.note)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=409, detail=str(exc))
    return row.to_dict()


@router.post("/strategies/{strategy_id}/suspension")
def set_suspension(strategy_id: str, body: SuspensionIn, db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    """Manually suspend or resume a strategy (the adaptive engine can suspend; only a human resumes)."""
    from app.adaptive_edge.knowledge_base import AdaptiveKnowledgeBase

    reg = get_or_create_registry(db, strategy_id)
    reg.suspended = body.suspended
    reg.stage = "SUSPENDED" if body.suspended else "MONITORING"
    db.commit()
    AdaptiveKnowledgeBase(db).record(
        "strategy_suspended" if body.suspended else "strategy_resumed", strategy_id,
        {"actor": body.actor, "reason": body.reason}, tags=[strategy_id],
    )
    return reg.to_dict()


# ---------------------------------------------------------------------------- backtests / leakage
class BacktestIn(BaseModel):
    strategy_id: str = Field(..., min_length=1, max_length=64)
    symbol: str = Field(..., min_length=1, max_length=64)
    provider: str = Field(..., min_length=1, max_length=32)
    result: dict[str, Any]
    partition: Literal["train", "validation", "holdout", "unclassified"] = "unclassified"
    strategy_version: Optional[int] = Field(default=None, ge=1)
    interval: Optional[str] = Field(default=None, max_length=16)
    data_start: Optional[str] = Field(default=None, max_length=64)
    data_end: Optional[str] = Field(default=None, max_length=64)
    training_range: Optional[list[float]] = Field(default=None, min_length=2, max_length=2)
    evaluation_range: Optional[list[float]] = Field(default=None, min_length=2, max_length=2)
    embargo_bars: int = Field(default=0, ge=0)
    horizon: int = Field(default=0, ge=0)
    parameters_fitted: bool = True
    tuned_on_evaluation: bool = False
    universe_source: Literal["point_in_time", "current_listing", "unknown"] = "unknown"
    fee_bps: Optional[float] = Field(default=None, ge=0, allow_inf_nan=False)
    params: dict[str, Any] = Field(default_factory=dict)

    @field_validator("result")
    @classmethod
    def _size(cls, v: dict[str, Any]) -> dict[str, Any]:
        return _bounded(v, "result")


@router.post("/backtests", status_code=201)
def record_backtest(body: BacktestIn, db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    data = body.model_dump()
    for k in ("training_range", "evaluation_range"):
        if data[k] is not None:
            data[k] = tuple(data[k])
    try:
        row = BacktestMemoryService(db).record(**data)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return row.to_dict()


@router.get("/backtests")
def list_backtests(
    strategy_id: Optional[str] = None,
    symbol: Optional[str] = None,
    partition: Optional[str] = None,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    rows = BacktestMemoryService(db).list(strategy_id=strategy_id, symbol=symbol, partition=partition, limit=limit, offset=offset)
    out = []
    for r in rows:
        d = r.to_dict()
        d.pop("result", None)
        out.append(d)
    return {"backtests": out, "partitions": [p.value for p in Partition]}


@router.get("/backtests/{run_id}")
def get_backtest(run_id: str, db: Session = Depends(get_db)):
    row = BacktestMemoryService(db).get(run_id)
    if row is None:
        raise _not_found("backtest")
    return row.to_dict()


@router.get("/split-plan")
def split_plan(
    n_bars: int = Query(..., ge=10, le=1_000_000),
    train_frac: float = Query(0.6, gt=0, lt=1),
    validation_frac: float = Query(0.2, gt=0, lt=1),
    embargo_bars: int = Query(0, ge=0),
):
    """Chronological train/validation/holdout plan with embargo gaps (never shuffled)."""
    try:
        return chronological_split(n_bars, train_frac, validation_frac, embargo_bars).to_dict()
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


class AuditIn(BaseModel):
    training_range: Optional[list[float]] = Field(default=None, min_length=2, max_length=2)
    evaluation_range: Optional[list[float]] = Field(default=None, min_length=2, max_length=2)
    embargo_bars: int = Field(default=0, ge=0)
    horizon: int = Field(default=0, ge=0)
    parameters_fitted: bool = True
    tuned_on_evaluation: bool = False
    universe_source: Literal["point_in_time", "current_listing", "unknown"] = "unknown"


@router.post("/leakage-audit")
def leakage_audit(body: AuditIn):
    return audit_split(
        tuple(body.training_range) if body.training_range else None,
        tuple(body.evaluation_range) if body.evaluation_range else None,
        embargo_bars=body.embargo_bars, horizon=body.horizon, parameters_fitted=body.parameters_fitted,
        tuned_on_evaluation=body.tuned_on_evaluation, universe_source=body.universe_source,
    )


# ---------------------------------------------------------------------------- market conditions
class RegimeIn(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=64)
    provider: str = Field(..., min_length=1, max_length=32)
    primary_regime: str = Field(..., min_length=1, max_length=64)
    coexisting: list[str] = Field(default_factory=list, max_length=20)
    confidence: Optional[float] = Field(default=None, ge=0, le=1)
    as_of: Optional[datetime] = None


@router.post("/regimes", status_code=201)
def record_regime(body: RegimeIn, settings: Settings = Depends(get_settings), db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    try:
        row = RegimeMemoryService(db, settings).record(
            body.symbol, body.provider, body.primary_regime, coexisting=body.coexisting,
            confidence=body.confidence, source="manual", as_of=body.as_of,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return row.to_dict()


@router.get("/regimes")
def list_regimes(
    symbol: Optional[str] = None,
    provider: Optional[str] = None,
    limit: int = Query(100, ge=1, le=500),
    settings: Settings = Depends(get_settings),
    db: Session = Depends(get_db),
):
    return {"regimes": [r.to_dict() for r in RegimeMemoryService(db, settings).list(symbol=symbol, provider=provider, limit=limit)]}
