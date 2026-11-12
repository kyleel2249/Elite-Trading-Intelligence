"""Tests for the Elite Strategy Intelligence library (pure Python; no network, no database).
Synthetic series are used ONLY to exercise code paths; they are never reported as strategy results."""
from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from _strategy_fixtures import synth, synth_pair  # noqa: E402
from app.strategies import (CRITERIA, STRATEGY_CLASSES, Bars, CostModel, MissingData, Plan, RiskModel, get_strategy, latest_signal, list_specs, validate)  # noqa: E402
from app.strategies import engine, indicators as ind  # noqa: E402
from app.strategies.data import align_asof, align_bars, build_aux, events_to_indices  # noqa: E402
from app.strategies.validation import _phi, _phi_inv, deflated_sharpe  # noqa: E402

EXPECTED = ["trend_following", "breakout", "pullback", "momentum", "mean_reversion", "swing_trading", "scalping", "position_trading",
            "statistical_arbitrage", "pairs_trading", "quantitative_trading", "volatility_trading", "macro_trading", "fundamental_value",
            "growth_investing", "contrarian", "wyckoff_method", "darvas_box", "can_slim", "volatility_contraction_pattern",
            "turtle_trading", "price_action", "event_driven"]
GRADES = {"blocked_missing_data", "insufficient_sample", "no_evidence_of_edge", "weak_evidence", "candidate_requires_forward_test"}


