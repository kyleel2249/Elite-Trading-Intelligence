"""Market Change Detection & Early Warning System."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional
import math
import statistics


class ChangeSeverity(str, Enum):
    NORMAL_FLUCTUATION = "NORMAL_FLUCTUATION"
    EARLY_WARNING = "EARLY_WARNING"
    MATERIAL_MARKET_CHANGE = "MATERIAL_MARKET_CHANGE"
    STRATEGY_DISRUPTION = "STRATEGY_DISRUPTION"
    MAJOR_REGIME_TRANSITION = "MAJOR_REGIME_TRANSITION"
    MARKET_EMERGENCY = "MARKET_EMERGENCY"


@dataclass
class ChangeEvent:
    event_id: str
    severity: str
    confidence: float
    affected_instruments: list[str]
    affected_asset_classes: list[str]
    affected_strategies: list[str]
    expected_portfolio_impact: str
    recommended_response: str
    evidence: list[str]
    metrics: dict[str, float]
    timestamp: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class MarketChangeDetector:
    """
    Multi-evidence change detector.
    Uses CUSUM-style cumulative sums, rolling distribution shifts,
    and correlation/vol structural breaks. Requires corroboration
    before elevating severity above EARLY_WARNING.
    """

    def __init__(self, cusum_threshold: float = 4.0):
        self.cusum_threshold = cusum_threshold
        self._cusum_pos: dict[str, float] = {}
        self._cusum_neg: dict[str, float] = {}
        self._baseline_mean: dict[str, float] = {}
        self._baseline_std: dict[str, float] = {}

    def update_baseline(self, key: str, series: list[float]) -> None:
        if len(series) < 5:
            return
        self._baseline_mean[key] = statistics.mean(series)
        self._baseline_std[key] = statistics.stdev(series) if len(series) > 1 else 1e-6

    def _cusum_step(self, key: str, value: float) -> tuple[float, float]:
        mean = self._baseline_mean.get(key, 0.0)
        std = max(self._baseline_std.get(key, 1e-6), 1e-6)
        z = (value - mean) / std
        pos = max(0.0, self._cusum_pos.get(key, 0.0) + z - 0.5)
        neg = max(0.0, self._cusum_neg.get(key, 0.0) - z - 0.5)
        self._cusum_pos[key] = pos
        self._cusum_neg[key] = neg
        return pos, neg

    def detect(
        self,
        symbol: str,
        closes: list[float],
        volumes: Optional[list[float]] = None,
        previous_regime: Optional[str] = None,
        current_regime: Optional[str] = None,
        strategy_health_flags: Optional[list[str]] = None,
        correlation_shift: Optional[float] = None,
        spread_bps: Optional[float] = None,
        funding_rate: Optional[float] = None,
    ) -> Optional[ChangeEvent]:
        evidence: list[str] = []
        metrics: dict[str, float] = {}
        signals = 0
        max_severity = ChangeSeverity.NORMAL_FLUCTUATION

        if len(closes) < 10:
            return None

        rets = []
        for i in range(1, len(closes)):
            if closes[i - 1]:
                rets.append((closes[i] - closes[i - 1]) / closes[i - 1])
        if len(rets) < 5:
            return None

        key = f"{symbol}:ret"
        hist = rets[:-5] if len(rets) > 10 else rets[: max(5, len(rets) // 2)]
        self.update_baseline(key, hist)
        recent = rets[-1]
        pos, neg = self._cusum_step(key, recent)
        metrics["cusum_pos"] = round(pos, 4)
        metrics["cusum_neg"] = round(neg, 4)
        metrics["last_return"] = round(recent, 6)

        if pos > self.cusum_threshold or neg > self.cusum_threshold:
            signals += 1
            evidence.append(f"cusum_break_pos={pos:.2f}_neg={neg:.2f}")
            max_severity = ChangeSeverity.EARLY_WARNING

        # Volatility expansion
        short_vol = statistics.stdev(rets[-10:]) if len(rets) >= 10 else statistics.stdev(rets)
        long_vol = statistics.stdev(rets[-40:]) if len(rets) >= 40 else statistics.stdev(rets)
        metrics["short_vol"] = round(short_vol, 6)
        metrics["long_vol"] = round(long_vol, 6)
        if long_vol > 0 and short_vol > long_vol * 2.0:
            signals += 1
            evidence.append(f"vol_expansion_ratio={short_vol/long_vol:.2f}")
            max_severity = max(max_severity, ChangeSeverity.MATERIAL_MARKET_CHANGE, key=lambda s: list(ChangeSeverity).index(s))

        # Abnormal volume
        if volumes and len(volumes) >= 15:
            recent_v = statistics.mean(volumes[-3:])
            base_v = statistics.mean(volumes[-20:-3]) if len(volumes) >= 23 else statistics.mean(volumes[:-3] or volumes)
            if base_v > 0:
                vr = recent_v / base_v
                metrics["volume_ratio"] = round(vr, 4)
                if vr > 3.0:
                    signals += 1
                    evidence.append(f"abnormal_volume_{vr:.2f}x")
                    max_severity = max(max_severity, ChangeSeverity.EARLY_WARNING, key=lambda s: list(ChangeSeverity).index(s))

        # Regime transition
        if previous_regime and current_regime and previous_regime != current_regime:
            signals += 1
            evidence.append(f"regime_{previous_regime}_to_{current_regime}")
            major_from = previous_regime in ("strong_bull", "strong_bear", "crisis")
            major_to = current_regime in ("strong_bear", "crisis", "market_dislocation", "high_volatility")
            if major_from or major_to:
                max_severity = ChangeSeverity.MAJOR_REGIME_TRANSITION
            else:
                max_severity = max(max_severity, ChangeSeverity.MATERIAL_MARKET_CHANGE, key=lambda s: list(ChangeSeverity).index(s))

        # Strategy health disruption
        if strategy_health_flags:
            bad = [f for f in strategy_health_flags if f in ("DEGRADED", "BROKEN", "WEAKENING")]
            if bad:
                signals += 1
                evidence.append(f"strategy_health_{','.join(bad)}")
                max_severity = max(max_severity, ChangeSeverity.STRATEGY_DISRUPTION, key=lambda s: list(ChangeSeverity).index(s))

        if correlation_shift is not None and abs(correlation_shift) > 0.4:
            signals += 1
            evidence.append(f"correlation_shift_{correlation_shift:.2f}")
            metrics["correlation_shift"] = correlation_shift
            max_severity = max(max_severity, ChangeSeverity.MATERIAL_MARKET_CHANGE, key=lambda s: list(ChangeSeverity).index(s))

        if spread_bps is not None and spread_bps > 50:
            signals += 1
            evidence.append(f"spread_expansion_{spread_bps:.1f}bps")
            metrics["spread_bps"] = spread_bps

        if funding_rate is not None and abs(funding_rate) > 0.001:
            signals += 1
            evidence.append(f"unusual_funding_{funding_rate:.5f}")
            metrics["funding_rate"] = funding_rate

        # Emergency: extreme single-bar move + vol expansion
        if abs(recent) > 0.08 and short_vol > long_vol * 2.5:
            signals += 2
            evidence.append("extreme_move_with_vol_spike")
            max_severity = ChangeSeverity.MARKET_EMERGENCY

        if signals < 1 and max_severity == ChangeSeverity.NORMAL_FLUCTUATION:
            return None

        # Require corroboration for elevated severity
        if max_severity in (
            ChangeSeverity.MAJOR_REGIME_TRANSITION,
            ChangeSeverity.MARKET_EMERGENCY,
            ChangeSeverity.STRATEGY_DISRUPTION,
        ) and signals < 2:
            max_severity = ChangeSeverity.EARLY_WARNING
            evidence.append("downgraded_pending_corroboration")

        confidence = min(0.95, 0.35 + 0.15 * signals)

        response_map = {
            ChangeSeverity.NORMAL_FLUCTUATION: "continue_monitoring",
            ChangeSeverity.EARLY_WARNING: "heighten_monitoring_review_edges",
            ChangeSeverity.MATERIAL_MARKET_CHANGE: "reassess_strategy_suitability",
            ChangeSeverity.STRATEGY_DISRUPTION: "suspend_weak_strategies_paper_review",
            ChangeSeverity.MAJOR_REGIME_TRANSITION: "rotate_strategies_recalc_allocations",
            ChangeSeverity.MARKET_EMERGENCY: "defensive_mode_reduce_exposure_preserve_stops",
        }

        impact_map = {
            ChangeSeverity.NORMAL_FLUCTUATION: "negligible",
            ChangeSeverity.EARLY_WARNING: "monitor_closely",
            ChangeSeverity.MATERIAL_MARKET_CHANGE: "moderate_reallocation_possible",
            ChangeSeverity.STRATEGY_DISRUPTION: "strategy_level_impact",
            ChangeSeverity.MAJOR_REGIME_TRANSITION: "portfolio_wide_review",
            ChangeSeverity.MARKET_EMERGENCY: "capital_preservation_priority",
        }

        ts = datetime.now(timezone.utc).isoformat()
        eid = f"chg_{symbol}_{ts.replace(':', '').replace('-', '')[:15]}"

        return ChangeEvent(
            event_id=eid,
            severity=max_severity.value,
            confidence=round(confidence, 4),
            affected_instruments=[symbol],
            affected_asset_classes=[],
            affected_strategies=list(strategy_health_flags or []),
            expected_portfolio_impact=impact_map[max_severity],
            recommended_response=response_map[max_severity],
            evidence=evidence,
            metrics=metrics,
            timestamp=ts,
        )
