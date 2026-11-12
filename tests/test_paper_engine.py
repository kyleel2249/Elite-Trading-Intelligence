"""Internal paper engine: fills, fees, balances, holdings, orders, P&L, persistence. Pure Python, no network."""
from __future__ import annotations

import json
import pytest

# These suites target the standalone engine (app.paper.core / app.paper.modes) that was superseded by app/paper/engine.py,
# service.py and mode.py. They are kept, not deleted, and skip until they are ported to the surviving engine.
pytest.importorskip("app.paper.core", reason="targets the superseded app.paper.core engine; port to app.paper.engine")

import unittest
from datetime import datetime, timedelta, timezone

from app.paper.core import (Account, Book, LIMIT, MARKET, OrderRequest, PaperConfig, PaperEngine, PaperError,
                            STOP_LOSS, TAKE_PROFIT, simulate_walk)

T0 = datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)


def book(bid=100.0, ask=100.1, depth=100.0, ts=T0, symbol="BTCUSDT", levels=None):
    if levels:
        bids, asks = levels
    else:
        bids = tuple((round(bid - i * 0.1, 6), depth) for i in range(5))
        asks = tuple((round(ask + i * 0.1, 6), depth) for i in range(5))
    return Book(symbol, tuple(bids), tuple(asks), ts, "test")


def engine(**cfg):
    base = dict(starting_cash=10_000.0, taker_fee_bps=10, maker_fee_bps=10, extra_slippage_bps=0.0, participation=1.0,
                max_position_notional_pct=100, max_order_notional_pct=100, duplicate_window_seconds=0)
    base.update(cfg)
    return PaperEngine(PaperEngine.new_account("t", PaperConfig(**base), T0))


def req(side="buy", type=MARKET, qty=1.0, **kw):
    return OrderRequest("BTCUSDT", side, type, qty, **kw)


class BuySellTests(unittest.TestCase):
    def test_market_buy_walks_book_and_charges_fee(self):
        e = engine()
        b = book(levels=(((99.9, 5),), ((100.0, 1), (101.0, 2))))
        o = e.place_order(req("buy", qty=2), b, T0)
        self.assertEqual(o.status, "filled")
        self.assertAlmostEqual(o.avg_fill_price, (100.0 + 101.0) / 2)      # real slippage from depth
        notional, fee = 201.0, 201.0 * 0.001
        self.assertAlmostEqual(e.acct.cash, 10_000 - notional - fee)
        self.assertAlmostEqual(o.fees, fee)
        self.assertAlmostEqual(e.acct.positions["BTCUSDT"].avg_cost, (notional + fee) / 2)

    def test_extra_slippage_applied(self):
        e = engine(extra_slippage_bps=10)
        o = e.place_order(req(qty=1), book(), T0)
        self.assertAlmostEqual(o.avg_fill_price, 100.1 * 1.001)

    def test_sell_realizes_pnl_net_of_both_fees(self):
        e = engine()
        e.place_order(req("buy", qty=1), book(bid=99.9, ask=100.0), T0)
        o = e.place_order(req("sell", qty=1, client_order_id="s"), book(bid=110.0, ask=110.1), T0)
        buy_cost = 100.0 + 0.1
        sell_net = 110.0 - 0.11
        self.assertAlmostEqual(e.acct.realized_pnl, sell_net - buy_cost)
        self.assertAlmostEqual(e.acct.cash, 10_000 + sell_net - buy_cost)
        s = e.summary()
        self.assertEqual(s["positions"], [])
        self.assertAlmostEqual(s["total_pnl"], s["realized_pnl"])
        self.assertAlmostEqual(s["fees_paid"], 0.1 + 0.11)

    def test_pnl_invariant_equity_equals_start_plus_realized_plus_unrealized(self):
        e = engine()
        e.place_order(req("buy", qty=3), book(bid=99.9, ask=100.0), T0)
        e.place_order(req("sell", qty=1, client_order_id="a"), book(bid=104.0, ask=104.1), T0)
        e.place_order(req("buy", qty=2, client_order_id="b"), book(bid=102.0, ask=102.1), T0)
        s = e.summary({"BTCUSDT": 101.0})
        self.assertAlmostEqual(s["equity"] - s["starting_cash"], s["realized_pnl"] + s["unrealized_pnl"], places=9)
        self.assertAlmostEqual(s["total_pnl"], s["realized_pnl"] + s["unrealized_pnl"], places=9)

    def test_average_cost_on_multiple_buys(self):
        e = engine(taker_fee_bps=0)
        e.place_order(req("buy", qty=1), book(bid=99.9, ask=100.0), T0)
        e.place_order(req("buy", qty=1, client_order_id="2"), book(bid=119.9, ask=120.0), T0)
        p = e.acct.positions["BTCUSDT"]
        self.assertAlmostEqual(p.avg_cost, 110.0)
        self.assertAlmostEqual(p.qty, 2.0)

    def test_unrealized_uses_bid_mark(self):
        e = engine(taker_fee_bps=0)
        e.place_order(req("buy", qty=1), book(bid=99.9, ask=100.0), T0)
        s = e.summary({"BTCUSDT": 105.0})
        self.assertAlmostEqual(s["unrealized_pnl"], 5.0)


