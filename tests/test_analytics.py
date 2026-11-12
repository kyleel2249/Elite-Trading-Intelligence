import math
import random
import unittest

from app.analytics import correlation, detectors, montecarlo, regime, reporting, research, stats, stress, walkforward


def candles(n, drift=0.002, vol=0.01, seed=1, base_vol=1000.0):
    r = random.Random(seed)
    px, out = 100.0, []
    for _ in range(n):
        o = px
        px *= 1 + drift + r.gauss(0, vol)
        out.append({"open": o, "high": max(o, px) * 1.003, "low": min(o, px) * 0.997, "close": px, "volume": base_vol * (1 + r.random() * 0.1)})
    return out


class MonteCarlo(unittest.TestCase):
    def test_insufficient(self):
        self.assertEqual(montecarlo.monte_carlo([0.01] * 5)["status"], "insufficient_data")

    def test_deterministic_and_sane(self):
        rets = stats.pct_returns(stats.closes_of(candles(200)))
        a = montecarlo.monte_carlo(rets, horizon=50, n_paths=300, seed=7)
        b = montecarlo.monte_carlo(rets, horizon=50, n_paths=300, seed=7)
        self.assertEqual(a, b)
        self.assertLessEqual(a["terminal_equity"]["p5"], a["terminal_equity"]["p50"])
        self.assertLessEqual(a["terminal_equity"]["p50"], a["terminal_equity"]["p95"])
        self.assertTrue(0 <= a["probability_of_loss"] <= 1)

    def test_rejects_bad_args(self):
        with self.assertRaises(ValueError):
            montecarlo.monte_carlo([0.01] * 40, horizon=0)


class Stress(unittest.TestCase):
    def test_pnl(self):
        pos = [{"symbol": "BTC", "market_value": 1000, "asset_class": "crypto"}, {"symbol": "AAPL", "market_value": 1000, "asset_class": "stock"}]
        r = stress.stress_test(pos, {"s": {"crypto": -0.5, "stock": -0.1}})
        self.assertEqual(r["scenarios"][0]["pnl"], -600.0)

    def test_short_gains_in_selloff(self):
        r = stress.stress_test([{"symbol": "X", "market_value": -1000, "asset_class": "stock"}], {"s": {"stock": -0.2}})
        self.assertEqual(r["scenarios"][0]["pnl"], 200.0)

    def test_scenario_probabilities(self):
        pos = [{"symbol": "A", "market_value": 100, "asset_class": "stock"}]
        with self.assertRaises(ValueError):
            stress.scenario_analysis(pos, [{"name": "a", "probability": 0.5, "shocks": {}}])
        r = stress.scenario_analysis(pos, [{"name": "up", "probability": 0.5, "shocks": {"stock": 0.1}}, {"name": "dn", "probability": 0.5, "shocks": {"stock": -0.3}}])
        self.assertEqual(r["expected_pnl"], -10.0)


class Correlation(unittest.TestCase):
    def test_pairs(self):
        base = stats.closes_of(candles(120, seed=3))
        prices = {"A": base, "B": [p * 2 for p in base], "C": stats.closes_of(candles(120, seed=99))}
        r = correlation.correlation_matrix(prices)
        self.assertAlmostEqual(r["matrix"]["A"]["B"], 1.0, places=3)
        self.assertTrue(any({"A", "B"} == {w["a"], w["b"]} for w in r["concentration_warnings"]))

    def test_insufficient(self):
        self.assertEqual(correlation.correlation_matrix({"A": [1, 2, 3], "B": [1, 2, 3]})["status"], "insufficient_data")


class Regime(unittest.TestCase):
    def test_uptrend(self):
        r = regime.detect_regime(candles(150, drift=0.01, vol=0.002))
        self.assertEqual(r["regime"], "trending_up")

    def test_downtrend(self):
        self.assertEqual(regime.detect_regime(candles(150, drift=-0.01, vol=0.002))["regime"], "trending_down")

    def test_range(self):
        ks = [{"open": 100, "high": 101, "low": 99, "close": 100 + (1 if i % 2 else -1), "volume": 1} for i in range(120)]
        self.assertEqual(regime.detect_regime(ks)["regime"], "ranging")


class Detectors(unittest.TestCase):
    def test_volume_spike(self):
        ks = candles(40)
        ks[-1]["volume"] = 20000
        self.assertTrue(detectors.unusual_volume(ks)["unusual"])
        self.assertFalse(detectors.unusual_volume(candles(40))["unusual"])

    def test_breakout(self):
        ks = [{"open": 100, "high": 100.5, "low": 99.5, "close": 100 + (0.2 if i % 2 else -0.2), "volume": 1} for i in range(80)]
        ks.append({"open": 100, "high": 108, "low": 99, "close": 107, "volume": 5})
        r = detectors.volatility_breakout(ks)
        self.assertEqual(r["direction"], "up")
        self.assertTrue(r["alert"])


