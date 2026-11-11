"""Internal paper engine tests: no network, no credentials, no database."""
from __future__ import annotations

import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.paper.engine import PaperConfig, PaperEngine, Snapshot  # noqa: E402

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


class Clock:
    def __init__(self): self.t = T0
    def __call__(self): return self.t
    def advance(self, s): self.t += timedelta(seconds=s)


def snap(clock, bid=99.9, ask=100.1, bids=None, asks=None, symbol="BTCUSDT", verified=True, age=0):
    return Snapshot(symbol, bid, ask, clock.t - timedelta(seconds=age), bids=bids, asks=asks, verified=verified)


def mk(**cfg):
    c = Clock(); k = {"killed": False}
    e = PaperEngine("t", PaperConfig(**cfg), clock=c, kill_switch=lambda: k["killed"])
    return e, c, k


class Orders(unittest.TestCase):
    def test_market_buy_pays_slippage_and_fee_and_updates_cash(self):
        e, c, _ = mk()
        r = e.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap(c))
        self.assertTrue(r["accepted"]); o = r["order"]; self.assertEqual(o["status"], "filled")
        f = r["fills"][0]
        self.assertGreater(f["price"], 100.1)                       # slippage against us
        self.assertAlmostEqual(f["fee"], 10 * f["price"] * 10 / 1e4)
        self.assertAlmostEqual(e.cash, 100_000 - 10 * f["price"] - f["fee"])
        self.assertEqual(e.reserved_cash(), 0.0)
        self.assertAlmostEqual(e.held_qty("BTCUSDT"), 10)

    def test_sell_realizes_pnl_and_cannot_exceed_holdings(self):
        e, c, _ = mk()
        e.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap(c)); c.advance(10)
        bad = e.submit(symbol="BTCUSDT", side="sell", qty=10.5, snap=snap(c, 109.9, 110.1))
        self.assertFalse(bad["accepted"]); self.assertEqual(bad["reasons"], ["insufficient_holdings"])
        ok = e.submit(symbol="BTCUSDT", side="sell", qty=10, snap=snap(c, 109.9, 110.1))
        self.assertTrue(ok["accepted"]); self.assertGreater(e.realized_pnl, 0)
        self.assertEqual(e.open_positions(), 0)

    def test_no_shorting_without_any_holdings(self):
        e, c, _ = mk()
        r = e.submit(symbol="BTCUSDT", side="sell", qty=1, snap=snap(c))
        self.assertEqual(r["reasons"], ["insufficient_holdings"])

    def test_insufficient_balance_rejected_without_state_change(self):
        e, c, _ = mk(starting_cash=1_000, max_order_pct=1000, max_position_pct=1000)
        r = e.submit(symbol="BTCUSDT", side="buy", qty=20, snap=snap(c))
        self.assertEqual(r["reasons"], ["insufficient_balance"]); self.assertEqual(e.cash, 1_000)
        self.assertEqual(e.open_positions(), 0)

    def test_partial_fill_from_limited_depth_ioc_cancels_remainder(self):
        e, c, _ = mk()
        asks = [(100.1, 4.0), (100.2, 4.0)]   # participation 0.5 -> only 2 + 2 available
        r = e.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap(c, asks=asks, bids=[(99.9, 50)]))
        self.assertAlmostEqual(r["fills"][0]["qty"], 4.0)
        o = r["order"]; self.assertEqual(o["status"], "canceled"); self.assertEqual(o["reason"], "ioc_unfilled_remainder_canceled")
        self.assertAlmostEqual(o["filled_qty"], 4.0); self.assertEqual(e.reserved_cash(), 0.0)

    def test_partial_fill_gtc_market_stays_working_and_completes_on_tick(self):
        e, c, _ = mk()
        asks = [(100.1, 8.0)]
        r = e.submit(symbol="BTCUSDT", side="buy", qty=10, tif="gtc", snap=snap(c, asks=asks, bids=[(99.9, 50)]))
        self.assertEqual(r["order"]["status"], "partially_filled"); self.assertGreater(e.reserved_cash(), 0)
        c.advance(1)
        f = e.process_market(snap(c, asks=[(100.1, 20.0)], bids=[(99.9, 50)]))
        self.assertAlmostEqual(f[0]["qty"], 6.0)
        self.assertEqual(e.orders[r["order"]["id"]].status, "filled"); self.assertEqual(e.reserved_cash(), 0.0)

    def test_limit_buy_rests_then_fills_as_maker_at_limit(self):
        e, c, _ = mk()
        r = e.submit(symbol="BTCUSDT", side="buy", qty=5, order_type="limit", limit_price=99.0, snap=snap(c))
        self.assertEqual(r["order"]["status"], "new"); self.assertGreater(e.reserved_cash(), 0)
        c.advance(2); self.assertEqual(e.process_market(snap(c, 99.5, 99.7)), [])      # not crossed yet
        c.advance(2); f = e.process_market(snap(c, 98.7, 98.9))
        self.assertEqual(f[0]["role"], "maker"); self.assertAlmostEqual(f[0]["price"], 99.0)

    def test_marketable_limit_is_taker_with_price_improvement(self):
        e, c, _ = mk()
        r = e.submit(symbol="BTCUSDT", side="buy", qty=5, order_type="limit", limit_price=101.0, snap=snap(c))
        self.assertEqual(r["fills"][0]["role"], "taker"); self.assertAlmostEqual(r["fills"][0]["price"], 100.1)

    def test_cancel_releases_reservation_and_is_idempotent(self):
        e, c, _ = mk()
        r = e.submit(symbol="BTCUSDT", side="buy", qty=5, order_type="limit", limit_price=90.0, snap=snap(c))
        self.assertGreater(e.reserved_cash(), 0)
        x = e.cancel(r["order"]["id"]); self.assertTrue(x["ok"]); self.assertEqual(e.reserved_cash(), 0.0)
        self.assertFalse(e.cancel(r["order"]["id"])["ok"])
        self.assertEqual(e.available_cash(), e.cash)

    def test_cancel_sell_releases_holdings(self):
        e, c, _ = mk()
        e.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap(c)); c.advance(10)
        s = e.submit(symbol="BTCUSDT", side="sell", qty=10, order_type="limit", limit_price=150, snap=snap(c))
        self.assertAlmostEqual(e.available_qty("BTCUSDT"), 0)
        e.cancel(s["order"]["id"]); self.assertAlmostEqual(e.available_qty("BTCUSDT"), 10)

    def test_stop_loss_triggers_and_fills_below_trigger_on_gap(self):
        e, c, _ = mk()
        e.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap(c)); c.advance(10)
        s = e.submit(symbol="BTCUSDT", side="sell", qty=10, order_type="stop", trigger_price=95.0, snap=snap(c))
        self.assertEqual(s["order"]["status"], "new")
        c.advance(2); self.assertEqual(e.process_market(snap(c, 97, 97.2)), [])
        c.advance(2); f = e.process_market(snap(c, 90.0, 90.2))                     # gap through the stop
        self.assertLess(f[0]["price"], 90.0 + 1e-9); self.assertLess(f[0]["price"], 95.0)
        self.assertLess(e.realized_pnl, 0)

    def test_take_profit_triggers(self):
        e, c, _ = mk()
        e.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap(c)); c.advance(10)
        e.submit(symbol="BTCUSDT", side="sell", qty=10, order_type="take_profit", trigger_price=110.0, snap=snap(c))
        c.advance(2); f = e.process_market(snap(c, 111, 111.2))
        self.assertEqual(len(f), 1); self.assertGreater(e.realized_pnl, 0)

    def test_stop_already_hit_is_rejected(self):
        e, c, _ = mk()
        e.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap(c)); c.advance(10)
        r = e.submit(symbol="BTCUSDT", side="sell", qty=10, order_type="stop", trigger_price=105.0, snap=snap(c))
        self.assertEqual(r["reasons"], ["trigger_already_hit"])

    def test_oco_shares_reservation_and_cancels_sibling(self):
        e, c, _ = mk()
        e.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap(c)); c.advance(10)
        r = e.submit_oco(symbol="BTCUSDT", qty=10, stop_price=95, take_profit_price=110, snap=snap(c))
        self.assertTrue(r["accepted"]); self.assertAlmostEqual(e.available_qty("BTCUSDT"), 0)   # one reservation, not two
        c.advance(2); e.process_market(snap(c, 111, 111.2))
        st = {o["type"]: o["status"] for o in e.list_orders("all") if o["oco_group"]}
        self.assertEqual(st, {"stop": "canceled", "take_profit": "filled"})
        self.assertAlmostEqual(e.held_qty("BTCUSDT"), 0)

    def test_oco_cannot_exceed_holdings(self):
        e, c, _ = mk()
        r = e.submit_oco(symbol="BTCUSDT", qty=1, stop_price=95, take_profit_price=110, snap=snap(c))
        self.assertFalse(r["accepted"])


