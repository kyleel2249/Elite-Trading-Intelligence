"""Adapter: Global Alpha predictions are written to ETI's single, immutable prediction ledger
(app.prediction_ledger). That ledger owns immutability (ORM guards + DB triggers), outcome scoring,
calibration, the resolver job and monthly reports; Global Alpha keeps no ledger of its own."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.prediction_ledger.models import PredictionRecord
from app.prediction_ledger.service import create_prediction, prediction_to_dict

STRATEGY_TAG = "alpha:global-alpha"
MODEL_VERSION = "alpha-1.0"
PROVIDER_FOR = {"crypto": "binance", "equity": "alpaca", "etf": "alpaca"}


def record_alpha_prediction(db: Session, *, symbol: str, asset_class: str, price: float, tp1: float, tp2: float, stop: float,
                            probability: float, candidate_id: str, stage: Optional[str], regime: Optional[str],
                            reasoning: str, horizon_seconds: int = 14 * 86400, sources: Optional[list[str]] = None,
                            now: Optional[datetime] = None) -> tuple[PredictionRecord, bool]:
    """Record a bullish (direction 'up') prediction at decision time. One per candidate per hour (idempotent)."""
    if price <= 0 or not (price < tp1 <= tp2) or not (0 < stop < price) or not 0.0 < probability < 1.0:
        raise ValueError("invalid prediction levels or probability")
    now = now or datetime.now(timezone.utc)
    return create_prediction(
        db, asset=symbol, market="crypto" if asset_class in ("crypto", "token") else "equity", direction="up",
        entry_reference=price, horizon_seconds=horizon_seconds, probability=probability, reasoning=reasoning,
        sources=sources or ["ETI Decision-layer independent validation"],
        invalidation_criteria=f"price at or below {stop:.8g} (validated stop) before the horizon",
        provider=PROVIDER_FOR.get(asset_class), target_low=price, target_base=tp1, target_high=tp2, invalidation_price=stop,
        market_regime=regime, strategy=STRATEGY_TAG, model_version=MODEL_VERSION, analyst="eti-decision-layer",
        idempotency_key=f"alpha:{candidate_id}:{now.strftime('%Y%m%d%H')}")


def alpha_predictions(db: Session, limit: int = 50, asset: Optional[str] = None) -> list[dict[str, Any]]:
    q = db.query(PredictionRecord).filter(PredictionRecord.strategy == STRATEGY_TAG)
    if asset:
        q = q.filter(PredictionRecord.asset == asset.upper())
    return [prediction_to_dict(p) for p in q.order_by(PredictionRecord.id.desc()).limit(min(limit, 200)).all()]
