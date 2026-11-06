"""Persist market snapshots, orders, council decisions, forecasts."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.models import MarketSnapshot, OrderRecord, RiskEvent, CouncilDecisionRecord, ForecastRecord


def save_snapshot(db: Session, snap: dict[str, Any]) -> MarketSnapshot:
    row = MarketSnapshot(
        provider=snap.get("provider", "unknown"),
        symbol=snap.get("symbol", ""),
        price=float(snap.get("price") or 0),
        bid=snap.get("bid"),
        ask=snap.get("ask"),
        volume=snap.get("volume"),
        ts_provider=None,
        ts_utc=datetime.utcnow(),
        data_status=snap.get("data_status", "unknown"),
        quality_flags={"exchange": snap.get("exchange"), "quote_currency": snap.get("quote_currency")},
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def save_order(db: Session, payload: dict[str, Any]) -> OrderRecord:
    risk = payload.get("risk") or {}
    row = OrderRecord(
        client_order_id=payload.get("client_order_id") or f"unknown-{datetime.utcnow().timestamp()}",
        provider=payload.get("provider", "unknown"),
        environment=payload.get("environment", "paper"),
        symbol=payload.get("symbol", ""),
        side=payload.get("side", ""),
        order_type=payload.get("order_type", "market"),
        qty=float(payload.get("qty") or 0),
        limit_price=payload.get("limit_price"),
        fill_price=payload.get("fill_price"),
        status=payload.get("status", "unknown"),
        provider_order_id=str(
            (payload.get("provider_response") or {}).get("orderId")
            or (payload.get("provider_response") or {}).get("id")
            or ""
        )
        or None,
        risk_approved=bool(risk.get("decision") == "APPROVED"),
        risk_notes=str(risk.get("notes") or risk.get("reasons") or ""),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def save_council_decision(db: Session, symbol: str, provider: str, decision: dict[str, Any]) -> CouncilDecisionRecord:
    row = CouncilDecisionRecord(
        symbol=symbol,
        provider=provider,
        action=decision.get("action", "WAIT"),
        confidence=float(decision.get("confidence") or 0),
        summary=decision.get("summary") or "",
        risk_veto=bool(decision.get("risk_veto")),
        data_quality=decision.get("data_quality") or "unknown",
        payload=decision,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def save_forecast(db: Session, forecast: dict[str, Any]) -> ForecastRecord:
    scenarios = forecast.get("scenarios") or {}
    row = ForecastRecord(
        symbol=forecast.get("symbol", ""),
        provider=forecast.get("provider", ""),
        horizon=forecast.get("horizon", "intraday"),
        model_version=forecast.get("model_version", "v0-scaffold"),
        analyst=forecast.get("analyst", "Lars Hagen"),
        bull_price=scenarios.get("bull"),
        base_price=scenarios.get("base"),
        bear_price=scenarios.get("bear"),
        expected_vol=forecast.get("expected_vol"),
        confidence=float(forecast.get("confidence") or 0),
        payload=forecast,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def log_risk_event(
    db: Session, event_type: str, severity: str, message: str, context: Optional[dict] = None
) -> RiskEvent:
    row = RiskEvent(event_type=event_type, severity=severity, message=message, context=context)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row
