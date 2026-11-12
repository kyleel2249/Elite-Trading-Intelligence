"""Crypto derivatives crowding evidence (funding rate + open interest) and new-listing detection.

Funding/OI describe positioning, not value: they flag crowded trades (a risk) or crowded shorts (a possible
contrarian setup). Thresholds are ETI parameters, not exchange or investor rules. Evidence only: never an approval."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.alpha.db_models import AlphaKnownAsset
from app.alpha.providers import BinanceFutures

FUNDING_ELEVATED = 0.0005   # 0.05% per 8h
FUNDING_EXTREME = 0.0010    # 0.10% per 8h
OI_RISE_PCT = 20.0          # open-interest value change over the window, percent


def derivatives_view(funding_rate: Optional[float], oi_series: list[dict[str, float]]) -> dict[str, Any]:
    if funding_rate is None:
        return {"state": "UNKNOWN", "reason": "no futures funding data (spot-only symbol or provider unavailable)"}
    oi_change = None
    if len(oi_series) >= 2 and oi_series[0]["oi_value"] > 0:
        oi_change = (oi_series[-1]["oi_value"] / oi_series[0]["oi_value"] - 1) * 100
    state, why = "NEUTRAL", [f"funding {funding_rate * 100:.4f}% per 8h"]
    if oi_change is not None:
        why.append(f"open interest {oi_change:+.1f}% over {len(oi_series)} daily points")
    if funding_rate >= FUNDING_ELEVATED and (oi_change or 0) >= OI_RISE_PCT:
        state = "CROWDED_LONG_RISK"
    elif funding_rate >= FUNDING_EXTREME:
        state = "CROWDED_LONG_RISK"
    elif funding_rate <= -FUNDING_ELEVATED:
        state = "SHORTS_CROWDED"
    return {"state": state, "funding_rate": funding_rate, "oi_change_pct": round(oi_change, 2) if oi_change is not None else None, "evidence": why,
            "extreme": funding_rate >= FUNDING_EXTREME, "note": "positioning evidence only; thresholds are ETI parameters"}


async def load_derivatives(fut: BinanceFutures, symbol: str) -> dict[str, Any]:
    try:
        f = await fut.funding(symbol)
    except Exception:  # noqa: BLE001 - spot-only symbols return 400; provider status is recorded by the adapter
        return {"state": "UNKNOWN", "reason": "futures data unavailable"}
    if f is None:
        return {"state": "UNKNOWN", "reason": "no funding rate returned"}
    try:
        oi = await fut.open_interest_hist(symbol)
    except Exception:  # noqa: BLE001
        oi = []
    return derivatives_view(f["funding_rate"], oi)


def detect_new_listings(db: Session, provider: str, symbols: list[str], now: Optional[datetime] = None) -> dict[str, Any]:
    """First call per provider seeds a baseline (nothing is called 'new'); later calls flag symbols never seen before."""
    now = (now or datetime.now(timezone.utc)).replace(tzinfo=None)
    known = {r.symbol for r in db.query(AlphaKnownAsset).filter_by(provider=provider).all()}
    if not known:
        for sym in symbols:
            db.add(AlphaKnownAsset(provider=provider, symbol=sym, first_seen=now, baseline=True))
        db.commit()
        return {"baseline_seeded": len(symbols), "new": []}
    new = [s for s in symbols if s not in known]
    for sym in new:
        db.add(AlphaKnownAsset(provider=provider, symbol=sym, first_seen=now, baseline=False))
    if new:
        db.commit()
    return {"baseline_seeded": 0, "new": new}


def recent_listings(db: Session, provider: str = "binance_public", days: int = 30, now: Optional[datetime] = None) -> list[dict[str, Any]]:
    now = (now or datetime.now(timezone.utc)).replace(tzinfo=None)
    rows = (db.query(AlphaKnownAsset).filter(AlphaKnownAsset.provider == provider, AlphaKnownAsset.baseline.is_(False),
                                             AlphaKnownAsset.first_seen >= now - timedelta(days=days)).order_by(AlphaKnownAsset.first_seen.desc()).all())
    return [{"symbol": r.symbol, "first_seen": r.first_seen.isoformat(), "age_days": round((now - r.first_seen).total_seconds() / 86400, 2),
             "scoreable": (now - r.first_seen).days >= 60, "note": "needs >= 60 daily bars before ETI will score it"} for r in rows]
