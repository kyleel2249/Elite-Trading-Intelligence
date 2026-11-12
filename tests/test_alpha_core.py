from app.alpha.features import compute_features
from app.alpha.scoring import WEIGHTS, classify_stage, score_early_alpha, STAGES
from app.alpha.token_safety import screen_dex_pair
from tests.alpha_helpers import make_bars, accumulation_bars


def test_features_need_history():
    assert compute_features(make_bars(30))["sufficient"] is False


def test_features_fields_and_rsi_bounds():
    f = compute_features(make_bars(250))
    assert f["sufficient"] and 0 <= f["rsi14"] <= 100 and f["atr14"] > 0 and f["sma200"] is not None


def test_accumulation_detected():
    f = compute_features(accumulation_bars())
    assert f["ud_volume_ratio"] > 1.5 and f["ad_slope"] is not None
    assert classify_stage(f, "crypto")["stage"] in ("EARLY_ACCUMULATION", "BREAKOUT_FORMATION", "PRE_ACCUMULATION")


def test_stage_values_are_valid():
    for seed in range(8):
        st = classify_stage(compute_features(make_bars(250, seed=seed, drift=0.002 * (seed - 4))), "crypto")["stage"]
        assert st is None or st in STAGES


def test_distribution_and_reversal_flags():
    f = {"sufficient": True, "last": 95, "sma50": 100, "sma200": 90, "ad_slope": -0.2, "dist_to_high": 0.2, "ud_volume_ratio": 0.7, "rvol": 1.5}
    assert classify_stage(f)["stage"] == "REVERSAL_RISK"
    f2 = {"sufficient": True, "last": 100, "sma50": 98, "sma200": 90, "ad_slope": -0.1, "dist_to_high": 0.02, "ud_volume_ratio": 0.7, "rvol": 1.6}
    assert classify_stage(f2)["stage"] == "DISTRIBUTION"


def test_score_missing_data_is_excluded_and_reduces_confidence():
    full = {k: 80.0 for k in WEIGHTS["crypto"] if WEIGHTS["crypto"][k] > 0}
    sparse = {"accumulation": 80.0}
    a, b = score_early_alpha("crypto", full), score_early_alpha("crypto", sparse)
    assert a["coverage"] == 1.0 and b["coverage"] < 0.3
    assert b["uncertainty"] > a["uncertainty"]
    assert abs(b["score"] - 50) < abs(a["score"] - 50)  # thin evidence is shrunk toward neutral


def test_score_no_evidence_returns_none():
    assert score_early_alpha("equity", {})["score"] is None


def test_asset_class_weights_differ_and_onchain_only_for_crypto():
    assert WEIGHTS["equity"]["onchain"] == 0 and WEIGHTS["crypto"]["onchain"] > 0
    assert WEIGHTS["token"]["liquidity"] > WEIGHTS["equity"]["liquidity"]


def test_token_safety_never_says_safe():
    good = {"liquidity": {"usd": 900_000}, "volume": {"h24": 500_000}, "fdv": 10_000_000, "txns": {"h24": {"buys": 400, "sells": 380}},
            "pairCreatedAt": 1}
    r = screen_dex_pair(good)
    assert r["verdict"] == "NO_FLAGS_FOUND" and r["unverified"] and "audit" in r["disclaimer"].lower()


def test_token_safety_blocks():
    assert screen_dex_pair({"liquidity": {"usd": 1000}})["hard_fail"]
    honey = {"liquidity": {"usd": 500_000}, "txns": {"h24": {"buys": 300, "sells": 0}}, "pairCreatedAt": 1}
    assert any(f["code"] == "NO_SELLS_OBSERVED" for f in screen_dex_pair(honey)["flags"])
    wash = {"liquidity": {"usd": 30_000}, "volume": {"h24": 3_000_000}, "pairCreatedAt": 1}
    assert any(f["code"] == "VOLUME_VS_LIQUIDITY" for f in screen_dex_pair(wash)["flags"])
    assert screen_dex_pair({"liquidity": {"usd": 500_000}, "_holders": {"top10_pct": 92}, "pairCreatedAt": 1})["hard_fail"]