class RejectionTests(unittest.TestCase):
    def test_insufficient_balance(self):
        e = engine(starting_cash=100)
        with self.assertRaisesRegex(PaperError, "Insufficient balance"):
            e.place_order(req("buy", qty=5), book(), T0)
        self.assertEqual(e.acct.cash, 100)
        self.assertEqual(e.audit[-1]["event"], "order_rejected")

    def test_insufficient_holdings(self):
        e = engine()
        with self.assertRaisesRegex(PaperError, "Insufficient holdings"):
            e.place_order(req("sell", qty=1), book(), T0)
        e.place_order(req("buy", qty=1), book(), T0)
        with self.assertRaisesRegex(PaperError, "Insufficient holdings"):
            e.place_order(req("sell", qty=1.5, client_order_id="x"), book(), T0)

    def test_open_sell_orders_reserve_holdings(self):
        e = engine()
        e.place_order(req("buy", qty=2), book(), T0)
        e.place_order(req("sell", LIMIT, 1.5, limit_price=200.0), book(), T0)
        with self.assertRaisesRegex(PaperError, "reserved"):
            e.place_order(req("sell", MARKET, 1.0, client_order_id="y"), book(), T0)
        self.assertAlmostEqual(e.available_qty("BTCUSDT"), 0.5)

    def test_open_limit_buy_reserves_cash(self):
        e = engine(starting_cash=1000)
        e.place_order(req("buy", LIMIT, 9, limit_price=100.0), book(bid=100.1, ask=100.2), T0)
        self.assertAlmostEqual(e.available_cash(), 1000 - 9 * 100 * 1.001)
        with self.assertRaisesRegex(PaperError, "Insufficient balance"):
            e.place_order(req("buy", LIMIT, 2, limit_price=100.0, client_order_id="z"), book(bid=100.1, ask=100.2), T0)

    def test_stale_crossed_wide_empty_book_rejected(self):
        e = engine()
        with self.assertRaisesRegex(PaperError, "stale"):
            e.place_order(req(), book(ts=T0 - timedelta(seconds=30)), T0)
        with self.assertRaisesRegex(PaperError, "crossed|empty"):
            e.place_order(req(client_order_id="a"), book(bid=101, ask=100), T0)
        with self.assertRaisesRegex(PaperError, "Spread"):
            e.place_order(req(client_order_id="b"), book(bid=90, ask=110), T0)
        with self.assertRaisesRegex(PaperError, "crossed|empty"):
            e.place_order(req(client_order_id="c"), Book("BTCUSDT", (), (), T0), T0)
        self.assertEqual(e.acct.cash, 10_000)

    def test_bad_inputs(self):
        e = engine()
        for bad in (req(qty=0), req(qty=-1), req(qty=float("nan")), req(qty=float("inf")),
                    req(type="iceberg"), req(side="hold"), req(type=LIMIT), req(type=STOP_LOSS, side="sell"),
                    req(type=STOP_LOSS, side="buy", stop_price=90.0), OrderRequest("bad symbol!", "buy", MARKET, 1)):
            with self.assertRaises(PaperError):
                e.place_order(bad, book(), T0)

    def test_position_and_order_limits(self):
        e = engine(max_order_notional_pct=10)
        with self.assertRaisesRegex(PaperError, "equity"):
            e.place_order(req(qty=20), book(), T0)               # 2000 notional > 10% of 10000
        e = engine(max_position_notional_pct=15, max_order_notional_pct=100)
        e.place_order(req(qty=10), book(), T0)                    # ~1000 = 10%
        with self.assertRaisesRegex(PaperError, "Position"):
            e.place_order(req(qty=10, client_order_id="b"), book(), T0)

    def test_max_open_positions(self):
        e = engine(max_open_positions=1)
        e.place_order(req(qty=1), book(), T0)
        with self.assertRaisesRegex(PaperError, "Maximum open positions"):
            e.place_order(OrderRequest("ETHUSDT", "buy", MARKET, 1), book(symbol="ETHUSDT"), T0)

    def test_kill_switch_blocks_orders_but_not_cancels(self):
        e = engine()
        o = e.place_order(req("buy", LIMIT, 1, limit_price=50.0), book(), T0)
        with self.assertRaisesRegex(PaperError, "halted"):
            e.place_order(req(client_order_id="k"), book(), T0, halted=True)
        e.cancel_order(o.id, T0)
        self.assertEqual(e.acct.orders[o.id].status, "canceled")


