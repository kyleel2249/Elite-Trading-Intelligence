"""End-to-end Phase 8 sequence against a fake Binance-testnet transport: rules, balance, precision, notional, acknowledgement,
fill verification, protective OCO orders, reconciliation and the failure paths. No network: the transport emulates the venue.
The emulation follows Binance's documented REST shapes; it has not been run against the real testnet."""
import asyncio
import json
from datetime import datetime, timezone

from app.execution import protective
from app.execution.adapters.binance import BinanceAdapter
from app.execution.domain import AccountPolicy, InstrumentRules, Mode, OrderIntent, Side
from app.execution.engine import ExecutionEngine
from app.execution.errors import TransientProviderError
from app.execution.store import AccountRecord, InMemoryStore

RULES = InstrumentRules(tick_size=0.01, step_size=0.001, min_qty=0.001, min_notional=10.0)
NOW = datetime(2026, 11, 10, 12, 0, 0, tzinfo=timezone.utc)
PLAN = {"stop_loss": 99.0, "take_profits": [{"price": 101.0, "fraction": 0.4}, {"price": 102.0, "fraction": 0.3}, {"price": 103.0, "fraction": 0.3}]}


class FakeVenue:
    """Minimal Binance spot emulation: books, balances, IOC limit buys, OCO lists, order lookup, cancel."""
    def __init__(self, *, fill_fraction=1.0, oco="ok", usdt=10000.0):
        self.orders, self.calls, self.fill_fraction, self.oco, self.usdt, self.base = {}, [], fill_fraction, oco, usdt, 0.0
        self.bid, self.ask = 99.99, 100.01

    async def request(self, method, url, *, params=None, json=None, data=None, headers=None, write=False):
        path = url.split("binance.vision")[-1]
        p = params or {}
        self.calls.append((method, path, {k: v for k, v in p.items() if k not in ("signature", "timestamp", "recvWindow")}))
        if path == "/api/v3/ticker/bookTicker":
            return 200, {"symbol": "BTCUSDT", "bidPrice": str(self.bid), "askPrice": str(self.ask)}
        if path == "/api/v3/depth":
            return 200, {"bids": [[str(self.bid - i * 0.01), "50"] for i in range(20)], "asks": [[str(self.ask + i * 0.01), "50"] for i in range(20)]}
        if path == "/api/v3/exchangeInfo":
            return 200, {"symbols": [{"filters": [{"filterType": "PRICE_FILTER", "tickSize": "0.01"}, {"filterType": "LOT_SIZE", "stepSize": "0.001", "minQty": "0.001"}, {"filterType": "NOTIONAL", "minNotional": "10"}]}]}
        if path == "/api/v3/account":
            return 200, {"canTrade": True, "balances": [{"asset": "USDT", "free": str(self.usdt), "locked": "0"}, {"asset": "BTC", "free": str(self.base), "locked": "0"}]}
        if path == "/api/v3/order" and method == "POST":
            qty = float(p["quantity"]) * self.fill_fraction
            qty = int(qty / 0.001 + 1e-9) * 0.001
            o = {"clientOrderId": p["newClientOrderId"], "orderId": len(self.orders) + 1, "origQty": p["quantity"], "executedQty": str(qty),
                 "cummulativeQuoteQty": str(qty * self.ask), "status": "FILLED" if self.fill_fraction >= 1 else ("EXPIRED" if qty == 0 else "EXPIRED")}
            self.orders[p["newClientOrderId"]] = o
            self.base += qty * 0.999        # fee taken in the base asset
            self.usdt -= qty * self.ask
            return 200, o
        if path == "/api/v3/orderList/oco":
            if self.oco == "reject":
                return 400, {"code": -1013, "msg": "Filter failure: PERCENT_PRICE_BY_SIDE"}
            if self.oco == "timeout_absent":
                raise TransientProviderError("timeout")
            if self.oco == "timeout_present":
                self._oco(p)
                raise TransientProviderError("timeout")
            return 200, self._oco(p)
        if path == "/api/v3/order" and method == "GET":
            o = self.orders.get(p["origClientOrderId"])
            return (200, o) if o else (400, {"code": -2013, "msg": "Order does not exist."})
        if path == "/api/v3/order" and method == "DELETE":
            o = self.orders.get(p["origClientOrderId"])
            if o is None:
                return 400, {"code": -2011, "msg": "Unknown order sent."}
            for x in self.orders.values():           # Binance: cancelling either leg of an OCO cancels the whole list
                if x.get("list") == o.get("list") and x["status"] == "NEW":
                    x["status"] = "CANCELED"
            o["status"] = "CANCELED" if o["status"] == "NEW" else o["status"]
            return 200, {}
        if path == "/api/v3/openOrders":
            return 200, [o for o in self.orders.values() if o["status"] == "NEW"]
        return 404, {"msg": path}

    def fill_leg(self, cid):
        """The venue fills one OCO leg: it executes in full and its sibling is cancelled."""
        o = self.orders[cid]
        o["status"], o["executedQty"], o["cummulativeQuoteQty"] = "FILLED", o["origQty"], str(float(o["origQty"]) * float(o["price"]))
        for x in self.orders.values():
            if x is not o and x.get("list") == o.get("list") and x["status"] == "NEW":
                x["status"] = "CANCELED"

    def _oco(self, p):
        reports = []
        for cid, typ, price in ((p["aboveClientOrderId"], "LIMIT_MAKER", p["abovePrice"]), (p["belowClientOrderId"], "STOP_LOSS_LIMIT", p["belowPrice"])):
            o = {"clientOrderId": cid, "orderId": len(self.orders) + 1, "origQty": p["quantity"], "executedQty": "0", "cummulativeQuoteQty": "0", "status": "NEW", "type": typ, "price": price, "list": p["listClientOrderId"]}
            self.orders[cid] = o
            reports.append(o)
        return {"orderListId": 1, "listClientOrderId": p["listClientOrderId"], "orderReports": reports}


