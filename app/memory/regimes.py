"""Point-in-time market-regime memory (market conditions)."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.memory.models import RegimeObservation
from app.memory.partition import assert_not_future
from app.memory.util import as_utc, naive_utc, utcnow


class RegimeMemoryService:
    def __init__(self, db: Session, settings: Optional[Settings] = None):
        self.db = db
        self.settings = settings or get_settings()

    def record(
        self,
        symbol: str,
        provider: str,
        primary_regime: str,
        *,
        coexisting: Optional[list[str]] = None,
        confidence: Optional[float] = None,
        metrics: Optional[dict[str, Any]] = None,
        source: str = "manual",
        as_of: Optional[datetime] = None,
        commit: bool = True,
    ) -> RegimeObservation:
        if not (symbol or "").strip() or not (primary_regime or "").strip():
            raise ValueError("symbol and primary_regime are required")
        ts = as_utc(as_of) if as_of is not None else utcnow()
        assert_not_future(ts, label="regime as_of")
        row = RegimeObservation(
            symbol=symbol.strip().upper(),
            provider=(provider or "").strip().lower(),
            as_of=ts,
            primary_regime=primary_regime.strip().lower(),
            coexisting=list(coexisting or []),
            confidence=confidence,
            metrics=dict(metrics or {}),
            source=source,
        )
        self.db.add(row)
        if commit:
            self.db.commit()
            self.db.refresh(row)
        else:
            self.db.flush()
        return row

    def latest_as_of(
        self,
        symbol: str,
        provider: str,
        as_of: Optional[datetime] = None,
        max_age_seconds: Optional[int] = None,
    ) -> Optional[RegimeObservation]:
        """Latest observation at or before ``as_of`` (never later - no look-ahead)."""
        cutoff = as_utc(as_of) if as_of is not None else utcnow()
        row = (
            self.db.query(RegimeObservation)
            .filter(
                RegimeObservation.symbol == symbol.strip().upper(),
                RegimeObservation.provider == (provider or "").strip().lower(),
                RegimeObservation.as_of <= naive_utc(cutoff),
            )
            .order_by(RegimeObservation.as_of.desc())
            .first()
        )
        if row is None:
            return None
        limit = max_age_seconds if max_age_seconds is not None else self.settings.memory_regime_max_age_seconds
        if limit and (cutoff - as_utc(row.as_of)) > timedelta(seconds=limit):  # type: ignore[operator]
            return None
        return row

    def list(self, symbol: Optional[str] = None, provider: Optional[str] = None, limit: int = 100) -> list[RegimeObservation]:
        q = self.db.query(RegimeObservation)
        if symbol:
            q = q.filter(RegimeObservation.symbol == symbol.strip().upper())
        if provider:
            q = q.filter(RegimeObservation.provider == provider.strip().lower())
        return q.order_by(RegimeObservation.as_of.desc()).limit(max(1, min(limit, 500))).all()

    def classify_from_closes(
        self,
        symbol: str,
        provider: str,
        closes: list[float],
        volumes: Optional[list[float]] = None,
        *,
        source: str = "council",
    ) -> Optional[RegimeObservation]:
        """Classify from bars that are all already known, then store it as of now."""
        if len(closes) < 5:
            return None
        from app.adaptive_edge.regime import MarketRegimeEngine  # lazy: keeps import graph acyclic

        snap = MarketRegimeEngine().assess(symbol, provider, closes, volumes)
        metrics = dict(snap.metrics)
        metrics["evidence"] = list(snap.evidence)
        return self.record(
            symbol,
            provider,
            snap.primary_regime,
            coexisting=snap.coexisting,
            confidence=snap.confidence,
            metrics=metrics,
            source=source,
        )