class Protections(unittest.TestCase):
    def test_idempotent_client_order_id(self):
        e, c, _ = mk()
        a = e.submit(symbol="BTCUSDT", side="buy", qty=1, client_order_id="abc", snap=snap(c))
        b = e.submit(symbol="BTCUSDT", side="buy", qty=1, client_order_id="abc", snap=snap(c))
        self.assertTrue(b["duplicate"]); self.assertEqual(a["order"]["id"], b["order"]["id"]); self.assertEqual(len(e.fills), 1)

    def test_duplicate_content_window(self):
        e, c, _ = mk()
        e.submit(symbol="BTCUSDT", side="buy", qty=1, snap=snap(c))
        r = e.submit(symbol="BTCUSDT", side="buy", qty=1, snap=snap(c))
        self.assertEqual(r["reasons"], ["duplicate_order_within_window"])
        c.advance(30); self.assertTrue(e.submit(symbol="BTCUSDT", side="buy", qty=1, snap=snap(c))["accepted"])

    def test_kill_switch_blocks_orders_and_freezes_fills_but_allows_cancel(self):
        e, c, k = mk()
        r = e.submit(symbol="BTCUSDT", side="buy", qty=1, order_type="limit", limit_price=90, snap=snap(c))
        k["killed"] = True
        self.assertEqual(e.submit(symbol="BTCUSDT", side="buy", qty=2, snap=snap(c))["reasons"], ["kill_switch_active"])
        self.assertEqual(e.process_market(snap(c, 80, 80.1)), [])
        self.assertTrue(e.cancel(r["order"]["id"])["ok"])

    def test_no_price_or_unverified_or_stale_quote_rejected(self):
        e, c, _ = mk()
        self.assertEqual(e.submit(symbol="BTCUSDT", side="buy", qty=1, snap=None)["reasons"], ["no_verified_live_price"])
        self.assertEqual(e.submit(symbol="BTCUSDT", side="buy", qty=1, snap=snap(c, verified=False))["reasons"], ["quote_not_verified"])
        self.assertEqual(e.submit(symbol="BTCUSDT", side="buy", qty=1, snap=snap(c, age=60))["reasons"], ["quote_stale"])
        self.assertEqual(e.submit(symbol="BTCUSDT", side="buy", qty=1, snap=snap(c, 90, 110))["reasons"], ["spread_too_wide"])
        self.assertEqual(e.cash, 100_000)

    def test_input_validation(self):
        e, c, _ = mk(); s = snap(c)
        for kw, why in [({"qty": 0}, "invalid_quantity"), ({"qty": float("nan")}, "invalid_quantity"), ({"side": "short"}, "invalid_side"),
                        ({"order_type": "limit"}, "limit_price_required"), ({"order_type": "stop"}, "trigger_price_required"),
                        ({"symbol": "BT C"}, "invalid_symbol"), ({"order_type": "iceberg"}, "invalid_order_type")]:
            args = {"symbol": "BTCUSDT", "side": "buy", "qty": 1, **kw}
            self.assertEqual(e.submit(snap=s, **args)["reasons"], [why], kw)

    def test_position_and_order_limits(self):
        e, c, _ = mk(max_order_pct=10)
        self.assertEqual(e.submit(symbol="BTCUSDT", side="buy", qty=200, snap=snap(c))["reasons"], ["order_exceeds_max_order_pct"])
        e2, c2, _ = mk(max_open_positions=1)
        e2.submit(symbol="BTCUSDT", side="buy", qty=1, snap=snap(c2))
        r = e2.submit(symbol="ETHUSDT", side="buy", qty=1, snap=snap(c2, symbol="ETHUSDT"))
        self.assertEqual(r["reasons"], ["max_open_positions_reached"])

    def test_rejected_orders_are_recorded_and_audited(self):
        e, c, _ = mk(); e.submit(symbol="BTCUSDT", side="sell", qty=1, snap=snap(c))
        self.assertEqual(e.list_orders("closed")[0]["status"], "rejected")
        self.assertIn("order_rejected", [a["event"] for a in e.drain_audit()])

    def test_preview_never_mutates(self):
        e, c, _ = mk(); before = json.dumps(e.to_state(), sort_keys=True)
        p = e.preview(symbol="BTCUSDT", side="buy", qty=5, snap=snap(c))
        self.assertTrue(p["would_accept"]); self.assertGreater(p["estimated_avg_price"], 100.1); self.assertGreater(p["estimated_fees"], 0)
        self.assertEqual(json.dumps(e.to_state(), sort_keys=True), before); self.assertEqual(e.drain_audit(), [])
        bad = e.preview(symbol="BTCUSDT", side="sell", qty=5, snap=snap(c)); self.assertFalse(bad["would_accept"])


