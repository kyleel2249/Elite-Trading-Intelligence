"""Paper API: works with no exchange credentials, labels the mode, refuses live, rejects bad orders."""
from __future__ import annotations

import unittest
import uuid
from datetime import datetime, timezone
from unittest import mock

from fastapi.testclient import TestClient

import app.api.paper as paper_api
from app.main import app
from app.paper.core import Book, PaperError
from app.paper.service import PaperService, PaperSettings
from app.paper.store import InMemoryPaperStore


class _Books:
    def __init__(self):
        self.bid, self.ask = 100.0, 100.1

    async def get_book(self, symbol, depth=20):
        if symbol.upper() == "NOPEUSDT":
            raise PaperError("Unknown symbol NOPEUSDT on Binance spot")
        return Book(symbol.upper(), tuple((self.bid - i * 0.1, 50.0) for i in range(5)),
                    tuple((self.ask + i * 0.1, 50.0) for i in range(5)), datetime.now(timezone.utc), "fake")


class PaperApiTests(unittest.TestCase):
    def setUp(self):
        self.books = _Books()
        self.svc = PaperService(InMemoryPaperStore(), self.books,
                                PaperSettings(starting_cash=10_000.0, extra_slippage_bps=0.0,
                                              max_position_notional_pct=100.0))
        p = mock.patch.object(paper_api.wiring, "get_paper_service", lambda: self.svc)
        p.start()
        self.addCleanup(p.stop)
        self.c = TestClient(app)
        self.acct = f"api-{uuid.uuid4().hex[:6]}"

    def order(self, **kw):
        body = {"account_id": self.acct, "symbol": "BTCUSDT", "side": "buy", "type": "market", "qty": 1}
        body.update(kw)
        return self.c.post("/api/paper/orders", json=body)

    def test_mode_reports_internal_paper_default_and_live_disabled(self):
        j = self.c.get("/api/paper/mode").json()
        self.assertEqual(j["active_default"], "internal_paper")
        self.assertFalse(j["live"]["available"])
        self.assertFalse(j["exchange_testnet"]["available"])

    def test_buy_without_any_exchange_key_fills_and_shows_in_account(self):
        r = self.order()
        self.assertEqual(r.status_code, 200, r.text)
        j = r.json()
        self.assertEqual(j["mode"], "internal_paper")
        self.assertEqual(j["order"]["status"], "filled")
        acct = self.c.get(f"/api/paper/account?account_id={self.acct}").json()
        self.assertEqual(acct["positions"][0]["symbol"], "BTCUSDT")
        self.assertLess(acct["cash"], 10_000)
        self.assertEqual(len(self.c.get(f"/api/paper/fills?account_id={self.acct}").json()["fills"]), 1)

    def test_sell_more_than_held_and_insufficient_balance_are_rejected(self):
        r = self.order(side="sell", qty=1)
        self.assertEqual(r.status_code, 422)
        self.assertIn("Insufficient holdings", r.json()["detail"]["error"])
        r = self.order(qty=1000)
        self.assertEqual(r.status_code, 422)
        self.assertIn("Insufficient balance", r.json()["detail"]["error"])

    def test_live_is_refused_and_testnet_without_credentials_is_labelled_internal(self):
        r = self.order(mode="live")
        self.assertEqual(r.status_code, 403)
        r = self.order(mode="exchange_testnet", client_order_id="tn1")
        self.assertEqual(r.status_code, 200)
        j = r.json()
        self.assertEqual((j["mode"], j["downgraded"]), ("internal_paper", True))
        self.assertIn("Nothing was sent to an exchange", j["reason"])

    def test_limit_order_rests_then_can_be_cancelled(self):
        r = self.order(type="limit", limit_price=90.0)
        oid = r.json()["order"]["id"]
        self.assertEqual(r.json()["order"]["status"], "new")
        open_ = self.c.get(f"/api/paper/orders?status=open&account_id={self.acct}").json()["orders"]
        self.assertEqual([o["id"] for o in open_], [oid])
        d = self.c.delete(f"/api/paper/orders/{oid}?account_id={self.acct}")
        self.assertEqual(d.status_code, 200)
        self.assertEqual(self.c.delete(f"/api/paper/orders/{oid}?account_id={self.acct}").status_code, 409)

    def test_preview_matches_order_and_changes_nothing(self):
        body = {"account_id": self.acct, "symbol": "BTCUSDT", "side": "buy", "type": "market", "qty": 2}
        p = self.c.post("/api/paper/preview", json=body).json()["preview"]
        self.assertEqual(self.c.get(f"/api/paper/account?account_id={self.acct}").json()["cash"], 10_000)
        o = self.order(qty=2).json()["order"]
        self.assertAlmostEqual(p["expected_avg_price"], o["avg_fill_price"])

    def test_invalid_inputs_and_unknown_symbol(self):
        self.assertEqual(self.order(qty=-1).status_code, 422)
        self.assertEqual(self.order(side="hold").status_code, 422)
        r = self.order(symbol="NOPEUSDT")
        self.assertEqual(r.status_code, 422)

    def test_duplicate_client_order_id_is_idempotent(self):
        a = self.order(client_order_id="dup-1").json()["order"]["id"]
        b = self.order(client_order_id="dup-1").json()["order"]["id"]
        self.assertEqual(a, b)
        self.assertEqual(len(self.c.get(f"/api/paper/fills?account_id={self.acct}").json()["fills"]), 1)

    def test_flatten_and_reset_require_exact_confirmation(self):
        self.order()
        self.assertEqual(self.c.post("/api/paper/flatten", json={"account_id": self.acct, "confirm": "no"}).status_code, 422)
        r = self.c.post("/api/paper/flatten", json={"account_id": self.acct, "confirm": f"FLATTEN {self.acct}"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(self.c.get(f"/api/paper/account?account_id={self.acct}").json()["positions"], [])
        self.assertEqual(self.c.post("/api/paper/reset", json={"account_id": self.acct, "confirm": "x"}).status_code, 422)
        r = self.c.post("/api/paper/reset", json={"account_id": self.acct, "confirm": f"RESET {self.acct}"})
        self.assertEqual(r.json()["cash"], 10_000)

    def test_kill_switch_blocks_new_orders(self):
        from app.config import get_settings
        s = get_settings()
        s.kill_switch = True
        try:
            svc = PaperService(InMemoryPaperStore(), self.books, PaperSettings(), kill_switch=lambda: True)
            with mock.patch.object(paper_api.wiring, "get_paper_service", lambda: svc):
                r = self.order()
            self.assertEqual(r.status_code, 422)
            self.assertIn("halted", r.json()["detail"]["error"])
        finally:
            s.kill_switch = False

    def test_dashboard_serves_paper_controls(self):
        html = self.c.get("/").text
        for needle in ("INTERNAL PAPER", "LIVE TRADING", "pp-submit", "/api/paper/orders"):
            self.assertIn(needle, html)


if __name__ == "__main__":
    unittest.main()
