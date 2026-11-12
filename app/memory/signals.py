"""Signal memory: record predictions exactly as known at the time, score them later.

Bias controls
-------------
* look-ahead : a signal cannot be dated in the future; an outcome cannot be dated before the
  signal's horizon has elapsed; the original analysis is hash-fingerprinted.
* survivorship: signals that expired unscored, were not scorable or are still pending stay in the
  population report - accuracy is never computed on survivors only.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.memory.models import MemorySignal
from app.memory.partition import LeakageError, assert_not_future
from app.memory.regimes import RegimeMemoryService
from app.memory.util import (
    as_utc, clamp, is_finite_number, naive_utc, sha256_json, utcnow, wilson_interval,
)

SOURCES = frozenset({"council", "strategy_runner", "forecast", "manual"})
DIRECTIONS = frozenset({"long", "short", "flat", "exit", "unknown"})

_LONG = {"buy", "long", "strong_buy", "accumulate", "enter_long", "bullish"}
_SHORT = {"sell", "short", "strong_sell", "enter_short", "bearish"}
_FLAT = {"hold", "flat", "neutral", "wait", "no_trade", "avoid", "watch", "stand_aside", "no_action"}
_EXIT = {"exit_long", "exit_short", "exit", "close", "close_long", "close_short", "reduce", "trim"}


def direction_from_action(action: Optional[str]) -> str:
    a = (action or "").strip().lower().replace("-", "_").replace(" ", "_")
    if a in _LONG:
        return "long"
    if a in _SHORT:
        return "short"
    if a in _FLAT:
        return "flat"
    if a in _EXIT:
        return "exit"
    return "unknown"


def derive_assumptions(
    direction: str,
    explicit: Optional[list[dict[str, Any]]],
    *,
    stop: Optional[float],
    target: Optional[float],
    horizon: Optional[int],
    regime: Optional[str],
) -> list[dict[str, Any]]:
    """Explicit assumptions plus the ones implied by the signal's own claims (nothing invented)."""
    items = [dict(a) for a in (explicit or []) if isinstance(a, dict)]
    for a in items:
        a.setdefault("type", "custom")
        a.setdefault("id", str(a["type"]))
    have = {a["type"] for a in items}

    def add(t: str, statement: str) -> None:
        if t not in have:
            items.append({"id": t, "type": t, "statement": statement, "derived": True})
            have.add(t)

    if direction in ("long", "short"):
        add("direction", f"price moves {'up' if direction == 'long' else 'down'} after entry")
        if target:
            add("target_reached", f"price reaches target {target}")
        if stop:
            add("stop_respected", f"risk is bounded at stop {stop}")
        if horizon:
            add("horizon", f"thesis plays out within {horizon}s")
        if regime:
            add("regime_stable", f"regime stays '{regime}' while the trade is open")
    return items


def fingerprint(sig_fields: dict[str, Any]) -> str:
    keys = ("direction", "confidence", "reference_price", "stop_price", "target_price", "horizon_seconds",
            "strategy_id", "symbol", "provider", "assumptions", "analysis")
    return sha256_json({k: sig_fields.get(k) for k in keys})


def signal_fingerprint(sig: MemorySignal) -> str:
    return fingerprint({
        "direction": sig.direction, "confidence": sig.confidence, "reference_price": sig.reference_price,
        "stop_price": sig.stop_price, "target_price": sig.target_price, "horizon_seconds": sig.horizon_seconds,
        "strategy_id": sig.strategy_id, "symbol": sig.symbol, "provider": sig.provider,
        "assumptions": sig.assumptions, "analysis": sig.analysis,
    })


def _positive(x: Any, name: str) -> Optional[float]:
    if x is None:
        return None
    if not is_finite_number(x) or float(x) <= 0:
        raise ValueError(f"{name} must be a positive finite number")
    return float(x)


