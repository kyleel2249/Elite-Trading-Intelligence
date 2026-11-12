"""Futures calculator: every expected figure is derived independently (hand arithmetic / fractions)."""
from __future__ import annotations

import re
from decimal import Decimal as D
from fractions import Fraction as F
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.futures.calc import (CalcError, Inputs, Limits, MarginTier, PRESET_LEVERAGE, allocate_capital, calculate,
                              exposure_capital, portfolio_preview)

Z = D(0)
ROOT = Path(__file__).resolve().parents[1]


def mk(**kw) -> Inputs:
    base = dict(direction="long", capital=D("1000"), leverage=20, entry_price=D("100000"),
                taker_fee_rate=Z, maker_fee_rate=Z, slippage_bps=Z)
    base.update(kw)
    return Inputs(**base)


def codes(r):
    return {v["code"] for v in r["violations"]}


def warn_codes(r):
    return {w["code"] for w in r["risk"]["warnings"]}


def frac(f: F) -> D:
    return D(f.numerator) / D(f.denominator)


def close(a, b, tol="0.0001"):
    assert abs(D(a) - b) < D(tol), (a, b)


# ------------------------------------------------------------------------------ the spec's worked example

def test_spec_example_1000_at_20x_one_percent():
    r = calculate(mk(move_pct=D("1")))
    assert D(r["sizing"]["notional"]) == 20000
    assert D(r["sizing"]["quantity"]) == D("0.2")
    assert D(r["sizing"]["initial_margin"]) == 1000
    assert D(r["target"]["price"]) == 101000
    assert D(r["target"]["gross_pnl"]) == 200
    assert D(r["target"]["gross_return_on_margin_pct"]) == 20


@pytest.mark.parametrize("lev", PRESET_LEVERAGE)
def test_notional_is_capital_times_leverage_at_every_preset(lev):
    r = calculate(mk(leverage=lev, capital=D("500"), entry_price=D("250")))
    assert D(r["sizing"]["notional"]) == 500 * lev
    assert D(r["sizing"]["initial_margin"]) == 500
    assert D(r["sizing"]["quantity"]) * 250 == 500 * lev


@pytest.mark.parametrize("lev", [0, 151, -5])
def test_leverage_outside_platform_range_is_rejected(lev):
    with pytest.raises(CalcError):
        calculate(mk(leverage=lev))


def test_non_integer_leverage_rejected():
    with pytest.raises(CalcError):
        calculate(mk(leverage=10.5))


# ------------------------------------------------------------------------------ P&L

def test_long_and_short_gross_pnl_signs():
    up = calculate(mk(exit_price=D("101000")))["target"]["gross_pnl"]
    down = calculate(mk(exit_price=D("99000")))["target"]["gross_pnl"]
    assert (D(up), D(down)) == (200, -200)
    s_down = calculate(mk(direction="short", exit_price=D("99000")))["target"]["gross_pnl"]
    s_up = calculate(mk(direction="short", exit_price=D("101000")))["target"]["gross_pnl"]
    assert (D(s_down), D(s_up)) == (200, -200)


def test_short_target_from_movement_is_below_entry():
    r = calculate(mk(direction="short", move_pct=D("1")))
    assert D(r["target"]["price"]) == 99000
    assert D(r["target"]["gross_pnl"]) == 200


def test_fees_reduce_net_pnl():
    r = calculate(mk(exit_price=D("101000"), taker_fee_rate=D("0.0005")))
    t = r["target"]
    assert D(t["entry_fee"]) == 10          # 0.2 * 100000 * 0.0005
    assert D(t["exit_fee"]) == D("10.10")   # 0.2 * 101000 * 0.0005
    assert D(t["net_pnl"]) == D("179.90")
    assert D(t["gross_pnl"]) == 200


def test_slippage_is_charged_on_taker_sides_only():
    t = calculate(mk(exit_price=D("101000"), slippage_bps=D("5")))["target"]
    assert D(t["slippage"]) == D("20.10")  # 10 entry + 10.1 exit
    t2 = calculate(mk(exit_price=D("101000"), slippage_bps=D("5"), entry_liquidity="maker", exit_liquidity="maker"))["target"]
    assert D(t2["slippage"]) == 0


def test_funding_is_a_cost_for_longs_and_income_for_shorts_when_rate_positive():
    kw = dict(exit_price=D("101000"), funding_rate=D("0.0001"), funding_intervals=D("3"))
    assert D(calculate(mk(**kw))["target"]["funding"]) == 6
    short = calculate(mk(direction="short", **kw))["target"]
    assert D(short["funding"]) == -6


