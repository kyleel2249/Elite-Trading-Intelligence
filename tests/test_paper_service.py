"""Service/persistence/mode tests for the internal paper exchange (no network, no credentials)."""
from __future__ import annotations

import asyncio
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.paper import mode as M  # noqa: E402
from app.paper.engine import PaperConfig, Snapshot  # noqa: E402
from app.paper.service import PaperExchange, PaperTickJob, config_from_env  # noqa: E402
from app.paper.store import JsonFileStore, MemoryStore, StaleStateError  # noqa: E402

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


class Clock:
    def __init__(self): self.t = T0
    def __call__(self): return self.t
    def advance(self, s): self.t += timedelta(seconds=s)


class FakeQuotes:
    def __init__(self, clock): self.clock, self.q, self.calls = clock, {}, 0
    def set(self, sym, bid, ask, **kw): self.q[sym] = (bid, ask, kw)
    async def get(self, symbol):
        self.calls += 1
        if symbol not in self.q: return None
        bid, ask, kw = self.q[symbol]
        return Snapshot(symbol, bid, ask, self.clock.t, **kw)


def run(coro): return asyncio.run(coro)


def make(store=None, **cfg):
    c = Clock(); qs = FakeQuotes(c); k = {"k": False}
    ex = PaperExchange(store or MemoryStore(), qs, PaperConfig(**cfg), clock=c, kill_switch=lambda: k["k"])
    return ex, c, qs, k


class Service(unittest.TestCase):
    def test_trades_without_any_credentials_and_tracks_pnl(self):
        ex, c, qs, _ = make(); qs.set("BTCUSDT", 99.9, 100.1)
        async def go():
            buy = await ex.submit(symbol="BTCUSDT", side="buy", qty=10)
            c.advance(10); qs.set("BTCUSDT", 109.9, 110.1)
            acct = await ex.account(); sell = await ex.submit(symbol="BTCUSDT", side="sell", qty=10)
            return buy, acct, sell, await ex.account()
        buy, acct, sell, final = run(go())
        self.assertEqual(buy["order"]["status"], "filled"); self.assertEqual(acct["execution_mode"], "INTERNAL_PAPER")
        self.assertGreater(acct["unrealized_pnl"], 0); self.assertEqual(sell["order"]["status"], "filled")
        self.assertAlmostEqual(final["total_pnl"], final["realized_pnl"] + final["unrealized_pnl"], 6)
        self.assertEqual(final["open_positions"], 0); self.assertGreater(final["realized_pnl"], 0)

    def test_restart_persistence_with_durable_store(self):
        d = tempfile.mkdtemp()
        ex1, c, qs, _ = make(JsonFileStore(d)); qs.set("BTCUSDT", 99.9, 100.1)
        async def first():
            await ex1.submit(symbol="BTCUSDT", side="buy", qty=10)
            c.advance(10)
            await ex1.submit(symbol="BTCUSDT", side="sell", qty=4, order_type="limit", limit_price=150)
            return await ex1.account(tick=False)
        before = run(first())
        ex2 = PaperExchange(JsonFileStore(d), qs, PaperConfig(), clock=c)           # fresh process, same files
        after = run(ex2.account(tick=False))
        for k in ("cash", "equity", "realized_pnl", "reserved_cash", "available_cash", "fees_paid", "open_orders"):
            self.assertAlmostEqual(before[k], after[k], 9, k)
        self.assertEqual(before["positions"], after["positions"])
        self.assertEqual(len(run(ex2.orders("open"))), 1); self.assertEqual(len(run(ex2.fills())), 1)
        audit_events = [a["event"] for a in run(ex2.audit())]
        self.assertIn("fill", audit_events); self.assertIn("account_created", audit_events)

    def test_resting_orders_fill_during_tick_after_restart(self):
        d = tempfile.mkdtemp(); ex1, c, qs, _ = make(JsonFileStore(d)); qs.set("BTCUSDT", 99.9, 100.1)
        run(ex1.submit(symbol="BTCUSDT", side="buy", qty=5, order_type="limit", limit_price=95.0))
        ex2 = PaperExchange(JsonFileStore(d), qs, PaperConfig(), clock=c); c.advance(5); qs.set("BTCUSDT", 94.0, 94.2)
        res = run(ex2.tick()); self.assertEqual(len(res["fills"]), 1)
        self.assertEqual(run(ex2.account(tick=False))["open_positions"], 1)

    def test_stale_write_is_detected_by_store(self):
        s = MemoryStore(); s.save("a", {"x": 1}, [], 0)
        with self.assertRaises(StaleStateError): s.save("a", {"x": 2}, [], 0)
        self.assertEqual(s.load("a")[1], 1)

    def test_no_quote_means_no_trade_and_no_invented_price(self):
        ex, *_ = make()
        r = run(ex.submit(symbol="ZZZUSDT", side="buy", qty=1))
        self.assertEqual(r["reasons"], ["no_verified_live_price"]); self.assertEqual(run(ex.account(tick=False))["cash"], 100_000)

    def test_unpriced_holding_is_reported_not_silently_zeroed(self):
        ex, c, qs, _ = make(); qs.set("BTCUSDT", 99.9, 100.1); run(ex.submit(symbol="BTCUSDT", side="buy", qty=5)); qs.q.clear()
        acct = run(ex.account()); self.assertEqual(acct["unmarked_symbols"], ["BTCUSDT"]); self.assertGreater(acct["equity"], 99_000)

    def test_kill_switch_visible_and_enforced(self):
        ex, c, qs, k = make(); qs.set("BTCUSDT", 99.9, 100.1); k["k"] = True
        self.assertEqual(run(ex.submit(symbol="BTCUSDT", side="buy", qty=1))["reasons"], ["kill_switch_active"])
        self.assertTrue(run(ex.account())["kill_switch"])

    def test_cancel_and_cancel_all(self):
        ex, c, qs, _ = make(); qs.set("BTCUSDT", 99.9, 100.1)
        a = run(ex.submit(symbol="BTCUSDT", side="buy", qty=1, order_type="limit", limit_price=90))
        run(ex.submit(symbol="BTCUSDT", side="buy", qty=2, order_type="limit", limit_price=91))
        self.assertTrue(run(ex.cancel(a["order"]["id"]))["ok"]); self.assertEqual(run(ex.cancel_all())["canceled"], 1)
        self.assertEqual(run(ex.account(tick=False))["reserved_cash"], 0.0); self.assertEqual(len(run(ex.orders("closed"))), 2)

    def test_preview_matches_actual_submit(self):
        ex, c, qs, _ = make(); qs.set("BTCUSDT", 99.9, 100.1, asks=[(100.1, 100.0)], bids=[(99.9, 100.0)])
        p = run(ex.preview(symbol="BTCUSDT", side="buy", qty=5)); r = run(ex.submit(symbol="BTCUSDT", side="buy", qty=5))
        self.assertAlmostEqual(p["estimated_avg_price"], r["fills"][0]["price"]); self.assertAlmostEqual(p["estimated_fees"], r["fills"][0]["fee"])

    def test_reset_requires_explicit_call_and_clears(self):
        ex, c, qs, _ = make(); qs.set("BTCUSDT", 99.9, 100.1); run(ex.submit(symbol="BTCUSDT", side="buy", qty=1))
        a = run(ex.reset(7_000)); self.assertEqual(a["cash"], 7_000); self.assertEqual(run(ex.fills()), [])

    def test_tick_job_status(self):
        ex, *_ = make(); job = PaperTickJob(lambda: ex, 1.0)
        async def go():
            await job.start(); await asyncio.sleep(0.05); st = job.status(); await job.stop(); return st, job.status()
        st, st2 = run(go()); self.assertTrue(st["running"]); self.assertFalse(st2["running"]); self.assertGreaterEqual(st["runs"], 1)

    def test_config_from_env(self):
        c = config_from_env({"PAPER_STARTING_CASH": "5000", "PAPER_TAKER_FEE_BPS": "bad", "PAPER_PARTICIPATION": "9"})
        self.assertEqual(c.starting_cash, 5000); self.assertEqual(c.taker_fee_bps, 10.0); self.assertEqual(c.participation, 1.0)


