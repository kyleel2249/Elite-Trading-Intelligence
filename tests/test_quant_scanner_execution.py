"""Scanner / execution / controls tests.

Provider responses here are **clearly-labelled in-process fixtures**, not real
market data. They prove logic (batching, failover, staleness, recovery,
idempotency, risk gating). Real-provider load tests must be run separately
(see docs/QUANT_ENGINE.md).
"""
import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from app.config import Settings
from app.quant.controls import TradingControls
from app.quant.execution import (ExecutionEngine, ExecutionSignal, OrderState, PortfolioContext)
from app.quant.scanner import GlobalScanner, UniverseEntry


NOW = datetime(2026, 11, 8, 12, 0, tzinfo=timezone.utc)


class FixtureProvider:
    max_batch = 500
    rate_per_sec = 10_000.0

    def __init__(self, name, fail=False, age=5, missing=()):
        self.name, self.fail, self.age, self.missing = name, fail, age, set(missing)
        self.calls = 0

    async def fetch_batch(self, symbols):
        self.calls += 1
        if self.fail:
            raise ConnectionError("provider outage")
        return {s: {"price": 100.0 + (hash(s) % 50), "bid": 99.9, "ask": 100.1, "volume": 1e6,
                    "ts_utc": NOW - timedelta(seconds=self.age)}
                for s in symbols if s not in self.missing}


async def _nosleep(_):
    return None


def make_scanner(providers, **kw):
    return GlobalScanner(providers, max_age_seconds=300, interval_seconds=600, base_backoff=0.01,
                         clock=lambda: NOW, sleep=_nosleep, jitter=False, **kw)


def universe(n, chain=("a",)):
    return [UniverseEntry(f"SYM{i}", "equity", "TEST", list(chain)) for i in range(n)]


@pytest.mark.asyncio
async def test_scan_1000_and_2000_fixture_instruments():
    for n in (1000, 2000):
        p = FixtureProvider("a")
        sc = make_scanner({"a": p})
        sc.set_universe(universe(n))
        m = await sc.scan_once()
        assert m.scanned_ok == n and m.completion_pct == 100.0
        assert m.within_interval and m.requests <= n // 500 + 1      # batched, not one call per symbol
        assert sc.last_full_scan is not None


@pytest.mark.asyncio
async def test_failover_to_secondary_provider():
    a, b = FixtureProvider("a", fail=True), FixtureProvider("b")
    sc = make_scanner({"a": a, "b": b}, )
    sc.max_retries = 1
    sc.set_universe(universe(50, chain=("a", "b")))
    m = await sc.scan_once()
    assert m.scanned_ok == 50 and m.failovers == 50 and m.retries >= 1
    assert all(c.provider == "b" for c in sc.coverage.values())
    assert sc.provider_health["a"]["errors"] >= 2 and sc.provider_health["a"]["last_error"]


@pytest.mark.asyncio
async def test_unavailable_when_no_provider_works_never_reported_active():
    sc = make_scanner({"a": FixtureProvider("a", fail=True)})
    sc.max_retries = 0
    sc.set_universe(universe(10))
    m = await sc.scan_once()
    assert m.scanned_ok == 0 and m.unavailable == 10
    assert all(c.status == "UNAVAILABLE" and c.last_error for c in sc.coverage.values())


@pytest.mark.asyncio
async def test_stale_data_detected_and_not_active():
    sc = make_scanner({"a": FixtureProvider("a", age=3600)})
    sc.set_universe(universe(20))
    m = await sc.scan_once()
    assert m.stale == 20 and m.scanned_ok == 0
    assert all(c.status == "STALE" for c in sc.coverage.values())
    assert sc.fresh_ratio() == 0.0


@pytest.mark.asyncio
async def test_missing_symbols_marked_unavailable_others_ok():
    sc = make_scanner({"a": FixtureProvider("a", missing={"SYM3", "SYM4"})})
    sc.set_universe(universe(10))
    m = await sc.scan_once()
    assert m.scanned_ok == 8 and sc.coverage["SYM3"].status == "UNAVAILABLE"


@pytest.mark.asyncio
async def test_recovery_after_outage():
    p = FixtureProvider("a", fail=True)
    sc = make_scanner({"a": p})
    sc.max_retries = 0
    sc.set_universe(universe(25))
    assert (await sc.scan_once()).scanned_ok == 0
    p.fail = False
    m = await sc.scan_once()
    assert m.scanned_ok == 25 and all(c.consecutive_failures == 0 for c in sc.coverage.values())


@pytest.mark.asyncio
async def test_prior_fresh_data_ages_to_stale_when_provider_dies():
    p = FixtureProvider("a")
    clock = {"t": NOW}
    sc = GlobalScanner({"a": p}, max_age_seconds=300, clock=lambda: clock["t"], sleep=_nosleep, jitter=False,
                       max_retries=0)
    sc.set_universe(universe(5))
    assert (await sc.scan_once()).scanned_ok == 5
    p.fail = True
    clock["t"] = NOW + timedelta(seconds=900)
    m = await sc.scan_once()
    assert m.scanned_ok == 0 and m.stale == 5


