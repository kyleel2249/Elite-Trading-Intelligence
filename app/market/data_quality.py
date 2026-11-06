"""Data quality and freshness engine."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from app.integrations.base import NormalizedQuote


def assess_quote(quote: NormalizedQuote, max_age_seconds: int = 300) -> NormalizedQuote:
    now = datetime.now(timezone.utc)
    age = (now - quote.ts_utc.replace(tzinfo=timezone.utc)).total_seconds() if quote.ts_utc else None
    status = quote.data_status or "unknown"

    if quote.price is None or quote.price <= 0:
        status = "invalid"
    elif age is not None:
        if age < 0:
            status = "invalid"  # future timestamp
        elif age > max_age_seconds * 3:
            status = "stale"
        elif age > max_age_seconds:
            status = "delayed"
        else:
            status = "fresh"

    if quote.bid is not None and quote.ask is not None:
        if quote.bid > quote.ask:
            status = "invalid"

    quote.data_status = status
    return quote


def validate_ohlc(o: float, h: float, l: float, c: float) -> list[str]:
    issues: list[str] = []
    if min(o, h, l, c) <= 0:
        issues.append("non_positive_price")
    if h < max(o, c) or l > min(o, c):
        issues.append("invalid_ohlc_relationship")
    if h < l:
        issues.append("high_lt_low")
    return issues


def assess_kline(kline: dict[str, Any], max_age_seconds: int = 3600) -> dict[str, Any]:
    issues = validate_ohlc(kline["open"], kline["high"], kline["low"], kline["close"])
    status = "valid" if not issues else "invalid"
    age = None
    if "close_time" in kline:
        try:
            ct = datetime.fromtimestamp(kline["close_time"] / 1000, tz=timezone.utc)
            age = (datetime.now(timezone.utc) - ct).total_seconds()
            if age > max_age_seconds * 3:
                status = "stale" if status == "valid" else status
            elif age > max_age_seconds:
                status = "delayed" if status == "valid" else status
        except Exception:
            pass
    return {**kline, "data_status": status, "quality_issues": issues, "age_seconds": age}