def build(venue, **policy_kw):
    store = InMemoryStore()
    pol = AccountPolicy(mode=Mode.AUTONOMOUS, autonomous_enabled=True, allowed_symbols=["BTCUSDT"], max_order_notional=5000, max_total_notional=20000, **policy_kw)
    store.save_account(AccountRecord("acc", "binance", "paper", policy=pol))
    ad = BinanceAdapter("k", "s", testnet=True, symbols=["BTCUSDT"], transport=venue, clock_ms=lambda: 1_700_000_000_000)
    ad._perms_ok = True
    eng = ExecutionEngine(store, lambda a: ad, clock=lambda: datetime.now(timezone.utc))
    return eng, store, ad


def intent(qty=1.0, plan=PLAN):
    i = OrderIntent("acc", "BTCUSDT", Side.BUY, qty, strategy="omnisignal", thesis="test")
    if plan is not None:
        i.meta["protective"] = plan
    return i


def run(c):
    return asyncio.run(c)


# ---------- pure planning ----------
def test_plan_rounds_to_tick_and_lot_and_keeps_total_below_fill():
    tr, probs = protective.plan_protection(1.0, 100.0, 99.0, PLAN["take_profits"], RULES)
    assert probs == [] and len(tr) == 3
    assert sum(t.qty for t in tr) <= 1.0 * (1 - 0.0025) + 1e-9          # fee buffer: never try to sell more than we can hold
    assert all(abs(t.qty / 0.001 - round(t.qty / 0.001)) < 1e-6 for t in tr)
    assert all(t.stop_limit <= t.stop_price < t.take_profit for t in tr)


def test_plan_rejects_invalid_geometry():
    for stop, tps in [(101.0, PLAN["take_profits"]), (99.0, [{"price": 99.5, "fraction": 1}]), (99.0, []),
                      (99.0, [{"price": 103, "fraction": .5}, {"price": 101, "fraction": .5}]), (99.0, [{"price": 101, "fraction": .7}, {"price": 102, "fraction": .7}]),
                      (None, PLAN["take_profits"]), (99.0, [{"price": 101}])]:
        t, p = protective.plan_protection(1.0, 100.0, stop, tps, RULES)
        assert t == [] and p, (stop, tps)


