from app.quant.evaluate import evaluate_instrument, valuation_score


def equity_inputs():
    return {"dcf": {"fcf_per_share": 5.0, "growth_rate": 0.06, "terminal_growth": 0.025, "discount_rate": 0.09},
            "multiples": {"peer_metric_per_share": 5.0, "peer_median_multiple": 20.0},
            "ddm": {"dividend_per_share": 3.0, "dividend_growth": 0.03, "cost_of_equity": 0.065}}


GOOD = {"liquidity_adequate": True, "corporate_action": False, "fundamental_deterioration": False,
        "unresolved_event_risk": False, "convergence_horizon_days": 60}


def ev(price, **kw):
    d = dict(symbol="X", asset_class="equity", price=price, price_fresh=True, fair_value_inputs=equity_inputs(),
             win_probability=0.6, sample_size=500, bankroll=100_000.0, verification=GOOD)
    d.update(kw)
    return evaluate_instrument(**d)


def test_no_price_means_rejected_not_guessed():
    assert ev(None)["classification"] == "REJECTED"


def test_unsupported_valuation_never_reaches_sizing():
    r = ev(50.0, fair_value_inputs={"dcf": equity_inputs()["dcf"]})
    assert r["classification"] == "UNSUPPORTED" and "sizing" not in r


def test_confirmed_undervalued_gets_a_capped_trade_plan():
    fv = ev(50.0)["fair_value"]["fair_value"]
    r = ev(fv * 0.8)                                   # 20% below fair value
    assert r["classification"] == "CONFIRMED_UNDERVALUED" and r["sizing"]["approved"]
    assert r["sizing"]["final_allocation_pct"] <= 6.0 + 1e-9 and r["trade_plan"]["side"] == "buy"


def test_unverified_evidence_blocks_confirmation_and_sizing():
    fv = ev(50.0)["fair_value"]["fair_value"]
    r = ev(fv * 0.8, verification={})
    assert r["classification"] == "MISPRICED_UNVERIFIED" and r["sizing"] is None
    assert r["valuation_score"] <= 40.0


def test_stale_price_rejects_even_a_large_gap():
    fv = ev(50.0)["fair_value"]["fair_value"]
    assert ev(fv * 0.8, price_fresh=False)["classification"] == "REJECTED"


def test_overvalued_is_flagged_but_not_sized_without_shorting():
    fv = ev(50.0)["fair_value"]["fair_value"]
    r = ev(fv * 1.3)
    assert r["classification"] == "CONFIRMED_OVERVALUED" and r["sizing"]["approved"] is False
    assert ev(fv * 1.3, can_short=True)["sizing"]["approved"] in (True, False)


def test_models_that_straddle_the_price_do_not_confirm():
    wide = {"dcf": equity_inputs()["dcf"], "multiples": {"peer_metric_per_share": 6.0, "peer_median_multiple": 20.0},
            "ddm": {"dividend_per_share": 2.0, "dividend_growth": 0.04, "cost_of_equity": 0.09}}
    fv = evaluate_instrument(symbol="X", asset_class="equity", price=50.0, price_fresh=True, fair_value_inputs=wide)["fair_value"]
    r = evaluate_instrument(symbol="X", asset_class="equity", price=fv["fair_value"] * 0.8, price_fresh=True,
                            fair_value_inputs=wide, verification=GOOD)
    assert r["classification"] == "MISPRICED_UNVERIFIED" and "independent_models_agree" in r["mispricing"]["failed_checks"]


def test_small_gap_is_not_flagged():
    fv = ev(50.0)["fair_value"]["fair_value"]
    assert ev(fv * 0.97)["classification"] == "NOT_MISPRICED_ABOVE_8PCT"


def test_valuation_score_caps_unconfirmed():
    assert valuation_score(25.0, False, 1.0) <= 40.0 and valuation_score(25.0, True, 1.0) == 100.0
    assert valuation_score(None, True, 1.0) == 0.0