class WalkForward(unittest.TestCase):
    def test_no_lookahead_in_simulate(self):
        closes = [100, 110, 100]
        res = walkforward.simulate(closes, [1, 0, 0], fee_bps=0)
        self.assertAlmostEqual(res["return_pct"], 10.0, places=6)

    def test_walk_forward_runs_and_is_oos(self):
        closes = stats.closes_of(candles(400, drift=0.003, vol=0.02, seed=5))
        r = walkforward.walk_forward(closes, "sma_cross", {"fast": [5, 10], "slow": [20, 40]}, train_bars=120, test_bars=40, min_trades=1)
        self.assertEqual(r["status"], "ok")
        self.assertGreaterEqual(r["fold_count"], 3)
        for f in r["folds"]:
            self.assertGreaterEqual(f["start_index"], 120)

    def test_insufficient_and_bad_strategy(self):
        self.assertEqual(walkforward.walk_forward([1.0] * 10, "sma_cross", {"fast": [2], "slow": [3]})["status"], "insufficient_data")
        with self.assertRaises(ValueError):
            walkforward.walk_forward([1.0] * 500, "nope", {"a": [1]})

    def test_compare(self):
        closes = stats.closes_of(candles(200))
        r = walkforward.compare_strategies(closes, [{"name": "a", "strategy": "sma_cross", "params": {"fast": 5, "slow": 20}},
                                                    {"name": "b", "strategy": "channel_breakout", "params": {"lookback": 20}}])
        self.assertEqual(len(r["results"]), 2)


class Reporting(unittest.TestCase):
    def tx(self):
        return [{"id": "1", "ts": "2024-01-01T00:00:00Z", "symbol": "BTC", "side": "buy", "qty": 1, "price": 100},
                {"id": "2", "ts": "2024-02-01T00:00:00Z", "symbol": "BTC", "side": "buy", "qty": 1, "price": 200},
                {"id": "3", "ts": "2025-03-01T00:00:00Z", "symbol": "BTC", "side": "sell", "qty": 1, "price": 300}]

    def test_fifo_lifo_hifo(self):
        self.assertEqual(reporting.realized_gains(self.tx(), "FIFO")["totals"]["net_gain"], 200.0)
        self.assertEqual(reporting.realized_gains(self.tx(), "FIFO")["totals"]["long_term_gain"], 200.0)
        self.assertEqual(reporting.realized_gains(self.tx(), "LIFO")["totals"]["net_gain"], 100.0)
        self.assertEqual(reporting.realized_gains(self.tx(), "HIFO")["totals"]["net_gain"], 100.0)

    def test_oversell_flagged(self):
        r = reporting.realized_gains([{"id": "s", "ts": "2024-01-01", "symbol": "X", "side": "sell", "qty": 1, "price": 1}])
        self.assertTrue(r["issues"])

    def test_fees_and_csv(self):
        r = reporting.realized_gains([{"id": "b", "ts": "2024-01-01", "symbol": "X", "side": "buy", "qty": 1, "price": 100, "fee": 1},
                                      {"id": "s", "ts": "2024-01-10", "symbol": "X", "side": "sell", "qty": 1, "price": 110, "fee": 1}])
        self.assertEqual(r["totals"]["net_gain"], 8.0)
        self.assertIn("symbol,sell_id", reporting.transactions_csv(r["rows"]))

    def test_fx_missing_rate_not_guessed(self):
        r = reporting.convert_portfolio([{"account": "a", "symbol": "S", "value": 100, "currency": "EUR"},
                                         {"account": "b", "symbol": "T", "value": 50, "currency": "JPY"}], "USD", {"EUR": 1.1})
        self.assertEqual(r["status"], "partial")
        self.assertEqual(r["total_value"], 110.0)
        self.assertEqual(r["missing_fx_rates"], ["JPY"])

    def test_live_vs_backtest(self):
        rng = random.Random(2)
        bt = [rng.gauss(0.01, 0.01) for _ in range(60)]
        live = [rng.gauss(-0.01, 0.01) for _ in range(60)]
        self.assertTrue(reporting.live_vs_backtest(live, bt)["degradation"])
        self.assertEqual(reporting.live_vs_backtest([0.1], bt)["status"], "insufficient_data")


class Research(unittest.TestCase):
    def test_rank_watchlist_alerts(self):
        scans = [research.scan_symbol("UP", candles(150, drift=0.01, vol=0.002)), research.scan_symbol("SHORT", candles(10))]
        self.assertEqual(scans[1]["status"], "insufficient_data")
        ranked = research.rank_opportunities(scans)
        self.assertEqual(ranked[0]["symbol"], "UP")
        self.assertEqual(research.build_watchlist(ranked)["count"], 1)
        al = research.risk_alerts({"equity": 8000, "peak_equity": 10000, "daily_pnl_pct": -4, "positions": [{"symbol": "A", "market_value": 5000}]})
        self.assertEqual({a["rule"] for a in al}, {"drawdown", "daily_loss", "concentration"})

    def test_replay_has_no_lookahead(self):
        rp = research.Replay(candles(100), start=60)
        self.assertEqual(len(rp.visible()), 60)
        rp.step(5)
        self.assertEqual(len(rp.visible()), 65)

    def test_nlq(self):
        r = research.parse_query("Is BTCUSDT trending on the 4h?")
        self.assertEqual((r["intent"], r["symbols"], r["interval"]), ("regime", ["BTCUSDT"], "4h"))
        self.assertEqual(research.parse_query("tell me a joke")["status"], "unrecognized")
        with self.assertRaises(ValueError):
            research.parse_query("  ")

    def test_dossier_gates_recommendation(self):
        d = research.research_dossier("AAPL", "stock", {"fundamentals": {"pe": 30}})
        self.assertEqual(d["exposure_recommendation"], "no_recommendation_insufficient_evidence")
        full = {k: "x" for k in research.REQUIRED_EVIDENCE["currency"]}
        self.assertEqual(research.research_dossier("EURUSD", "currency", full)["exposure_recommendation"], "research_complete_human_review_required")


if __name__ == "__main__":
    unittest.main()