# ------------------------------------------------------------------------------ rounding, filters

def test_quantity_rounds_down_so_margin_never_exceeds_capital():
    r = calculate(mk(entry_price=D("30000"), qty_step=D("0.001")))
    assert D(r["sizing"]["quantity"]) == D("0.666")
    assert D(r["sizing"]["notional"]) == 19980
    assert D(r["sizing"]["initial_margin"]) == 999
    assert D(r["sizing"]["unused_capital"]) == 1


def test_min_quantity_and_min_notional_violations():
    r = calculate(mk(min_qty=D("1"), min_notional=D("50000")))
    assert {"below_min_quantity", "below_min_notional"} <= codes(r)
    assert not r["valid"]


def test_capital_too_small_for_one_step_raises():
    with pytest.raises(CalcError):
        calculate(mk(capital=D("1"), leverage=1, entry_price=D("100000"), qty_step=D("0.1")))


def test_price_not_on_tick_is_flagged_not_rounded():
    r = calculate(mk(entry_price=D("100000.13"), tick_size=D("0.1")))
    assert "price_not_on_tick" in codes(r)
    assert D(r["entry"]["requested_price"]) == D("100000.13")


# ------------------------------------------------------------------------------ leverage limits

def test_exchange_limit_blocks_higher_leverage_and_names_the_source():
    r = calculate(mk(leverage=75, limits=Limits(exchange_max_leverage=50)))
    assert "leverage_exceeds_limit" in codes(r)
    assert r["sizing"]["effective_max_leverage"] == 50
    assert r["sizing"]["effective_max_leverage_source"] == "exchange"
    ok = calculate(mk(leverage=50, limits=Limits(exchange_max_leverage=50)))
    assert "leverage_exceeds_limit" not in codes(ok)


def test_lowest_of_all_limits_applies():
    r = calculate(mk(leverage=30, limits=Limits(exchange_max_leverage=125, account_max_leverage=40, policy_max_leverage=25)))
    assert r["sizing"]["effective_max_leverage"] == 25
    assert r["sizing"]["effective_max_leverage_source"] == "policy"
    assert "leverage_exceeds_limit" in codes(r)


def test_unverified_exchange_limit_is_warned():
    assert "leverage_unverified" in warn_codes(calculate(mk()))
    assert "leverage_unverified" not in warn_codes(calculate(mk(limits=Limits(exchange_max_leverage=150))))


def test_risk_tier_leverage_cap_depends_on_notional():
    tiers = (MarginTier(mmr=D("0.004"), notional_cap=D("10000"), max_leverage=125),
             MarginTier(mmr=D("0.005"), notional_cap=D("50000"), max_leverage=50),
             MarginTier(mmr=D("0.01"), notional_cap=None, max_leverage=20))
    small = calculate(mk(capital=D("100"), leverage=100, tiers=tiers))   # notional 10,000 -> tier 1
    assert "leverage_exceeds_limit" not in codes(small)
    big = calculate(mk(capital=D("1000"), leverage=100, tiers=tiers))    # notional 100,000 -> tier 3 (max 20x)
    assert "leverage_exceeds_limit" in codes(big)
    assert big["sizing"]["maintenance_margin_source"] == "supplied_tier_table"


# ------------------------------------------------------------------------------ liquidation

def test_isolated_long_and_short_liquidation_match_independent_formula():
    # capital 1000, 10x, entry 100000 -> notional 10000, qty 0.1, margin 1000, mmr 0.5%
    long = calculate(mk(leverage=10, maintenance_margin_rate=D("0.005")))["liquidation"]
    close(long["price"], frac(F(9000) / (F(1, 10) * F(995, 1000))))
    short = calculate(mk(direction="short", leverage=10, maintenance_margin_rate=D("0.005")))["liquidation"]
    close(short["price"], frac(F(11000) / (F(1, 10) * F(1005, 1000))))
    assert long["authoritative"] is False


def test_tier_offset_shifts_liquidation_price():
    t = (MarginTier(mmr=D("0.005"), notional_cap=None, cum=D("50")),)
    r = calculate(mk(leverage=10, tiers=t))
    close(r["liquidation"]["price"], frac((F(10000) - F(1000) - F(50)) / (F(1, 10) * F(995, 1000))))
    assert D(r["sizing"]["maintenance_margin"]) == 0   # 10000 * 0.005 - 50


