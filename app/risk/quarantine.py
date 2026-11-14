"""ETI strategy elimination system — evaluation and state machine (pure logic).

ETI continuously compares each strategy's live behaviour with what was validated
before it was allowed to trade. When a strategy fails any quarantine test it is
QUARANTINED: it can no longer produce executable orders (the Capital Protection
System refuses them) until a human reviews it and it passes revalidation.

State machine::

    ACTIVE --auto/manual trigger--> QUARANTINED --human review--> UNDER_REVIEW
        ^                                                              |
        |                                                  human approves revalidation
        +------ passes revalidation + human release ------ REVALIDATING <-+
                                                (paper/testnet only; any new trigger -> QUARANTINED)

Safety restrictions are never lowered by software: every transition out of
QUARANTINED needs a human authorisation object (see ``HumanAuthorization``) that
only the admin-key-protected API can create. An AI agent has no code path to it.

Standard library only; no imports from the model council or signal engines.
"""
from __future__ import annotations

import math
import statistics
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Optional, Sequence


class StrategyStatus(str, Enum):
    ACTIVE = "ACTIVE"
    QUARANTINED = "QUARANTINED"
    UNDER_REVIEW = "UNDER_REVIEW"
    REVALIDATING = "REVALIDATING"


class QuarantineReason(str, Enum):
    PERFORMANCE_DETERIORATION = "PERFORMANCE_DETERIORATION"
    LIVE_DIVERGENCE = "LIVE_DIVERGENCE"
    DRAWDOWN_BREACH = "DRAWDOWN_BREACH"
    EXECUTION_QUALITY = "EXECUTION_QUALITY"
    ASSUMPTIONS_INVALIDATED = "ASSUMPTIONS_INVALIDATED"
    DATA_INTEGRITY = "DATA_INTEGRITY"
    MANUAL = "MANUAL"


@dataclass(frozen=True)
class StrategyExpectations:
    """What was validated (backtest / walk-forward / out-of-sample) before the strategy went live."""

    win_rate: float
    profit_factor: float
    expected_max_drawdown_pct: float
    max_drawdown_threshold_pct: float  # predefined hard stop; independent of the expected drawdown
    expected_slippage_bps: float = 2.0
    max_slippage_bps: float = 25.0
    max_reject_rate: float = 0.25
    validated_regimes: tuple[str, ...] = ()  # empty = regime check not applicable
    validated_atr_pct_range: Optional[tuple[float, float]] = None
    validation_evidence: str = ""  # reference to the validation report (not interpreted by code)

    def validate(self) -> list[str]:
        problems = []
        if not (0.0 < self.win_rate < 1.0):
            problems.append("win_rate must be between 0 and 1 (exclusive)")
        if not (self.profit_factor > 0 and math.isfinite(self.profit_factor)):
            problems.append("profit_factor must be positive and finite")
        if not (0 < self.max_drawdown_threshold_pct <= 50):
            problems.append("max_drawdown_threshold_pct must be in (0, 50]")
        if self.expected_max_drawdown_pct < 0:
            problems.append("expected_max_drawdown_pct must be >= 0")
        if self.validated_atr_pct_range and not (0 < self.validated_atr_pct_range[0] < self.validated_atr_pct_range[1]):
            problems.append("validated_atr_pct_range must be (low, high) with 0 < low < high")
        if not self.validation_evidence.strip():
            problems.append("validation_evidence (reference to the validation report) is required")
        return problems

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["validated_regimes"] = list(self.validated_regimes)
        if self.validated_atr_pct_range:
            d["validated_atr_pct_range"] = list(self.validated_atr_pct_range)
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "StrategyExpectations":
        rng = d.get("validated_atr_pct_range")
        return cls(
            win_rate=float(d["win_rate"]), profit_factor=float(d["profit_factor"]),
            expected_max_drawdown_pct=float(d["expected_max_drawdown_pct"]),
            max_drawdown_threshold_pct=float(d["max_drawdown_threshold_pct"]),
            expected_slippage_bps=float(d.get("expected_slippage_bps", 2.0)),
            max_slippage_bps=float(d.get("max_slippage_bps", 25.0)),
            max_reject_rate=float(d.get("max_reject_rate", 0.25)),
            validated_regimes=tuple(d.get("validated_regimes") or ()),
            validated_atr_pct_range=(float(rng[0]), float(rng[1])) if rng else None,
            validation_evidence=str(d.get("validation_evidence", "")),
        )


