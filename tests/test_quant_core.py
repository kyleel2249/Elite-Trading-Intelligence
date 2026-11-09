"""Unit tests for Kelly / mispricing / fair value / sentiment / scoring (no network)."""
import math
from datetime import datetime, timedelta, timezone

import pytest

from app.quant.kelly import (HARD_MAX_POSITION_PCT, KellyInput, KellyLimits, kelly_fraction,
                             size_position, wilson_lower_bound)
from app.quant.mispricing import VerificationEvidence, classify_band, evaluate_mispricing, mispricing_pct
from app.quant.fair_value import estimate_fair_value
from app.quant.sentiment import SentimentItem, aggregate
from app.quant.scoring import OpportunityInput, get_weights, rank


def base_input(**kw):
    d = dict(bankroll=100_000, entry_price=100.0, stop_price=95.0, target_price=115.0,
             win_probability=0.60, sample_size=200, fee_bps=0, slippage_bps=0)
    d.update(kw)
    return KellyInput(**d)


# ---------------- Kelly ----------------
def test_kelly_formula_matches_textbook():
    # p=0.6, b=2 -> f* = (2*0.6-0.4)/2 = 0.4
    assert kelly_fraction(0.6, 2.0) == pytest.approx(0.4)


def test_negative_edge_gives_zero_allocation():
    r = size_position(base_input(win_probability=0.20))
    assert not r.approved and r.final_allocation_pct == 0.0 and r.position_notional == 0.0


def test_zero_edge_gives_zero_allocation():
    # b = 1 (reward == risk), p = 0.5 -> f* = 0
    r = size_position(base_input(target_price=105.0, win_probability=0.5, sample_size=10_000))
    assert not r.approved and r.position_notional == 0.0


def test_fractional_kelly_applied_and_default_is_quarter():
    r = size_position(base_input(), KellyLimits(max_risk_per_trade_pct=100.0, max_position_pct=100.0,
                                                max_total_exposure_pct=1e6, max_sector_exposure_pct=1e6,
                                                max_correlated_exposure_pct=1e6))
    assert r.kelly_fraction_used == 0.25
    assert r.fractional_kelly_pct == pytest.approx(r.full_kelly_pct * 0.25, rel=1e-6)


def test_fraction_config_clamped_to_quarter_to_half():
    assert KellyLimits(kelly_fraction=0.9).effective_kelly_fraction() == 0.5
    assert KellyLimits(kelly_fraction=0.05).effective_kelly_fraction() == 0.25


@pytest.mark.parametrize("stop", [99.9, 99.0, 97.0, 90.0])
def test_position_never_exceeds_6_percent_even_with_tight_stop(stop):
    # Tight stops make Kelly-derived notional huge; the 6% cap must bind.
    r = size_position(base_input(stop_price=stop, win_probability=0.9, sample_size=5000,
                                 target_price=130.0),
                      KellyLimits(max_risk_per_trade_pct=5.0, kelly_fraction=0.5))
    assert r.approved
    assert r.final_allocation_pct <= HARD_MAX_POSITION_PCT + 1e-9
    assert r.position_notional <= 100_000 * 0.06 + 1e-6


def test_config_cannot_raise_cap_above_6_percent():
    r = size_position(base_input(stop_price=99.5, win_probability=0.95, sample_size=5000, target_price=140.0),
                      KellyLimits(max_position_pct=50.0, max_risk_per_trade_pct=10.0, kelly_fraction=0.5,
                                  max_total_exposure_pct=100, max_sector_exposure_pct=100,
                                  max_correlated_exposure_pct=100))
    assert r.final_allocation_pct <= 6.0 + 1e-9


def test_stop_loss_risk_capped_independently():
    # Wide stop (20%): 6% allocation would risk 1.2% of bankroll; cap risk at 0.5%.
    r = size_position(base_input(stop_price=80.0, target_price=160.0, win_probability=0.8, sample_size=5000),
                      KellyLimits(max_risk_per_trade_pct=0.5, kelly_fraction=0.5))
    assert r.approved
    assert r.max_loss_at_stop_pct <= 0.5 + 1e-6