class SignalMemoryService:
    def __init__(self, db: Session, settings: Optional[Settings] = None):
        self.db = db
        self.settings = settings or get_settings()

    # -- record -------------------------------------------------------------------------------
    def record(
        self,
        *,
        source: str,
        symbol: str,
        provider: str,
        direction: Optional[str] = None,
        action: Optional[str] = None,
        confidence: Optional[float] = None,
        reference_price: Optional[float] = None,
        stop_price: Optional[float] = None,
        target_price: Optional[float] = None,
        horizon_seconds: Optional[int] = None,
        strategy_id: Optional[str] = None,
        strategy_version: Optional[int] = None,
        regime: Optional[str] = None,
        assumptions: Optional[list[dict[str, Any]]] = None,
        analysis: Optional[dict[str, Any]] = None,
        as_of: Optional[datetime] = None,
        dedupe: bool = True,
    ) -> MemorySignal:
        if source not in SOURCES:
            raise ValueError(f"source must be one of {sorted(SOURCES)}")
        sym = (symbol or "").strip().upper()
        prov = (provider or "").strip().lower()
        if not sym or not prov:
            raise ValueError("symbol and provider are required")
        direction = (direction or direction_from_action(action)).lower()
        if direction not in DIRECTIONS:
            raise ValueError(f"direction must be one of {sorted(DIRECTIONS)}")

        ts = as_utc(as_of) if as_of is not None else utcnow()
        assert_not_future(ts, label="signal as_of")

        conf: Optional[float] = None
        if confidence is not None:
            if not is_finite_number(confidence) or confidence < 0:
                raise ValueError("confidence must be a non-negative finite number")
            conf = float(confidence) / 100.0 if confidence > 1.0 else float(confidence)
            conf = clamp(conf, 0.0, 1.0)

        ref = _positive(reference_price, "reference_price")
        stop = _positive(stop_price, "stop_price")
        target = _positive(target_price, "target_price")
        if direction in ("long", "short") and ref and (stop or target):
            if direction == "long" and ((stop and stop >= ref) or (target and target <= ref)):
                raise ValueError("long signal needs stop < reference < target")
            if direction == "short" and ((stop and stop <= ref) or (target and target >= ref)):
                raise ValueError("short signal needs target < reference < stop")

        horizon = horizon_seconds
        if horizon is not None and (not isinstance(horizon, int) or horizon <= 0):
            raise ValueError("horizon_seconds must be a positive integer")
        if horizon is None and direction in ("long", "short", "flat"):
            horizon = int(self.settings.memory_default_signal_horizon_seconds)

        if regime is None:
            obs = RegimeMemoryService(self.db, self.settings).latest_as_of(sym, prov, ts)
            regime = obs.primary_regime if obs else None

        if dedupe:
            window = ts - timedelta(seconds=int(self.settings.memory_signal_dedupe_seconds))
            q = self.db.query(MemorySignal).filter(
                MemorySignal.source == source, MemorySignal.symbol == sym, MemorySignal.provider == prov,
                MemorySignal.direction == direction, MemorySignal.status == "open",
                MemorySignal.as_of >= naive_utc(window),
            )
            if strategy_id:
                q = q.filter(MemorySignal.strategy_id == strategy_id)
            existing = q.order_by(MemorySignal.as_of.desc()).first()
            if existing is not None:
                return existing

        items = derive_assumptions(direction, assumptions, stop=stop, target=target, horizon=horizon, regime=regime)
        fields = {
            "direction": direction, "confidence": conf, "reference_price": ref, "stop_price": stop,
            "target_price": target, "horizon_seconds": horizon, "strategy_id": strategy_id, "symbol": sym,
            "provider": prov, "assumptions": items, "analysis": analysis or {},
        }
        row = MemorySignal(
            signal_id=f"sig-{uuid.uuid4().hex[:20]}", source=source, strategy_id=strategy_id,
            strategy_version=strategy_version, symbol=sym, provider=prov, direction=direction,
            confidence=conf, reference_price=ref, stop_price=stop, target_price=target,
            horizon_seconds=horizon, regime=regime, assumptions=items, analysis=analysis or {},
            analysis_sha256=fingerprint(fields), as_of=ts, data_partition="live", status="open",
            outcome_status="pending",
        )
        self.db.add(row)
        self.db.commit()
        self.db.refresh(row)
        return row

    def get(self, signal_id: str) -> Optional[MemorySignal]:
        return self.db.query(MemorySignal).filter(MemorySignal.signal_id == signal_id).one_or_none()

    def list(
        self,
        *,
        symbol: Optional[str] = None,
        strategy_id: Optional[str] = None,
        source: Optional[str] = None,
        outcome_status: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[MemorySignal]:
        q = self.db.query(MemorySignal)
        if symbol:
            q = q.filter(MemorySignal.symbol == symbol.strip().upper())
        if strategy_id:
            q = q.filter(MemorySignal.strategy_id == strategy_id)
        if source:
            q = q.filter(MemorySignal.source == source)
        if outcome_status:
            q = q.filter(MemorySignal.outcome_status == outcome_status)
        return q.order_by(MemorySignal.as_of.desc()).offset(max(0, offset)).limit(max(1, min(limit, 500))).all()

    # -- resolution ---------------------------------------------------------------------------
    @staticmethod
    def due_at(sig: MemorySignal) -> Optional[datetime]:
        if not sig.horizon_seconds:
            return None
        return as_utc(sig.as_of) + timedelta(seconds=int(sig.horizon_seconds))  # type: ignore[operator]

    def _tolerance(self, sig: MemorySignal) -> timedelta:
        return timedelta(seconds=max(300.0, 0.25 * float(sig.horizon_seconds or 0)))

    def resolve_signal(
        self,
        sig: MemorySignal,
        outcome_price: float,
        outcome_ts: datetime,
        *,
        now: Optional[datetime] = None,
        commit: bool = True,
    ) -> MemorySignal:
        if sig.outcome_status != "pending":
            raise ValueError("signal already resolved")
        due = self.due_at(sig)
        if due is None:
            raise ValueError("signal has no horizon; it cannot be scored automatically")
        if not is_finite_number(outcome_price) or outcome_price <= 0:
            raise ValueError("outcome_price must be a positive finite number")
        ots = as_utc(outcome_ts)
        if ots < due:  # type: ignore[operator]
            raise LeakageError("outcome is dated before the signal horizon elapsed")
        assert_not_future(ots, now, label="outcome_ts")  # type: ignore[arg-type]

        sig.outcome_price = float(outcome_price)
        sig.outcome_ts = ots
        sig.resolution_lag_seconds = (ots - due).total_seconds()  # type: ignore[operator]

        if sig.direction not in ("long", "short", "flat") or not sig.reference_price:
            sig.outcome_status = "not_scored"
            sig.outcome_note = "direction not scorable or no reference price"
        else:
            raw = (float(outcome_price) - sig.reference_price) / sig.reference_price * 100.0
            if sig.direction == "flat":
                ok = abs(raw) <= float(self.settings.memory_flat_band_pct)
                sig.outcome = "flat_ok" if ok else "flat_miss"
                sig.outcome_return_pct = raw
            else:
                ret = raw if sig.direction == "long" else -raw
                sig.outcome = "hit" if ret > 0 else "miss"
                sig.outcome_return_pct = ret
            sig.outcome_status = "scored"
        if commit:
            self.db.commit()
            self.db.refresh(sig)
        return sig

    def pending_due(self, now: Optional[datetime] = None, limit: int = 500) -> list[MemorySignal]:
        t = as_utc(now) if now is not None else utcnow()
        rows = (
            self.db.query(MemorySignal)
            .filter(MemorySignal.outcome_status == "pending", MemorySignal.horizon_seconds.isnot(None))
            .order_by(MemorySignal.as_of.asc())
            .limit(limit)
            .all()
        )
        return [r for r in rows if (self.due_at(r) or t) <= t]  # type: ignore[operator]

    def due_keys(self, now: Optional[datetime] = None) -> set[tuple[str, str]]:
        """(provider, symbol) pairs that still have a scorable due signal (inside tolerance)."""
        t = as_utc(now) if now is not None else utcnow()
        return {
            (r.provider, r.symbol)
            for r in self.pending_due(t)
            if (t - self.due_at(r)) <= self._tolerance(r)  # type: ignore[operator]
        }

    def resolve_due(self, prices: dict[tuple[str, str], float], now: Optional[datetime] = None) -> dict[str, Any]:
        """Score due signals with a *current* price only when it is close enough to the horizon;
        otherwise mark the signal expired_unscored (kept in the population, never dropped)."""
        t = as_utc(now) if now is not None else utcnow()
        scored = expired = waiting = 0
        for sig in self.pending_due(t):
            lag = t - self.due_at(sig)  # type: ignore[operator]
            if lag > self._tolerance(sig):
                sig.outcome_status = "expired_unscored"
                sig.outcome_note = "resolution window missed; no point-in-time price available"
                expired += 1
                continue
            px = prices.get((sig.provider, sig.symbol))
            if px is None:
                waiting += 1
                continue
            try:
                self.resolve_signal(sig, px, t, now=t, commit=False)
                scored += 1
            except ValueError:
                waiting += 1
        self.db.commit()
        return {"scored": scored, "expired_unscored": expired, "waiting_for_price": waiting}

    def link_trade(self, sig: MemorySignal, trade_id: str) -> None:
        sig.status = "executed"
        sig.trade_id = trade_id

    # -- accuracy -----------------------------------------------------------------------------
    def accuracy(
        self,
        *,
        strategy_id: Optional[str] = None,
        symbol: Optional[str] = None,
        regime: Optional[str] = None,
        source: Optional[str] = None,
        since: Optional[datetime] = None,
        until: Optional[datetime] = None,
    ) -> dict[str, Any]:
        q = self.db.query(MemorySignal)
        if strategy_id:
            q = q.filter(MemorySignal.strategy_id == strategy_id)
        if symbol:
            q = q.filter(MemorySignal.symbol == symbol.strip().upper())
        if regime:
            q = q.filter(MemorySignal.regime == regime)
        if source:
            q = q.filter(MemorySignal.source == source)
        if since:
            q = q.filter(MemorySignal.as_of >= naive_utc(since))
        if until:
            q = q.filter(MemorySignal.as_of <= naive_utc(until))
        rows = q.limit(10000).all()

        population: dict[str, int] = {"total": len(rows), "pending": 0, "scored": 0, "expired_unscored": 0, "not_scored": 0}
        for r in rows:
            population[r.outcome_status] = population.get(r.outcome_status, 0) + 1

        directional = [r for r in rows if r.outcome in ("hit", "miss")]
        flat = [r for r in rows if r.outcome in ("flat_ok", "flat_miss")]
        hits = sum(1 for r in directional if r.outcome == "hit")
        n = len(directional)
        ci = wilson_interval(hits, n)
        rets = [r.outcome_return_pct for r in directional if r.outcome_return_pct is not None]
        with_conf = [r for r in directional if r.confidence is not None]
        brier = (
            sum((r.confidence - (1.0 if r.outcome == "hit" else 0.0)) ** 2 for r in with_conf) / len(with_conf)
            if with_conf else None
        )

        buckets = []
        edges = [0.0, 0.2, 0.4, 0.6, 0.8, 1.0001]
        for lo, hi in zip(edges[:-1], edges[1:]):
            b = [r for r in with_conf if lo <= r.confidence < hi]
            if b:
                buckets.append({
                    "bucket": f"{lo:.1f}-{min(hi, 1.0):.1f}", "n": len(b),
                    "mean_confidence": round(sum(r.confidence for r in b) / len(b), 4),
                    "hit_rate": round(sum(1 for r in b if r.outcome == "hit") / len(b), 4),
                })

        def group(attr: str) -> dict[str, Any]:
            g: dict[str, list[MemorySignal]] = {}
            for r in directional:
                g.setdefault(getattr(r, attr) or "unknown", []).append(r)
            return {k: {"n": len(v), "hit_rate": round(sum(1 for r in v if r.outcome == "hit") / len(v), 4)} for k, v in g.items()}

        coverage_den = population["scored"] + population["expired_unscored"]
        return {
            "population": population,
            "coverage": round(population["scored"] / coverage_den, 4) if coverage_den else None,
            "directional": {
                "n": n, "hits": hits, "hit_rate": round(hits / n, 4) if n else None,
                "wilson95": [round(ci[0], 4), round(ci[1], 4)] if ci else None,
                "mean_return_pct": round(sum(rets) / len(rets), 4) if rets else None,
                "brier_score": round(brier, 4) if brier is not None else None,
            },
            "flat": {"n": len(flat), "ok_rate": round(sum(1 for r in flat if r.outcome == "flat_ok") / len(flat), 4) if flat else None},
            "calibration": buckets,
            "by_regime": group("regime"),
            "by_strategy": group("strategy_id"),
            "notes": [
                "Expired/pending/unscorable signals are counted in population - accuracy is not survivor-only.",
                "Hit rate with n < 30 is not statistically meaningful." if n < 30 else "Sample size adequate for a rough estimate.",
                "Signals are scored at the horizon using a price captured within a tolerance window; the lag is stored.",
            ],
        }