@dataclass(frozen=True)
class StrategyLiveStats:
    trades_pnl: tuple[float, ...] = ()  # chronological realised PnL per closed trade
    base_equity: float = 0.0
    slippage_bps: tuple[float, ...] = ()
    exec_outcomes: tuple[str, ...] = ()  # filled | provider_error | provider_rejected (chronological)
    regimes: tuple[str, ...] = ()  # recently observed market regimes (chronological)
    atr_pct_obs: tuple[float, ...] = ()
    integrity_flags: tuple[str, ...] = ()  # e.g. stale_data, nan_values, duplicate_bars, gap, source_mismatch
    assumption_flags: tuple[str, ...] = ()  # e.g. spread_widened, liquidity_dropped, structure_changed


@dataclass(frozen=True)
class QuarantineConfig:
    min_trades: int = 20
    window: int = 20
    rolling_pf_floor: float = 0.8
    win_rate_z_crit: float = 2.33  # one-sided ~1%
    pf_ratio_floor: float = 0.5
    pf_ratio_min_trades: int = 30
    slippage_multiple: float = 3.0
    slippage_floor_bps: float = 5.0
    min_exec_samples: int = 10
    regime_mismatch_k: int = 3
    revalidation_min_trades: int = 30
    revalidation_min_profit_factor: float = 1.2
    revalidation_min_cooling_hours: float = 24.0


@dataclass
class QuarantineFinding:
    reason: str
    detail: str
    metrics: dict[str, Any] = field(default_factory=dict)


@dataclass
class QuarantineDecision:
    quarantine: bool
    findings: list[QuarantineFinding]
    metrics: dict[str, Any]
    evaluated_at: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "quarantine": self.quarantine,
            "findings": [asdict(f) for f in self.findings],
            "metrics": self.metrics,
            "evaluated_at": self.evaluated_at,
        }


# --------------------------------------------------------------------------- metrics
def profit_factor(pnls: Sequence[float]) -> Optional[float]:
    wins = sum(p for p in pnls if p > 0)
    losses = -sum(p for p in pnls if p < 0)
    if losses <= 0:
        return None if wins <= 0 else float("inf")
    return wins / losses


def max_drawdown_pct(pnls: Sequence[float], base_equity: float) -> float:
    """Peak-to-trough drop of the strategy's cumulative PnL, as a % of (base equity + peak PnL)."""
    if base_equity <= 0:
        return 0.0
    cum = peak = worst = 0.0
    for p in pnls:
        cum += p
        peak = max(peak, cum)
        dd = (peak - cum) / (base_equity + peak) * 100.0
        worst = max(worst, dd)
    return worst


def trade_metrics(pnls: Sequence[float], base_equity: float) -> dict[str, Any]:
    n = len(pnls)
    wins = sum(1 for p in pnls if p > 0)
    pf = profit_factor(pnls)
    return {
        "trades": n,
        "win_rate": (wins / n) if n else None,
        "profit_factor": pf if pf is None or math.isfinite(pf) else 999.0,
        "expectancy": statistics.fmean(pnls) if n else None,
        "net_pnl": sum(pnls),
        "max_drawdown_pct": round(max_drawdown_pct(pnls, base_equity), 4),
    }