def test_extra_isolated_margin_moves_liquidation_further_away():
    base = D(calculate(mk(leverage=20))["liquidation"]["price"])
    more = D(calculate(mk(leverage=20, extra_margin=D("500")))["liquidation"]["price"])
    assert more < base


def test_150x_has_a_tiny_liquidation_distance_and_extreme_warning():
    r = calculate(mk(capital=D("100"), leverage=150, maintenance_margin_rate=D("0.005")))
    close(r["liquidation"]["price"], frac(F(14900) / (F(15, 100) * F(995, 1000))))
    assert D("0.16") < D(r["liquidation"]["distance_pct_from_entry"]) < D("0.17")
    assert r["risk"]["class"] == "extreme"
    assert "extreme_leverage" in warn_codes(r)


def test_maintenance_rate_at_or_above_one_over_leverage_is_instant_liquidation():
    r = calculate(mk(leverage=100, maintenance_margin_rate=D("0.01")))
    assert "liquidation_at_or_beyond_entry" in codes(r)
    assert not r["valid"]


def test_cross_margin_needs_account_balance_then_uses_it():
    r = calculate(mk(margin_mode="cross", maintenance_margin_rate=D("0.005")))
    assert r["liquidation"]["price"] is None and r["liquidation"]["status"] == "unavailable"
    r2 = calculate(mk(margin_mode="cross", cross_wallet_balance=D("5000"), maintenance_margin_rate=D("0.005")))
    close(r2["liquidation"]["price"], frac(F(15000) / (F(2, 10) * F(995, 1000))))


def test_default_maintenance_rate_is_flagged_as_assumed():
    r = calculate(mk())
    assert r["sizing"]["maintenance_margin_source"] == "assumed_default"
    assert "mmr_assumed" in warn_codes(r)


def test_policy_minimum_liquidation_distance():
    r = calculate(mk(leverage=100, maintenance_margin_rate=D("0.005"), limits=Limits(min_liquidation_distance_pct=D("2"))))
    assert "liquidation_too_close" in codes(r)


# ------------------------------------------------------------------------------ inverse contracts

def test_inverse_pnl_uses_reciprocal_formula_not_linear():
    r = calculate(mk(contract_type="inverse", settle_currency="BTC", capital=D("0.1"), leverage=10,
                     entry_price=D("50000"), exit_price=D("55000")))
    assert D(r["sizing"]["notional"]) == 50000           # USD
    assert D(r["sizing"]["quantity"]) == 50000           # contracts at 1 USD each
    assert D(r["sizing"]["initial_margin"]) == D("0.1")  # coin
    exp = frac(F(50000) * (F(1, 50000) - F(1, 55000)))
    close(r["target"]["gross_pnl"], exp, "0.000000005")
    linear_style = D(50000) * D(5000) / D(50000) / 10    # a (wrong) linear formula applied to this position: 500
    assert abs(D(r["target"]["gross_pnl"]) - linear_style) > D("1")


def test_inverse_liquidation_matches_closed_form():
    kw = dict(contract_type="inverse", settle_currency="BTC", capital=D("0.1"), leverage=10, entry_price=D("50000"),
              maintenance_margin_rate=D("0.005"))
    close(calculate(mk(**kw))["liquidation"]["price"], frac(F(50000) * 10 * F(1005, 1000) / 11))
    close(calculate(mk(direction="short", **kw))["liquidation"]["price"], frac(F(50000) * 10 * F(995, 1000) / 9))


# ------------------------------------------------------------------------------ stops, take-profit, R:R

def test_stop_on_wrong_side_and_beyond_liquidation():
    assert "stop_wrong_side" in codes(calculate(mk(stop_price=D("101000"))))
    r = calculate(mk(leverage=100, maintenance_margin_rate=D("0.005"), stop_price=D("99000")))
    assert "stop_beyond_liquidation" in codes(r)   # liquidation is ~99497


def test_take_profit_side():
    assert "take_profit_wrong_side" in codes(calculate(mk(take_profit_prices=(D("99000"),))))


def test_risk_reward_ratio():
    r = calculate(mk(stop_price=D("99000"), take_profit_prices=(D("102000"),)))
    assert D(r["risk_reward"]["gross"]) == 2
    low = calculate(mk(stop_price=D("99000"), take_profit_prices=(D("100500"),), limits=Limits(min_risk_reward=D("2"))))
    assert "risk_reward_too_low" in codes(low)