@pytest.mark.asyncio
async def test_priority_instruments_scanned_first_and_partial_scan_does_not_set_full_scan():
    sc = make_scanner({"a": FixtureProvider("a")})
    sc.set_universe([UniverseEntry("LOW", "equity", "T", ["a"], 0), UniverseEntry("HIGH", "equity", "T", ["a"], 9)])
    await sc.scan_once(only=["HIGH"])
    assert sc.last_full_scan is None and sc.coverage["HIGH"].status == "ACTIVE"
    assert sc.coverage["LOW"].status == "NEVER_SCANNED"


@pytest.mark.asyncio
async def test_unregistered_primary_provider_fails_over_or_is_unavailable():
    b = FixtureProvider("b")
    sc = make_scanner({"b": b})
    sc.set_universe(universe(5, chain=("ghost", "b")) + [UniverseEntry("ONLY_GHOST", "equity", "T", ["ghost"])])
    m = await sc.scan_once()
    assert m.scanned_ok == 5 and sc.coverage["ONLY_GHOST"].status == "UNAVAILABLE"
    assert "not registered" in sc.coverage["ONLY_GHOST"].last_error


# ---------------- execution ----------------
def settings(**kw):
    base = dict(live_trading_enabled=False, api_key=None, data_max_age_seconds=300)
    base.update(kw)
    return Settings(**base)


class FakeSubmitter:
    def __init__(self, response=None, raises=False):
        self.calls, self.response, self.raises = [], response, raises

    async def __call__(self, **kw):
        self.calls.append(kw)
        if self.raises:
            raise TimeoutError("exchange timeout")
        return self.response or {"status": "submitted", "client_order_id": f"eti-{len(self.calls)}",
                                 "provider_response": {"orderId": 123, "status": "FILLED",
                                                       "executedQty": str(kw["qty"]), "price": "100.05"}}


def signal(**kw):
    d = dict(signal_id="s1", provider="binance", environment="paper", symbol="BTCUSDT", side="buy",
             quantity=50.0, entry_price=100.0, stop_price=98.0, take_profits=[104.0],
             mispricing_confirmed=True, data_age_seconds=5, data_status="fresh", bid=99.99, ask=100.01)
    d.update(kw)
    return ExecutionSignal(**d)


CTX = PortfolioContext(equity=100_000.0)


def engine(sub=None, **kw):
    return ExecutionEngine(kw.pop("settings", settings()), sub or FakeSubmitter(),
                           controls=kw.pop("controls", TradingControls()), **kw)


@pytest.mark.asyncio
async def test_paper_execution_fill_and_latency_metrics():
    sub = FakeSubmitter()
    e = engine(sub)
    rec = await e.execute(signal(), CTX)
    assert rec.state == OrderState.FILLED and rec.filled_qty == 50.0
    assert [h["state"] for h in rec.history] == ["PENDING", "APPROVED", "SUBMITTED", "ACKNOWLEDGED", "FILLED"]
    assert "signal_to_risk" in rec.latency_ms and "signal_to_ack" in rec.latency_ms
    assert rec.protective_orders["status"] == "not_attached"       # never claimed
    assert e.metrics()["orders"] == 1 and rec.slippage_bps is not None


@pytest.mark.asyncio
async def test_duplicate_signal_does_not_submit_twice():
    sub = FakeSubmitter()
    e = engine(sub)
    r1 = await e.execute(signal(), CTX)
    r2 = await e.execute(signal(), CTX)
    assert r1 is r2 and len(sub.calls) == 1


@pytest.mark.asyncio
async def test_order_over_6_percent_is_rejected_and_not_submitted():
    sub = FakeSubmitter()
    rec = await engine(sub).execute(signal(quantity=70.0), CTX)       # $7,000 = 7%
    assert rec.state == OrderState.REJECTED and not sub.calls
    assert any("6" in r for r in rec.reasons)


@pytest.mark.asyncio
async def test_risk_engine_independently_enforces_cap_for_close_to_limit():
    sub = FakeSubmitter()
    rec = await engine(sub).execute(signal(quantity=60.0, stop_price=99.5), CTX)   # exactly 6%
    assert rec.state in (OrderState.FILLED, OrderState.SUBMITTED, OrderState.ACKNOWLEDGED)


@pytest.mark.asyncio
async def test_stop_loss_risk_cap_enforced_by_risk_engine():
    sub = FakeSubmitter()
    rec = await engine(sub).execute(signal(quantity=50.0, stop_price=90.0), CTX)   # risk $500 = 0.5% ok
    assert rec.state != OrderState.REJECTED
    rec2 = await engine(sub).execute(signal(signal_id="s2", quantity=50.0, stop_price=60.0), CTX)  # risk $2,000 = 2%
    assert rec2.state == OrderState.REJECTED and any("Risk per trade" in r for r in rec2.reasons)