# --------------------------------------------------------------------------- automatic evaluation
def evaluate_strategy(
    expectations: StrategyExpectations,
    stats: StrategyLiveStats,
    *,
    now: Optional[datetime] = None,
    config: QuarantineConfig = QuarantineConfig(),
) -> QuarantineDecision:
    """Return whether the strategy must be quarantined now, with every finding that justifies it."""
    now = now or datetime.now(timezone.utc)
    pnls = list(stats.trades_pnl)
    n = len(pnls)
    findings: list[QuarantineFinding] = []
    live = trade_metrics(pnls, stats.base_equity)
    metrics: dict[str, Any] = {"live": live}

    # 1. data integrity — any confirmed integrity problem quarantines immediately
    if stats.integrity_flags:
        findings.append(QuarantineFinding(
            QuarantineReason.DATA_INTEGRITY.value,
            f"Data integrity compromised: {', '.join(sorted(set(stats.integrity_flags)))}",
            {"flags": sorted(set(stats.integrity_flags))},
        ))

    # 2. drawdown breach against the predefined threshold (no minimum sample: capital first)
    dd = live["max_drawdown_pct"]
    if dd >= expectations.max_drawdown_threshold_pct:
        findings.append(QuarantineFinding(
            QuarantineReason.DRAWDOWN_BREACH.value,
            f"Strategy drawdown {dd:.2f}% >= threshold {expectations.max_drawdown_threshold_pct}%",
            {"drawdown_pct": dd, "threshold_pct": expectations.max_drawdown_threshold_pct},
        ))

    # 3. performance deterioration — rolling window
    window = pnls[-config.window:]
    if len(window) >= min(config.window, 15):
        wpf = profit_factor(window)
        wexp = statistics.fmean(window)
        metrics["rolling"] = {"trades": len(window), "profit_factor": None if wpf is None else (wpf if math.isfinite(wpf) else 999.0), "expectancy": wexp}
        if wpf is not None and wpf < config.rolling_pf_floor and wexp < 0:
            findings.append(QuarantineFinding(
                QuarantineReason.PERFORMANCE_DETERIORATION.value,
                f"Rolling {len(window)}-trade profit factor {wpf:.2f} < {config.rolling_pf_floor} with negative expectancy",
                {"rolling_profit_factor": wpf, "rolling_expectancy": wexp},
            ))

    # 4. divergence from validated expectations (downside only, statistically tested)
    if n >= config.min_trades:
        p0 = min(0.95, max(0.05, expectations.win_rate))
        p_live = live["win_rate"]
        z = (p_live - p0) / math.sqrt(p0 * (1 - p0) / n)
        metrics["win_rate_z"] = round(z, 3)
        if z <= -config.win_rate_z_crit:
            findings.append(QuarantineFinding(
                QuarantineReason.LIVE_DIVERGENCE.value,
                f"Live win rate {p_live:.1%} is statistically below validated {expectations.win_rate:.1%} (z={z:.2f}, n={n})",
                {"z": z, "live_win_rate": p_live, "expected_win_rate": expectations.win_rate},
            ))
    if n >= config.pf_ratio_min_trades and live["profit_factor"] is not None:
        if live["profit_factor"] < expectations.profit_factor * config.pf_ratio_floor and live["profit_factor"] < 1.0:
            findings.append(QuarantineFinding(
                QuarantineReason.LIVE_DIVERGENCE.value,
                f"Live profit factor {live['profit_factor']:.2f} is below {config.pf_ratio_floor:.0%} of validated {expectations.profit_factor:.2f} and below breakeven",
                {"live_profit_factor": live["profit_factor"], "expected_profit_factor": expectations.profit_factor},
            ))

    # 5. execution quality
    slip = list(stats.slippage_bps)
    if len(slip) >= config.min_exec_samples:
        recent = slip[-config.min_exec_samples * 2:]
        avg = statistics.fmean(recent)
        limit = min(expectations.max_slippage_bps,
                    expectations.expected_slippage_bps * config.slippage_multiple + config.slippage_floor_bps)
        metrics["avg_slippage_bps"] = round(avg, 3)
        if avg > limit:
            findings.append(QuarantineFinding(
                QuarantineReason.EXECUTION_QUALITY.value,
                f"Average slippage {avg:.1f} bps exceeds acceptable {limit:.1f} bps",
                {"avg_slippage_bps": avg, "limit_bps": limit},
            ))
    outcomes = list(stats.exec_outcomes)
    if len(outcomes) >= config.min_exec_samples:
        recent_o = outcomes[-config.min_exec_samples * 2:]
        bad = sum(1 for o in recent_o if o in ("provider_error", "provider_rejected"))
        rate = bad / len(recent_o)
        metrics["reject_rate"] = round(rate, 4)
        if rate > expectations.max_reject_rate:
            findings.append(QuarantineFinding(
                QuarantineReason.EXECUTION_QUALITY.value,
                f"Order failure/rejection rate {rate:.0%} exceeds {expectations.max_reject_rate:.0%}",
                {"reject_rate": rate},
            ))

    # 6. validated market assumptions
    k = config.regime_mismatch_k
    if expectations.validated_regimes and len(stats.regimes) >= k:
        tail = stats.regimes[-k:]
        if all(r not in expectations.validated_regimes for r in tail):
            findings.append(QuarantineFinding(
                QuarantineReason.ASSUMPTIONS_INVALIDATED.value,
                f"Market regime '{tail[-1]}' outside validated regimes {list(expectations.validated_regimes)} for {k} consecutive observations",
                {"observed": list(tail)},
            ))
    rng = expectations.validated_atr_pct_range
    if rng and len(stats.atr_pct_obs) >= k:
        tail_v = stats.atr_pct_obs[-k:]
        if all(v < rng[0] or v > rng[1] for v in tail_v):
            findings.append(QuarantineFinding(
                QuarantineReason.ASSUMPTIONS_INVALIDATED.value,
                f"Volatility {tail_v[-1]:.2f}% outside validated range {rng[0]}-{rng[1]}% for {k} consecutive observations",
                {"observed_atr_pct": list(tail_v)},
            ))
    if stats.assumption_flags:
        findings.append(QuarantineFinding(
            QuarantineReason.ASSUMPTIONS_INVALIDATED.value,
            f"Underlying assumptions flagged invalid: {', '.join(sorted(set(stats.assumption_flags)))}",
            {"flags": sorted(set(stats.assumption_flags))},
        ))

    return QuarantineDecision(bool(findings), findings, metrics, now.isoformat())


