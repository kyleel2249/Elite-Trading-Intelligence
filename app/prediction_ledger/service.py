"""Create / resolve / query predictions. Writes are insert-only."""
from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.prediction_ledger.evaluation import lateness_tolerance, score_prediction
from app.prediction_ledger.models import PredictionOutcome, PredictionRecord

logger = logging.getLogger(__name__)

HORIZON_SECONDS = {"scalp": 3600, "intraday": 21600, "swing": 259200, "position": 1209600}


def naive_utc(dt: Optional[datetime] = None) -> datetime:
    dt = dt or datetime.now(timezone.utc)
    if dt.tzinfo is not None:
        dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
    return dt


def iso(dt: Optional[datetime]) -> Optional[str]:
    return (naive_utc(dt).isoformat(timespec="microseconds") + "Z") if dt else None


def horizon_label_for(seconds: int) -> str:
    for label, s in HORIZON_SECONDS.items():
        if seconds <= s:
            return label
    return "position"


def _hash(payload: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str, separators=(",", ":")).encode()).hexdigest()


def prediction_to_dict(p: PredictionRecord) -> dict[str, Any]:
    return {
        "prediction_uid": p.prediction_uid, "created_at": iso(p.created_at), "asset": p.asset, "market": p.market,
        "provider": p.provider, "direction": p.direction, "entry_reference": p.entry_reference,
        "horizon_label": p.horizon_label, "horizon_seconds": p.horizon_seconds, "expires_at": iso(p.expires_at),
        "target_low": p.target_low, "target_high": p.target_high, "target_base": p.target_base,
        "probability": p.probability, "reasoning": p.reasoning, "sources": p.sources,
        "invalidation_criteria": p.invalidation_criteria, "invalidation_price": p.invalidation_price,
        "market_regime": p.market_regime, "strategy": p.strategy, "model_version": p.model_version,
        "analyst": p.analyst, "content_hash": p.content_hash,
    }


def outcome_to_dict(o: Optional[PredictionOutcome]) -> Optional[dict[str, Any]]:
    if o is None:
        return None
    return {
        "status": o.status, "evaluated_at": iso(o.evaluated_at), "observed_at": iso(o.observed_at),
        "realized_price": o.realized_price, "price_source": o.price_source, "late_seconds": o.late_seconds,
        "return_pct": o.return_pct, "direction_correct": o.direction_correct, "in_target_range": o.in_target_range,
        "abs_error": o.abs_error, "pct_error": o.pct_error, "invalidated": o.invalidated, "notes": o.notes,
    }


