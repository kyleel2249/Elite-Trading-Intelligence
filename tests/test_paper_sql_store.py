"""SQL-backed paper store + full service restart over the real database (sqlite in CI via conftest)."""
from __future__ import annotations

import unittest
import uuid
from datetime import datetime, timedelta, timezone

from app.database import SessionLocal, init_db
from app.paper.core import Book, OrderRequest
from app.paper.service import PaperService, PaperSettings
from app.paper.store import SqlPaperStore, VersionConflict

T0 = datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)


class _Books:
    def __init__(self):
        self.bid, self.ask = 100.0, 100.1

    async def get_book(self, symbol, depth=20):
        return Book(symbol.upper(), tuple((self.bid - i * 0.1, 50.0) for i in range(5)),
                    tuple((self.ask + i * 0.1, 50.0) for i in range(5)), T0, "fake")


class SqlStoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()

    def test_save_load_and_optimistic_versioning(self):
        s, acct = SqlPaperStore(SessionLocal), f"t-{uuid.uuid4().hex[:8]}"
        self.assertIsNone(s.load(acct))
        self.assertEqual(s.save(acct, {"a": 1}, 0), 1)
        self.assertEqual(s.load(acct)[1]["a"], 1)
        with self.assertRaises(VersionConflict):
            s.save(acct, {"a": 9}, 0)                    # stale writer
        self.assertEqual(s.save(acct, {"a": 2}, 1), 2)
        with self.assertRaises(VersionConflict):
            s.save(acct, {"a": 3}, 1)
        self.assertEqual(s.load(acct), (2, {"a": 2, "version": 2}))
        self.assertIn(acct, s.list_accounts())

    def test_events_are_append_only_and_filterable(self):
        s, acct = SqlPaperStore(SessionLocal), f"e-{uuid.uuid4().hex[:8]}"
        s.append_events([{"ts": T0.isoformat(), "account_id": acct, "event": "fill", "order_id": "ord-1", "details": {"q": 1}},
                         {"ts": (T0 + timedelta(seconds=1)).isoformat(), "account_id": acct, "event": "order_canceled",
                          "order_id": "ord-2", "details": {}}])
        rows = s.list_events(acct)
        self.assertEqual([r["event"] for r in rows], ["order_canceled", "fill"])
        self.assertEqual([r["event"] for r in s.list_events(acct, event="fill")], ["fill"])


class SqlServiceRestartTests(unittest.IsolatedAsyncioTestCase):
    async def test_balances_holdings_orders_survive_a_new_service_instance(self):
        init_db()
        acct = f"r-{uuid.uuid4().hex[:8]}"
        books = _Books()
        mk = lambda: PaperService(SqlPaperStore(SessionLocal), books,
                                  PaperSettings(starting_cash=10_000.0, extra_slippage_bps=0.0,
                                                max_position_notional_pct=100.0), clock=lambda: T0)
        svc = mk()
        await svc.submit(acct, OrderRequest("BTCUSDT", "buy", "market", 2))
        await svc.submit(acct, OrderRequest("BTCUSDT", "buy", "limit", 1, limit_price=90.0))
        before = await svc.summary(acct)
        svc2 = mk()                                       # "restart"
        self.assertEqual(await svc2.summary(acct), before)
        self.assertEqual(len(svc2.orders(acct, "open")), 1)
        self.assertEqual(len(svc2.fills(acct)), 1)
        self.assertIn("fill", [e["event"] for e in svc2.events(acct)])


if __name__ == "__main__":
    unittest.main()