def make_aux(b: Bars) -> dict:
    n = len(b)
    return {"pair_close": synth_pair(b), "basket_closes": {f"P{k}": synth_pair(b, 20 + k) for k in range(4)},
            "benchmark_close": [100 + 0.01 * i + math.sin(i / 30) * 3 for i in range(n)],
            "fundamentals": {"earnings_yield": [0.04 + 0.02 * math.sin(i / 90) for i in range(n)], "roe": [0.15] * n, "net_debt_to_ebitda": [1.5] * n,
                             "revenue_growth_yoy": [0.25 + 0.1 * math.sin(i / 70) for i in range(n)], "eps_growth_yoy": [0.3 + 0.2 * math.sin(i / 50) for i in range(n)]},
            "macro": {"liq": [math.sin(i / 80) + i / 1000 for i in range(n)], "usd": [math.cos(i / 60) for i in range(n)]},
            "events": [{"index": i, "surprise": 0.08 if (i // 50) % 2 else -0.08, "kind": "earnings"} for i in range(60, n - 30, 50)]}


def prefix_aux(aux: dict, k: int) -> dict:
    out = {}
    for key, v in aux.items():
        if key == "events": out[key] = [e for e in v if e["index"] < k]
        elif isinstance(v, dict): out[key] = {a: b[:k] for a, b in v.items()}
        else: out[key] = v[:k]
    return out


PARAMS = {"macro_trading": {"signs": {"liq": 1, "usd": -1}}}


class Registry(unittest.TestCase):
    def test_exactly_23_in_specified_order(self):
        self.assertEqual(list(STRATEGY_CLASSES), EXPECTED)
        self.assertEqual(len(list_specs()), 23)

    def test_every_spec_is_complete(self):
        for sid, cls in STRATEGY_CLASSES.items():
            s = cls.spec
            self.assertEqual(s.id, sid)
            for f in ("summary", "timeframe", "stop_loss", "position_sizing"): self.assertTrue(getattr(s, f), (sid, f))
            for f in ("required_data", "entry_rules", "exit_rules", "known_weaknesses"): self.assertTrue(getattr(s, f), (sid, f))
            self.assertIn("fee_bps_per_side", s.expected_costs, sid)
            self.assertTrue(set(s.param_grid) <= set(s.params_default), sid)
            self.assertIn(s.mode, ("trade", "exposure")); self.assertIn(s.fidelity, ("full", "proxy", "partial"))
            if s.fidelity != "full": self.assertTrue(s.fidelity_note, sid)

    def test_unknown_param_rejected(self):
        with self.assertRaises(ValueError): get_strategy("breakout", nope=1)

    def test_modules_are_independent_instances(self):
        a, b = get_strategy("breakout", lookback=10), get_strategy("breakout")
        self.assertNotEqual(a.params["lookback"], b.params["lookback"])


class Indicators(unittest.TestCase):
    def test_sma_ema_constant(self):
        c = [5.0] * 50
        self.assertAlmostEqual(ind.sma(c, 10)[-1], 5.0); self.assertAlmostEqual(ind.ema(c, 10)[-1], 5.0)
        self.assertTrue(math.isnan(ind.sma(c, 10)[8]))

    def test_rsi_bounds_and_extremes(self):
        up = [float(i) for i in range(1, 60)]
        self.assertEqual(ind.rsi(up, 14)[-1], 100.0)
        r = ind.rsi(synth(300).c, 14)
        self.assertTrue(all(0 <= x <= 100 for x in r if not math.isnan(x)))

    def test_highest_shift_excludes_current(self):
        h = [1, 2, 3, 10, 4]
        self.assertEqual(ind.highest(h, 3, 1)[4], 10); self.assertEqual(ind.highest(h, 3, 1)[3], 3)

    def test_ols(self):
        a, b = ind.ols([3, 5, 7, 9], [1, 2, 3, 4]); self.assertAlmostEqual(a, 1.0); self.assertAlmostEqual(b, 2.0)


class Engine(unittest.TestCase):
    def bars(self, o, h, l, c): return Bars(c=c, o=o, h=h, l=l)

    def plan(self, n, **kw):
        p = Plan(signal=[0] * n, exit_signal=[False] * n, stop_dist=[2.0] * n); [setattr(p, k, v) for k, v in kw.items()]; return p

    def test_fill_at_next_open_not_signal_close(self):
        b = self.bars([100, 100, 105, 106, 107, 108], [101, 101, 106, 107, 108, 109], [99, 99, 104, 105, 106, 107], [100, 100, 105, 106, 107, 108])
        p = self.plan(6); p.signal[1] = 1
        r = engine.run_trade(b, p, CostModel(0, 0, 0), RiskModel())
        self.assertEqual(r.trades[0]["entry_i"], 2); self.assertAlmostEqual(r.trades[0]["entry_px"], 105.0)

    def test_gap_through_stop_fills_at_open(self):
        b = self.bars([100, 100, 90, 90], [101, 101, 91, 91], [99, 99, 89, 89], [100, 100, 90, 90])
        p = self.plan(4); p.signal[0] = 1
        r = engine.run_trade(b, p, CostModel(0, 0, 0), RiskModel())
        t = r.trades[0]; self.assertEqual(t["reason"], "stop"); self.assertAlmostEqual(t["exit_px"], 90.0)

    def test_stop_wins_when_stop_and_target_in_same_bar(self):
        b = self.bars([100, 100, 100, 100], [101, 101, 130, 101], [99, 99, 90, 99], [100, 100, 100, 100])
        p = self.plan(4, take_profit_r=1.0); p.signal[0] = 1
        r = engine.run_trade(b, p, CostModel(0, 0, 0), RiskModel())
        self.assertEqual(r.trades[0]["reason"], "stop")

    def test_costs_reduce_pnl_and_leverage_cap(self):
        c = [100 + i * 0.5 for i in range(30)]
        b = Bars(c=c, o=c, h=[x + 0.1 for x in c], l=[x - 0.1 for x in c])
        p = self.plan(30); p.signal[1] = 1; p.exit_signal[20] = True; p.stop_dist = [0.01] * 30
        free = engine.run_trade(b, p, CostModel(0, 0, 0), RiskModel()); paid = engine.run_trade(b, p, CostModel(20, 10, 5), RiskModel())
        self.assertLess(paid.trades[0]["pnl"], free.trades[0]["pnl"])
        self.assertLessEqual(free.trades[0]["qty"] * free.trades[0]["entry_px"], 10_000 * 1.0001)  # tiny stop must not create leverage

    def test_risk_sizing(self):
        c = [100.0] * 10; b = Bars(c=c, o=c, h=c, l=[99.0] * 10)
        p = self.plan(10); p.signal[0] = 1; p.stop_dist = [2.0] * 10
        r = engine.run_trade(b, p, CostModel(0, 0, 0), RiskModel(risk_pct=1.0, max_leverage=5.0))
        self.assertAlmostEqual(r.trades[0]["qty"], 50.0)  # 1% of 10k = 100 risk / 2 stop

    def test_exposure_applies_with_one_bar_delay(self):
        c = [100, 110, 121, 133.1, 133.1]
        p = Plan(mode="exposure", exposure=[1, 1, 1, 0, 0])
        r = engine.run_exposure(c, p, CostModel(0, 0, 0), RiskModel())
        self.assertAlmostEqual(r.bar_returns[0], 0.0); self.assertAlmostEqual(r.bar_returns[1], 0.1)  # exposure set at close 0 earns bar 1

    def test_metrics_drawdown(self):
        self.assertAlmostEqual(engine.max_drawdown_pct([0.1, -0.5, 0.1]), 50.0)


class NoLookAhead(unittest.TestCase):
    """The decisive test: a plan computed on a prefix must equal the same plan restricted from the full series."""

    def test_all_strategies_are_causal(self):
        b = synth(900); aux = make_aux(b); k = 600
        sub = Bars(c=b.c[:k], o=b.o[:k], h=b.h[:k], l=b.l[:k], v=b.v[:k], t=b.t[:k], symbol="S", interval="1h")
        for sid in STRATEGY_CLASSES:
            full = get_strategy(sid, **PARAMS.get(sid, {})).plan(b, aux); part = get_strategy(sid, **PARAMS.get(sid, {})).plan(sub, prefix_aux(aux, k))
            if full.mode == "exposure":
                for i in range(k):
                    self.assertAlmostEqual(full.exposure[i], part.exposure[i], 9, f"{sid}@{i}")
            else:
                self.assertEqual(full.signal[:k], part.signal, sid); self.assertEqual(full.exit_signal[:k], part.exit_signal, sid)
                for i in range(k):
                    a, c = full.stop_dist[i], part.stop_dist[i]
                    self.assertTrue((math.isnan(a) and math.isnan(c)) or abs(a - c) < 1e-9, f"{sid} stop@{i}")


class Behaviour(unittest.TestCase):
    def test_all_run_and_grade_is_from_published_set(self):
        b = synth(1200); aux = make_aux(b)
        for sid in STRATEGY_CLASSES:
            r = validate(sid, b, aux, params=PARAMS.get(sid))
            self.assertEqual(r["status"], "validated_run", sid); self.assertIn(r["verdict"]["grade"], GRADES, sid)
            self.assertFalse(r["execution_eligible"]); self.assertIn("NOT a claim", r["statement"])
            for key in ("backtest", "train_test", "walk_forward", "max_drawdown", "regimes", "cost_sensitivity", "significance"): self.assertIn(key, r, (sid, key))

    def test_missing_data_blocks_instead_of_inventing(self):
        b = synth(500)
        for sid, aux in [("pairs_trading", None), ("statistical_arbitrage", {}), ("fundamental_value", None), ("growth_investing", {}), ("can_slim", None),
                         ("event_driven", None), ("macro_trading", None)]:
            r = validate(sid, b, aux, params=PARAMS.get(sid)); self.assertEqual(r["status"], "blocked_missing_data", sid)
            self.assertEqual(r["verdict"]["grade"], "blocked_missing_data")
            self.assertNotIn("backtest", r)

    def test_close_only_data_refused_by_ohlc_strategies(self):
        b = Bars.from_closes(synth(400).c)
        self.assertEqual(validate("price_action", b)["status"], "blocked_missing_data")

    def test_misaligned_series_blocked(self):
        b = synth(400); r = validate("pairs_trading", b, {"pair_close": [1.0] * 10}); self.assertEqual(r["status"], "blocked_missing_data")

    def test_short_history_is_insufficient_not_validated(self):
        r = validate("breakout", synth(200)); self.assertEqual(r["status"], "insufficient_history"); self.assertEqual(r["verdict"]["grade"], "insufficient_sample")

    def test_random_walk_never_earns_candidate_grade(self):
        # 23 strategies x 3 seeds of driftless noise: a "candidate" here would be a false discovery
        for seed in (1, 2, 3):
            b = synth(1500, seed=seed, drift=0.0); aux = make_aux(b)
            for sid in STRATEGY_CLASSES:
                g = validate(sid, b, aux, params=PARAMS.get(sid))["verdict"]["grade"]
                self.assertNotEqual(g, "candidate_requires_forward_test", (sid, seed))

    def test_latest_signal_shape(self):
        b = synth(600)
        s = latest_signal("trend_following", b); self.assertEqual(s["mode"], "trade"); self.assertIn(s["state"], ("enter_long", "enter_short", "no_entry"))
        m = latest_signal("momentum", b); self.assertEqual(m["mode"], "exposure")

    def test_cost_stress_present_and_monotone_for_active_strategy(self):
        r = validate("mean_reversion", synth(1200)); cs = r["cost_sensitivity"]
        self.assertGreaterEqual(cs["1x"]["total_return_pct"], cs["3x"]["total_return_pct"])


class Statistics(unittest.TestCase):
    def test_phi_inverse_roundtrip(self):
        for p in (0.01, 0.2, 0.5, 0.9, 0.999): self.assertAlmostEqual(_phi(_phi_inv(p)), p, 5)

    def test_deflated_sharpe_penalises_many_trials(self):
        import random
        rng = random.Random(3); r = [rng.gauss(0.0006, 0.01) for _ in range(500)]
        few = deflated_sharpe(r, [0.01]); many = deflated_sharpe(r, [rng.gauss(0.02, 0.05) for _ in range(100)])
        self.assertGreater(few, many)

    def test_criteria_are_published(self):
        self.assertGreaterEqual(CRITERIA["min_oos_trades"], 30)


class DataAlignment(unittest.TestCase):
    def test_asof_never_looks_ahead(self):
        out = align_asof([100, 200, 300, 400], [[250, 5.0], [100, 1.0]])
        self.assertEqual(out, [1.0, 1.0, 5.0, 5.0]); self.assertIsNone(align_asof([50], [[100, 1.0]])[0])

    def test_events_map_to_containing_bar(self):
        ev = events_to_indices([0, 100, 200, 300], [{"ts": 150, "surprise": 0.1}, {"ts": 5000, "surprise": 0.1}, {"ts": -5, "surprise": 1}])
        self.assertEqual([e["index"] for e in ev], [1, 3])  # ts 5000 falls in the last bar; before-window event dropped

    def test_align_bars_inner_join(self):
        a = synth(120); b2 = synth(120, seed=9); b2.t = [t + 10 for t in b2.t]
        sub, closes = align_bars(a, {"B": b2}); self.assertEqual(len(sub), 110); self.assertEqual(len(closes["B"]), 110)

    def test_align_requires_timestamps(self):
        a = Bars.from_closes([1.0] * 100)
        with self.assertRaises(MissingData): align_bars(a, {"B": a})

    def test_from_klines_drops_invalid_and_unfinished(self):
        kl = [{"open": 1, "high": 2, "low": 0.5, "close": 1.5, "volume": 3, "open_time": 1, "close_time": 10},
              {"open": 1, "high": 0.5, "low": 0.4, "close": 1.5, "volume": 3, "open_time": 2, "close_time": 20, "quality_issues": ["invalid_ohlc_relationship"]},
              {"open": 1, "high": 2, "low": 0.5, "close": 1.5, "volume": 3, "open_time": 3, "close_time": 10 ** 15}]
        self.assertEqual(len(Bars.from_klines(kl, now_ms=1000)), 1)


if __name__ == "__main__":
    unittest.main()
