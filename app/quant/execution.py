"""Second-level execution engine.

Workflow per signal: idempotency -> kill switch/suspension -> live authorization
-> freshness -> liquidity -> 6% cap re-check -> RiskEngine preflight ->
route/submit -> acknowledgement -> fill reconciliation.

An order is never "executed" because a request was sent: states are
SUBMITTED, ACKNOWLEDGED, PARTIALLY_FILLED, FILLED, REJECTED, CANCELLED, FAILED.
Provider bracket orders are not implemented, so protective stop / take-profit
levels are *recorded and flagged as not attached* rather than claimed.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Awaitable, Callable, Optional

from app.config import Settings
from app.quant.controls import TradingControls, controls as global_controls
from app.quant.kelly import HARD_MAX_POSITION_PCT
from app.risk.engine import OrderProposal, RiskEngine


class OrderState(str, Enum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    SUBMITTED = "SUBMITTED"
    ACKNOWLEDGED = "ACKNOWLEDGED"
    PARTIALLY_FILLED = "PARTIALLY_FILLED"
    FILLED = "FILLED"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"
    FAILED = "FAILED"


TERMINAL = {OrderState.FILLED, OrderState.REJECTED, OrderState.CANCELLED, OrderState.FAILED}


@dataclass
class ExecutionSignal:
    signal_id: str                      # idempotency key
    provider: str
    environment: str                    # paper | testnet | live
    symbol: str
    side: str
    quantity: float
    entry_price: float
    stop_price: float
    take_profits: list[float] = field(default_factory=list)
    mispricing_confirmed: bool = False  # signals must come from validated opportunities
    data_age_seconds: Optional[float] = None
    data_status: str = "unknown"
    bid: Optional[float] = None
    ask: Optional[float] = None
    liquidity_notional: Optional[float] = None
    thesis: Optional[str] = None


@dataclass
class PortfolioContext:
    equity: float
    current_open_positions: int = 0
    daily_realized_pnl_pct: float = 0.0
    current_drawdown_pct: float = 0.0
    reduces_exposure: bool = False


@dataclass
class ExecutionRecord:
    signal_id: str
    client_order_id: Optional[str]
    state: OrderState
    side: str = "buy"
    reasons: list[str] = field(default_factory=list)
    order_type: Optional[str] = None
    limit_price: Optional[float] = None
    requested_qty: float = 0.0
    filled_qty: float = 0.0
    avg_fill_price: Optional[float] = None
    expected_price: Optional[float] = None
    slippage_bps: Optional[float] = None
    risk_decision: Optional[dict] = None
    provider_response: Optional[dict] = None
    protective_orders: dict = field(default_factory=lambda: {
        "status": "not_attached",
        "reason": "provider bracket orders not implemented; levels recorded for monitoring only"})
    latency_ms: dict[str, float] = field(default_factory=dict)
    history: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["state"] = self.state.value
        return d


Submitter = Callable[..., Awaitable[dict]]


class ExecutionEngine:
    def __init__(self, settings: Settings, submitter: Submitter, risk: Optional[RiskEngine] = None,
                 controls: Optional[TradingControls] = None, max_spread_bps: float = 50.0,
                 max_participation: float = 0.10):
        self.settings = settings
        self.submit = submitter
        self.risk = risk or RiskEngine(settings)
        self.controls = controls or global_controls
        self.max_spread_bps = max_spread_bps
        self.max_participation = max_participation
        self.records: dict[str, ExecutionRecord] = {}      # signal_id -> record
        self.by_client_id: dict[str, ExecutionRecord] = {}

    # ---------- helpers ----------
    def _set(self, rec: ExecutionRecord, state: OrderState, note: str = "") -> None:
        rec.state = state
        rec.history.append({"ts": datetime.now(timezone.utc).isoformat(), "state": state.value, "note": note})

    def _reject(self, rec: ExecutionRecord, reasons: list[str], t0: int) -> ExecutionRecord:
        rec.reasons.extend(reasons)
        self._set(rec, OrderState.REJECTED, "; ".join(reasons))
        rec.latency_ms["total"] = (time.perf_counter_ns() - t0) / 1e6
        self.controls.record_execution_outcome("REJECTED")
        return rec

    def choose_order_type(self, sig: ExecutionSignal) -> tuple[str, Optional[float]]:
        """Avoid blind market orders: live always limit; wide/unknown spread -> limit at entry."""
        spread_bps = None
        if sig.bid and sig.ask and sig.ask > 0:
            spread_bps = (sig.ask - sig.bid) / ((sig.ask + sig.bid) / 2) * 10_000
        if sig.environment == "live" or spread_bps is None or spread_bps > 10:
            if sig.bid and sig.ask:   # marketable limit: cross the spread with a small buffer
                buf = 1 + 0.0005 if sig.side == "buy" else 1 - 0.0005
                px = (sig.ask if sig.side == "buy" else sig.bid) * buf
            else:
                px = sig.entry_price
            return "limit", round(px, 8)
        return "market", None

    # ---------- main entry ----------
    async def execute(self, sig: ExecutionSignal, ctx: PortfolioContext) -> ExecutionRecord:
        t0 = time.perf_counter_ns()
        if sig.signal_id in self.records:          # duplicate-order prevention
            return self.records[sig.signal_id]
        rec = ExecutionRecord(sig.signal_id, None, OrderState.PENDING, side=sig.side, requested_qty=sig.quantity,
                              expected_price=sig.entry_price)
        self.records[sig.signal_id] = rec
        self._set(rec, OrderState.PENDING, "signal received")

        blocked = self.controls.trading_blocked()
        if blocked:
            return self._reject(rec, [blocked], t0)
        if sig.environment not in ("paper", "testnet", "live"):
            return self._reject(rec, ["unknown environment"], t0)
        if sig.environment == "live":
            if not self.settings.live_trading_enabled:
                return self._reject(rec, ["LIVE_TRADING_ENABLED is false"], t0)
            if not self.settings.api_key:
                return self._reject(rec, ["live execution requires API_KEY to be configured"], t0)
        if not sig.mispricing_confirmed:
            return self._reject(rec, ["signal is not a verified opportunity"], t0)
        if sig.quantity <= 0 or sig.entry_price <= 0:
            return self._reject(rec, ["invalid quantity or entry price"], t0)
        if (sig.data_age_seconds is None or sig.data_age_seconds > self.settings.data_max_age_seconds
                or sig.data_status in ("stale", "invalid", "unavailable", "incomplete", "unknown")):
            return self._reject(rec, ["price data is stale or unverified"], t0)

        # liquidity
        notional = sig.quantity * sig.entry_price
        if sig.bid and sig.ask:
            spread_bps = (sig.ask - sig.bid) / ((sig.ask + sig.bid) / 2) * 10_000
            if spread_bps > self.max_spread_bps:
                return self._reject(rec, [f"spread {spread_bps:.1f} bps exceeds {self.max_spread_bps}"], t0)
        if sig.liquidity_notional is not None and notional > sig.liquidity_notional * self.max_participation:
            return self._reject(rec, ["order exceeds liquidity participation limit"], t0)

        # independent 6% re-check (defence in depth; RiskEngine enforces it too)
        if ctx.equity <= 0:
            return self._reject(rec, ["equity unavailable"], t0)
        if not ctx.reduces_exposure and notional > ctx.equity * HARD_MAX_POSITION_PCT / 100 + 1e-9:
            return self._reject(rec, [f"notional exceeds {HARD_MAX_POSITION_PCT}% position cap"], t0)

        order_type, limit_price = self.choose_order_type(sig)
        rec.order_type, rec.limit_price = order_type, limit_price
        reference = limit_price or sig.entry_price
        # Risk preflight (same RiskEngine behind /api/risk-gateway/preflight)
        risk_amount = abs(sig.entry_price - sig.stop_price) * sig.quantity
        proposal = OrderProposal(
            provider=sig.provider, environment=sig.environment, symbol=sig.symbol.upper(), side=sig.side,
            qty=sig.quantity, order_type=order_type, limit_price=limit_price,
            stop_loss=sig.stop_price, take_profit=sig.take_profits[0] if sig.take_profits else None,
            client_order_id=None, equity=ctx.equity, current_open_positions=ctx.current_open_positions,
            daily_realized_pnl_pct=ctx.daily_realized_pnl_pct, current_drawdown_pct=ctx.current_drawdown_pct,
            estimated_risk_amount=risk_amount, data_age_seconds=sig.data_age_seconds, data_status=sig.data_status,
            reference_price=reference, reduces_exposure=ctx.reduces_exposure)
        decision = self.risk.evaluate(proposal)
        rec.risk_decision = {"decision": decision.decision.value, "reasons": decision.reasons,
                             "risk_per_trade_pct": decision.risk_per_trade_pct}
        rec.latency_ms["signal_to_risk"] = (time.perf_counter_ns() - t0) / 1e6
        if not decision.approved:
            return self._reject(rec, decision.reasons, t0)
        self._set(rec, OrderState.APPROVED, "risk gateway approved")

        # Route + submit
        t_sub = time.perf_counter_ns()
        try:
            resp = await self.submit(
                provider=sig.provider, environment=sig.environment, symbol=sig.symbol, side=sig.side,
                qty=sig.quantity, order_type=order_type, limit_price=limit_price,
                equity=ctx.equity, current_open_positions=ctx.current_open_positions,
                daily_realized_pnl_pct=ctx.daily_realized_pnl_pct,
                current_drawdown_pct=ctx.current_drawdown_pct, data_age_seconds=sig.data_age_seconds,
                data_status=sig.data_status, estimated_risk_amount=risk_amount, thesis=sig.thesis,
                fill_price_hint=sig.entry_price if sig.environment != "live" else None)
        except Exception as e:  # noqa: BLE001
            rec.reasons.append(f"submit error: {type(e).__name__}")
            self._set(rec, OrderState.FAILED, str(e)[:200])
            self.controls.record_execution_outcome("FAILED")
            return rec
        t_ack = time.perf_counter_ns()
        rec.latency_ms["risk_to_submit"] = (t_sub - t0) / 1e6 - rec.latency_ms["signal_to_risk"]
        rec.latency_ms["exchange_ack"] = (t_ack - t_sub) / 1e6
        rec.latency_ms["signal_to_ack"] = (t_ack - t0) / 1e6
        rec.provider_response = resp
        rec.client_order_id = resp.get("client_order_id")
        if rec.client_order_id:
            self.by_client_id[rec.client_order_id] = rec

        status = str(resp.get("status", "")).lower()
        if status == "rejected":
            return self._reject(rec, (resp.get("risk") or {}).get("reasons", ["rejected by trading service"]), t0)
        if status == "error":
            self._set(rec, OrderState.FAILED, str(resp.get("error"))[:200])
            self.controls.record_execution_outcome("FAILED")
            return rec
        self._set(rec, OrderState.SUBMITTED, "request sent")
        pr = resp.get("provider_response") or {}
        if pr.get("orderId") or pr.get("id"):
            self._set(rec, OrderState.ACKNOWLEDGED, "provider returned an order id")
        # Only a provider-reported fill counts as a fill.
        pstat = str(pr.get("status", "")).upper()
        executed = pr.get("executedQty") or pr.get("filled_qty")
        if pstat in ("FILLED", "PARTIALLY_FILLED") and executed is not None:
            px = pr.get("avgPrice") or pr.get("filled_avg_price") or pr.get("price")
            try:
                self.apply_fill_report(rec.client_order_id or sig.signal_id, float(executed),
                                       float(px) if px not in (None, "", "0", "0.0") else None, rec=rec)
            except (TypeError, ValueError):
                pass
        rec.latency_ms.setdefault("total", (time.perf_counter_ns() - t0) / 1e6)
        self.controls.record_execution_outcome(rec.state.value)
        return rec

    # ---------- reconciliation ----------
    def apply_fill_report(self, client_order_id: str, filled_qty: float, price: Optional[float],
                          rec: Optional[ExecutionRecord] = None) -> Optional[ExecutionRecord]:
        rec = rec or self.by_client_id.get(client_order_id) or self.records.get(client_order_id)
        if rec is None or rec.state in TERMINAL:
            return rec
        filled_qty = max(0.0, min(filled_qty, rec.requested_qty))
        rec.filled_qty = max(rec.filled_qty, filled_qty)
        if price is not None and filled_qty > 0:
            rec.avg_fill_price = price          # providers report the cumulative average price
            if rec.expected_price:
                adverse = 1 if rec.side == "buy" else -1
                rec.slippage_bps = adverse * (price - rec.expected_price) / rec.expected_price * 10_000
        if rec.filled_qty >= rec.requested_qty - 1e-12:
            self._set(rec, OrderState.FILLED, "fill confirmed")
            rec.latency_ms["fill"] = rec.latency_ms.get("signal_to_ack", 0.0)
        elif rec.filled_qty > 0:
            self._set(rec, OrderState.PARTIALLY_FILLED, f"{rec.filled_qty}/{rec.requested_qty}")
        return rec

    def cancel(self, signal_id: str) -> Optional[ExecutionRecord]:
        rec = self.records.get(signal_id)
        if rec and rec.state not in TERMINAL:
            self._set(rec, OrderState.CANCELLED, "cancelled")
        return rec

    def metrics(self) -> dict:
        recs = list(self.records.values())
        n = len(recs)
        def avg(key):
            xs = [r.latency_ms[key] for r in recs if key in r.latency_ms]
            return round(sum(xs) / len(xs), 3) if xs else None
        counts: dict[str, int] = {}
        for r in recs:
            counts[r.state.value] = counts.get(r.state.value, 0) + 1
        sl = [r.slippage_bps for r in recs if r.slippage_bps is not None]
        return {"orders": n, "state_counts": counts,
                "rejection_rate": round(counts.get("REJECTED", 0) / n, 4) if n else None,
                "partial_fill_rate": round(counts.get("PARTIALLY_FILLED", 0) / n, 4) if n else None,
                "avg_signal_to_risk_ms": avg("signal_to_risk"), "avg_risk_to_submit_ms": avg("risk_to_submit"),
                "avg_exchange_ack_ms": avg("exchange_ack"), "avg_signal_to_ack_ms": avg("signal_to_ack"),
                "avg_slippage_bps": round(sum(sl) / len(sl), 3) if sl else None}
