#!/usr/bin/env python3
"""Real Binance SPOT TESTNET verification of the Phase 8 sequence, using ETI's own engine and adapter.

Reads BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET from the environment (never from files, never printed).
The adapter is constructed with testnet=True, so it can only talk to https://testnet.binance.vision. Test funds only.

Steps (each reported pass/fail with evidence):
  1 connectivity + signed account read + balances        4 engine: guards -> order -> acknowledgement -> fill verification
  2 symbol rules (tick, step, min qty, min notional)     5 engine: protective OCO tranches placed and visible on the venue
  3 quote + order book                                   6 reconciliation: open orders match the engine's record
Always cleans up: cancels protective orders and sells the test position back at market.

  python scripts/testnet_verify.py [--symbol BTCUSDT] [--notional 30]
  python scripts/testnet_verify.py --selftest      # logic check against the in-repo fake venue, no network, no keys
"""
import argparse
import asyncio
import json
import math
import os
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.execution.adapters.binance import BinanceAdapter, split_symbol  # noqa: E402
from app.execution.domain import AccountPolicy, Mode, OrderIntent, OrderType, Side  # noqa: E402
from app.execution.engine import ExecutionEngine  # noqa: E402
from app.execution.store import AccountRecord, InMemoryStore  # noqa: E402

report = {"environment": "binance spot testnet", "steps": [], "ok": False}


def step(name, ok, **evidence):
    report["steps"].append({"step": name, "ok": bool(ok), **evidence})
    print(("PASS " if ok else "FAIL ") + name, json.dumps(evidence, default=str)[:400], flush=True)
    return bool(ok)


def ceil_step(x, step_size):
    return math.ceil(x / step_size - 1e-9) * step_size if step_size else x


async def main(a, transport=None, key="k", secret="s", clock=None):
    ad = BinanceAdapter(key, secret, testnet=True, symbols=[a.symbol], transport=transport, **({"clock_ms": clock} if clock else {}))
    assert ad.testnet and "testnet" in ad.base, "refusing to run: adapter is not pointed at the testnet"
    base, quote = split_symbol(a.symbol)
    sold_back = False
    try:
        # 1 connectivity, signed read, balances
        try:
            bal = await ad._balances()
            step("1 signed account read and balances", True, quote_free=bal.get(quote), base_free=bal.get(base))
        except Exception as e:
            step("1 signed account read and balances", False, error=type(e).__name__ + ": " + str(e)[:200]); return
        # 2 rules
        r = await ad.get_rules(a.symbol)
        step("2 symbol rules", r.tick_size > 0 and r.step_size > 0 and r.min_notional >= 0, tick=r.tick_size, step=r.step_size, min_qty=r.min_qty, min_notional=r.min_notional)
        # 3 quote + book
        q = await ad.get_quote(a.symbol); ob = await ad.get_order_book(a.symbol, 20)
        step("3 quote and order book", q.ask >= q.bid > 0 and len(ob.bids) > 0 and len(ob.asks) > 0, bid=q.bid, ask=q.ask, bid_levels=len(ob.bids), ask_levels=len(ob.asks))
        # sizing: smallest quantity that satisfies lot, min qty and a comfortable notional
        qty = ceil_step(max(r.min_qty, max(a.notional, r.min_notional * 2) / q.ask), r.step_size)
        price = round(q.ask * 1.0005, 8)  # inside the engine's slippage band
        tick = r.tick_size or 0.01
        price = math.floor(price / tick) * tick
        need = qty * price
        if (bal.get(quote) or 0) < need * 1.05:
            step("4 prerequisite: enough test balance", False, need=need, free=bal.get(quote)); return
        # 4 + 5 engine
        store = InMemoryStore()
        pol = AccountPolicy(mode=Mode.AUTONOMOUS, autonomous_enabled=True, allowed_symbols=[a.symbol], max_order_notional=max(need * 3, 100), max_total_notional=max(need * 6, 300))
        store.save_account(AccountRecord("verify", "binance", "paper", policy=pol))
        eng = ExecutionEngine(store, lambda _a: ad, clock=lambda: datetime.now(timezone.utc))
        stop, tps = round(q.ask * 0.97, 2), [{"price": round(q.ask * 1.02, 2), "fraction": .4}, {"price": round(q.ask * 1.03, 2), "fraction": .3}, {"price": round(q.ask * 1.04, 2), "fraction": .3}]
        it = OrderIntent("verify", a.symbol, Side.BUY, qty, OrderType.LIMIT, price, strategy="omnisignal", thesis="testnet verification", signal_id=f"verify-{int(time.time())}")
        it.meta["protective"] = {"stop_loss": stop, "take_profits": tps}
        res = await eng.submit_signal(it)
        d = res.to_dict() if hasattr(res, "to_dict") else dict(res.__dict__)
        step("4 engine order: guards, acknowledgement, fill verification", d["status"] in ("filled", "filled_unprotected"), status=d["status"], reasons=d.get("reasons"), order=d.get("order"))
        prot = d.get("protective") or []
        step("5 protective stop and take-profit orders placed", d["status"] == "filled" and len(prot) >= 1, tranches=len(prot), detail=prot)
        # 6 reconciliation: what the venue holds versus what the engine recorded
        opens = await ad.list_open_orders()
        ids_venue = {o.client_order_id for o in opens}
        rows = store.list_orders("verify"); recorded = {row.client_order_id for row in rows}
        legs = [o for o in opens if o.client_order_id]
        unmatched = sorted(ids_venue - recorded)
        step("6 reconciliation: every venue open order is recorded by the engine, and protection exists", bool(prot) and len(legs) >= 2 * len(prot) and not unmatched, venue_open=len(legs), recorded_orders=len(recorded), unmatched=unmatched[:5])
    finally:
        # cleanup: cancel everything open on the symbol, then sell the test position back
        try:
            for o in await ad.list_open_orders():
                await ad.cancel_order(a.symbol, o.client_order_id, o.provider_order_id)
            held = (await ad._balances()).get(base) or 0
            r = await ad.get_rules(a.symbol); sellable = math.floor(held / r.step_size + 1e-9) * r.step_size if r.step_size else held
            if sellable >= (r.min_qty or 0) and sellable > 0:
                o = await ad.submit_order(client_order_id=f"verify-exit-{int(time.time())}", symbol=a.symbol, side=Side.SELL, qty=sellable, order_type=OrderType.MARKET, limit_price=None)
                sold_back = True; step("cleanup: protective orders cancelled, position sold back", True, sold_qty=sellable, status=o.status.value)
            else:
                step("cleanup: protective orders cancelled, nothing to sell back", True)
        except Exception as e:
            step("cleanup", False, error=type(e).__name__ + ": " + str(e)[:200])
    report["ok"] = all(s["ok"] for s in report["steps"]) and len(report["steps"]) >= 7


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--symbol", default="BTCUSDT"); ap.add_argument("--notional", type=float, default=30.0); ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        from tests.test_protective_execution import FakeVenue  # noqa: E402
        v = FakeVenue(); asyncio.run(main(a, transport=v, clock=lambda: 1_700_000_000_000))
    else:
        k, s = os.environ.get("BINANCE_TESTNET_API_KEY", ""), os.environ.get("BINANCE_TESTNET_API_SECRET", "")
        if not k or not s:
            print("BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_API_SECRET are not set", file=sys.stderr); sys.exit(2)
        asyncio.run(main(a, key=k, secret=s))
    print(json.dumps({"ok": report["ok"], "passed": sum(s["ok"] for s in report["steps"]), "total": len(report["steps"])}))
    sys.exit(0 if report["ok"] else 1)