class DuplicateTests(unittest.TestCase):
    def test_client_order_id_is_idempotent(self):
        e = engine()
        a = e.place_order(req(client_order_id="same"), book(), T0)
        b = e.place_order(req(client_order_id="same"), book(), T0)
        self.assertEqual(a.id, b.id)
        self.assertEqual(len(e.acct.fills), 1)
        self.assertAlmostEqual(e.acct.positions["BTCUSDT"].qty, 1.0)

    def test_identical_orders_inside_window_blocked(self):
        e = engine(duplicate_window_seconds=3)
        e.place_order(req(qty=0.5), book(), T0)
        with self.assertRaisesRegex(PaperError, "Duplicate"):
            e.place_order(req(qty=0.5), book(), T0 + timedelta(seconds=1))
        e.place_order(req(qty=0.5), book(ts=T0 + timedelta(seconds=5)), T0 + timedelta(seconds=5))
        self.assertEqual(len(e.acct.fills), 2)


class PartialFillTests(unittest.TestCase):
    def test_market_order_partial_when_liquidity_thin_cancels_remainder(self):
        e = engine(participation=0.5)
        b = book(levels=(((99.9, 10),), ((100.0, 4),)))      # 4 visible, 50% participation -> 2
        o = e.place_order(req(qty=5), b, T0)
        self.assertEqual((o.status, o.filled_qty), ("canceled", 2.0))
        self.assertIn("remainder", o.note)
        self.assertAlmostEqual(e.acct.positions["BTCUSDT"].qty, 2.0)

    def test_market_order_no_liquidity_rejected(self):
        e = engine(participation=0.0)
        o = e.place_order(req(qty=1), book(), T0)
        self.assertEqual(o.status, "rejected")
        self.assertEqual(e.acct.cash, 10_000)

    def test_marketable_limit_partial_then_rests_and_fills_later(self):
        e = engine(participation=0.5)
        thin = book(levels=(((99.9, 10),), ((100.0, 2),)))
        o = e.place_order(req("buy", LIMIT, 3, limit_price=100.0), thin, T0)
        self.assertEqual((o.status, o.filled_qty), ("partially_filled", 1.0))
        self.assertEqual(len(e.open_orders()), 1)
        e.on_tick(book(bid=99.0, ask=100.0, depth=10), T0)           # more liquidity at the limit
        self.assertEqual(o.status, "filled")
        self.assertAlmostEqual(e.acct.positions["BTCUSDT"].qty, 3.0)
        self.assertEqual({f.liquidity for f in e.acct.fills}, {"taker", "maker"})

    def test_limit_never_fills_worse_than_limit(self):
        e = engine(extra_slippage_bps=50)
        o = e.place_order(req("buy", LIMIT, 1, limit_price=100.1), book(bid=100.0, ask=100.1), T0)
        self.assertLessEqual(o.avg_fill_price, 100.1 + 1e-9)