def create_prediction(db: Session, *, asset: str, market: str, direction: str, entry_reference: float,
                      horizon_seconds: int, probability: float, reasoning: str, sources: list[str],
                      invalidation_criteria: str, provider: Optional[str] = None,
                      horizon_label: Optional[str] = None, target_low: Optional[float] = None,
                      target_high: Optional[float] = None, target_base: Optional[float] = None,
                      invalidation_price: Optional[float] = None, market_regime: Optional[str] = None,
                      strategy: Optional[str] = None, model_version: str = "manual",
                      analyst: Optional[str] = None, idempotency_key: Optional[str] = None,
                      legacy_forecast_id: Optional[int] = None) -> tuple[PredictionRecord, bool]:
    """Insert a prediction. The timestamp is the server clock; callers cannot supply it."""
    if idempotency_key:
        existing = db.execute(select(PredictionRecord).where(PredictionRecord.idempotency_key == idempotency_key)).scalar_one_or_none()
        if existing:
            return existing, False
    now = naive_utc()
    uid = str(uuid.uuid4())
    body = dict(
        prediction_uid=uid, created_at=now.isoformat(), asset=asset.upper(), market=market.lower(),
        provider=provider, direction=direction, entry_reference=entry_reference, horizon_seconds=horizon_seconds,
        target_low=target_low, target_high=target_high, target_base=target_base, probability=probability,
        reasoning=reasoning, sources=sources, invalidation_criteria=invalidation_criteria,
        invalidation_price=invalidation_price, market_regime=market_regime, strategy=strategy,
        model_version=model_version,
    )
    row = PredictionRecord(
        prediction_uid=uid, idempotency_key=idempotency_key, created_at=now, asset=asset.upper(),
        market=market.lower(), provider=provider, direction=direction, entry_reference=entry_reference,
        horizon_label=horizon_label or horizon_label_for(horizon_seconds), horizon_seconds=horizon_seconds,
        expires_at=now + timedelta(seconds=horizon_seconds), target_low=target_low, target_high=target_high,
        target_base=target_base, probability=probability, reasoning=reasoning, sources=sources,
        invalidation_criteria=invalidation_criteria, invalidation_price=invalidation_price,
        market_regime=market_regime, strategy=strategy, model_version=model_version, analyst=analyst,
        legacy_forecast_id=legacy_forecast_id, content_hash=_hash(body),
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if idempotency_key:
            existing = db.execute(select(PredictionRecord).where(PredictionRecord.idempotency_key == idempotency_key)).scalar_one_or_none()
            if existing:
                return existing, False
        raise
    db.refresh(row)
    return row, True


def get_outcome(db: Session, prediction_id: int) -> Optional[PredictionOutcome]:
    return db.execute(select(PredictionOutcome).where(PredictionOutcome.prediction_id == prediction_id)).scalar_one_or_none()


def resolve_prediction(db: Session, pred: PredictionRecord, realized_price: float, *, price_source: str,
                       observed_at: Optional[datetime] = None, notes: Optional[str] = None) -> PredictionOutcome:
    """Write the (single) outcome. Refuses before expiry. Existing outcomes are returned unchanged."""
    existing = get_outcome(db, pred.id)
    if existing:
        return existing
    observed = naive_utc(observed_at)
    if observed < pred.expires_at:
        raise ValueError("prediction has not reached its expiry yet")
    if realized_price <= 0:
        raise ValueError("realized_price must be positive")
    late = (observed - pred.expires_at).total_seconds()
    s = score_prediction(prediction_to_dict(pred), realized_price)
    status = "late" if late > lateness_tolerance(pred.horizon_seconds) else ("invalidated" if s["invalidated"] else "resolved")
    out = PredictionOutcome(prediction_id=pred.id, status=status, realized_price=realized_price,
                            price_source=price_source, observed_at=observed, late_seconds=late, notes=notes, **s)
    db.add(out)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return get_outcome(db, pred.id)  # concurrent writer won; first outcome stands
    db.refresh(out)
    return out


def pending_matured(db: Session, now: Optional[datetime] = None) -> list[PredictionRecord]:
    now = naive_utc(now)
    done = select(PredictionOutcome.prediction_id)
    return list(db.execute(select(PredictionRecord).where(PredictionRecord.expires_at <= now, PredictionRecord.id.not_in(done))
                           .order_by(PredictionRecord.expires_at)).scalars())


def scored_rows(db: Session, *, start: Optional[datetime] = None, end: Optional[datetime] = None,
                asset: Optional[str] = None, include_pending: bool = False) -> list[dict[str, Any]]:
    """Flat prediction+outcome dicts. Filters on expires_at (when the prediction was due)."""
    q = select(PredictionRecord, PredictionOutcome).outerjoin(PredictionOutcome, PredictionOutcome.prediction_id == PredictionRecord.id)
    if start:
        q = q.where(PredictionRecord.expires_at >= naive_utc(start))
    if end:
        q = q.where(PredictionRecord.expires_at < naive_utc(end))
    if asset:
        q = q.where(PredictionRecord.asset == asset.upper())
    rows = []
    for p, o in db.execute(q.order_by(PredictionRecord.created_at)).all():
        if o is None and not include_pending:
            continue
        d = prediction_to_dict(p)
        d.update({"status": o.status if o else "pending"})
        if o:
            d.update({k: v for k, v in outcome_to_dict(o).items() if k != "status"})
        rows.append(d)
    return rows


def record_from_forecast(db: Session, forecast: dict[str, Any], closes: Optional[list[float]] = None,
                         forecast_id: Optional[int] = None) -> dict[str, Any]:
    """Log a PredictiveEngine forecast into the ledger (deduplicated per symbol/horizon/model/hour)."""
    from app.adaptive_edge.regime import MarketRegimeEngine

    sc = forecast.get("scenarios") or {}
    last, base, bull, bear = (forecast.get("last_price"), sc.get("base"), sc.get("bull"), sc.get("bear"))
    if not all(isinstance(x, (int, float)) for x in (last, base, bull, bear)) or last <= 0:
        raise ValueError("forecast is missing price fields")
    thr = last * 0.0005
    direction = "up" if base > last + thr else "down" if base < last - thr else "neutral"
    horizon = forecast.get("horizon", "intraday")
    seconds = HORIZON_SECONDS.get(horizon, HORIZON_SECONDS["intraday"])
    regime = None
    if closes and len(closes) >= 5:
        regime = MarketRegimeEngine().assess(forecast.get("symbol", ""), forecast.get("provider", ""), closes).primary_regime
    stop = forecast.get("stop_zone") or []
    inv = (min(stop) if direction == "up" else max(stop)) if stop and direction != "neutral" else None
    model = forecast.get("model_version", "v0-scaffold")
    bucket = int(datetime.now(timezone.utc).timestamp() // 3600)
    key = f"auto:{forecast.get('symbol')}:{forecast.get('provider')}:{horizon}:{model}:{bucket}"
    row, created = create_prediction(
        db, asset=forecast.get("symbol", ""), market="crypto" if forecast.get("provider") == "binance" else "equity",
        provider=forecast.get("provider"), direction=direction, entry_reference=last, horizon_seconds=seconds,
        horizon_label=horizon, target_low=min(bear, bull), target_high=max(bear, bull), target_base=base,
        probability=min(0.99, max(0.01, float(forecast.get("confidence") or 0.5))),
        reasoning="Volatility-scaled scenario forecast. Assumptions: " + "; ".join(forecast.get("assumptions") or []),
        sources=[f"internal:PredictiveEngine:{model}", f"market:{forecast.get('provider')}:1h-klines"],
        invalidation_criteria="Price crosses the forecast stop zone against the predicted direction by expiry.",
        invalidation_price=inv, market_regime=regime, strategy="predictive_scaffold", model_version=model,
        analyst=forecast.get("analyst"), idempotency_key=key, legacy_forecast_id=forecast_id,
    )
    return {"prediction_uid": row.prediction_uid, "created": created}
