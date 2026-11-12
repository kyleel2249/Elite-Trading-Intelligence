import pytest
from app.alpha.strategy_lab import (apply_verdict, compatibility, detect_regime, evaluate_promotion, evaluate_strategy, metrics, simulate,
                                    combination_test, walk_forward, evaluate_pooled, live_signals)
from app.alpha.strategy_library import LIBRARY, executable_ids, kelly_fraction
from app.database import SessionLocal, init_db
from tests.alpha_helpers import make_bars


@pytest.fixture()
def db():
    init_db()
    s = SessionLocal()
    yield s
    s.close()


def test_library_signals_align_and_binary():
    bars = make_bars(400, seed=3, drift=0.003, vol=0.02)
    for sid in executable_ids():
        s = LIBRARY[sid]
        sig = s.signal(bars, s.param_grid[0])
        assert len(sig) == len(bars) and set(sig) <= {0, 1}


def test_non_executable_modules_have_no_fake_backtest(db):
    r = evaluate_strategy(db, "buffett_quality_value", make_bars(600), "equity", "X")
    assert r["verdict"] == "NOT_TESTABLE" and "requires external data" in r["reasons"][0]
    assert "out_of_sample" not in r


def test_no_lookahead_fill_at_next_open():
    bars = make_bars(10, seed=2)
    pos = [0, 1, 1, 0, 0, 0, 0, 0, 0, 0]
    sim = simulate(bars, pos, 0.0)
    t = sim["trades"][0]
    assert t["entry_i"] == 2 and t["exit_i"] == 4
    assert abs(t["ret"] - (bars[4]["open"] / bars[2]["open"] - 1)) < 1e-12


def test_costs_reduce_returns():
    bars = make_bars(60, seed=4)
    pos = [0] * 5 + [1] * 20 + [0] * 35
    assert simulate(bars, pos, 50)["trades"][0]["ret"] < simulate(bars, pos, 0)["trades"][0]["ret"]


def test_metrics_empty_and_basic():
    assert metrics([])["trades"] == 0
    m = metrics([{"ret": 0.1}, {"ret": -0.05}, {"ret": 0.08}, {"ret": 0.02}])
    assert m["trades"] == 4 and m["win_rate"] == 0.75 and m["profit_factor"] > 1


def test_walk_forward_only_counts_unseen_segments():
    bars = make_bars(900, seed=5, drift=0.003, vol=0.02)
    wf = walk_forward(LIBRARY["turtle_donchian"], bars, "crypto")
    assert len(wf["folds"]) == (900 - 250) // 60
    assert all(f["params"] in LIBRARY["turtle_donchian"].param_grid for f in wf["folds"])


def test_promotion_gates():
    base = {"in_sample": {"expectancy_pct": 1.0}, "folds": [{"oos_return_pct": 2, "oos_trades": 10}] * 5,
            "out_of_sample": {"trades": 50, "expectancy_pct": 1.0, "t_stat": 3.5, "profit_factor": 1.6, "max_drawdown_pct": 12}}
    assert evaluate_promotion(base)["verdict"] == "PROMOTE"
    few = {**base, "out_of_sample": {**base["out_of_sample"], "trades": 10}}
    assert evaluate_promotion(few)["verdict"] == "INSUFFICIENT_DATA"
    weak_t = {**base, "out_of_sample": {**base["out_of_sample"], "t_stat": 1.2}}
    assert evaluate_promotion(weak_t)["verdict"] == "FAIL"
    # multiple-testing haircut raises the bar
    marginal = {**base, "out_of_sample": {**base["out_of_sample"], "t_stat": 2.1}}
    assert evaluate_promotion(marginal, n_tested=1)["verdict"] == "PROMOTE"
    assert evaluate_promotion(marginal, n_tested=100)["verdict"] == "FAIL"
    overfit = {**base, "in_sample": {"expectancy_pct": 10.0}}
    assert evaluate_promotion(overfit)["verdict"] == "FAIL"


def test_champion_needs_two_passes_and_rolls_back(db):
    sid, ac = "unit_strategy", "crypto"
    assert apply_verdict(db, sid, ac, "PROMOTE").status == "CHALLENGER"
    assert apply_verdict(db, sid, ac, "PROMOTE").status == "CHAMPION"
    assert apply_verdict(db, sid, ac, "FAIL").status == "CHAMPION"
    st = apply_verdict(db, sid, ac, "FAIL")
    assert st.status == "CHALLENGER" and st.version >= 3  # automatic rollback


def test_compatibility_engine_refuses_misuse():
    regime = {"trend": "range", "regimes": ["any", "range"]}
    assert not compatibility("turtle_donchian", "crypto", "1d", regime)["compatible"]
    assert compatibility("stat_zscore_reversion", "crypto", "1d", regime)["compatible"]
    assert not compatibility("turtle_donchian", "crypto", "1m", {"regimes": ["trend_up"]})["compatible"]
    assert not compatibility("oneil_base_breakout", "crypto", "1d", {"regimes": ["trend_up", "any"]})["compatible"]
    r = compatibility("buffett_quality_value", "equity", "1d", {"regimes": ["any"]})
    assert not r["compatible"] and "external data" in " ".join(r["reasons"])


def test_pooled_evaluation_and_combination(db):
    ds = {f"S{i}": make_bars(1100, seed=i, drift=0.004, vol=0.02) for i in range(1, 7)}
    r = evaluate_pooled(db, "turtle_donchian", ds, "crypto")
    assert r["symbol"].startswith("POOLED") and r["verdict"] in ("PROMOTE", "FAIL", "INSUFFICIENT_DATA") and "pooling_note" in r
    c = combination_test(db, "turtle_donchian", "seykota_ema", make_bars(900, seed=2, drift=0.004, vol=0.02), "crypto", "S")
    assert c["strategy_id"].startswith("combo:")
    assert combination_test(db, "buffett_quality_value", "seykota_ema", [], "crypto", "S")["verdict"] == "NOT_TESTABLE"


def test_live_signals_and_regime():
    bars = make_bars(300, seed=9, drift=0.004)
    assert detect_regime(bars)["trend"] in ("trend_up", "trend_down", "range")
    sigs = live_signals(bars, "crypto")
    assert len(sigs) == len(LIBRARY) and all("compatible" in s for s in sigs)


def test_kelly_is_capped_and_zero_without_edge():
    assert kelly_fraction(0.4, 1.0, 1.0) == 0.0
    assert 0 < kelly_fraction(0.6, 1.5, 1.0) <= 0.25
