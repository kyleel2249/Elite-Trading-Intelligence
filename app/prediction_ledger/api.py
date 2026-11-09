"""Prediction ledger REST API. Reads are public (like the rest of ETI); writes need X-API-Key."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.prediction_ledger import reports as rpt
from app.prediction_ledger.evaluation import breakdowns, compute_metrics
from app.prediction_ledger.job import prediction_resolver_job
from app.prediction_ledger.models import PredictionRecord
from app.prediction_ledger.service import (create_prediction, get_outcome, naive_utc, outcome_to_dict,
                                           prediction_to_dict, resolve_prediction, scored_rows)
from app.security.auth import require_api_key

router = APIRouter(prefix="/api/predictions", tags=["prediction-ledger"])


class PredictionCreate(BaseModel):
    asset: str = Field(..., min_length=1, max_length=32, pattern=r"^[A-Za-z0-9./_-]+$")
    market: Literal["crypto", "equity", "fx", "commodity", "index", "rates", "other"]
    provider: Optional[Literal["binance", "alpaca"]] = None
    direction: Literal["up", "down", "neutral"]
    entry_reference: float = Field(..., gt=0, allow_inf_nan=False)
    horizon_seconds: int = Field(..., ge=60, le=400 * 86400)
    horizon_label: Optional[str] = Field(default=None, pattern=r"^[a-z0-9_-]{1,32}$")
    target_low: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)
    target_high: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)
    target_base: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)
    probability: float = Field(..., ge=0.01, le=0.99, description="Probability the stated direction is right")
    reasoning: str = Field(..., min_length=10, max_length=8000)
    sources: list[str] = Field(..., min_length=1, max_length=25)
    invalidation_criteria: str = Field(..., min_length=5, max_length=2000)
    invalidation_price: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)
    market_regime: Optional[str] = Field(default=None, max_length=48)
    strategy: Optional[str] = Field(default=None, max_length=96)
    model_version: str = Field(default="manual", max_length=48)
    analyst: Optional[str] = Field(default=None, max_length=64)
    idempotency_key: Optional[str] = Field(default=None, max_length=160)

    @field_validator("sources")
    @classmethod
    def _sources(cls, v: list[str]) -> list[str]:
        v = [s.strip() for s in v if s and s.strip()]
        if not v:
            raise ValueError("at least one non-empty source is required")
        return [s[:500] for s in v]

    @model_validator(mode="after")
    def _ranges(self):
        if (self.target_low is None) != (self.target_high is None):
            raise ValueError("target_low and target_high must be given together")
        if self.target_low is not None and self.target_low > self.target_high:
            raise ValueError("target_low must be <= target_high")
        return self


class OutcomeCreate(BaseModel):
    realized_price: float = Field(..., gt=0, allow_inf_nan=False)
    price_source: str = Field(..., min_length=2, max_length=64)
    observed_at: Optional[datetime] = None
    notes: Optional[str] = Field(default=None, max_length=2000)


@router.post("", status_code=201)
def create(body: PredictionCreate, db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    data = body.model_dump()
    row, created = create_prediction(db, **data)
    return {"created": created, **prediction_to_dict(row)}


@router.get("")
def list_predictions(asset: Optional[str] = None, status: Optional[Literal["pending", "resolved", "invalidated", "late"]] = None,
                     limit: int = Query(50, ge=1, le=500), offset: int = Query(0, ge=0), db: Session = Depends(get_db)):
    rows = scored_rows(db, asset=asset, include_pending=True)
    if status:
        rows = [r for r in rows if r["status"] == status]
    rows.sort(key=lambda r: r["created_at"], reverse=True)
    return {"total": len(rows), "predictions": rows[offset:offset + limit]}


@router.get("/metrics")
def metrics(asset: Optional[str] = None, db: Session = Depends(get_db)):
    rows = scored_rows(db, asset=asset)
    return {"overall": compute_metrics(rows), **breakdowns(rows)}


@router.get("/job/status")
def job_status():
    return prediction_resolver_job.status()


@router.post("/job/run")
async def job_run(_auth=Depends(require_api_key)):
    return await prediction_resolver_job.run_once()


@router.get("/reports")
def list_reports(db: Session = Depends(get_db)):
    from app.prediction_ledger.models import PredictionReport
    rows = db.execute(select(PredictionReport).order_by(PredictionReport.period.desc())).scalars().all()
    return {"reports": [rpt.report_to_dict(r, full=False) for r in rows]}


@router.get("/reports/{period}/preview")
def report_preview(period: str, db: Session = Depends(get_db)):
    try:
        s = rpt.build_summary(db, period)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    return {"preview": True, "summary": s, "markdown": rpt.render_markdown(s)}


@router.get("/reports/{period}")
def report_get(period: str, db: Session = Depends(get_db)):
    if not rpt.PERIOD_RE.match(period):
        raise HTTPException(status_code=422, detail="period must be YYYY-MM")
    r = rpt.get_report(db, period)
    if not r:
        raise HTTPException(status_code=404, detail="No published report for that period")
    return rpt.report_to_dict(r)


@router.get("/reports/{period}/markdown", response_class=PlainTextResponse)
def report_markdown(period: str, db: Session = Depends(get_db)):
    if not rpt.PERIOD_RE.match(period):
        raise HTTPException(status_code=422, detail="period must be YYYY-MM")
    r = rpt.get_report(db, period)
    if not r:
        raise HTTPException(status_code=404, detail="No published report for that period")
    return r.markdown


@router.post("/reports/{period}/publish", status_code=201)
def report_publish(period: str, db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    try:
        r, created = rpt.publish_report(db, period)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"created": created, **rpt.report_to_dict(r, full=False)}


@router.get("/{uid}")
def get_one(uid: str, db: Session = Depends(get_db)):
    p = db.execute(select(PredictionRecord).where(PredictionRecord.prediction_uid == uid)).scalar_one_or_none()
    if not p:
        raise HTTPException(status_code=404, detail="Prediction not found")
    return {**prediction_to_dict(p), "outcome": outcome_to_dict(get_outcome(db, p.id))}


@router.post("/{uid}/outcome", status_code=201)
def settle(uid: str, body: OutcomeCreate, db: Session = Depends(get_db), _auth=Depends(require_api_key)):
    """Manually settle a matured prediction with no automatic price feed. Write-once."""
    p = db.execute(select(PredictionRecord).where(PredictionRecord.prediction_uid == uid)).scalar_one_or_none()
    if not p:
        raise HTTPException(status_code=404, detail="Prediction not found")
    if get_outcome(db, p.id):
        raise HTTPException(status_code=409, detail="Outcome already recorded; outcomes are immutable")
    try:
        o = resolve_prediction(db, p, body.realized_price, price_source=body.price_source,
                               observed_at=body.observed_at or naive_utc(), notes=body.notes)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return outcome_to_dict(o)
