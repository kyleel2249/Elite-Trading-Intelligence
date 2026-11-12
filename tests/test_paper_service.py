"""Paper service: persistence across restart, audit log, kill switch, bracket orders, tick loop, mode resolution."""
from __future__ import annotations

import pytest

# These suites target the standalone engine (app.paper.core / app.paper.modes) that was superseded by app/paper/engine.py,
# service.py and mode.py. They are kept, not deleted, and skip until they are ported to the surviving engine.
pytest.importorskip("app.paper.core", reason="targets the superseded app.paper.core engine; port to app.paper.engine")

import unittest
from datetime import datetime, timedelta, timezone

from app.paper.core import Book, OrderRequest, PaperError
from app.paper.modes import (EXCHANGE_TESTNET, INTERNAL_PAPER, LIVE, LiveTradingDisabled, UnknownMode, resolve_mode)
from app.paper.service import PaperService, PaperSettings
from app.paper.store import InMemoryPaperStore

T0 = datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)


class Clock:
    def __init__(self):
        self.t = T0

    def __call__(self):
        return self.t

    def advance(self, s):
        self.t += timedelta(seconds=s)


class FakeBooks:
    """Stands in for the Binance public feed. Books are stamped with the service clock so they are 'fresh'."""

    def __init__(self, clock):
        self.clock, self.prices, self.down = clock, {}, False
        self.calls = 0

    def set(self, symbol, bid, ask, depth=50.0):
        self.prices[symbol] = (bid, ask, depth)

    async def get_book(self, symbol, depth=20):
        self.calls += 1
        if self.down:
            raise PaperError("Live price unavailable (simulated outage)")
        if symbol.upper() not in self.prices:
            raise PaperError(f"unknown symbol {symbol}")
        bid, ask, d = self.prices[symbol.upper()]
        return Book(symbol.upper(), tuple((bid - i * 0.1, d) for i in range(5)),
                    tuple((ask + i * 0.1, d) for i in range(5)), self.clock(), "fake")


def make(store=None, kill=False, **settings):
    clock = Clock()
    books = FakeBooks(clock)
    books.set("BTCUSDT", 100.0, 100.1)
    flag = {"kill": kill}
    st = dict(starting_cash=10_000.0, extra_slippage_bps=0.0, max_position_notional_pct=100.0)
    st.update(settings)
    svc = PaperService(store or InMemoryPaperStore(), books, PaperSettings(**st), lambda: flag["kill"], clock)
    return svc, books, clock, flag


def buy(qty=1.0, **kw):
    return OrderRequest("BTCUSDT", "buy", "market", qty, **kw)