def test_allocation_and_capital_at_risk_are_different_numbers():
    r = size_position(base_input(stop_price=90.0, target_price=130.0, win_probability=0.7, sample_size=1000))
    assert r.approved
    assert r.final_allocation_pct != pytest.approx(r.max_loss_at_stop_pct)


def test_insufficient_samples_rejected_and_partial_samples_reduce_size():
    assert not size_position(base_input(sample_size=5)).approved
    full = size_position(base_input(sample_size=500, win_probability=0.62))
    part = size_position(base_input(sample_size=20, win_probability=0.62))
    assert full.approved
    # fewer samples -> lower (or rejected) Kelly fraction before caps are applied
    assert (not part.approved) or part.fractional_kelly_pct < full.fractional_kelly_pct


def test_uncalibrated_probability_rejected():
    assert not size_position(base_input(probability_calibrated=False)).approved


def test_costs_can_eliminate_edge():
    r = size_position(base_input(target_price=100.2, fee_bps=50, slippage_bps=50))
    assert not r.approved


def test_remaining_portfolio_capacity_binds():
    r = size_position(base_input(win_probability=0.9, sample_size=5000, target_price=140.0, stop_price=99.0),
                      KellyLimits(max_risk_per_trade_pct=5.0, kelly_fraction=0.5),)
    r2 = size_position(base_input(win_probability=0.9, sample_size=5000, target_price=140.0, stop_price=99.0,
                                  current_exposure_pct=58.0),
                       KellyLimits(max_risk_per_trade_pct=5.0, kelly_fraction=0.5))
    assert r2.approved and r2.position_notional <= 100_000 * 0.02 + 1e-6
    assert r2.binding_constraint == "portfolio_capacity" and r.position_notional > r2.position_notional


def test_correlated_exposure_limit_blocks_when_full():
    r = size_position(base_input(correlated_exposure_pct=25.0))
    assert not r.approved


def test_liquidity_capacity_binds():
    r = size_position(base_input(win_probability=0.9, sample_size=5000, target_price=140.0, stop_price=99.0,
                                 liquidity_capacity_notional=1000.0),
                      KellyLimits(max_risk_per_trade_pct=5.0, kelly_fraction=0.5))
    assert r.position_notional == pytest.approx(1000.0) and r.binding_constraint == "liquidity_capacity"


def test_volatility_scaling_reduces_size():
    calm = size_position(base_input(win_probability=0.58, sample_size=500))
    wild = size_position(base_input(win_probability=0.58, sample_size=500, realized_daily_vol_pct=9.0))
    assert wild.fractional_kelly_pct < calm.fractional_kelly_pct


def test_invalid_inputs_fail_closed():
    assert not size_position(base_input(entry_price=-1)).approved
    assert not size_position(base_input(stop_price=105.0)).approved           # long with stop above entry
    assert not size_position(base_input(win_probability=float("nan"))).approved
    assert not size_position(base_input(win_probability=1.5)).approved


def test_short_side_sizing():
    r = size_position(base_input(side="sell", entry_price=100.0, stop_price=105.0, target_price=85.0))
    assert r.approved and r.final_allocation_pct <= 6.0


def test_wilson_bound_monotonic_in_n():
    assert wilson_lower_bound(0.6, 1000, 1.28) > wilson_lower_bound(0.6, 30, 1.28)


# ---------------- mispricing ----------------
def test_mispricing_formula_and_direction():
    assert mispricing_pct(120.0, 100.0) == pytest.approx(16.6667, rel=1e-4)
    assert mispricing_pct(100.0, 120.0) == pytest.approx(-20.0)
    assert mispricing_pct(0, 100) is None and mispricing_pct(100, -1) is None


@pytest.mark.parametrize("pct,band", [(2.9, "insignificant"), (3, "minor"), (5, "developing"),
                                      (8, "developing"), (8.01, "material"), (12.5, "significant"),
                                      (20.5, "exceptional")])
def test_bands(pct, band):
    assert classify_band(pct) == band


