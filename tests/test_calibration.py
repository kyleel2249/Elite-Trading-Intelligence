"""Calibration math, Alpaca bars / option quote parsing, and calibrated assessment (fake transports only)."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.integrations.alpaca.client import AlpacaClient
from app.markets.calibration import adv_usd, atr_wilder, calibrated_assess, spread_bps

ALP = Settings(alpaca_api_key="k", alpaca_secret_key="s")


def iso(delta=0):
    return (datetime.now(timezone.utc) - timedelta(seconds=delta)).strftime("%Y-%m-%dT%H:%M:%SZ")


def bars(n=30, rng=2.0, close=100.0, vol=1_000_000):
    return [{"open_time": i, "open": close, "high": close + rng / 2, "low": close - rng / 2, "close": close, "volume": vol,
             "close_time": i + 1, "data_status": "valid"} for i in range(n)]


def test_atr_constant_range_and_gaps():
    assert atr_wilder(bars(20, rng=2.0)) == pytest.approx(2.0)
    assert atr_wilder(bars(10)) is None                                   # not enough history -> no guess
    gap = bars(20, rng=1.0)
    gap[-1].update(open=110, high=110.5, low=109.5, close=110)           # gap up: true range includes the jump
    assert atr_wilder(gap) > atr_wilder(bars(20, rng=1.0))


def test_spread_and_adv():
    assert spread_bps(99.99, 100.01) == pytest.approx(2.0, rel=1e-3)
    assert spread_bps(None, 1) is None and spread_bps(101, 100) is None and spread_bps(0, 1) is None
    assert adv_usd(bars(10, close=10, vol=100)) == 1000
    assert adv_usd(bars(3)) is None


class FakeMS:
    def __init__(self, snap, rows, fail=None):
        self.snap, self.rows, self.fail, self.calls = snap, rows, fail, []

    async def get_snapshot(self, provider, symbol):
        self.calls.append(("snap", provider, symbol))
        if self.fail == "snap":
            raise RuntimeError("boom")
        return self.snap

    async def get_history(self, provider, symbol, interval="1h", limit=100):
        self.calls.append(("hist", provider, symbol, interval))
        if self.fail == "hist":
            raise RuntimeError("no history")
        return self.rows


CRYPTO_SNAP = {"data_status": "fresh", "price": 100.0, "bid": 99.95, "ask": 100.05}


@pytest.mark.asyncio
async def test_crypto_calibration_uses_measured_inputs():
    ms = FakeMS(CRYPTO_SNAP, bars())
    out = await calibrated_assess("BTCUSDT", market_service=ms, settings=Settings(), account_equity=50_000)
    cal = out["calibration"]
    assert set(cal["used"]) == {"price", "measured_spread_bps", "atr", "avg_daily_volume_usd"} and not cal["errors"]
    assert out["costs"]["spread_source"] == "measured" and out["costs"]["spread_bps"] == pytest.approx(10.0, rel=1e-3)
    assert ("hist", "binance", "BTCUSDT", "1d") in ms.calls


@pytest.mark.asyncio
async def test_caller_values_override_measurements():
    out = await calibrated_assess("BTCUSDT", market_service=FakeMS(CRYPTO_SNAP, bars()), settings=Settings(), measured_spread_bps=3.0)
    assert out["costs"]["spread_bps"] == 3.0 and "overridden" in out["calibration"]["skipped"]["measured_spread_bps"]


@pytest.mark.asyncio
async def test_failures_degrade_to_baselines_and_say_so():
    out = await calibrated_assess("BTCUSDT", market_service=FakeMS(CRYPTO_SNAP, [], fail="hist"), settings=Settings())
    assert any("history" in e for e in out["calibration"]["errors"]) and "atr" in out["calibration"]["skipped"]
    assert out["verdict"] in {"ready", "caution", "wait_for_session", "analysis_only", "blocked", "needs_setup"}
    bad_quote = await calibrated_assess("BTCUSDT", market_service=FakeMS({"data_status": "stale", "price": 1.0}, bars()), settings=Settings())
    assert "price" in bad_quote["calibration"]["skipped"] and "price" not in bad_quote["calibration"]["used"]


@pytest.mark.asyncio
async def test_forex_skips_volume_and_etf_proxy_is_never_calibrated():
    s = Settings(oanda_api_token="t", oanda_account_id="a")
    fx = await calibrated_assess("EURUSD", market_service=FakeMS({"data_status": "fresh", "price": 1.085, "bid": 1.0849, "ask": 1.0851}, bars(close=1.085, rng=0.01)), settings=s)
    assert "avg_daily_volume_usd" in fx["calibration"]["skipped"] and fx["calibration"]["route"]["provider"] == "oanda"
    # only Alpaca configured: index falls to the ETF proxy -> nothing measured is applied
    ms = FakeMS(CRYPTO_SNAP, bars())
    px = await calibrated_assess("SPX", market_service=ms, settings=ALP)
    assert "ETF proxy" in px["calibration"]["skipped"]["all"] and not ms.calls


@pytest.mark.asyncio
async def test_unconfigured_and_unrouted_markets_do_not_call_providers():
    ms = FakeMS(CRYPTO_SNAP, bars())
    for sym in ("EURUSD", "ESZ6", "VOD.L"):
        out = await calibrated_assess(sym, market_service=ms, settings=Settings())
        assert "all" in out["calibration"]["skipped"]
    assert not ms.calls


# ---------------------------------------------------------------- Alpaca
def alpaca(handler):
    return AlpacaClient(ALP, transport=httpx.MockTransport(handler))


@pytest.mark.asyncio
async def test_alpaca_bars_shape_and_params():
    seen = {}

    def h(req):
        seen.update(req.url.params)
        return httpx.Response(200, json={"bars": [{"t": "2026-11-05T05:00:00Z", "o": 10, "h": 12, "l": 9, "c": 11, "v": 500},
                                                  {"t": "2026-11-06T05:00:00Z", "o": 11, "h": 13, "l": 10, "c": 12, "v": 600}]})
    rows = await alpaca(h).get_bars("aapl", "1d", 30)
    assert seen["timeframe"] == "1Day" and seen["adjustment"] == "raw" and len(rows) == 2
    assert rows[1]["close"] == 12.0 and rows[1]["close_time"] - rows[1]["open_time"] == 86400_000 - 1
    with pytest.raises(RuntimeError, match="Unsupported"):
        await alpaca(h).get_bars("AAPL", "3m")
    with pytest.raises(RuntimeError, match="403"):
        await alpaca(lambda r: httpx.Response(403, text="forbidden")).get_bars("AAPL")


@pytest.mark.asyncio
async def test_alpaca_quote_gets_bid_ask_and_tolerates_missing_nbbo():
    def h(req):
        if req.url.path.endswith("/trades/latest"):
            return httpx.Response(200, json={"trade": {"p": 100.0, "t": iso(2)}})
        return httpx.Response(200, json={"quote": {"bp": 99.98, "ap": 100.02}})
    q = await alpaca(h).get_quote("AAPL")
    assert (q.bid, q.ask) == (99.98, 100.02) and q.data_status == "fresh"
    q2 = await alpaca(lambda r: httpx.Response(200, json={"trade": {"p": 5, "t": iso()}}) if "trades" in r.url.path else httpx.Response(500)).get_quote("AAPL")
    assert q2.bid is None and q2.price == 5


@pytest.mark.asyncio
async def test_alpaca_option_quote():
    sym = "AAPL261218C00200000"

    def h(req):
        assert req.url.path == "/v1beta1/options/snapshots" and req.url.params["symbols"] == sym
        return httpx.Response(200, json={"snapshots": {sym: {"latestQuote": {"bp": 4.0, "ap": 4.4, "t": iso(3)}, "latestTrade": {"p": 4.1}}}})
    q = await alpaca(h).get_option_quote(sym)
    assert q.price == pytest.approx(4.2) and q.asset_class == "option" and q.meta["unverified_live"] is True
    with pytest.raises(RuntimeError, match="No option snapshot"):
        await alpaca(lambda r: httpx.Response(200, json={"snapshots": {}})).get_option_quote(sym)


@pytest.mark.asyncio
async def test_market_service_routes_options_and_history_to_alpaca(monkeypatch):
    import app.market.service as svc
    from app.market.service import MarketService
    hits = []

    def h(req):
        hits.append(req.url.path)
        if "options" in req.url.path:
            return httpx.Response(200, json={"snapshots": {"AAPL261218C00200000": {"latestQuote": {"bp": 1, "ap": 1.2, "t": iso()}}}})
        return httpx.Response(200, json={"bars": [{"t": "2026-11-05T05:00:00Z", "o": 1, "h": 2, "l": 1, "c": 2, "v": 3}]})
    monkeypatch.setattr(svc, "AlpacaClient", lambda settings: AlpacaClient(settings, transport=httpx.MockTransport(h)))
    ms = MarketService(ALP)
    snap = await ms.get_snapshot("alpaca", "AAPL261218C00200000")
    assert snap["asset_class"] == "option" and any("options" in p for p in hits)
    hist = await ms.get_history("alpaca", "AAPL", "1d", 5)
    assert hist[0]["provider"] == "alpaca" and hist[0]["close"] == 2


def test_calibrated_endpoint_validates_and_never_500s_on_unrouted(monkeypatch):
    from app.main import app
    c = TestClient(app)
    assert c.get("/api/markets/calibrated-assess", params={"symbol": "???!!"}).status_code == 422
    r = c.get("/api/markets/calibrated-assess", params={"symbol": "ESZ6"})
    assert r.status_code == 200 and "calibration" in r.json() and "all" in r.json()["calibration"]["skipped"]
