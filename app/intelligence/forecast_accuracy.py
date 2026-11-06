"""Walk-forward forecast accuracy tracking for Lars Hagen calibration."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models import ForecastRecord, ForecastAccuracy


class ForecastAccuracyService:
    """
    Compare prior forecasts to later realized prices.
    Does not claim calibration quality until sample is sufficient.
    """

    def __init__(self, db: Session):
        self.db = db

    def score_pending(self, symbol: str, realized_price: float, provider: str = "binance") -> list[dict[str, Any]]:
        """Score unscored forecasts for symbol against a realized price."""
        rows = (
            self.db.query(ForecastRecord)
            .filter(
                ForecastRecord.symbol == symbol.upper(),
                ForecastRecord.provider == provider,
            )
            .order_by(ForecastRecord.created_at.desc())
            .limit(50)
            .all()
        )
        results = []
        for fc in rows:
            existing = (
                self.db.query(ForecastAccuracy)
                .filter(ForecastAccuracy.forecast_id == fc.id)
                .one_or_none()
            )
            if existing:
                continue
            base = fc.base_price or realized_price
            bull = fc.bull_price
            bear = fc.bear_price
            err = realized_price - base if base is not None else None
            abs_err = abs(err) if err is not None else None
            pct_err = (err / base) if base else None
            # Scenario hit: realized inside bull-bear range
            in_range = None
            if bull is not None and bear is not None:
                lo, hi = min(bear, bull), max(bear, bull)
                in_range = lo <= realized_price <= hi
            direction_ok = None
            if fc.payload and fc.payload.get("last_price") and base is not None:
                last = float(fc.payload["last_price"])
                pred_dir = 1 if base >= last else -1
                real_dir = 1 if realized_price >= last else -1
                direction_ok = pred_dir == real_dir

            acc = ForecastAccuracy(
                forecast_id=fc.id,
                symbol=fc.symbol,
                provider=provider,
                horizon=fc.horizon,
                predicted_base=base,
                realized_price=realized_price,
                absolute_error=abs_err,
                pct_error=pct_err,
                in_scenario_range=in_range,
                direction_correct=direction_ok,
                analyst="Lars Hagen",
                model_version=fc.model_version,
            )
            self.db.add(acc)
            results.append(
                {
                    "forecast_id": fc.id,
                    "absolute_error": abs_err,
                    "pct_error": pct_err,
                    "in_scenario_range": in_range,
                    "direction_correct": direction_ok,
                }
            )
        self.db.commit()
        return results

    def summary(self, symbol: Optional[str] = None, limit: int = 200) -> dict[str, Any]:
        q = self.db.query(ForecastAccuracy)
        if symbol:
            q = q.filter(ForecastAccuracy.symbol == symbol.upper())
        rows = q.order_by(ForecastAccuracy.created_at.desc()).limit(limit).all()
        if not rows:
            return {
                "sample_size": 0,
                "message": "No scored forecasts yet",
                "analyst": "Lars Hagen",
                "note": "Not calibrated — insufficient sample",
            }
        n = len(rows)
        mae = sum(r.absolute_error or 0 for r in rows) / n
        mape = sum(abs(r.pct_error or 0) for r in rows) / n
        dir_rows = [r for r in rows if r.direction_correct is not None]
        dir_acc = (sum(1 for r in dir_rows if r.direction_correct) / len(dir_rows)) if dir_rows else None
        range_rows = [r for r in rows if r.in_scenario_range is not None]
        range_hit = (sum(1 for r in range_rows if r.in_scenario_range) / len(range_rows)) if range_rows else None
        return {
            "sample_size": n,
            "mae": mae,
            "mape": mape,
            "direction_accuracy": dir_acc,
            "scenario_range_hit_rate": range_hit,
            "analyst": "Lars Hagen",
            "model_versions": sorted({r.model_version for r in rows}),
            "note": "Heuristic accuracy only — not a production calibration certificate",
        }