@pytest.mark.asyncio
async def test_live_blocked_when_disabled_and_nothing_submitted():
    sub = FakeSubmitter()
    rec = await engine(sub).execute(signal(environment="live"), CTX)
    assert rec.state == OrderState.REJECTED and not sub.calls
    assert any("LIVE_TRADING_ENABLED" in r for r in rec.reasons)


@pytest.mark.asyncio
async def test_live_requires_api_key_even_when_enabled():
    sub = FakeSubmitter()
    rec = await engine(sub, settings=settings(live_trading_enabled=True)).execute(signal(environment="live"), CTX)
    assert rec.state == OrderState.REJECTED and not sub.calls


@pytest.mark.asyncio
async def test_kill_switch_blocks_everything():
    c = TradingControls()
    c.engage_kill_switch()
    sub = FakeSubmitter()
    rec = await engine(sub, controls=c).execute(signal(), CTX)
    assert rec.state == OrderState.REJECTED and not sub.calls
    c.release_kill_switch()
    assert (await engine(sub, controls=c).execute(signal(signal_id="again"), CTX)).state != OrderState.REJECTED


@pytest.mark.asyncio
async def test_stale_price_and_unverified_signal_rejected():
    sub = FakeSubmitter()
    e = engine(sub)
    assert (await e.execute(signal(signal_id="a", data_age_seconds=900), CTX)).state == OrderState.REJECTED
    assert (await e.execute(signal(signal_id="b", data_status="stale"), CTX)).state == OrderState.REJECTED
    assert (await e.execute(signal(signal_id="c", mispricing_confirmed=False), CTX)).state == OrderState.REJECTED
    assert not sub.calls


@pytest.mark.asyncio
async def test_wide_spread_and_thin_liquidity_rejected():
    e = engine()
    assert (await e.execute(signal(signal_id="w", bid=98.0, ask=102.0), CTX)).state == OrderState.REJECTED
    assert (await e.execute(signal(signal_id="t", liquidity_notional=10_000.0), CTX)).state == OrderState.REJECTED


@pytest.mark.asyncio
async def test_rejected_by_trading_service_maps_to_rejected():
    sub = FakeSubmitter({"status": "rejected", "client_order_id": "x1", "risk": {"reasons": ["provider said no"]}})
    rec = await engine(sub).execute(signal(), CTX)
    assert rec.state == OrderState.REJECTED and "provider said no" in rec.reasons


@pytest.mark.asyncio
async def test_exception_is_failed_not_filled():
    rec = await engine(FakeSubmitter(raises=True)).execute(signal(), CTX)
    assert rec.state == OrderState.FAILED and rec.filled_qty == 0.0


@pytest.mark.asyncio
async def test_submitted_is_not_filled_without_provider_fill_report():
    sub = FakeSubmitter({"status": "submitted", "client_order_id": "c9", "provider_response": {"orderId": 7}})
    e = engine(sub)
    rec = await e.execute(signal(), CTX)
    assert rec.state == OrderState.ACKNOWLEDGED and rec.filled_qty == 0.0
    # reconciliation: partial then full
    e.apply_fill_report("c9", 20.0, 100.02)
    assert rec.state == OrderState.PARTIALLY_FILLED and rec.filled_qty == 20.0
    e.apply_fill_report("c9", 50.0, 100.03)
    assert rec.state == OrderState.FILLED and e.metrics()["state_counts"]["FILLED"] == 1


@pytest.mark.asyncio
async def test_cancel_and_terminal_states_are_final():
    sub = FakeSubmitter({"status": "submitted", "client_order_id": "c1", "provider_response": {"orderId": 1}})
    e = engine(sub)
    await e.execute(signal(), CTX)
    e.cancel("s1")
    assert e.records["s1"].state == OrderState.CANCELLED
    e.apply_fill_report("c1", 50.0, 100.0)
    assert e.records["s1"].state == OrderState.CANCELLED


@pytest.mark.asyncio
async def test_live_orders_always_use_limit_not_market():
    e = engine(settings=settings(live_trading_enabled=True, api_key="k"))
    typ, px = e.choose_order_type(signal(environment="live"))
    assert typ == "limit" and px is not None


def test_abnormal_execution_behaviour_auto_suspends():
    c = TradingControls()
    for _ in range(12):
        c.record_execution_outcome("REJECTED")
    assert c.trading_blocked() and "abnormal_execution_behavior" in c.suspended_reasons


def test_stale_data_auto_suspends_and_recovers():
    c = TradingControls()
    c.check_data_health(0.1)
    assert c.trading_blocked()
    c.check_data_health(0.9)
    assert c.trading_blocked() is None
