"""Internal paper exchange engine (app.paper.engine): accounting, rejection paths, fills, OCO, persistence.

Pure Python, no network, no database. These cover the engine that app.paper.service / app.paper.runtime
actually run; tests/test_paper_engine.py documents the older parallel engine and is skipped while that
module does not exist.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from app.paper.engine import EPS, PaperConfig, PaperEngine, Snapshot

T0 = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)


def snap(bid=100.0, ask=100.1, ts=T0, depth=1000.0, symbol="BTCUSDT", verified=True, levels=5):
    bids = [(round(bid - i * 0.1, 6), depth) for i in range(levels)]
    asks = [(round(ask + i * 0.1, 6), depth) for i in range(levels)]
    return Snapshot(symbol, bid, ask, ts, bids=bids, asks=asks, verified=verified)


def make(clock=None, kill=False, **cfg):
    base = dict(starting_cash=100_000.0, duplicate_window_s=0.0, max_order_pct=100.0, max_position_pct=100.0)
    base.update(cfg)
    state = {"now": T0}
    eng = PaperEngine("t", PaperConfig(**base), clock=clock or (lambda: state["now"]), kill_switch=lambda: kill)
    eng._test_state = state  # lets a test move time
    return eng


def assert_accounting_identity(eng, marks=None):
    view = eng.account_view(marks or {})
    assert view["equity"] - view["starting_cash"] == pytest.approx(view["realized_pnl"] + view["unrealized_pnl"], abs=1e-6)
    assert view["cash"] >= -EPS
    for p in view["positions"]:
        assert p["qty"] >= -EPS, "shorting must be impossible"


# ------------------------------------------------------------------ rejection paths: prices are never invented
def test_order_without_a_verified_live_quote_is_rejected():
    r = make().submit(symbol="BTCUSDT", side="buy", qty=1, snap=None)
    assert r["accepted"] is False and r["reasons"] == ["no_verified_live_price"] and r["fills"] == []


@pytest.mark.parametrize("quote,reason", [
    (snap(ts=T0 - timedelta(seconds=60)), "quote_stale"),
    (snap(verified=False), "quote_not_verified"),
    (snap(bid=100.0, ask=110.0), "spread_too_wide"),
    (snap(bid=101.0, ask=100.0), "invalid_quote"),
])
def test_bad_quotes_are_rejected_with_a_specific_reason(quote, reason):
    r = make().submit(symbol="BTCUSDT", side="buy", qty=1, snap=quote)
    assert r["accepted"] is False and r["reasons"] == [reason]


def test_kill_switch_blocks_new_orders():
    r = make(kill=True).submit(symbol="BTCUSDT", side="buy", qty=1, snap=snap())
    assert r["accepted"] is False and r["reasons"] == ["kill_switch_active"]


@pytest.mark.parametrize("kwargs,reason", [
    (dict(symbol="BTCUSDT", side="buy", qty=0), None),
    (dict(symbol="BTCUSDT", side="hold", qty=1), None),
    (dict(symbol="BTCUSDT", side="buy", qty=1, order_type="limit"), None),          # limit needs a price
    (dict(symbol="BTCUSDT", side="buy", qty=float("nan")), None),
])
def test_malformed_orders_are_rejected(kwargs, reason):
    r = make().submit(snap=snap(), **kwargs)
    assert r["accepted"] is False and r["reasons"]


def test_no_shorting_selling_without_holdings_is_rejected():
    eng = make()
    r = eng.submit(symbol="BTCUSDT", side="sell", qty=1, snap=snap())
    assert r["accepted"] is False and r["reasons"] == ["insufficient_holdings"]
    assert_accounting_identity(eng)


def test_buy_beyond_available_cash_is_rejected():
    eng = make(starting_cash=10_000.0)
    # A resting limit buy reserves ~8.6k of the 10k, so a second ~2k buy is within the equity-based caps
    # but beyond what is actually available.
    assert eng.submit(symbol="BTCUSDT", side="buy", qty=90, order_type="limit", limit_price=95.0, snap=snap())["accepted"] is True
    r = eng.submit(symbol="BTCUSDT", side="buy", qty=20, snap=snap())  # ~2,002 notional
    assert r["accepted"] is False and r["reasons"] == ["insufficient_balance"]
    assert eng.cash == pytest.approx(10_000.0), "a rejected order must not move any cash"


def test_order_larger_than_the_whole_account_hits_the_size_cap_first():
    r = make(starting_cash=1_000.0).submit(symbol="BTCUSDT", side="buy", qty=50, snap=snap())  # ~5,005 notional
    assert r["accepted"] is False and r["reasons"] == ["order_exceeds_max_order_pct"]


def test_order_size_and_position_limits_use_equity_percentages():
    eng = make(max_order_pct=1.0, max_position_pct=1.0)
    r = eng.submit(symbol="BTCUSDT", side="buy", qty=20, snap=snap())  # ~2,002 > 1% of 100k
    assert r["accepted"] is False and r["reasons"] == ["order_exceeds_max_order_pct"]


def test_below_minimum_notional_is_rejected():
    r = make().submit(symbol="BTCUSDT", side="buy", qty=0.01, snap=snap())  # ~1.0 < 10
    assert r["accepted"] is False and r["reasons"] == ["below_min_notional"]


# ------------------------------------------------------------------ fills and accounting
def test_market_buy_fills_at_or_above_ask_and_charges_a_fee():
    eng = make()
    r = eng.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap())
    assert r["accepted"] is True and r["order"]["status"] == "filled"
    assert r["order"]["avg_fill_price"] >= 100.1, "a buy can never fill better than the ask"
    assert r["order"]["fees"] > 0 and eng.fees_paid == pytest.approx(r["order"]["fees"])
    assert eng.held_qty("BTCUSDT") == pytest.approx(10)
    assert eng.cash < 100_000.0 - 10 * 100.1
    assert_accounting_identity(eng, {"BTCUSDT": 100.05})


def test_round_trip_realizes_pnl_and_keeps_the_accounting_identity():
    eng = make()
    eng.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap())
    up = snap(bid=110.0, ask=110.1)
    r = eng.submit(symbol="BTCUSDT", side="sell", qty=10, snap=up)
    assert r["order"]["status"] == "filled"
    assert eng.held_qty("BTCUSDT") == pytest.approx(0, abs=1e-9)
    assert eng.realized_pnl > 0, "price rose ~10% so the round trip must be profitable after fees"
    assert_accounting_identity(eng)


def test_losing_round_trip_realizes_a_loss():
    eng = make()
    eng.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap())
    eng.submit(symbol="BTCUSDT", side="sell", qty=10, snap=snap(bid=90.0, ask=90.1))
    assert eng.realized_pnl < 0
    assert_accounting_identity(eng)


def test_thin_book_gives_a_partial_fill_not_an_invented_price():
    eng = make(participation=0.5)
    thin = snap(depth=2.0, levels=3)  # visible depth 3 levels x 2 units, 50% participation => at most 3 units
    r = eng.submit(symbol="BTCUSDT", side="buy", qty=10, snap=thin)
    assert r["accepted"] is True
    assert 0 < r["order"]["filled_qty"] < 10
    assert r["order"]["status"] in ("partially_filled", "canceled", "expired", "filled") and r["order"]["status"] != "filled"
    assert_accounting_identity(eng)


# ------------------------------------------------------------------ resting orders, triggers, OCO
def test_limit_buy_below_the_market_rests_then_fills_when_price_arrives():
    eng = make()
    r = eng.submit(symbol="BTCUSDT", side="buy", qty=5, order_type="limit", limit_price=95.0, snap=snap())
    assert r["accepted"] is True and r["order"]["status"] == "new" and r["fills"] == []
    assert eng.available_cash() < eng.cash, "a resting buy reserves cash"
    fills = eng.process_market(snap(bid=94.8, ask=94.9))
    assert fills, "the limit must execute once the ask crosses it"
    assert eng.held_qty("BTCUSDT") == pytest.approx(5)
    assert_accounting_identity(eng)


def test_cancel_releases_reserved_cash():
    eng = make()
    r = eng.submit(symbol="BTCUSDT", side="buy", qty=5, order_type="limit", limit_price=95.0, snap=snap())
    reserved = eng.cash - eng.available_cash()
    assert reserved > 0
    assert eng.cancel(r["order"]["id"])["order"]["status"] == "canceled"
    assert eng.available_cash() == pytest.approx(eng.cash)


def test_stop_order_triggers_when_the_bid_falls_through_it():
    eng = make()
    eng.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap())
    r = eng.submit(symbol="BTCUSDT", side="sell", qty=10, order_type="stop", trigger_price=95.0, snap=snap())
    assert r["accepted"] is True and r["order"]["status"] == "new"
    assert eng.process_market(snap(bid=96.0, ask=96.1)) == [], "not triggered while the bid is above the stop"
    fills = eng.process_market(snap(bid=94.0, ask=94.1))
    assert fills and eng.held_qty("BTCUSDT") == pytest.approx(0, abs=1e-9)
    assert_accounting_identity(eng)


def test_stop_that_is_already_through_the_market_is_rejected():
    eng = make()
    eng.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap())
    r = eng.submit(symbol="BTCUSDT", side="sell", qty=10, order_type="stop", trigger_price=105.0, snap=snap())
    assert r["accepted"] is False and r["reasons"] == ["trigger_already_hit"]


def test_oco_exit_pair_cancels_the_sibling_when_one_leg_fills():
    eng = make()
    eng.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap())
    r = eng.submit_oco(symbol="BTCUSDT", qty=10, stop_price=90.0, take_profit_price=110.0, snap=snap())
    assert r["accepted"] is True and len(r["orders"]) == 2
    eng.process_market(snap(bid=111.0, ask=111.1))
    statuses = {o["type"]: o["status"] for o in eng.list_orders("all") if o.get("oco_group") == r["oco_group"]}
    assert statuses["take_profit"] == "filled"
    assert statuses["stop"] in ("canceled", "cancelled", "expired")
    assert eng.held_qty("BTCUSDT") == pytest.approx(0, abs=1e-9)
    assert_accounting_identity(eng)


def test_oco_with_inverted_prices_is_rejected():
    eng = make()
    eng.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap())
    r = eng.submit_oco(symbol="BTCUSDT", qty=10, stop_price=110.0, take_profit_price=90.0, snap=snap())
    assert r["accepted"] is False and r["reasons"] == ["invalid_oco_prices"]


# ------------------------------------------------------------------ idempotency, audit, persistence
def test_repeating_a_client_order_id_returns_the_original_order_without_a_second_fill():
    eng = make()
    first = eng.submit(symbol="BTCUSDT", side="buy", qty=5, client_order_id="abc-1", snap=snap())
    second = eng.submit(symbol="BTCUSDT", side="buy", qty=5, client_order_id="abc-1", snap=snap())
    assert second["duplicate"] is True and second["order"]["id"] == first["order"]["id"]
    assert eng.held_qty("BTCUSDT") == pytest.approx(5)


def test_identical_orders_inside_the_duplicate_window_are_refused():
    eng = make(duplicate_window_s=5.0)
    assert eng.submit(symbol="BTCUSDT", side="buy", qty=5, snap=snap())["accepted"] is True
    r = eng.submit(symbol="BTCUSDT", side="buy", qty=5, snap=snap())
    assert r["accepted"] is False and r["reasons"] == ["duplicate_order_within_window"]


def test_every_decision_is_audited_and_the_audit_drains_once():
    eng = make()
    eng.submit(symbol="BTCUSDT", side="buy", qty=5, snap=snap())
    eng.submit(symbol="BTCUSDT", side="sell", qty=999, snap=snap())
    events = eng.drain_audit()
    kinds = [e["event"] for e in events]
    assert "order_accepted" in kinds and any(k.startswith("order_rejected") or k == "order_rejected" for k in kinds)
    assert [e["seq"] for e in events] == sorted(e["seq"] for e in events)
    assert eng.drain_audit() == []


def test_state_round_trips_through_json_safe_dicts():
    import json

    eng = make()
    eng.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap())
    eng.submit(symbol="BTCUSDT", side="sell", qty=3, order_type="limit", limit_price=120.0, snap=snap())
    state = json.loads(json.dumps(eng.to_state()))
    clone = PaperEngine.from_state(state, eng.cfg, clock=eng.clock)
    assert clone.cash == pytest.approx(eng.cash)
    assert clone.held_qty("BTCUSDT") == pytest.approx(eng.held_qty("BTCUSDT"))
    assert {o["id"]: o["status"] for o in clone.list_orders("all")} == {o["id"]: o["status"] for o in eng.list_orders("all")}
    assert clone.available_cash() == pytest.approx(eng.available_cash())


def test_reset_restores_starting_cash_and_clears_state():
    eng = make()
    eng.submit(symbol="BTCUSDT", side="buy", qty=10, snap=snap())
    eng.reset(50_000.0)
    assert eng.cash == pytest.approx(50_000.0) and eng.held_qty("BTCUSDT") == 0 and eng.list_orders("all") == []