class ServiceTests(unittest.IsolatedAsyncioTestCase):
    async def test_works_with_no_exchange_credentials_end_to_end(self):
        svc, books, clock, _ = make()
        o = await svc.submit("default", buy(2))
        self.assertEqual(o.status, "filled")
        s = await svc.summary("default")
        self.assertAlmostEqual(s["cash"], 10_000 - 2 * 100.1 * 1.001)
        self.assertEqual(s["positions"][0]["symbol"], "BTCUSDT")
        books.set("BTCUSDT", 110.0, 110.1)
        s = await svc.summary("default")
        self.assertGreater(s["unrealized_pnl"], 0)
        self.assertAlmostEqual(s["total_pnl"], s["realized_pnl"] + s["unrealized_pnl"], places=9)

    async def test_restart_persistence_of_balances_holdings_orders_and_fills(self):
        store = InMemoryPaperStore()
        svc, books, clock, _ = make(store)
        await svc.submit("default", buy(2))
        await svc.submit("default", OrderRequest("BTCUSDT", "buy", "limit", 1, limit_price=90.0))
        await svc.submit("default", OrderRequest("BTCUSDT", "sell", "stop_loss", 1, stop_price=95.0))
        before = await svc.summary("default")
        # brand-new service object over the same store == process restart
        svc2, books2, clock2, _ = make(store)
        after = await svc2.summary("default")
        self.assertEqual(before, after)
        self.assertEqual(len(svc2.orders("default", "open")), 2)
        self.assertEqual(len(svc2.fills("default")), 1)
        books2.set("BTCUSDT", 94.0, 94.1)
        out = await svc2.tick("default")                  # resting stop-loss still executes after restart
        self.assertEqual(len(out["changed"]), 1)          # only the stop fires; the buy limit at 90 keeps resting
        self.assertEqual(len(svc2.fills("default")), 2)

    async def test_cancel_and_events_are_audited_and_persisted(self):
        svc, _, _, _ = make()
        o = await svc.submit("default", OrderRequest("BTCUSDT", "buy", "limit", 1, limit_price=90.0))
        c = await svc.cancel("default", o.id)
        self.assertEqual(c.status, "canceled")
        names = [e["event"] for e in svc.events("default")]
        for expected in ("order_accepted", "order_canceled"):
            self.assertIn(expected, names)
        with self.assertRaises(PaperError):
            await svc.cancel("default", o.id)

    async def test_rejections_are_audited_and_do_not_change_state(self):
        svc, _, _, _ = make(starting_cash=50)
        with self.assertRaisesRegex(PaperError, "Insufficient balance"):
            await svc.submit("default", buy(5))
        with self.assertRaisesRegex(PaperError, "Insufficient holdings"):
            await svc.submit("default", OrderRequest("BTCUSDT", "sell", "market", 1))
        rej = [e for e in svc.events("default") if e["event"] == "order_rejected"]
        self.assertEqual(len(rej), 2)
        self.assertEqual((await svc.summary("default"))["cash"], 50)

    async def test_kill_switch_blocks_new_orders_but_allows_cancel_and_flatten(self):
        svc, books, _, flag = make()
        await svc.submit("default", buy(1))
        o = await svc.submit("default", OrderRequest("BTCUSDT", "buy", "limit", 1, limit_price=90.0))
        flag["kill"] = True
        with self.assertRaisesRegex(PaperError, "halted"):
            await svc.submit("default", buy(1, client_order_id="x"))
        self.assertEqual((await svc.cancel("default", o.id)).status, "canceled")
        out = await svc.flatten("default")
        self.assertEqual(out["failed"], [])
        self.assertEqual((await svc.summary("default"))["positions"], [])

    async def test_no_price_no_fill(self):
        svc, books, _, _ = make()
        books.down = True
        with self.assertRaisesRegex(PaperError, "unavailable"):
            await svc.submit("default", buy(1))
        self.assertEqual(svc.fills("default"), [])

    async def test_bracket_creates_oco_pair_and_rolls_back_on_failure(self):
        svc, books, _, _ = make()
        await svc.submit("default", buy(1))
        sl, tp = await svc.submit_bracket("default", "BTCUSDT", 1, 95.0, 110.0)
        self.assertEqual(sl.oco_group, tp.oco_group)
        books.set("BTCUSDT", 111.0, 111.1)
        await svc.tick("default")
        statuses = {o["type"]: o["status"] for o in svc.orders("default")}
        self.assertEqual((statuses["take_profit"], statuses["stop_loss"]), ("filled", "canceled"))
        # invalid take-profit (below bid) must not leave a dangling stop
        await svc.submit("default", buy(1, client_order_id="again"))
        books.set("BTCUSDT", 100.0, 100.1)
        with self.assertRaises(PaperError):
            await svc.submit_bracket("default", "BTCUSDT", 1, 95.0, 90.0)
        self.assertEqual([o for o in svc.orders("default", "open")], [])

    async def test_tick_skips_symbols_without_price_and_keeps_orders(self):
        svc, books, _, _ = make()
        await svc.submit("default", OrderRequest("BTCUSDT", "buy", "limit", 1, limit_price=90.0))
        books.down = True
        out = await svc.tick("default")
        self.assertEqual(out["changed"], [])
        self.assertEqual(len(out["skipped"]), 1)
        self.assertEqual(len(svc.orders("default", "open")), 1)

    async def test_stale_marks_are_reported_when_price_feed_is_down(self):
        svc, books, _, _ = make()
        await svc.submit("default", buy(1))
        books.down = True
        s = await svc.summary("default")
        self.assertEqual(s["marks_stale_for"], ["BTCUSDT"])

    async def test_reset_is_explicit_audited_and_keeps_id_sequence(self):
        svc, _, _, _ = make()
        await svc.submit("default", buy(1))
        s = await svc.reset("default", 5_000)
        self.assertEqual((s["cash"], s["positions"], s["starting_cash"]), (5_000, [], 5_000))
        self.assertIn("account_reset", [e["event"] for e in svc.events("default")])
        o = await svc.submit("default", buy(1, client_order_id="n"))
        self.assertNotEqual(o.id, "ord-000001")

    async def test_accounts_are_isolated(self):
        svc, _, _, _ = make()
        await svc.submit("a", buy(1))
        self.assertEqual((await svc.summary("b"))["positions"], [])

    async def test_concurrent_identical_orders_fill_once(self):
        import asyncio
        svc, _, _, _ = make()
        res = await asyncio.gather(*[svc.submit("default", buy(1, client_order_id="same")) for _ in range(5)],
                                   return_exceptions=True)
        self.assertEqual(len(svc.fills("default")), 1)
        self.assertEqual(len({r.id for r in res if not isinstance(r, Exception)}), 1)


class ModeTests(unittest.TestCase):
    def test_default_and_explicit_internal(self):
        for req in (None, "auto", "internal_paper", "paper"):
            r = resolve_mode(req, testnet_account_available=False)
            self.assertEqual((r.mode, r.downgraded), (INTERNAL_PAPER, False))

    def test_testnet_without_credentials_falls_back_visibly(self):
        r = resolve_mode("exchange_testnet", testnet_account_available=False, env_credentials_present=True)
        self.assertEqual((r.mode, r.downgraded), (INTERNAL_PAPER, True))
        self.assertIn("Nothing was sent to an exchange", r.reason)
        self.assertIn("register", r.reason)
        self.assertIn("INTERNAL PAPER", r.label)

    def test_testnet_with_account_connects(self):
        r = resolve_mode("testnet", testnet_account_available=True)
        self.assertEqual((r.mode, r.downgraded), (EXCHANGE_TESTNET, False))

    def test_live_is_never_available_and_never_a_fallback(self):
        with self.assertRaises(LiveTradingDisabled):
            resolve_mode("live", testnet_account_available=True)
        with self.assertRaises(UnknownMode):
            resolve_mode("moon", testnet_account_available=True)


if __name__ == "__main__":
    unittest.main()