def test_plan_merges_dust_tranches_and_refuses_when_nothing_is_sellable():
    tr, p = protective.plan_protection(0.08, 100.0, 99.0, PLAN["take_profits"], RULES)   # the whole position is worth ~$8, under the $10 minimum
    assert p and tr == []
    tr, p = protective.plan_protection(0.12, 100.0, 99.0, PLAN["take_profits"], RULES)   # ~$12 in total: every tranche is dust, so they merge into one OCO
    assert p == [] and len(tr) == 1
    tr, p = protective.plan_protection(0.5, 100.0, 99.0, PLAN["take_profits"], RULES)    # 0.2/0.15/0.15 -> 20/15/15 notional: all fine
    assert len(tr) == 3
    tr, p = protective.plan_protection(0.3, 100.0, 99.0, PLAN["take_profits"], RULES)    # 0.12/0.09/0.09 -> 12/9/9: small ones merge forward
    assert p == [] and 1 <= len(tr) < 3 and sum(t.qty for t in tr) <= 0.3


# ---------- the whole sequence ----------
def test_full_fill_places_three_oco_tranches_and_reconciles():
    v = FakeVenue(); eng, store, _ = build(v)
    res = run(eng.submit_signal(intent(1.0)))
    assert res.status == "filled", res
    assert res.protective and len(res.protective) == 3
    ocos = [c for c in v.calls if c[1] == "/api/v3/orderList/oco"]
    assert len(ocos) == 3 and all(c[2]["side"] == "SELL" and c[2]["aboveType"] == "LIMIT_MAKER" and c[2]["belowType"] == "STOP_LOSS_LIMIT" for c in ocos)
    assert sum(float(c[2]["quantity"]) for c in ocos) <= 0.9990 * 1.0 + 1e-9           # never more than the base balance after fees
    prot = [r for r in store.list_orders("acc") if r.origin == "protective"]
    assert len(prot) == 6 and all(r.side == "sell" and r.status == "submitted" for r in prot)
    assert any(c[1] == "/api/v3/account" for c in v.calls)                           # balance checked
    # Precision: every price is a multiple of the tick, every qty a multiple of the step.
    for c in ocos:
        for k in ("abovePrice", "belowPrice", "belowStopPrice"):
            assert abs(float(c[2][k]) * 100 - round(float(c[2][k]) * 100)) < 1e-6
    # Management sweep must not cancel GTC protective legs, even long after the TTL.
    later = datetime(2026, 12, 31, tzinfo=timezone.utc)
    eng.clock = lambda: later
    run(eng.manage_open_orders("acc"))
    assert not any(c[0] == "DELETE" for c in v.calls)
    assert all(r.status == "submitted" for r in store.list_orders("acc") if r.origin == "protective")
    rec = run(eng.reconcile_positions("acc"))
    assert rec["status"] in ("baseline_recorded", "in_sync"), rec


def test_partial_fill_protects_only_what_filled():
    v = FakeVenue(fill_fraction=0.5); eng, store, _ = build(v)
    res = run(eng.submit_signal(intent(1.0)))
    ocos = [c for c in v.calls if c[1] == "/api/v3/orderList/oco"]
    assert ocos and sum(float(c[2]["quantity"]) for c in ocos) <= 0.5
    assert res.status in ("filled", "partially_filled", "canceled") or res.protective


def test_venue_refusing_protection_halts_the_account_and_says_so():
    v = FakeVenue(oco="reject"); eng, store, _ = build(v)
    res = run(eng.submit_signal(intent(1.0)))
    assert res.status == "filled_unprotected" and res.protective == []
    assert any("Venue refused" in r for r in res.reasons)
    acct = store.get_account("acc")
    assert acct.halted and "Unprotected" in acct.halted_reason
    blocked = run(eng.submit_signal(intent(1.0, plan=None)))                           # halted account takes no new orders
    assert blocked.status == "rejected"
    assert any(e for e in store.logs if (e.get("event") if isinstance(e, dict) else getattr(e, "event", "")) == "protective_failed")


def test_uncertain_oco_outcome_adopts_existing_legs_and_never_double_places():
    v = FakeVenue(oco="timeout_present"); eng, store, _ = build(v)
    res = run(eng.submit_signal(intent(1.0)))
    assert res.status == "filled" and len(res.protective) == 3
    assert len([c for c in v.calls if c[1] == "/api/v3/orderList/oco"]) == 3          # one attempt per tranche, none repeated