def test_net_risk_reward_is_worse_than_gross_when_costs_exist():
    r = calculate(mk(stop_price=D("99000"), take_profit_prices=(D("102000"),), taker_fee_rate=D("0.0005")))
    assert D(r["risk_reward"]["net_of_costs"]) < D(r["risk_reward"]["gross"])


# ------------------------------------------------------------------------------ scenarios

def test_scenario_table_matches_spec_and_flags_liquidation():
    r = calculate(mk())
    row = next(s for s in r["scenarios"] if s["movement_pct"] == "1.0000" and s["side"] == "favourable")
    assert D(row["gross_pnl"]) == 200 and D(row["return_on_margin_pct"]) == 20
    adv = next(s for s in r["scenarios"] if s["movement_pct"] == "0.5000" and s["side"] == "adverse")
    assert D(adv["gross_pnl"]) == -100 and D(adv["return_on_margin_pct"]) == -10
    hot = calculate(mk(leverage=100, maintenance_margin_rate=D("0.005")))
    row = next(s for s in hot["scenarios"] if s["movement_pct"] == "1.0000" and s["side"] == "adverse")
    assert row["liquidated"] is True and D(row["net_pnl"]) == -1000
    safe = next(s for s in hot["scenarios"] if s["movement_pct"] == "0.2500" and s["side"] == "adverse")
    assert safe["liquidated"] is False


# ------------------------------------------------------------------------------ balance

def test_insufficient_balance():
    assert "insufficient_balance" in codes(calculate(mk(available_balance=D("500"))))
    ok = calculate(mk(available_balance=D("1500")))
    assert D(ok["balance"]["available_after"]) == 500


# ------------------------------------------------------------------------------ input hygiene

@pytest.mark.parametrize("kw", [dict(capital=Z), dict(capital=D("-1")), dict(entry_price=Z), dict(entry_price=D("NaN")),
                                dict(capital=D("Infinity")), dict(direction="sideways"), dict(margin_mode="x"),
                                dict(slippage_bps=D("-1")), dict(taker_fee_rate=D("0.5")), dict(move_pct=D("-100")),
                                dict(capital=D(10) ** 16)])
def test_bad_inputs_raise(kw):
    with pytest.raises(CalcError):
        calculate(mk(**kw))


def test_decimal_arithmetic_has_no_float_drift():
    r = calculate(mk(capital=D("0.1"), leverage=3, entry_price=D("0.3"), exit_price=D("0.6")))
    assert D(r["target"]["gross_pnl"]) == D("0.3")   # qty 1 * (0.6 - 0.3), no 0.30000000000000004


# ------------------------------------------------------------------------------ allocation / exposure / portfolio

def test_allocation_methods_never_exceed_total():
    eq = allocate_capital(D("1000"), "equal", 3)
    assert eq == [D("333.33")] * 3 and sum(eq) <= 1000
    assert allocate_capital(D("1000"), "percentage", 2, weights=[D("50"), D("30")]) == [D("500"), D("300")]
    assert allocate_capital(D("1000"), "manual", 2, weights=[D("400"), D("600")]) == [D("400"), D("600")]
    assert allocate_capital(D("900"), "risk_weighted", 2, risks=[D("1"), D("2")]) == [D("600"), D("300")]
    for bad in (lambda: allocate_capital(D("1000"), "percentage", 2, weights=[D("60"), D("50")]),
                lambda: allocate_capital(D("1000"), "manual", 2, weights=[D("600"), D("500")]),
                lambda: allocate_capital(D("1000"), "ai", 2),
                lambda: allocate_capital(D("1000"), "equal", 0)):
        with pytest.raises(CalcError):
            bad()


def test_exposure_presets_change_capital_only():
    assert exposure_capital(D("10000"), "conservative") == D("1000.00")
    assert exposure_capital(D("10000"), "maximum", max_pct=D("40")) == D("4000.00")
    assert exposure_capital(D("10000"), "custom", custom_pct=D("12.5")) == D("1250.00")
    with pytest.raises(CalcError):
        exposure_capital(D("10000"), "custom", custom_pct=D("60"), max_pct=D("50"))


def _spec_legs():
    return [mk(capital=D("500"), leverage=10, entry_price=D("100000"), correlation_group="crypto"),
            mk(capital=D("300"), leverage=15, entry_price=D("4000"), correlation_group="crypto"),
            mk(direction="short", capital=D("200"), leverage=5, entry_price=D("200"), correlation_group="crypto")]


