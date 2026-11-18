"""Strategy elimination system — evaluation logic (pure) and data-integrity checks."""
from datetime import datetime, timedelta, timezone

import pytest

from app.risk.data_integrity import check_klines
from app.risk.quarantine import (
    HumanAuthorization, QuarantineReason as R, StrategyExpectations, StrategyLiveStats,
    check_revalidation, evaluate_strategy, max_drawdown_pct, profit_factor,
)

NOW = datetime(2026, 11, 11, 12, 0, tzinfo=timezone.utc)
EXP = StrategyExpectations(win_rate=0.55, profit_factor=1.6, expected_max_drawdown_pct=6.0,
                           max_drawdown_threshold_pct=10.0, validation_evidence="walk-forward report 2026-10-30")


def stats(**kw):
    kw.setdefault("base_equity", 10_000.0)
    return StrategyLiveStats(**kw)


def reasons(decision):
    return {f.reason for f in decision.findings}


HEALTHY = tuple(2.0 if i % 20 < 11 else -1.5 for i in range(40))  # 55% win rate, PF ~1.6


def test_healthy_strategy_is_not_quarantined():
    d = evaluate_strategy(EXP, stats(trades_pnl=HEALTHY, slippage_bps=(2.0,) * 15,
                                     exec_outcomes=("filled",) * 15), now=NOW)
    assert not d.quarantine and d.findings == []


def test_no_data_is_not_a_trigger():
    assert not evaluate_strategy(EXP, stats(), now=NOW).quarantine


def test_performance_deterioration():
    bad = HEALTHY[:20] + tuple(1.0 if i < 6 else -1.0 for i in range(20))
    d = evaluate_strategy(EXP, stats(trades_pnl=bad), now=NOW)
    assert R.PERFORMANCE_DETERIORATION.value in reasons(d)


def test_live_divergence_from_validated_win_rate():
    pnls = tuple(1.0 if i < 10 else -0.3 for i in range(40))  # 25% win rate vs 55% validated
    d = evaluate_strategy(EXP, stats(trades_pnl=pnls), now=NOW)
    assert R.LIVE_DIVERGENCE.value in reasons(d) and d.metrics["win_rate_z"] < -2.33


def test_divergence_needs_a_meaningful_sample():
    pnls = (-1.0,) * 5 + (1.0,)
    assert R.LIVE_DIVERGENCE.value not in reasons(evaluate_strategy(EXP, stats(trades_pnl=pnls), now=NOW))


def test_drawdown_breach_triggers_without_minimum_sample():
    d = evaluate_strategy(EXP, stats(trades_pnl=(-500.0, -500.0, -500.0)), now=NOW)  # 15% of $10k
    assert R.DRAWDOWN_BREACH.value in reasons(d)


def test_execution_quality_slippage_and_rejections():
    d = evaluate_strategy(EXP, stats(slippage_bps=(30.0,) * 12), now=NOW)
    assert R.EXECUTION_QUALITY.value in reasons(d)
    outcomes = ("filled",) * 7 + ("provider_error",) * 5
    assert R.EXECUTION_QUALITY.value in reasons(evaluate_strategy(EXP, stats(exec_outcomes=outcomes), now=NOW))
    assert not evaluate_strategy(EXP, stats(slippage_bps=(3.0,) * 12), now=NOW).quarantine


def test_market_assumptions_invalidated():
    e = StrategyExpectations(**{**EXP.__dict__, "validated_regimes": ("trending",), "validated_atr_pct_range": (1.0, 4.0)})
    assert R.ASSUMPTIONS_INVALIDATED.value in reasons(evaluate_strategy(e, stats(regimes=("ranging",) * 3), now=NOW))
    assert not evaluate_strategy(e, stats(regimes=("ranging", "trending", "ranging")), now=NOW).quarantine
    assert R.ASSUMPTIONS_INVALIDATED.value in reasons(evaluate_strategy(e, stats(atr_pct_obs=(6.0, 7.0, 8.0)), now=NOW))
    assert R.ASSUMPTIONS_INVALIDATED.value in reasons(evaluate_strategy(e, stats(assumption_flags=("spread_widened",)), now=NOW))