class Accounting(unittest.TestCase):
    def test_equity_identity_realized_plus_unrealized(self):
        e, c, _ = mk()
        e.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap(c)); c.advance(10)
        e.submit(symbol="BTCUSDT", side="buy", qty=5, snap=snap(c, 104.9, 105.1)); c.advance(10)
        e.submit(symbol="BTCUSDT", side="sell", qty=6, snap=snap(c, 109.9, 110.1)); c.advance(10)
        v = e.account_view({"BTCUSDT": 108.0})
        self.assertAlmostEqual(v["equity"] - v["starting_cash"], v["realized_pnl"] + v["unrealized_pnl"], 6)
        self.assertAlmostEqual(v["total_pnl"], v["realized_pnl"] + v["unrealized_pnl"], 6)
        h = v["positions"][0]; self.assertAlmostEqual(h["qty"], 9.0)
        self.assertAlmostEqual(h["unrealized_pnl"], 9.0 * (108.0 - h["avg_cost"]))

    def test_weighted_average_cost_includes_fees(self):
        e, c, _ = mk(base_slippage_bps=0, impact_bps_full_level=0, unknown_liquidity_penalty_bps=0)
        e.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap(c, 99.9, 100.0)); c.advance(10)
        e.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap(c, 109.9, 110.0)); 
        h = e.holdings["BTCUSDT"]; fees = 10 * 100 * 0.001 + 10 * 110 * 0.001
        self.assertAlmostEqual(h["avg_cost"], (10 * 100 + 10 * 110 + fees) / 20, 6)

    def test_fees_paid_tracks_every_fill(self):
        e, c, _ = mk()
        e.submit(symbol="BTCUSDT", side="buy", qty=3, snap=snap(c)); c.advance(10); e.submit(symbol="BTCUSDT", side="sell", qty=3, snap=snap(c))
        self.assertAlmostEqual(e.fees_paid, sum(f["fee"] for f in e.fills))

    def test_losing_round_trip_costs_spread_slippage_and_fees(self):
        e, c, _ = mk()
        e.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap(c)); c.advance(10)
        e.submit(symbol="BTCUSDT", side="sell", qty=10, snap=snap(c))                 # same quote: flat market
        self.assertLess(e.account_view()["total_pnl"], 0)