class LimitStopTakeProfitTests(unittest.TestCase):
    def test_resting_limit_buy_fills_at_limit_when_ask_reaches_it(self):
        e = engine()
        o = e.place_order(req("buy", LIMIT, 1, limit_price=95.0), book(), T0)
        self.assertEqual(o.status, "new")
        e.on_tick(book(bid=96.0, ask=96.1), T0)
        self.assertEqual(o.status, "new")
        e.on_tick(book(bid=94.8, ask=95.0), T0)
        self.assertEqual((o.status, o.avg_fill_price), ("filled", 95.0))

    def test_resting_limit_sell(self):
        e = engine()
        e.place_order(req("buy", qty=1), book(), T0)
        o = e.place_order(req("sell", LIMIT, 1, limit_price=105.0, client_order_id="l"), book(), T0)
        e.on_tick(book(bid=105.5, ask=105.6), T0)
        self.assertEqual(o.status, "filled")
        self.assertEqual(o.avg_fill_price, 105.0)

    def test_stop_loss_triggers_as_market_sell(self):
        e = engine()
        e.place_order(req("buy", qty=1), book(), T0)
        sl = e.place_order(req("sell", STOP_LOSS, 1, stop_price=95.0), book(), T0)
        e.on_tick(book(bid=96.0, ask=96.1), T0)
        self.assertEqual(sl.status, "new")
        e.on_tick(book(bid=94.0, ask=94.1), T0)
        self.assertEqual(sl.status, "filled")
        self.assertAlmostEqual(sl.avg_fill_price, 94.0)       # gaps through the stop: fills at the market
        self.assertLess(e.acct.realized_pnl, 0)
        self.assertTrue(any(a["event"] == "stop_triggered" for a in e.audit))

    def test_stop_must_be_below_bid_and_tp_above(self):
        e = engine()
        e.place_order(req("buy", qty=1), book(), T0)
        with self.assertRaisesRegex(PaperError, "below the current bid"):
            e.place_order(req("sell", STOP_LOSS, 1, stop_price=101.0), book(), T0)
        with self.assertRaisesRegex(PaperError, "above the current bid"):
            e.place_order(req("sell", TAKE_PROFIT, 1, limit_price=99.0), book(), T0)

    def test_take_profit_fills_at_or_above_price(self):
        e = engine()
        e.place_order(req("buy", qty=1), book(), T0)
        tp = e.place_order(req("sell", TAKE_PROFIT, 1, limit_price=110.0), book(), T0)
        e.on_tick(book(bid=109.0, ask=109.1), T0)
        self.assertEqual(tp.status, "new")
        e.on_tick(book(bid=111.0, ask=111.1), T0)
        self.assertEqual(tp.status, "filled")
        self.assertGreaterEqual(tp.avg_fill_price, 110.0)
        self.assertGreater(e.acct.realized_pnl, 0)

    def test_oco_bracket_cancels_sibling_and_reserves_once(self):
        e = engine()
        e.place_order(req("buy", qty=1), book(), T0)
        sl = e.place_order(req("sell", STOP_LOSS, 1, stop_price=95.0, oco_group="g1"), book(), T0)
        tp = e.place_order(req("sell", TAKE_PROFIT, 1, limit_price=110.0, oco_group="g1"), book(), T0)
        self.assertAlmostEqual(e.available_qty("BTCUSDT"), 0.0)
        e.on_tick(book(bid=111.0, ask=111.1), T0)
        self.assertEqual((tp.status, sl.status), ("filled", "canceled"))
        self.assertEqual(e.open_orders(), [])

    def test_stale_tick_never_triggers(self):
        e = engine()
        e.place_order(req("buy", qty=1), book(), T0)
        sl = e.place_order(req("sell", STOP_LOSS, 1, stop_price=95.0), book(), T0)
        e.on_tick(book(bid=50, ask=50.1, ts=T0 - timedelta(seconds=60)), T0)
        self.assertEqual(sl.status, "new")