class Modes(unittest.TestCase):
    def test_paper_is_always_internal(self):
        d = M.resolve_mode("binance", "paper", creds_configured=True, live_enabled=False)
        self.assertEqual(d.mode, M.INTERNAL_PAPER); self.assertFalse(d.downgraded)

    def test_testnet_without_credentials_is_labelled_downgrade_never_exchange(self):
        d = M.resolve_mode("binance", "testnet", creds_configured=False, live_enabled=False)
        self.assertEqual(d.mode, M.INTERNAL_PAPER); self.assertTrue(d.downgraded); self.assertIn("NOT sent to any exchange", d.warning)

    def test_testnet_with_credentials_uses_exchange(self):
        self.assertEqual(M.resolve_mode("binance", "testnet", creds_configured=True, live_enabled=False).mode, M.EXCHANGE_TESTNET)

    def test_live_is_never_simulated_or_silently_switched(self):
        for creds in (True, False):
            d = M.resolve_mode("binance", "live", creds_configured=creds, live_enabled=False)
            self.assertEqual(d.mode, M.REJECT); self.assertEqual(d.reason, "live_trading_disabled")
        self.assertEqual(M.resolve_mode("binance", "live", creds_configured=False, live_enabled=True).mode, M.REJECT)
        self.assertEqual(M.resolve_mode("binance", "live", creds_configured=True, live_enabled=True).mode, M.EXCHANGE_LIVE)

    def test_unknown_environment_rejected_and_labels_distinct(self):
        self.assertEqual(M.resolve_mode("binance", "prod", creds_configured=True, live_enabled=True).mode, M.REJECT)
        self.assertEqual(len({M.LABELS[k] for k in (M.INTERNAL_PAPER, M.EXCHANGE_TESTNET, M.EXCHANGE_LIVE)}), 3)


if __name__ == "__main__":
    unittest.main()