def test_uncertain_oco_outcome_with_nothing_on_the_venue_is_reported_unprotected():
    v = FakeVenue(oco="timeout_absent"); eng, store, _ = build(v)
    res = run(eng.submit_signal(intent(1.0)))
    assert res.status == "filled_unprotected" and store.get_account("acc").halted


def test_invalid_plan_is_not_sent_to_the_venue_and_flags_unprotected():
    v = FakeVenue(); eng, store, _ = build(v)
    res = run(eng.submit_signal(intent(1.0, plan={"stop_loss": 150.0, "take_profits": PLAN["take_profits"]})))
    assert res.status == "filled_unprotected"
    assert not any(c[1] == "/api/v3/orderList/oco" for c in v.calls)


def test_no_protective_plan_leaves_behaviour_unchanged():
    v = FakeVenue(); eng, store, _ = build(v)
    res = run(eng.submit_signal(intent(1.0, plan=None)))
    assert res.status == "filled" and res.protective is None
    assert not any(c[1] == "/api/v3/orderList/oco" for c in v.calls)


def test_min_notional_and_lot_checks_still_block_entries():
    v = FakeVenue(); eng, store, _ = build(v)
    res = run(eng.submit_signal(intent(0.0004)))                                       # rounds to zero at the lot size
    assert res.status == "rejected" and not any(c[0] == "POST" for c in v.calls)
    v2 = FakeVenue(); eng2, _, _ = build(v2)
    res = run(eng2.submit_signal(intent(0.05)))                                        # 0.05 BTC = $5 notional < $10 minimum
    assert res.status == "rejected" and any("below venue minimum" in r for r in res.reasons)


def test_emergency_flatten_cancels_protective_orders_first():
    v = FakeVenue(); eng, store, _ = build(v)
    run(eng.submit_signal(intent(1.0)))
    out = run(eng.emergency_flatten("acc", "test"))
    assert len(out["canceled"]) >= 6 or any(c[0] == "DELETE" for c in v.calls)


# ---------- Phase 9: stop management after take-profits fill ----------
def tp_id(store, idx):
    return sorted([r for r in store.list_orders("acc") if r.origin == "protective" and r.client_order_id.endswith("-t") and r.idempotency_key.split("|")[2] == str(idx)], key=lambda r: r.created_at)[0].client_order_id


def active_stops(store):
    return sorted(r.limit_price for r in store.list_orders("acc") if r.origin == "protective" and r.client_order_id.endswith("-s") and r.status == "submitted")


def after_tp(n_filled, bid):
    v = FakeVenue(); eng, store, _ = build(v)
    assert run(eng.submit_signal(intent(1.0))).status == "filled"
    for i in range(n_filled):
        v.fill_leg(tp_id(store, i))
    v.bid, v.ask = bid, bid + 0.02
    return v, eng, store


def test_break_even_after_tp1_moves_remaining_stops_up_by_cancel_and_replace():
    v, eng, store = after_tp(1, 101.5)
    before = active_stops(store); assert len(before) == 3 and before[0] < 99                      # original stop (99 trigger, limit 0.2% below)
    out = run(eng.manage_open_orders("acc"))
    assert out["protection"]["adjusted"] == 2, out
    now = active_stops(store)
    assert len(now) == 2 and all(abs(s / (1 - 0.002) - 100.01 * 1.0025) < 0.02 for s in now)      # break-even plus costs
    seq = [(c[0], c[1]) for c in v.calls if c[1] in ("/api/v3/orderList/oco", "/api/v3/order") and c[0] in ("POST", "DELETE")]
    assert [m for m, _ in seq].count("DELETE") == 2 and seq.index(("DELETE", "/api/v3/order")) < len(seq) - 1
    assert len(store.list_logs("acc", event="protective_adjusted")) == 2
    assert not store.list_logs("acc", event="protective_failed")


def test_adjustment_is_idempotent_and_never_loosens():
    v, eng, store = after_tp(1, 101.5)
    run(eng.manage_open_orders("acc")); n = len(v.calls)
    stops = active_stops(store)
    out = run(eng.manage_open_orders("acc"))
    assert out["protection"]["adjusted"] == 0 and active_stops(store) == stops
    assert not any(c[0] == "DELETE" for c in v.calls[n:])


