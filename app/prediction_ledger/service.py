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

# Bucket labels for free-form horizons.
HORIZON_SECONDS = {"scalp": 3600, "intraday": 21600, "swing": 259200, "position": 1209600}
# PredictiveEngine scales hourly return volatility by 0.5 / 1 / 2 / 3.5 per horizon, so the horizon
# it actually models is scale x 1h. Auto-logged forecasts are scored over exactly that window.
FORECAST_MODEL_HORIZON_SECONDS = {"scalp": 1800, "intraday": 3600, "swing": 7200, "position": 12600}


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


def _hash_body(p: PredictionRecord) -> dict[str, Any]:
    return dict(
        prediction_uid=p.prediction_uid, created_at=naive_utc(p.created_at).isoformat(), asset=p.asset, market=p.market,
        provider=p.provider, direction=p.direction, entry_reference=p.entry_reference, horizon_seconds=p.horizon_seconds,
        target_low=p.target_low, target_high=p.target_high, target_base=p.target_base, probability=p.probability,
        reasoning=p.reasoning, sources=p.sources, invalidation_criteria=p.invalidation_criteria,
        invalidation_price=p.invalidation_price, market_regime=p.market_regime, strategy=p.strategy,
        model_version=p.model_version,
    )


def verify_hash(p: PredictionRecord) -> dict[str, Any]:
    """Recompute the SHA-256 of the stored fields. A mismatch means the row was altered outside the app."""
    recomputed = _hash(_hash_body(p))
    return {"prediction_uid": p.prediction_uid, "stored_hash": p.content_hash, "recomputed_hash": recomputed,
            "intact": recomputed == p.content_hash}


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
    def _existing():
        return db.execute(select(PredictionRecord).where(PredictionRecord.idempotency_key == idempotency_key)).scalar_one_or_none()

    if idempotency_key:
        found = _existing()
        if found:
            return found, False
    now = naive_utc()
    row = PredictionRecord(
        prediction_uid=str(uuid.uuid4()), idempotency_key=idempotency_key, created_at=now, asset=asset.upper(),
        market=market.lower(), provider=provider, direction=direction, entry_reference=entry_reference,
        horizon_label=horizon_label or horizon_label_for(horizon_seconds), horizon_seconds=horizon_seconds,
        expires_at=now + timedelta(seconds=horizon_seconds), target_low=target_low, target_high=target_high,
        target_base=target_base, probability=probability, reasoning=reasoning, sources=sources,
        invalidation_criteria=invalidation_criteria, invalidation_price=invalidation_price,
        market_regime=market_regime, strategy=strategy, model_version=model_version, analyst=analyst,
        legacy_forecast_id=legacy_forecast_id, content_hash="",
    )
    row.content_hash = _hash(_hash_body(row))
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if idempotency_key:
            found = _existing()
            if found:
                return found, False
        raise
    db.refresh(row)
    return row, True


def get_outcome(db: Session, prediction_id: int) -> Optional[PredictionOutcome]:
    return db.execute(select(PredictionOutcome).where(PredictionOutcome.prediction_id == prediction_id)).scalar_one_or_none()


def _from_ms(ms: float) -> datetime:
    return datetime.fromtimestamp(ms / 1000.0, timezone.utc).replace(tzinfo=None)


def _to_ms(dt: datetime) -> float:
    return naive_utc(dt).replace(tzinfo=timezone.utc).timestamp() * 1000.0


def kline_resolution(klines: list[dict[str, Any]], created_at: datetime, expires_at: datetime,
                     bar_ms: int) -> Optional[dict[str, Any]]:
    """Price at expiry plus the high/low path from historical candles.

    Uses only completed candles that open at/after creation and close at/before expiry (so the price is within
    one bar of expiry and the path excludes the partial bar containing creation). Returns None when the candle
    window does not cover creation..expiry, so callers can fall back to a snapshot.
    """
    c_ms, e_ms = _to_ms(created_at), _to_ms(expires_at)
    need = ("open_time", "close_time", "high", "low", "close")
    bars = [k for k in klines if k.get("data_status") != "invalid" and all(k.get(f) is not None for f in need)]
    if not bars:
        return None
    bars.sort(key=lambda k: k["open_time"])
    if bars[0]["open_time"] > c_ms + bar_ms:
        return None
    path = [k for k in bars if k["open_time"] >= c_ms and k["close_time"] <= e_ms]
    if not path:
        return None
    last = path[-1]
    if e_ms - last["close_time"] > 2 * bar_ms:
        return None
    return {
        "price": float(last["close"]), "observed_at": _from_ms(last["close_time"]),
        "low": min(float(k["low"]) for k in path), "high": max(float(k["high"]) for k in path), "bars": len(path),
    }


def resolve_prediction(db: Session, pred: PredictionRecord, realized_price: float, *, price_source: str,
                       observed_at: Optional[datetime] = None, notes: Optional[str] = None,
                       path_low: Optional[float] = None, path_high: Optional[float] = None,
                       historical: bool = False) -> PredictionOutcome:
    """Write the (single) outcome. Refuses before expiry. Existing outcomes are returned unchanged.

    historical=True means realized_price is the market price at expiry taken from stored candles, so it is
    never 'late' however long after expiry the evaluator ran.
    """
    existing = get_outcome(db, pred.id)
    if existing:
        return existing
    if realized_price <= 0:
        raise ValueError("realized_price must be positive")
    observed = naive_utc(observed_at)
    if historical:
        if naive_utc() < pred.expires_at:
            raise ValueError("prediction has not reached its expiry yet")
        late = 0.0
    else:
        if observed < pred.expires_at:
            raise ValueError("prediction has not reached its expiry yet")
        late = (observed - pred.expires_at).total_seconds()
    s = score_prediction(prediction_to_dict(pred), realized_price, path_low=path_low, path_high=path_high)
    if not historical and late > lateness_tolerance(pred.horizon_seconds):
        status = "late"
    else:
        status = "invalidated" if s["invalidated"] else "resolved"
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
    seconds = FORECAST_MODEL_HORIZON_SECONDS.get(horizon, FORECAST_MODEL_HORIZON_SECONDS["intraday"])
    regime = None
    if closes and len(closes) >= 5:
        regime = MarketRegimeEngine().assess(forecast.get("symbol", ""), forecast.get("provider", ""), closes).primary_regime
    # The forecast's stop_zone is long-side. Up calls are invalidated by trading down to the bear scenario;
    # down calls are the mirror image, invalidated by trading up to the bull scenario.
    inv = bear if direction == "up" else bull if direction == "down" else None
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
        invalidation_criteria=("Price trades at or below the bear scenario before expiry." if direction == "up" else
                               "Price trades at or above the bull scenario before expiry." if direction == "down" else
                               "None: neutral call has no directional invalidation level."),
        invalidation_price=inv, market_regime=regime, strategy="predictive_scaffold", model_version=model,
        analyst=forecast.get("analyst"), idempotency_key=key, legacy_forecast_id=forecast_id,
    )
    return {"prediction_uid": row.prediction_uid, "created": created}
