"""Autonomous Strategy Edge Health Monitor."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional
import math
import statistics


class EdgeHealthStatus(str, Enum):
    EXCEPTIONAL = "EXCEPTIONAL"
    HEALTHY = "HEALTHY"
    STABLE = "STABLE"
    WEAKENING = "WEAKENING"
    DEGRADED = "DEGRADED"
    BROKEN = "BROKEN"
    SUSPENDED = "SUSPENDED"
    UNDER_VALIDATION = "UNDER_VALIDATION"


@dataclass
class TradeSample:
    pnl: float
    win: bool
    holding_bars: int = 0
    costs: float = 0.0
    regime: Optional[str] = None


@dataclass
class EdgeHealthReport:
    strategy_id: str
    status: str
    sample_size: int
    win_rate: Optional[float]
    expected_value: Optional[float]
    profit_factor: Optional[float]
    sharpe_approx: Optional[float]
    max_drawdown_pct: Optional[float]
    avg_win: Optional[float]
    avg_loss: Optional[float]
    risk_reward: Optional[float]
    recent_vs_long_term: Optional[float]
    edge_after_costs: Optional[float]
    regime_compatibility: Optional[float]
    reasons: list[str]
    metrics: dict[str, float]
    assessed_at: str
    previous_status: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class EdgeHealthMonitor:
    """
    Statistical edge assessment. High historical win rate alone is insufficient.
    Considers sample size, costs, regime fit, and recent vs long-term decay.
    """

    MIN_SAMPLE_STABLE = 20
    MIN_SAMPLE_ANY = 5

    def assess(
        self,
        strategy_id: str,
        trades: list[TradeSample],
        current_regime: Optional[str] = None,
        regime_suitability: Optional[float] = None,
        previous_status: Optional[str] = None,
        suspended: bool = False,
        under_validation: bool = False,
    ) -> EdgeHealthReport:
        reasons: list[str] = []
        metrics: dict[str, float] = {}
        n = len(trades)
        metrics["sample_size"] = float(n)

        if under_validation:
            return self._report(
                strategy_id, EdgeHealthStatus.UNDER_VALIDATION, n, None, None, None, None, None, None, None, None,
                None, None, regime_suitability, ["under_validation_pipeline"], metrics, previous_status,
            )
        if suspended:
            return self._report(
                strategy_id, EdgeHealthStatus.SUSPENDED, n, None, None, None, None, None, None, None, None,
                None, None, regime_suitability, ["manually_or_auto_suspended"], metrics, previous_status,
            )
        if n < self.MIN_SAMPLE_ANY:
            return self._report(
                strategy_id, EdgeHealthStatus.UNDER_VALIDATION, n, None, None, None, None, None, None, None, None,
                None, None, regime_suitability, ["insufficient_sample"], metrics, previous_status,
            )

        pnls = [t.pnl for t in trades]
        wins = [t for t in trades if t.win]
        losses = [t for t in trades if not t.win]
        win_rate = len(wins) / n
        metrics["win_rate"] = round(win_rate, 4)

        avg_win = statistics.mean([t.pnl for t in wins]) if wins else 0.0
        avg_loss = statistics.mean([t.pnl for t in losses]) if losses else 0.0
        metrics["avg_win"] = round(avg_win, 6)
        metrics["avg_loss"] = round(avg_loss, 6)
        rr = abs(avg_win / avg_loss) if avg_loss != 0 else (None if not losses else 10.0)
        if rr is not None:
            metrics["risk_reward"] = round(rr, 4)

        gross_wins = sum(t.pnl for t in wins)
        gross_losses = abs(sum(t.pnl for t in losses)) or 1e-9
        profit_factor = gross_wins / gross_losses
        metrics["profit_factor"] = round(profit_factor, 4)

        total_costs = sum(t.costs for t in trades)
        net_pnl = sum(pnls) - total_costs
        ev = net_pnl / n
        metrics["expected_value"] = round(ev, 6)
        metrics["total_costs"] = round(total_costs, 6)
        edge_after_costs = ev

        # Approximate Sharpe from trade PnLs
        if len(pnls) > 1:
            mu = statistics.mean(pnls)
            sd = statistics.stdev(pnls) or 1e-9
            sharpe = (mu / sd) * math.sqrt(min(n, 252))
        else:
            sharpe = 0.0
        metrics["sharpe_approx"] = round(sharpe, 4)

        # Drawdown from equity curve of trades
        equity = 0.0
        peak = 0.0
        max_dd = 0.0
        for p in pnls:
            equity += p
            peak = max(peak, equity)
            dd = (peak - equity) / abs(peak) if peak != 0 else 0.0
            max_dd = max(max_dd, dd)
        metrics["max_drawdown_pct"] = round(max_dd * 100, 4)

        # Recent vs long-term
        recent_vs_lt = None
        if n >= 12:
            half = n // 2
            recent_ev = statistics.mean(pnls[-half:])
            long_ev = statistics.mean(pnls[:half])
            if abs(long_ev) > 1e-9:
                recent_vs_lt = recent_ev / long_ev
            else:
                recent_vs_lt = 1.0 if recent_ev >= 0 else -1.0
            metrics["recent_vs_long_term"] = round(recent_vs_lt, 4)

        # Classification
        status = EdgeHealthStatus.STABLE
        if n < self.MIN_SAMPLE_STABLE:
            reasons.append("sample_below_stable_threshold")
            status = EdgeHealthStatus.UNDER_VALIDATION
        elif edge_after_costs <= 0 and profit_factor < 1.0:
            reasons.append("edge_eliminated_by_costs_or_negative_ev")
            status = EdgeHealthStatus.BROKEN
        elif max_dd > 0.35 and sharpe < 0.3:
            reasons.append("severe_drawdown_weak_sharpe")
            status = EdgeHealthStatus.DEGRADED
        elif recent_vs_lt is not None and recent_vs_lt < 0.4 and win_rate < 0.45:
            reasons.append("alpha_decay_recent_underperformance")
            status = EdgeHealthStatus.WEAKENING
        elif regime_suitability is not None and regime_suitability < 0.3:
            reasons.append("regime_incompatible")
            status = EdgeHealthStatus.WEAKENING
        elif profit_factor >= 1.8 and sharpe >= 1.2 and edge_after_costs > 0 and win_rate >= 0.5:
            status = EdgeHealthStatus.EXCEPTIONAL
            reasons.append("strong_risk_adjusted_edge")
        elif profit_factor >= 1.25 and edge_after_costs > 0 and sharpe >= 0.6:
            status = EdgeHealthStatus.HEALTHY
            reasons.append("positive_edge_after_costs")
        elif edge_after_costs > 0 and profit_factor >= 1.05:
            status = EdgeHealthStatus.STABLE
            reasons.append("marginal_but_positive_edge")
        else:
            status = EdgeHealthStatus.WEAKENING
            reasons.append("deteriorating_metrics")

        if previous_status == EdgeHealthStatus.BROKEN.value and status not in (
            EdgeHealthStatus.EXCEPTIONAL,
            EdgeHealthStatus.HEALTHY,
        ):
            reasons.append("prior_broken_not_fully_recovered")

        return self._report(
            strategy_id, status, n, win_rate, ev, profit_factor, sharpe, max_dd * 100,
            avg_win, avg_loss, rr, recent_vs_lt, edge_after_costs, regime_suitability,
            reasons, metrics, previous_status,
        )

    def _report(self, strategy_id, status, n, wr, ev, pf, sharpe, mdd, aw, al, rr, rvl, eac, regime, reasons, metrics, prev):
        return EdgeHealthReport(
            strategy_id=strategy_id,
            status=status.value if isinstance(status, EdgeHealthStatus) else status,
            sample_size=n,
            win_rate=round(wr, 4) if wr is not None else None,
            expected_value=round(ev, 6) if ev is not None else None,
            profit_factor=round(pf, 4) if pf is not None else None,
            sharpe_approx=round(sharpe, 4) if sharpe is not None else None,
            max_drawdown_pct=round(mdd, 4) if mdd is not None else None,
            avg_win=round(aw, 6) if aw is not None else None,
            avg_loss=round(al, 6) if al is not None else None,
            risk_reward=round(rr, 4) if rr is not None else None,
            recent_vs_long_term=round(rvl, 4) if rvl is not None else None,
            edge_after_costs=round(eac, 6) if eac is not None else None,
            regime_compatibility=round(regime, 4) if regime is not None else None,
            reasons=reasons,
            metrics=metrics,
            assessed_at=datetime.now(timezone.utc).isoformat(),
            previous_status=prev,
        )