# --------------------------------------------------------------------------- human authorisation
@dataclass(frozen=True)
class HumanAuthorization:
    """Proof that a human operator authorised an action.

    Constructed only by the admin-key-protected API layer (protection_service.authorize_admin).
    ``actor_type`` must be 'human'; anything else is refused. Strategy code, the language model
    and the signal engines never receive or build one.
    """

    reviewer: str
    actor_type: str = "human"
    issued_at: str = ""

    def require(self) -> None:
        if self.actor_type != "human" or not self.reviewer.strip():
            raise PermissionError("A human reviewer authorisation is required for this action")


# --------------------------------------------------------------------------- revalidation
@dataclass
class RevalidationResult:
    passed: bool
    failures: list[str]
    metrics: dict[str, Any]


def check_revalidation(
    expectations: StrategyExpectations,
    stats: StrategyLiveStats,
    *,
    quarantined_at: datetime,
    now: Optional[datetime] = None,
    config: QuarantineConfig = QuarantineConfig(),
) -> RevalidationResult:
    """Fresh evidence gathered *after* the quarantine (paper/testnet) must satisfy every test again."""
    now = now or datetime.now(timezone.utc)
    failures: list[str] = []
    q_at = quarantined_at if quarantined_at.tzinfo else quarantined_at.replace(tzinfo=timezone.utc)
    cooled = (now - q_at) >= timedelta(hours=config.revalidation_min_cooling_hours)
    if not cooled:
        failures.append(f"Cooling-off period of {config.revalidation_min_cooling_hours:g}h has not elapsed")
    m = trade_metrics(stats.trades_pnl, stats.base_equity)
    if m["trades"] < config.revalidation_min_trades:
        failures.append(f"Only {m['trades']} post-quarantine trades; {config.revalidation_min_trades} required")
    pf = m["profit_factor"]
    if pf is None or pf < config.revalidation_min_profit_factor:
        failures.append(f"Profit factor {pf} below required {config.revalidation_min_profit_factor}")
    if m["max_drawdown_pct"] >= expectations.max_drawdown_threshold_pct:
        failures.append(f"Drawdown {m['max_drawdown_pct']}% breaches threshold {expectations.max_drawdown_threshold_pct}%")
    # Re-run every automatic test on the fresh sample; none may fire.
    decision = evaluate_strategy(expectations, stats, now=now, config=config)
    for f in decision.findings:
        failures.append(f"{f.reason}: {f.detail}")
    return RevalidationResult(not failures, failures, {**m, "evaluation": decision.metrics})