class Persistence(unittest.TestCase):
    def test_state_roundtrip_through_json_restores_everything(self):
        e, c, _ = mk()
        e.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap(c)); c.advance(10)
        e.submit(symbol="BTCUSDT", side="sell", qty=4, order_type="limit", limit_price=150, snap=snap(c)); c.advance(10)
        e.submit(symbol="BTCUSDT", side="buy", qty=2, order_type="limit", limit_price=50, snap=snap(c))
        state = json.loads(json.dumps(e.to_state()))
        r = PaperEngine.from_state(state, e.cfg, clock=c, kill_switch=lambda: False)
        self.assertEqual(r.cash, e.cash); self.assertEqual(r.realized_pnl, e.realized_pnl); self.assertEqual(r.holdings, e.holdings)
        self.assertEqual(r.list_orders("open"), e.list_orders("open")); self.assertEqual(r.fills, e.fills)
        self.assertAlmostEqual(r.available_qty("BTCUSDT"), 6.0); self.assertGreater(r.reserved_cash(), 0)
        # the restored engine keeps working: resting buy limit fills, ids do not collide
        c.advance(10); f = r.process_market(snap(c, 49.0, 49.2))
        self.assertEqual(len(f), 1); self.assertEqual(len({o["id"] for o in r.list_orders("all")}), 3)
        r.submit(symbol="BTCUSDT", side="buy", qty=1, snap=snap(c, 99.9, 100.1))
        self.assertEqual(len({o["id"] for o in r.list_orders("all")}), 4)

    def test_idempotency_survives_restart(self):
        e, c, _ = mk(); e.submit(symbol="BTCUSDT", side="buy", qty=1, client_order_id="k1", snap=snap(c))
        r = PaperEngine.from_state(json.loads(json.dumps(e.to_state())), e.cfg, clock=c)
        self.assertTrue(r.submit(symbol="BTCUSDT", side="buy", qty=1, client_order_id="k1", snap=snap(c))["duplicate"])
        self.assertEqual(len(r.fills), 1)

    def test_reset_clears_account_and_is_audited(self):
        e, c, _ = mk(); e.submit(symbol="BTCUSDT", side="buy", qty=1, snap=snap(c)); e.drain_audit()
        e.reset(5_000); self.assertEqual(e.cash, 5_000); self.assertEqual(e.fills, []); self.assertEqual(e.open_positions(), 0)
        self.assertEqual([a["event"] for a in e.drain_audit()], ["account_reset"])


if __name__ == "__main__":
    unittest.main()