def test_data_integrity_quarantines_immediately():
    d = evaluate_strategy(EXP, stats(integrity_flags=("stale_data",)), now=NOW)
    assert d.quarantine and reasons(d) == {R.DATA_INTEGRITY.value}


# ------------------------------------------------------------------ revalidation
POST = tuple(1.0 if i % 3 else -0.8 for i in range(36))  # 67% wins, PF 2.5


def test_revalidation_passes_only_with_fresh_evidence_and_cooling():
    q_at = NOW - timedelta(hours=48)
    assert check_revalidation(EXP, stats(trades_pnl=POST), quarantined_at=q_at, now=NOW).passed
    r = check_revalidation(EXP, stats(trades_pnl=POST), quarantined_at=NOW - timedelta(hours=2), now=NOW)
    assert not r.passed and any("Cooling" in f for f in r.failures)
    r = check_revalidation(EXP, stats(trades_pnl=POST[:10]), quarantined_at=q_at, now=NOW)
    assert not r.passed and any("post-quarantine trades" in f for f in r.failures)


def test_revalidation_fails_if_any_quarantine_test_still_fires():
    r = check_revalidation(EXP, stats(trades_pnl=POST, integrity_flags=("gap",)), quarantined_at=NOW - timedelta(hours=48), now=NOW)
    assert not r.passed and any(R.DATA_INTEGRITY.value in f for f in r.failures)
    weak = tuple(0.5 if i % 2 else -0.5 for i in range(40))  # PF 1.0
    assert not check_revalidation(EXP, stats(trades_pnl=weak), quarantined_at=NOW - timedelta(hours=48), now=NOW).passed


# ------------------------------------------------------------------ human authorisation & expectations
def test_only_a_human_authorisation_is_accepted():
    HumanAuthorization(reviewer="kyle").require()
    for bad in (HumanAuthorization(reviewer="agent-7", actor_type="agent"), HumanAuthorization(reviewer="  ")):
        with pytest.raises(PermissionError):
            bad.require()


def test_expectations_validation_and_roundtrip():
    assert EXP.validate() == []
    bad = StrategyExpectations(win_rate=1.2, profit_factor=-1, expected_max_drawdown_pct=1,
                               max_drawdown_threshold_pct=80, validation_evidence="")
    assert len(bad.validate()) >= 4
    assert StrategyExpectations.from_dict(EXP.to_dict()) == EXP


def test_metric_helpers():
    assert profit_factor([2, -1, 2, -1]) == 2.0
    assert profit_factor([-1]) == 0.0 and profit_factor([]) is None
    assert max_drawdown_pct([100, -300, 50], 10_000) == pytest.approx(300 / 10_100 * 100)


# ------------------------------------------------------------------ data integrity
def bar(t, o=100.0, h=101.0, l=99.0, c=100.5, v=10.0, close_time=None):
    return {"open_time": t, "open": o, "high": h, "low": l, "close": c, "volume": v,
            "close_time": close_time if close_time is not None else t + 3_599_999}


H = 3_600_000


def test_clean_series_has_no_flags():
    rows = [bar(i * H) for i in range(5)]
    assert check_klines(rows, interval="1h", now_ms=5 * H) == []


@pytest.mark.parametrize("rows,flag", [
    ([], "empty_series"),
    ([bar(0), bar(0)], "duplicate_bars"),
    ([bar(H), bar(0)], "out_of_order"),
    ([bar(0), bar(3 * H)], "gap"),
    ([bar(0, c=float("nan"))], "nan_values"),
    ([bar(0, o=-1.0)], "non_positive_price"),
    ([bar(0, h=95.0)], "invalid_ohlc"),
    ([bar(0, v=-5.0)], "nan_values"),
])
def test_integrity_flags(rows, flag):
    assert flag in check_klines(rows, interval="1h")


def test_stale_data_flag():
    rows = [bar(0), bar(H)]
    assert "stale_data" in check_klines(rows, interval="1h", now_ms=10 * H)
    assert "stale_data" not in check_klines(rows, interval="1h", now_ms=2 * H)