def test_flag_strictly_above_8_percent():
    at8 = evaluate_mispricing("X", 100.0, 92.0)            # exactly 8.0
    over = evaluate_mispricing("X", 100.0, 91.9)
    assert not at8.flagged and over.flagged and over.direction == "undervalued"
    assert evaluate_mispricing("X", 100.0, 110.0).direction == "overvalued"
    assert evaluate_mispricing("X", 100.0, 110.0).flagged


def good_evidence(**kw):
    d = dict(price_fresh=True, inputs_complete=True, model_appropriate=True,
             corporate_action_or_data_error=False, liquidity_adequate=True, round_trip_cost_pct=0.5,
             fundamental_deterioration=False, unresolved_event_risk=False, independent_models_agree=True,
             convergence_horizon_days=60)
    d.update(kw)
    return VerificationEvidence(**d)


def test_flagged_mispricing_confirmed_only_with_full_evidence():
    assert evaluate_mispricing("X", 100, 80, good_evidence()).confirmed
    assert not evaluate_mispricing("X", 100, 80).confirmed                       # unverified -> fail closed
    assert not evaluate_mispricing("X", 100, 80, good_evidence(price_fresh=False)).confirmed
    r = evaluate_mispricing("X", 100, 80, good_evidence(fundamental_deterioration=True))
    assert not r.confirmed and "fundamental_deterioration" in r.failed_checks
    r = evaluate_mispricing("X", 100, 91, good_evidence(round_trip_cost_pct=9.5))
    assert "transaction_costs_eliminate_edge" in r.failed_checks
    r = evaluate_mispricing("X", 100, 80, good_evidence(convergence_horizon_days=900))
    assert "convergence_horizon_unrealistic" in r.failed_checks


def test_exceptional_requires_heightened_verification_flag():
    assert evaluate_mispricing("X", 100, 70, good_evidence()).needs_heightened_verification


# ---------------- fair value ----------------
def equity_inputs():
    return {
        "dcf": {"fcf_per_share": 5.0, "growth_rate": 0.06, "terminal_growth": 0.025, "discount_rate": 0.09},
        "multiples": {"peer_metric_per_share": 6.0, "peer_median_multiple": 20.0, "multiple_name": "P/FCF"},
        "ddm": {"dividend_per_share": 2.0, "dividend_growth": 0.04, "cost_of_equity": 0.09},
    }


def test_equity_fair_value_uses_multiple_models_with_bounds():
    r = estimate_fair_value("AAPL", "equity", 100.0, equity_inputs())
    assert r.supported and len(r.methodology) == 3
    assert r.lower_bound <= r.fair_value <= r.upper_bound


def test_dcf_not_applied_to_tokens():
    r = estimate_fair_value("TOK", "crypto", 1.0, {"dcf": equity_inputs()["dcf"]})
    assert not r.supported and "dcf" in r.dropped_models and r.fair_value is None


def test_insufficient_inputs_marked_unsupported_not_guessed():
    r = estimate_fair_value("X", "equity", 50.0, {"dcf": {"fcf_per_share": -1, "growth_rate": 0.05,
                                                          "terminal_growth": 0.02, "discount_rate": 0.08}})
    assert not r.supported and r.fair_value is None and r.confidence == 0.0


def test_dcf_invalid_when_discount_not_above_terminal_growth():
    bad = {"fcf_per_share": 5, "growth_rate": 0.05, "terminal_growth": 0.09, "discount_rate": 0.09}
    assert estimate_fair_value("X", "equity", 10, {"dcf": bad, "multiples": equity_inputs()["multiples"]}).supported is False


def test_model_disagreement_rejects_valuation():
    r = estimate_fair_value("X", "equity", 100.0, {
        "multiples": {"peer_metric_per_share": 1.0, "peer_median_multiple": 10.0},
        "ddm": {"dividend_per_share": 5.0, "dividend_growth": 0.02, "cost_of_equity": 0.04}})
    assert not r.supported


def test_crypto_models():
    r = estimate_fair_value("TOK", "crypto", 2.0, {
        "protocol_revenue": {"annual_protocol_revenue_usd": 50e6, "peer_ps_multiple": 20.0,
                             "circulating_supply": 400e6, "unlock_dilution_pct": 0.1},
        "nvt": {"daily_onchain_tx_volume_usd": 5e6, "target_nvt": 2.5, "circulating_supply": 400e6}})
    assert r.supported and r.fair_value > 0


