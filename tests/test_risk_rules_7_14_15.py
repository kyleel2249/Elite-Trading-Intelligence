"""Non-negotiable rules 7, 14 and 15.

7.  A strategy never exceeds its approved risk limits (and unverifiable risk is not approved outside paper).
14. Risk is never increased automatically after losses.
15. Capital preservation is never traded away for trading frequency.
"""
from __future__ import annotations

from app.adaptive_edge.portfolio_adapt import PortfolioAdaptationEngine
from app.adaptive_edge.selection import AdaptiveStrategySelector
from app.config import Settings
from app.risk.engine import Decision, OrderProposal, RiskEngine


def _engine(**kw) -> RiskEngine:
    return RiskEngine(Settings(**kw))


def _p(**kw) -> OrderProposal:
    base = dict(provider="binance", environment="testnet", symbol="BTCUSDT", side="buy", qty=0.01, order_type="limit",
                limit_price=50000, equity=10000, data_status="fresh", data_age_seconds=1, meta={"ref_price": 50000})
    base.update(kw)
    return OrderProposal(**base)


# ---------------- rule 7 ----------------
def test_testnet_buy_without_verifiable_risk_is_rejected():
    d = _engine().evaluate(_p())
    assert d.decision == Decision.REJECTED and any("cannot be verified" in r for r in d.reasons)


def test_stop_loss_makes_risk_verifiable_and_within_limit_is_approved():
    d = _engine().evaluate(_p(stop_loss=49000))  # risk 10 = 0.1%
    assert d.decision == Decision.APPROVED


def test_risk_derived_from_stop_that_exceeds_limit_is_rejected():
    d = _engine().evaluate(_p(qty=0.01, stop_loss=30000))  # risk 200 = 2% > 1%
    assert d.decision == Decision.REJECTED and any("Risk per trade" in r for r in d.reasons)


def test_explicit_risk_amount_over_limit_is_rejected():
    d = _engine().evaluate(_p(estimated_risk_amount=500))
    assert d.decision == Decision.REJECTED


def test_unknown_notional_price_is_rejected_off_paper():
    d = _engine().evaluate(_p(limit_price=None, meta={}, order_type="market", estimated_risk_amount=10))
    assert d.decision == Decision.REJECTED and any("notional cannot be verified" in r for r in d.reasons)


def test_paper_buy_without_stop_is_allowed_but_flagged_not_silently_verified():
    d = _engine().evaluate(_p(environment="paper"))
    assert d.decision == Decision.APPROVED and any("not verified" in w for w in d.warnings)


def test_oversized_notional_is_rejected():
    d = _engine().evaluate(_p(qty=1.0, stop_loss=49990))  # notional 50,000 = 500% of equity
    assert d.decision == Decision.REJECTED and any("notional" in r.lower() for r in d.reasons)


def test_market_multipliers_can_only_tighten(monkeypatch):
    import app.risk.engine as eng
    from app.markets.types import MarketReview
    loose = MarketReview(notional_cap_multiplier=5.0, risk_multiplier=5.0)
    monkeypatch.setattr(eng, "market_risk_review", lambda *a, **k: loose)
    d = _engine().evaluate(_p(qty=1.0, stop_loss=49990))
    assert d.decision == Decision.REJECTED  # a multiplier above 1 must not widen the 6% notional cap


# ---------------- rule 15 (preservation limits do not yield to frequency) ----------------
def test_daily_loss_and_drawdown_limits_block_orders_regardless_of_other_inputs():
    e = _engine()
    assert e.evaluate(_p(stop_loss=49000, daily_realized_pnl_pct=-3.0)).decision == Decision.REJECTED
    assert e.evaluate(_p(stop_loss=49000, current_drawdown_pct=10.0)).decision == Decision.REJECTED
    assert e.evaluate(_p(stop_loss=49000, current_open_positions=8)).decision == Decision.REJECTED


def test_kill_switch_blocks_everything():
    assert _engine(kill_switch=True).evaluate(_p(stop_loss=49000)).decision == Decision.REJECTED


# ---------------- rule 14 ----------------
def test_selector_does_not_increase_after_recent_losses():
    sel = AdaptiveStrategySelector()
    kw = dict(strategy_id="s1", edge_status="HEALTHY", sample_size=60, regime_suitability=0.9, expected_value=0.5,
              correlation_with_active=0.1, current_allocation_pct=2.0)
    assert sel.decide(**kw).action == "increase"
    blocked = sel.decide(**kw, block_increase=True)
    assert blocked.action == "maintain" and blocked.allocation_pct == 2.0 and "increase_blocked_after_recent_losses" in blocked.reasons


def test_portfolio_plan_holds_instead_of_increasing_in_drawdown():
    eng = PortfolioAdaptationEngine()
    dec = [{"strategy_id": "s1", "action": "increase", "allocation_pct": 2.5}]
    in_dd = eng.plan("t", dec, current_drawdown_pct=1.5)
    assert not any(a["type"] == "increase_allocation" for a in in_dd.actions)
    assert any(a["type"] == "hold_allocation" for a in in_dd.actions)
    flat = eng.plan("t", dec, current_drawdown_pct=0.0)
    assert any(a["type"] == "increase_allocation" for a in flat.actions)