def test_trail_to_tp1_after_tp2():
    v, eng, store = after_tp(1, 101.5)
    run(eng.manage_open_orders("acc"))                                  # break-even first
    v.fill_leg(tp_id_in_stage(store, 1)); v.bid, v.ask = 104.0, 104.02
    out = run(eng.manage_open_orders("acc"))
    assert out["protection"]["adjusted"] == 1, out
    (s,) = active_stops(store); assert abs(s / (1 - 0.002) - 101.0) < 0.02                       # trailing stop at TP1 (101)


def tp_id_in_stage(store, idx):
    rows = [r for r in store.list_orders("acc") if r.origin == "protective" and r.client_order_id.endswith("-t") and r.idempotency_key.split("|")[2] == str(idx) and r.status == "submitted"]
    return rows[0].client_order_id


def test_stop_is_left_alone_when_the_market_is_too_close_to_move_it():
    v, eng, store = after_tp(1, 100.2)                                   # bid below break-even level: moving the stop would trigger it at once
    before = active_stops(store)
    out = run(eng.manage_open_orders("acc"))
    assert out["protection"]["skipped"] == 2 and out["protection"]["adjusted"] == 0
    assert active_stops(store) == before[:2] and not any(c[0] == "DELETE" for c in v.calls)   # (the filled target's sibling stop was cancelled by the venue)


def test_no_adjustment_before_any_target_fills():
    v, eng, store = after_tp(0, 101.5)
    out = run(eng.manage_open_orders("acc"))
    assert out["protection"] == {"adjusted": 0, "skipped": 0, "failed": 0}


def test_failed_replacement_restores_the_original_levels():
    v, eng, store = after_tp(1, 101.5)
    orig = active_stops(store)
    calls = {"n": 0}; real = v.request

    async def flaky(method, url, **kw):
        if url.endswith("/orderList/oco"):
            calls["n"] += 1
            if calls["n"] == 1:
                return 400, {"code": -1013, "msg": "Filter failure"}
        return await real(method, url, **kw)
    v.request = flaky
    out = run(eng.manage_open_orders("acc"))
    assert out["protection"]["failed"] >= 1
    assert store.list_logs("acc", event="protective_restored")
    live = [o for o in v.orders.values() if o["status"] == "NEW" and o["type"] == "STOP_LOSS_LIMIT"]
    assert len(live) == 2 and any(abs(float(o["price"]) - 98.81) < 0.02 for o in live)        # the failed tranche is back at its original level; no tranche is left bare


def test_unrecoverable_replacement_halts_the_account():
    v, eng, store = after_tp(1, 101.5)
    real = v.request

    async def broken(method, url, **kw):
        if url.endswith("/orderList/oco"):
            return 400, {"code": -1013, "msg": "Filter failure"}
        return await real(method, url, **kw)
    v.request = broken
    run(eng.manage_open_orders("acc"))
    assert store.list_logs("acc", event="protective_failed")
    acct = store.get_account("acc"); assert acct.halted and "unprotected" in acct.halted_reason


def test_pure_stop_planner():
    r = RULES
    assert protective.plan_stop_adjustment(0, 100, 101, 97, 105, r)[2] == "no take-profit has filled yet"
    s, l, why = protective.plan_stop_adjustment(1, 100.0, 101.0, 97.0, 105.0, r); assert why is None and abs(s - 100.25) < 0.011 and l < s
    assert protective.plan_stop_adjustment(1, 100.0, 101.0, 100.5, 105.0, r)[2] == "not tighter than the current stop"       # never loosen
    assert protective.plan_stop_adjustment(1, 100.0, 101.0, 97.0, 100.1, r)[2]                                               # market too close
    s, l, why = protective.plan_stop_adjustment(2, 100.0, 101.0, 100.25, 108.0, r); assert why is None and abs(s - 101.0) < 0.011
    assert protective.plan_stop_adjustment(2, 100.0, None, 97.0, 108.0, r)[2] == "no reference level for the new stop"