def test_portfolio_totals_and_balance_check():
    r = portfolio_preview(_spec_legs(), available_balance=D("1000"))
    assert D(r["totals"]["capital"]) == 1000
    assert D(r["totals"]["notional"]) == 10500          # 5000 + 4500 + 1000
    assert D(r["totals"]["initial_margin"]) == 1000
    assert D(r["exposure_by_group"]["crypto"]["net_notional"]) == 8500   # 9500 long - 1000 short
    assert D(r["balance"]["available_after"]) == 0
    short = portfolio_preview(_spec_legs(), D("900"))
    assert short["valid"] is False
    assert "insufficient_balance" in {v["code"] for v in short["violations"]}


def test_portfolio_rejects_mixed_settlement_and_reports_a_bad_leg_without_hiding_others():
    with pytest.raises(CalcError):
        portfolio_preview([mk(), mk(settle_currency="USDC")])
    r = portfolio_preview([mk(), mk(capital=D("1"), leverage=1, qty_step=D("1"))])
    assert r["valid"] is False
    assert r["legs"][0].get("sizing") and r["legs"][1].get("error")


# ------------------------------------------------------------------------------ API + safety

@pytest.fixture(scope="module")
def client():
    from app.main import app
    return TestClient(app)


BODY = {"direction": "long", "capital": "1000", "leverage": 20, "entry_price": "100000", "move_pct": "1",
        "taker_fee_bps": "0", "slippage_bps": "0"}


def test_api_preview_returns_exact_decimal_strings(client):
    r = client.post("/api/futures-calc/preview", json=BODY)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j["sizing"]["notional"] == "20000.00" and j["target"]["gross_pnl"] == "200.00"
    assert j["read_only"] is True


def test_api_rejects_out_of_range_and_unknown_fields(client):
    assert client.post("/api/futures-calc/preview", json={**BODY, "leverage": 151}).status_code == 422
    assert client.post("/api/futures-calc/preview", json={**BODY, "capital": "-5"}).status_code == 422
    assert client.post("/api/futures-calc/preview", json={**BODY, "submit": True}).status_code == 422


def test_api_calc_error_is_422_with_message(client):
    r = client.post("/api/futures-calc/preview", json={**BODY, "capital": "1", "leverage": 1, "qty_step": "1"})
    assert r.status_code == 422 and "too small" in r.json()["detail"]


def test_api_presets_portfolio_allocate_exposure(client):
    p = client.get("/api/futures-calc/presets").json()
    assert p["leverage_presets"][0] == 1 and p["leverage_presets"][-1] == 150 and p["platform_max_leverage"] == 150

    def leg(cap, lev, ent):
        return {**BODY, "capital": cap, "leverage": lev, "entry_price": ent}

    r = client.post("/api/futures-calc/portfolio", json={"legs": [leg("500", 10, "100000"), leg("300", 15, "4000")],
                                                        "available_balance": "1000"})
    assert r.status_code == 200 and r.json()["totals"]["notional"] == "9500.00"
    a = client.post("/api/futures-calc/allocate", json={"total": "1000", "method": "equal", "count": 3}).json()
    assert a["amounts"] == ["333.33"] * 3 and a["remaining"] == "0.01"
    assert client.post("/api/futures-calc/allocate", json={"total": "1000", "method": "ai", "count": 2}).status_code == 422
    e = client.post("/api/futures-calc/exposure", json={"available": "10000", "preset": "moderate"}).json()
    assert e["capital"] == "2500.00"


def test_calculator_exposes_no_order_route_and_imports_no_broker_code(client):
    paths = [p for p in client.app.openapi()["paths"] if p.startswith("/api/futures-calc")]
    assert paths and not [p for p in paths if re.search(r"order|execute|submit|trade", p)]
    for f in ("app/futures/calc.py", "app/api/futures_calc.py"):
        src = (ROOT / f).read_text()
        assert not re.search(r"^\s*(import|from)\s+(httpx|requests|app\.execution|app\.trading|app\.integrations)", src, re.M), f


def test_static_page_is_served_and_uses_only_local_script(client):
    r = client.get("/static/futures_calc.html")
    assert r.status_code == 200 and "Futures Calculator" in r.text
    assert re.findall(r'<script[^>]+src="([^"]+)"', r.text) == ["/static/futures_calc.js"]
    js = client.get("/static/futures_calc.js").text
    assert "/api/futures-calc/preview" in js and "Math.random" not in js