def test_forex_parity_and_commodity_carry():
    fx = estimate_fair_value("EURUSD", "forex", 1.1, {"interest_rate_parity": {
        "spot": 1.1, "domestic_rate": 0.05, "foreign_rate": 0.02, "years_to_expiry": 1.0}})
    assert not fx.supported            # a single model is not enough support
    from app.quant.fair_value import cost_of_carry, interest_rate_parity
    assert interest_rate_parity({"spot": 1.1, "domestic_rate": 0.05, "foreign_rate": 0.02, "years_to_expiry": 1.0}).value == pytest.approx(1.1 * 1.05 / 1.02)
    assert cost_of_carry({"spot": 100, "risk_free_rate": 0.04, "years_to_expiry": 1}).value == pytest.approx(100 * math.exp(0.04))


# ---------------- sentiment ----------------
NOW = datetime(2026, 11, 8, 12, 0, tzinfo=timezone.utc)


def item(score, v="credible", mins=30, text="t", author=None, **kw):
    return SentimentItem("src", v, score, NOW - timedelta(minutes=mins), text, author, **kw)


def test_sentiment_unavailable_is_reported_honestly():
    r = aggregate("X", [], expected_sources=["news", "social"], now=NOW)
    assert not r.available and r.label == "unavailable" and r.sources_unavailable == ["news", "social"]


def test_sentiment_labels_and_never_triggers_orders():
    bull = aggregate("X", [item(0.9, text=f"a{i}") for i in range(5)], now=NOW)
    bear = aggregate("X", [item(-0.9, text=f"b{i}") for i in range(5)], now=NOW)
    assert bull.score_0_100 > 80 and bull.label in ("bullish", "extremely_bullish")
    assert bear.score_0_100 < 20
    assert bull.can_trigger_order is False


def test_duplicate_news_and_bots_flagged():
    items = [item(0.9, v="social", text="BUY NOW to the moon", author="bot1") for _ in range(8)]
    r = aggregate("X", items, now=NOW)
    assert r.manipulation_suspected and "duplicate_content_heavy" in r.flags


def test_verified_outweighs_social():
    mixed = aggregate("X", [item(-0.8, v="verified", text="earnings miss"),
                            item(0.8, v="social", text="moon1"), item(0.8, v="social", text="moon2")], now=NOW)
    assert mixed.score_0_100 < 50


def test_sponsored_content_downweighted():
    r = aggregate("X", [item(0.9, text="ad", sponsored=True), item(-0.5, v="verified", text="filing")], now=NOW)
    assert r.score_0_100 < 50 and "paid_promotion_present" in r.flags


# ---------------- scoring ----------------
def test_weights_sum_to_one_for_all_profiles():
    for name in ("default", "crypto", "high_volatility"):
        assert sum(get_weights(name).values()) == pytest.approx(1.0)


def comps(v):
    return {k: v for k in get_weights()}


def test_high_score_cannot_hide_hard_failure():
    r = rank(OpportunityInput("X", comps(95), mispricing_pct=25, mispricing_confirmed=True,
                              hard_failures=["stale_data"]))
    assert r.classification == "REJECTED"


def test_conflicting_engines_lower_conviction():
    agree = rank(OpportunityInput("X", comps(90), 15, True, engine_votes={"a": "bullish", "b": "bullish"}))
    clash = rank(OpportunityInput("X", comps(90), 15, True, engine_votes={"a": "bullish", "b": "bearish"}))
    assert clash.score < agree.score and clash.conflict and agree.classification == "HIGH-CONVICTION"
    assert clash.classification != "HIGH-CONVICTION"


def test_unverified_mispricing_is_not_a_buy_candidate():
    r = rank(OpportunityInput("X", comps(90), mispricing_pct=15, mispricing_confirmed=False))
    assert r.classification == "MISPRICED ABOVE 8%"


def test_invalidated_and_hold():
    assert rank(OpportunityInput("X", comps(90), invalidated=True)).classification == "INVALIDATED"
    assert rank(OpportunityInput("X", comps(10))).classification == "HOLD"
