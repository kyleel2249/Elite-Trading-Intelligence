"""Service layer of the internal paper exchange: persistence, concurrency, kill switch, ticking, stores and mode resolution.

Covers app.paper.service / store / mode, which tests/test_paper_exchange_engine.py (pure engine) does not reach.
It replaces the intent of the skipped tests/test_paper_service.py, which targets the removed app.paper.core engine.
No network and no database: quotes are injected and stores are in-memory or a temp directory.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timezone

import pytest

from app.paper.engine import PaperConfig, Snapshot
from app.paper.mode import (EXCHANGE_LIVE, EXCHANGE_TESTNET, INTERNAL_PAPER, REJECT, resolve_mode)
from app.paper.service import PaperExchange, PaperTickJob, config_from_env
from app.paper.store import JsonFileStore, MemoryStore, StaleStateError

T0 = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)
CFG = dict(starting_cash=100_000.0, duplicate_window_s=0.0, max_order_pct=100.0, max_position_pct=100.0)


def snap(bid=100.0, ask=100.1, symbol="BTCUSDT", ts=T0, depth=1000.0):
    return Snapshot(symbol, bid, ask, ts, bids=[(bid - i * 0.1, depth) for i in range(5)],
                    asks=[(ask + i * 0.1, depth) for i in range(5)], verified=True)


class FakeQuotes:
    """Quote provider whose answers a test controls. A value of None means 'no verified quote'; an Exception is raised."""

    def __init__(self, **by_symbol):
        self.by_symbol = {k.upper(): v for k, v in by_symbol.items()}

    async def get(self, symbol):
        v = self.by_symbol.get(symbol.upper())
        if isinstance(v, Exception):
            raise v
        return v


def exchange(store=None, quotes=None, kill=None, account_id="acc", **cfg):
    kill = kill if kill is not None else {"on": False}
    ex = PaperExchange(store or MemoryStore(), quotes or FakeQuotes(BTCUSDT=snap()), PaperConfig(**{**CFG, **cfg}),
                       clock=lambda: T0, kill_switch=lambda: kill["on"], account_id=account_id)
    ex._kill = kill
    return ex


# ------------------------------------------------------------------ persistence and audit
async def test_state_survives_a_restart_because_it_lives_in_the_store():
    store = MemoryStore()
    r = await exchange(store).submit(symbol="BTCUSDT", side="buy", qty=1)
    assert r["accepted"] and r["fills"]
    after_restart = await exchange(store, FakeQuotes(BTCUSDT=snap())).account(tick=False)   # brand-new service object, same store
    open_positions = [p for p in after_restart["positions"] if p["open"]]
    assert [p["symbol"] for p in open_positions] == ["BTCUSDT"]
    assert after_restart["cash"] < CFG["starting_cash"]


async def test_audit_log_records_account_creation_and_the_accepted_order():
    ex = exchange()
    await ex.submit(symbol="BTCUSDT", side="buy", qty=1)
    events = [a["event"] if "event" in a else a.get("type") for a in await ex.audit()]
    assert "account_created" in events and "order_accepted" in events


async def test_reset_returns_the_account_to_starting_cash_with_no_positions():
    ex = exchange()
    await ex.submit(symbol="BTCUSDT", side="buy", qty=1)
    view = await ex.reset(50_000.0)
    assert view["cash"] == pytest.approx(50_000.0)
    assert not [p for p in view["positions"] if p["open"]]


# ------------------------------------------------------------------ prices are never invented
async def test_no_quote_means_rejection_not_a_made_up_fill():
    r = await exchange(quotes=FakeQuotes(BTCUSDT=None)).submit(symbol="BTCUSDT", side="buy", qty=1)
    assert r["accepted"] is False and r["reasons"] == ["no_verified_live_price"] and r["fills"] == []


async def test_a_crashing_quote_provider_is_contained_and_treated_as_no_quote():
    r = await exchange(quotes=FakeQuotes(BTCUSDT=RuntimeError("feed down"))).submit(symbol="BTCUSDT", side="buy", qty=1)
    assert r["accepted"] is False and r["reasons"] == ["no_verified_live_price"]


async def test_preview_never_changes_the_account():
    store = MemoryStore()
    ex = exchange(store)
    await ex.preview(symbol="BTCUSDT", side="buy", qty=1)
    assert store.load("acc") == (None, 0)          # nothing was written


# ------------------------------------------------------------------ kill switch
async def test_kill_switch_blocks_orders_and_is_reported_in_the_account_view():
    ex = exchange()
    ex._kill["on"] = True
    r = await ex.submit(symbol="BTCUSDT", side="buy", qty=1)
    assert r["accepted"] is False and r["reasons"] == ["kill_switch_active"]
    assert (await ex.account(tick=False))["kill_switch"] is True


# ------------------------------------------------------------------ resting orders execute on tick
async def test_resting_limit_buy_fills_on_tick_once_the_market_crosses_it():
    quotes = FakeQuotes(BTCUSDT=snap(100.0, 100.1))
    ex = exchange(quotes=quotes)
    r = await ex.submit(symbol="BTCUSDT", side="buy", qty=1, order_type="limit", limit_price=99.0)
    assert r["accepted"] and r["fills"] == []                                   # resting, nothing filled yet
    assert (await ex.tick())["fills"] == []                                      # market has not reached 99
    quotes.by_symbol["BTCUSDT"] = snap(98.7, 98.8)
    res = await ex.tick()
    assert res["symbols"] == ["BTCUSDT"] and len(res["fills"]) >= 1
    assert [o["status"] for o in await ex.orders("all")] == ["filled"]


async def test_tick_reports_symbols_it_could_not_price_instead_of_guessing():
    quotes = FakeQuotes(BTCUSDT=snap(100.0, 100.1))
    ex = exchange(quotes=quotes)
    await ex.submit(symbol="BTCUSDT", side="buy", qty=1, order_type="limit", limit_price=99.0)
    quotes.by_symbol["BTCUSDT"] = None
    res = await ex.tick()
    assert res["unpriced"] == ["BTCUSDT"] and res["fills"] == []


async def test_cancel_closes_a_resting_order_and_refuses_unknown_or_already_closed_ones():
    ex = exchange()
    first = await ex.submit(symbol="BTCUSDT", side="buy", qty=1, order_type="limit", limit_price=95.0)
    oid = first["order"]["id"]
    done = await ex.cancel(oid)
    assert done["ok"] is True and done["order"]["status"] == "canceled"
    again = await ex.cancel(oid)
    assert again["ok"] is False and again["reason"] == "already_closed"             # a second cancel is a no-op, never a second release
    assert (await ex.cancel("does-not-exist")) == {"ok": False, "reason": "unknown_order"}


async def test_cancel_all_only_touches_working_orders_and_can_be_scoped_to_a_symbol():
    quotes = FakeQuotes(BTCUSDT=snap(), ETHUSDT=snap(2000.0, 2000.5, symbol="ETHUSDT"))
    ex = exchange(quotes=quotes)
    await ex.submit(symbol="BTCUSDT", side="buy", qty=1, order_type="limit", limit_price=95.0)
    await ex.submit(symbol="BTCUSDT", side="buy", qty=2, order_type="limit", limit_price=94.0)
    await ex.submit(symbol="ETHUSDT", side="buy", qty=1, order_type="limit", limit_price=1900.0)
    assert (await ex.cancel_all("btcusdt"))["canceled"] == 2                     # symbol filter is case-insensitive
    assert (await ex.cancel_all())["canceled"] == 1                              # only the ETH order was still working
    assert (await ex.cancel_all())["canceled"] == 0                              # nothing left to cancel
    assert {o["status"] for o in await ex.orders("all")} == {"canceled"}


# ------------------------------------------------------------------ optimistic concurrency
class FlakyStore(MemoryStore):
    """Raises StaleStateError for the first N saves, as if another writer got in between load and save."""

    def __init__(self, stale_times):
        super().__init__()
        self.stale_times, self.save_attempts = stale_times, 0

    def save(self, account_id, state, audit, expected_version):
        self.save_attempts += 1
        if self.save_attempts <= self.stale_times:
            raise StaleStateError(account_id)
        return super().save(account_id, state, audit, expected_version)


async def test_a_concurrent_writer_is_retried_and_the_order_is_applied_once():
    store = FlakyStore(stale_times=2)
    r = await exchange(store).submit(symbol="BTCUSDT", side="buy", qty=1)
    assert r["accepted"] and store.save_attempts == 3
    assert len([o for o in await exchange(store).orders("all")]) == 1               # never double-applied


async def test_persistent_contention_fails_loudly_rather_than_losing_the_write_silently():
    store = FlakyStore(stale_times=99)
    with pytest.raises(RuntimeError, match="busy"):
        await exchange(store).submit(symbol="BTCUSDT", side="buy", qty=1)


# ------------------------------------------------------------------ stores
@pytest.mark.parametrize("make_store", [lambda tmp: MemoryStore(), lambda tmp: JsonFileStore(str(tmp))])
def test_store_versions_increase_and_stale_writes_are_refused(make_store, tmp_path):
    s = make_store(tmp_path)
    assert s.load("a") == (None, 0)
    assert s.save("a", {"n": 1}, [{"event": "x"}], 0) == 1
    assert s.load("a") == ({"n": 1}, 1)
    with pytest.raises(StaleStateError):
        s.save("a", {"n": 2}, [], 0)                                              # writer still holding version 0
    assert s.save("a", {"n": 2}, [{"event": "y"}], 1) == 2


@pytest.mark.parametrize("make_store", [lambda tmp: MemoryStore(), lambda tmp: JsonFileStore(str(tmp))])
def test_audit_is_newest_first_and_honours_the_limit(make_store, tmp_path):
    s = make_store(tmp_path)
    s.save("a", {}, [{"i": 1}, {"i": 2}, {"i": 3}], 0)
    assert [e["i"] for e in s.audit("a")] == [3, 2, 1]
    assert [e["i"] for e in s.audit("a", limit=2)] == [3, 2]
    assert s.audit("missing") == []


def test_json_file_store_survives_a_new_process_and_stays_inside_its_directory(tmp_path):
    JsonFileStore(str(tmp_path)).save("../../escape", {"ok": True}, [], 0)
    assert JsonFileStore(str(tmp_path)).load("../../escape") == ({"ok": True}, 1)   # a fresh instance reads it back
    files = list(tmp_path.glob("*.json"))
    assert len(files) == 1 and files[0].parent == tmp_path                             # path separators were stripped, no traversal
    assert json.loads(files[0].read_text())["version"] == 1


def test_memory_store_returns_copies_so_callers_cannot_corrupt_saved_state():
    s = MemoryStore()
    s.save("a", {"k": [1]}, [], 0)
    state, _ = s.load("a")
    state["k"].append(999)
    assert s.load("a")[0] == {"k": [1]}


# ------------------------------------------------------------------ mode resolution: live is never simulated, downgrades are loud
@pytest.mark.parametrize("env,creds,live,mode,downgraded,reason", [
    ("paper", False, False, INTERNAL_PAPER, False, None),
    ("PAPER", True, True, INTERNAL_PAPER, False, None),
    ("testnet", True, False, EXCHANGE_TESTNET, False, None),
    ("testnet", False, False, INTERNAL_PAPER, True, None),
    ("live", True, False, REJECT, False, "live_trading_disabled"),
    ("live", False, True, REJECT, False, "live_credentials_missing"),
    ("live", True, True, EXCHANGE_LIVE, False, None),
    ("", True, True, REJECT, False, "unknown_environment"),
    ("mainnet", True, True, REJECT, False, "unknown_environment"),
])
def test_mode_matrix(env, creds, live, mode, downgraded, reason):
    d = resolve_mode("binance", env, creds_configured=creds, live_enabled=live)
    assert d.mode == mode and d.downgraded is downgraded
    if reason:
        assert d.reason == reason
    if downgraded:
        assert "NOT sent to any exchange" in d.warning                            # a silent downgrade would look like a real testnet fill
    assert d.to_dict()["label"]


# ------------------------------------------------------------------ configuration from the environment
def test_config_from_env_applies_overrides_ignores_garbage_and_clamps_participation():
    c = config_from_env({"PAPER_STARTING_CASH": "5000", "PAPER_MAX_OPEN_POSITIONS": "3", "PAPER_TAKER_FEE_BPS": "oops",
                         "PAPER_PARTICIPATION": "7"})
    assert c.starting_cash == 5000.0 and c.max_open_positions == 3
    assert c.taker_fee_bps == PaperConfig().taker_fee_bps                         # invalid value ignored, default kept
    assert c.participation == 1.0                                                  # clamped to the valid range
    assert config_from_env({"PAPER_PARTICIPATION": "0"}).participation == 0.01


# ------------------------------------------------------------------ background tick job
async def test_tick_job_runs_reports_status_and_stops_cleanly():
    job = PaperTickJob(lambda: exchange(), interval_seconds=1.0)
    await job.start()
    await job.start()                                                              # idempotent: still one task
    await asyncio.sleep(0.05)
    assert job.status()["running"] is True and job.runs >= 1 and job.last_error is None
    await job.stop()
    assert job.status()["running"] is False


async def test_tick_job_survives_a_failing_tick_and_exposes_the_error_type():
    class Broken:
        async def tick(self):
            raise ConnectionError("exchange unreachable")

    job = PaperTickJob(lambda: Broken(), interval_seconds=1.0)
    await job.start()
    await asyncio.sleep(0.05)
    assert job.last_error == "ConnectionError" and job.status()["running"] is True   # the loop is still alive
    await job.stop()