class CancelTests(unittest.TestCase):
    def test_cancel_releases_reservation(self):
        e = engine(starting_cash=1000)
        o = e.place_order(req("buy", LIMIT, 5, limit_price=100.0), book(bid=100.1, ask=100.2), T0)
        self.assertLess(e.available_cash(), 1000)
        e.cancel_order(o.id, T0)
        self.assertAlmostEqual(e.available_cash(), 1000)
        with self.assertRaisesRegex(PaperError, "already canceled"):
            e.cancel_order(o.id, T0)
        with self.assertRaisesRegex(PaperError, "Unknown"):
            e.cancel_order("nope", T0)

    def test_cancel_partially_filled_keeps_fill(self):
        e = engine(participation=0.5)
        o = e.place_order(req("buy", LIMIT, 3, limit_price=100.0), book(levels=(((99.9, 10),), ((100.0, 2),))), T0)
        e.cancel_order(o.id, T0)
        self.assertEqual((o.status, o.filled_qty), ("canceled", 1.0))
        self.assertAlmostEqual(e.acct.positions["BTCUSDT"].qty, 1.0)

    def test_cancel_all(self):
        e = engine()
        for i, p in enumerate((90.0, 91.0, 92.0)):
            e.place_order(req("buy", LIMIT, 1, limit_price=p, client_order_id=str(i)), book(), T0)
        self.assertEqual(len(e.cancel_all(T0)), 3)
        self.assertEqual(e.open_orders(), [])


class PreviewTests(unittest.TestCase):
    def test_preview_changes_nothing_and_matches_execution(self):
        e = engine(extra_slippage_bps=2)
        b = book(levels=(((99.9, 5),), ((100.0, 1), (100.5, 5))))
        p = e.preview(req(qty=2), b, T0)
        self.assertEqual(e.acct.cash, 10_000)
        self.assertEqual(e.acct.orders, {})
        o = e.place_order(req(qty=2), b, T0)
        self.assertAlmostEqual(p["expected_avg_price"], o.avg_fill_price)
        self.assertAlmostEqual(p["expected_fee"], o.fees)
        with self.assertRaises(PaperError):
            engine(starting_cash=1).preview(req(qty=5), b, T0)


class FlattenTests(unittest.TestCase):
    def test_flatten_cancels_and_sells_everything(self):
        e = engine()
        e.place_order(req("buy", qty=2), book(), T0)
        e.place_order(req("buy", LIMIT, 1, limit_price=80.0, client_order_id="r"), book(), T0)
        out = e.flatten({"BTCUSDT": book()}, T0)
        self.assertEqual(len(out["canceled"]), 1)
        self.assertEqual(out["failed"], [])
        self.assertEqual(e.summary()["positions"], [])

    def test_flatten_reports_symbols_without_a_book(self):
        e = engine()
        e.place_order(req("buy", qty=1), book(), T0)
        out = e.flatten({}, T0)
        self.assertEqual(out["failed"][0]["symbol"], "BTCUSDT")


class PersistenceRoundTripTests(unittest.TestCase):
    def test_state_survives_json_round_trip_and_keeps_working(self):
        e = engine()
        e.place_order(req("buy", qty=2), book(), T0)
        e.place_order(req("sell", STOP_LOSS, 1, stop_price=90.0), book(), T0)
        e.place_order(req("buy", LIMIT, 1, limit_price=80.0, client_order_id="r"), book(), T0)
        before = e.summary({"BTCUSDT": 100.0})
        blob = json.dumps(e.acct.to_dict())                        # what the database stores
        e2 = PaperEngine(Account.from_dict(json.loads(blob)))      # "restart"
        self.assertEqual(e2.summary({"BTCUSDT": 100.0}), before)
        self.assertEqual(len(e2.open_orders()), 2)
        self.assertEqual(len(e2.acct.fills), 1)
        e2.on_tick(book(bid=89.0, ask=89.1), T0)                    # resting stop still works after restart
        self.assertEqual([o.status for o in e2.acct.orders.values() if o.type == STOP_LOSS], ["filled"])
        ids_before = set(e2.acct.orders)
        o = e2.place_order(req("buy", qty=0.1, client_order_id="n"), book(bid=89.0, ask=89.1), T0)
        self.assertNotIn(o.id, ids_before)                          # sequence continues, ids are never reused


class WalkTests(unittest.TestCase):
    def test_walk_respects_limit_and_participation(self):
        cfg = PaperConfig(participation=0.5, extra_slippage_bps=0)
        b = book(levels=(((99, 1),), ((100, 2), (101, 2), (102, 10))))
        q, px, depth = simulate_walk(b, "buy", 10, cfg, limit_price=101.0)
        self.assertEqual(depth, 4)
        self.assertAlmostEqual(q, 2.0)                  # 50% of the 4 eligible units
        self.assertAlmostEqual(px, 100.0)


if __name__ == "__main__":
    unittest.main()
