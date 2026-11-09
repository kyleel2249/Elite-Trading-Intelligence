"""Persistence + orchestration for the quant stack."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.quant import db_models as m
from app.quant.fair_value import FairValueResult, estimate_fair_value
from app.quant.kelly import KellyInput, KellyLimits, size_position
from app.quant.mispricing import VerificationEvidence, evaluate_mispricing
from app.quant.scanner import Coverage, ScanMetrics
from app.quant.scoring import OpportunityInput, rank
from app.quant.sentiment import SentimentItem, aggregate

LEDGER_STRATEGY = "mispricing_gt_8pct"


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class QuantStore:
    def __init__(self, db: Session):
        self.db = db

    # ---- audit ----
    def audit(self, event_type: str, actor: str = "system", detail: Optional[dict] = None) -> None:
        self.db.add(m.AuditEvent(event_type=event_type, actor=actor, detail=detail or {}))
        self.db.commit()

    # ---- scan ----
    def save_scan(self, metrics: ScanMetrics, coverage: dict[str, Coverage]) -> None:
        self.db.add(m.ScanRun(
            duration_seconds=metrics.duration_seconds, universe_size=metrics.universe_size,
            scanned_ok=metrics.scanned_ok, stale=metrics.stale, unavailable=metrics.unavailable,
            requests=metrics.requests, retries=metrics.retries, failovers=metrics.failovers,
            completion_pct=metrics.completion_pct, within_interval=metrics.within_interval,
            per_provider=metrics.per_provider))
        # Bulk upsert (single SELECT per 500 symbols, no N+1).
        symbols = list(coverage)
        existing: dict[str, m.MarketCoverage] = {}
        for i in range(0, len(symbols), 500):
            for row in self.db.query(m.MarketCoverage).filter(m.MarketCoverage.symbol.in_(symbols[i:i + 500])):
                existing[row.symbol] = row
        for sym, c in coverage.items():
            row = existing.get(sym) or m.MarketCoverage(symbol=sym, asset_class=c.asset_class, status=c.status)
            row.asset_class, row.exchange, row.provider = c.asset_class, c.exchange, c.provider
            row.failover_provider, row.status, row.price = c.failover_provider, c.status, c.price
            row.data_age_seconds, row.quality_score, row.fields = c.data_age_seconds, c.quality_score, c.fields
            row.last_success_ts, row.last_valid_data_ts = c.last_success_ts, c.last_valid_data_ts
            row.last_error, row.consecutive_failures = c.last_error, c.consecutive_failures
            if sym not in existing:
                self.db.add(row)
        self.db.commit()

    # ---- valuation ----
    def save_fair_value(self, fv: FairValueResult) -> int:
        row = m.FairValueEstimate(
            symbol=fv.symbol, asset_class=fv.asset_class, market_price=fv.market_price, fair_value=fv.fair_value,
            lower_bound=fv.lower_bound, upper_bound=fv.upper_bound, confidence=fv.confidence,
            supported=fv.supported, payload=fv.to_dict())
        self.db.add(row)
        self.db.commit()
        return row.id

    def record_mispricing(self, symbol: str, res) -> Optional[int]:
        if not res.flagged or res.mispricing_pct is None:
            return None
        open_alert = (self.db.query(m.MispricingAlert)
                      .filter_by(symbol=symbol, status="open", direction=res.direction).first())
        if open_alert:
            return open_alert.id        # keep the discovery-time numbers; never overwrite
        row = m.MispricingAlert(
            symbol=symbol, direction=res.direction, mispricing_pct=res.mispricing_pct, band=res.band,
            confirmed=res.confirmed, market_price_at_discovery=res.market_price,
            fair_value_at_discovery=res.fair_value, failed_checks=res.failed_checks,
            unverified_checks=res.unverified_checks)
        self.db.add(row)
        self.db.commit()
        return row.id

    def track_convergence(self, symbol: str, market_price: float) -> int:
        """Mark open alerts converged once the market is within 3% of the discovery fair value."""
        n = 0
        for a in self.db.query(m.MispricingAlert).filter_by(symbol=symbol, status="open"):
            gap = abs(a.fair_value_at_discovery - market_price) / a.fair_value_at_discovery * 100
            if gap <= 3.0:
                a.status, a.converged_at = "converged", _now()
                n += 1
        self.db.commit()
        return n

    # ---- predictions: written through the EXISTING append-only ledger ----
    def record_prediction(self, *, symbol: str, market_price: float, fair_value: float, mispricing_pct: float,
                          confidence: float, horizon_days: float, direction: str, invalidation: list[str],
                          strategy: str = LEDGER_STRATEGY, asset_class: Optional[str] = None):
        from app.prediction_ledger.service import create_prediction
        day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        key = f"fv:{symbol}:{direction}:{round(fair_value, 4)}:{day}"      # retry-safe
        row, _created = create_prediction(
            self.db, asset=symbol, market=(asset_class or "equity"), direction="up" if direction == "undervalued" else "down",
            entry_reference=market_price, horizon_seconds=int(max(1.0, horizon_days) * 86400),
            probability=min(0.99, max(0.01, float(confidence))),
            reasoning=f"Independent fair value {fair_value:.6g} vs market {market_price:.6g} "
                      f"({mispricing_pct:+.2f}% mispricing). Probability field carries valuation-model confidence.",
            sources=["internal:FairValueEngine:fv-1"], invalidation_criteria="; ".join(invalidation) or "n/a",
            target_base=fair_value, strategy=strategy, model_version="fv-1", idempotency_key=key)
        return row

    def ledger_rows(self, include_pending: bool = True) -> list[dict]:
        from app.prediction_ledger.service import scored_rows
        return [r for r in scored_rows(self.db, include_pending=include_pending) if r.get("strategy") == LEDGER_STRATEGY]

    def performance_summary(self) -> dict:
        rows = self.ledger_rows()
        scored = [r for r in rows if r.get("status") != "pending" and r.get("direction_correct") is not None]
        if not scored:
            return {"predictions": len(rows), "scored": 0, "hit_rate": None, "convergence_rate": None,
                    "note": "no scored predictions yet; no performance is claimed"}
        wins = [r["return_pct"] for r in scored if r["direction_correct"] and r.get("return_pct") is not None]
        losses = [r["return_pct"] for r in scored if not r["direction_correct"] and r.get("return_pct") is not None]
        conv = [r for r in scored if r.get("target_base") and r.get("realized_price")
                and abs(r["target_base"] - r["realized_price"]) / r["target_base"] * 100 <= 3.0]
        n = len(scored)
        return {"predictions": len(rows), "scored": n,
                "hit_rate": round(sum(1 for r in scored if r["direction_correct"]) / n, 4),
                "convergence_rate": round(len(conv) / n, 4),
                "false_positive_rate": round(sum(1 for r in scored if not r["direction_correct"]) / n, 4),
                "avg_win_pct": round(sum(wins) / len(wins), 3) if wins else None,
                "avg_loss_pct": round(sum(losses) / len(losses), 3) if losses else None}

    # ---- sizing / execution ----
    def save_kelly(self, symbol: Optional[str], inputs: dict, result: dict) -> None:
        self.db.add(m.KellyCalculation(symbol=symbol, approved=bool(result.get("approved")),
                                       final_allocation_pct=result.get("final_allocation_pct", 0.0),
                                       inputs=inputs, result=result))
        self.db.commit()

    def save_execution(self, rec: dict, symbol: str, environment: str) -> None:
        row = self.db.query(m.ExecutionEventRecord).filter_by(signal_id=rec["signal_id"]).first()
        if row is None:
            row = m.ExecutionEventRecord(signal_id=rec["signal_id"], symbol=symbol, environment=environment,
                                         state=rec["state"])
            self.db.add(row)
        row.state, row.client_order_id = rec["state"], rec.get("client_order_id")
        row.latency_ms, row.payload = rec.get("latency_ms"), rec
        self.db.commit()


def evaluate_opportunity(
    *, symbol: str, asset_class: str, coverage: Optional[Coverage], fair_value_inputs: dict[str, dict],
    sentiment_items: Optional[list[SentimentItem]] = None, components: Optional[dict[str, float]] = None,
    engine_votes: Optional[dict[str, str]] = None, hard_failures: Optional[list[str]] = None,
    side_hint: Optional[str] = None, stop_pct: float = 5.0, target_pct: Optional[float] = None,
    win_probability: Optional[float] = None, sample_size: int = 0, bankroll: Optional[float] = None,
    round_trip_cost_pct: float = 0.30, kelly_limits: Optional[KellyLimits] = None,
    sizing_context: Optional[dict] = None, max_age_seconds: float = 300.0,
) -> dict[str, Any]:
    """Run valuation -> mispricing -> sentiment -> ranking -> (optional) Kelly sizing.

    No step invents data: missing prices, stale quotes or unsupported valuations
    short-circuit to a rejected/unsupported result. ``sizing_context`` carries
    caller-verified facts (liquidity, corporate actions, event risk, horizon);
    anything not supplied stays "unverified" and blocks confirmation.
    """
    fails = list(hard_failures or [])
    out: dict[str, Any] = {"symbol": symbol, "asset_class": asset_class}
    if coverage is None or coverage.price is None:
        out.update(status="no_market_data", classification="REJECTED",
                   reasons=["instrument has no valid price from the scanner"])
        return out
    fresh = coverage.status == "ACTIVE" and (coverage.data_age_seconds or 0) <= max_age_seconds
    if not fresh:
        fails.append("stale_or_unavailable_market_data")
    price = coverage.price
    ctx = sizing_context or {}

    fv = estimate_fair_value(symbol, asset_class, price, fair_value_inputs)
    out["fair_value"] = fv.to_dict()
    sent = aggregate(symbol, sentiment_items or [], now=datetime.now(timezone.utc))
    out["sentiment"] = sent.to_dict()
    if not fv.supported:
        out.update(status="valuation_unsupported", classification="REJECTED", reasons=fv.reasons,
                   hard_failures=fails)
        return out

    models_vals = [e["value"] for e in fv.estimates]
    agree = len(models_vals) >= 2 and (all(v > price for v in models_vals) or all(v < price for v in models_vals))
    ev = VerificationEvidence(
        price_fresh=fresh, inputs_complete=fv.supported and fv.confidence >= 0.4, model_appropriate=True,
        corporate_action_or_data_error=ctx.get("corporate_action"),
        liquidity_adequate=ctx.get("liquidity_adequate"),
        round_trip_cost_pct=round_trip_cost_pct,
        fundamental_deterioration=ctx.get("fundamental_deterioration"),
        unresolved_event_risk=ctx.get("unresolved_event_risk"),
        independent_models_agree=agree,
        convergence_horizon_days=ctx.get("convergence_horizon_days"))
    mp = evaluate_mispricing(symbol, fv.fair_value, price, ev)
    out["mispricing"] = mp.to_dict()

    comps = dict(components or {})
    comps.setdefault("fair_value_discrepancy", min(100.0, mp.abs_mispricing_pct * 5))
    comps.setdefault("sentiment", sent.score_0_100 if sent.available and not sent.manipulation_suspected else 0.0)
    comps.setdefault("data_model_reliability", fv.confidence * 100 * (1.0 if fresh else 0.3))
    votes = dict(engine_votes or {})
    if mp.flagged:
        votes.setdefault("fair_value", "bullish" if mp.direction == "undervalued" else "bearish")
    if sent.available and not sent.manipulation_suspected and sent.label != "neutral":
        votes.setdefault("sentiment", "bullish" if "bullish" in sent.label else "bearish")
    opp = rank(OpportunityInput(symbol, comps, mp.mispricing_pct, mp.confirmed, asset_class, None, votes, fails))
    out["opportunity"] = opp.to_dict()
    out["classification"] = opp.classification
    out["engine_votes"] = votes

    out["sizing"] = None
    if (mp.confirmed and opp.classification in ("BUY CANDIDATE", "SELL CANDIDATE", "HIGH-CONVICTION")
            and bankroll and win_probability is not None):
        side = "buy" if mp.direction == "undervalued" else "sell"
        if side_hint and side_hint != side:
            out["sizing"] = {"approved": False, "reasons": ["requested side contradicts mispricing direction"]}
        else:
            stop = price * (1 - stop_pct / 100) if side == "buy" else price * (1 + stop_pct / 100)
            tgt_gap = min(abs(fv.fair_value - price), price * (target_pct or 100) / 100)
            tgt = price + tgt_gap if side == "buy" else price - tgt_gap
            k = size_position(KellyInput(bankroll=bankroll, entry_price=price, stop_price=stop, target_price=tgt,
                                         win_probability=win_probability, sample_size=sample_size, side=side,
                                         **ctx.get("kelly_extra", {})), kelly_limits)
            out["sizing"] = k.to_dict()
            out["trade_plan"] = {"side": side, "entry": price, "stop_loss": stop, "tp1": price + (tgt - price) * 0.5,
                                 "tp2": tgt, "tp3": fv.fair_value, "invalidation": [
                                     "price closes beyond stop", "fair value estimate drops below entry (re-valuation)",
                                     "data becomes stale", "material negative event"]}
    out["status"] = "evaluated"
    return out
