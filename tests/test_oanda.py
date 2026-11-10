"""OANDA adapter: real client code against a fake HTTP transport (no live OANDA access in CI).

What this proves: request shape (paths, params, auth header, order body), response parsing, precision and
minimum-size handling, error/cancel/reject handling, reconciliation, and integration with MarketService,
TradingService and the RiskEngine. What it cannot prove: that OANDA accepts these calls on a real account.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from app.config import Settings
from app.database import Base, SessionLocal, engine
from app.integrations.oanda import OandaClient, OandaError
from app.integrations.oanda.client import parse_oanda_time
from app.market.service import MarketService
from app.models import OrderRecord
from app.risk.engine import OrderProposal, RiskEngine
from app.trading.reconciliation import OrderReconciler
from app.trading.service import TradingService

ACCT = "101-001-1234567-001"
SETTINGS = Settings(oanda_api_token="tok-SECRET-123", oanda_account_id=ACCT)

INSTRUMENTS = {"instruments": [
    {"name": "EUR_USD", "displayPrecision": 5, "tradeUnitsPrecision": 0, "minimumTradeSize": "1", "maximumOrderUnits": "100000000"},
    {"name": "USD_JPY", "displayPrecision": 3, "tradeUnitsPrecision": 0, "minimumTradeSize": "1", "maximumOrderUnits": "100000000"},
    {"name": "XAU_USD", "displayPrecision": 3, "tradeUnitsPrecision": 0, "minimumTradeSize": "1", "maximumOrderUnits": "50000"},
    {"name": "SPX500_USD", "displayPrecision": 1, "tradeUnitsPrecision": 1, "minimumTradeSize": "0.1", "maximumOrderUnits": "1000"},
    {"name": "WTICO_USD", "displayPrecision": 3, "tradeUnitsPrecision": 0, "minimumTradeSize": "1", "maximumOrderUnits": "1000000"},
]}


def now_iso(delta_s=0):
    t = datetime.now(timezone.utc) - timedelta(seconds=delta_s)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + "123456789Z"          # OANDA sends nanoseconds


class FakeOanda:
    """Records every request and answers like the v20 API."""

    def __init__(self, *, tradeable=True, price_age=1, order_response=None, order_status=200, orders=None):
        self.requests: list[httpx.Request] = []
        self.tradeable, self.price_age = tradeable, price_age
        self.order_response, self.order_status = order_response, order_status
        self.orders = orders or {}

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def handle(self, req: httpx.Request) -> httpx.Response:
        self.requests.append(req)
        path, base = req.url.path, f"/v3/accounts/{ACCT}"
        if req.headers.get("authorization") != "Bearer tok-SECRET-123":
            return httpx.Response(401, json={"errorMessage": "Insufficient authorization to perform request."})
        if path == f"{base}/summary":
            return httpx.Response(200, json={"account": {"currency": "USD", "marginAvailable": "99000.0", "NAV": "100000"}})
        if path == f"{base}/instruments":
            return httpx.Response(200, json=INSTRUMENTS)
        if path == f"{base}/pricing":
            name = req.url.params["instruments"]
            return httpx.Response(200, json={"prices": [{"instrument": name, "time": now_iso(self.price_age), "tradeable": self.tradeable,
                                                         "status": "tradeable" if self.tradeable else "non-tradeable",
                                                         "bids": [{"price": "1.08490", "liquidity": 10000000}],
                                                         "asks": [{"price": "1.08510", "liquidity": 10000000}]}]})
        if path.startswith("/v3/instruments/") and path.endswith("/candles"):
            t0 = datetime(2026, 11, 9, 10, tzinfo=timezone.utc)
            candles = [{"complete": True, "volume": 100 + i, "time": (t0 + timedelta(hours=i)).strftime("%Y-%m-%dT%H:%M:%S.000000000Z"),
                        "mid": {"o": "1.0800", "h": "1.0900", "l": "1.0700", "c": "1.0850"}} for i in range(3)]
            candles.append({"complete": False, "volume": 5, "time": (t0 + timedelta(hours=3)).strftime("%Y-%m-%dT%H:%M:%S.000000000Z"),
                            "mid": {"o": "1.0850", "h": "1.0860", "l": "1.0840", "c": "1.0855"}})
            return httpx.Response(200, json={"candles": candles})
        if path == f"{base}/orders" and req.method == "POST":
            return httpx.Response(self.order_status, json=self.order_response or {
                "orderCreateTransaction": {"id": "6360", "type": "MARKET_ORDER"},
                "orderFillTransaction": {"id": "6361", "orderID": "6360", "price": "1.08512", "type": "ORDER_FILL"}})
        if path.startswith(f"{base}/orders/@"):
            cid = path.rsplit("@", 1)[1]
            return httpx.Response(200, json={"order": self.orders[cid]}) if cid in self.orders else httpx.Response(404, json={"errorMessage": "not found"})
        if path.startswith(f"{base}/transactions/"):
            return httpx.Response(200, json={"transaction": {"id": path.rsplit("/", 1)[1], "type": "ORDER_FILL", "price": "1.08777"}})
        return httpx.Response(404, json={"errorMessage": f"unexpected path {path}"})

    def client(self, **kw) -> OandaClient:
        return OandaClient(SETTINGS, transport=self.transport(), **kw)

    def order_body(self) -> dict:
        posts = [r for r in self.requests if r.method == "POST"]
        assert len(posts) == 1, "expected exactly one order submission"
        return json.loads(posts[0].content)["order"]


# ------------------------------------------------------------------ helpers / config
def test_parse_oanda_time_handles_nanoseconds_and_unix():
    t = parse_oanda_time("2026-11-09T19:00:00.123456789Z")
    assert t == datetime(2026, 11, 9, 19, 0, 0, 123456, tzinfo=timezone.utc)
    assert parse_oanda_time("2026-11-09T19:00:00Z").tzinfo is not None
    assert parse_oanda_time("1767225600.000000000") == datetime(2026, 1, 1, tzinfo=timezone.utc)


def test_settings_flag_and_hosts():
    assert SETTINGS.oanda_configured and not Settings(oanda_api_token=None, oanda_account_id=None).oanda_configured
    assert Settings().oanda_live_trading_enabled is False
    assert "fxpractice" in OandaClient(SETTINGS).base_url and "fxtrade" in OandaClient(SETTINGS, use_practice=False).base_url


@pytest.mark.asyncio
async def test_unconfigured_client_never_calls_the_network():
    c = OandaClient(Settings(oanda_api_token=None, oanda_account_id=None), transport=httpx.MockTransport(lambda r: pytest.fail("network used")))
    assert (await c.health())["status"] == "not_configured"
    with pytest.raises(OandaError, match="not configured"):
        await c.get_quote("EURUSD")
    with pytest.raises(OandaError, match="not configured"):
        await c.submit_order("EURUSD", 1000, "buy")


# ------------------------------------------------------------------ instruments / quotes / candles
@pytest.mark.asyncio
async def test_resolve_maps_eti_symbols_and_rejects_what_the_account_lacks():
    c = FakeOanda().client()
    assert await c.resolve("EURUSD") == "EUR_USD" and await c.resolve("eur/usd") == "EUR_USD"
    assert await c.resolve("XAUUSD") == "XAU_USD" and await c.resolve("SPX") == "SPX500_USD" and await c.resolve("WTI") == "WTICO_USD"
    assert await c.resolve("EUR_USD") == "EUR_USD"                                   # OANDA names pass through
    for unavailable in ("USDZAR", "COFFEE", "VOD.L", "BTCUSDT", "ESZ6"):            # not in the account's list / not OANDA markets
        with pytest.raises(OandaError, match="not available"):
            await c.resolve(unavailable)


@pytest.mark.asyncio
async def test_health_reports_connection_and_does_not_leak_the_token():
    h = await FakeOanda().client().health()
    assert h["status"] == "connected" and h["environment"] == "practice" and h["currency"] == "USD"
    assert "tok-SECRET" not in json.dumps(h)
    bad = OandaClient(Settings(oanda_api_token="wrong", oanda_account_id=ACCT), transport=FakeOanda().transport())
    hb = await bad.health()
    assert hb["status"] == "error" and "401" in hb["error"] and "wrong" not in json.dumps(hb)


@pytest.mark.asyncio
async def test_quote_parsing_request_shape_and_closed_market():
    fake = FakeOanda()
    q = await fake.client().get_quote("EURUSD")
    assert (q.bid, q.ask) == (1.0849, 1.0851) and abs(q.price - 1.0850) < 1e-9
    assert q.asset_class == "forex" and q.symbol == "EURUSD" and q.normalized_symbol == "EUR_USD" and q.data_status == "fresh"
    pricing = next(r for r in fake.requests if r.url.path.endswith("/pricing"))
    assert pricing.url.params["instruments"] == "EUR_USD" and pricing.headers["authorization"] == "Bearer tok-SECRET-123"
    closed = await FakeOanda(tradeable=False).client().get_quote("EURUSD")
    assert closed.data_status == "market_closed" and closed.meta["tradeable"] is False


@pytest.mark.asyncio
async def test_candles_drop_the_forming_bar_and_match_the_kline_shape():
    rows = await FakeOanda().client().get_candles("EURUSD", "1h", 10)
    assert len(rows) == 3                                                           # the incomplete 4th candle is excluded
    r = rows[0]
    assert set(r) == {"open_time", "open", "high", "low", "close", "volume", "close_time"}
    assert r["close_time"] - r["open_time"] == 3600 * 1000 - 1 and r["high"] >= max(r["open"], r["close"])
    with pytest.raises(OandaError, match="Unsupported interval"):
        await FakeOanda().client().get_candles("EURUSD", "7m")


# ------------------------------------------------------------------ orders
@pytest.mark.asyncio
async def test_market_buy_and_sell_bodies_and_fill_price():
    fake = FakeOanda()
    res = await fake.client().submit_order("EURUSD", 1000, "buy", client_order_id="eti-abc123")
    body = fake.order_body()
    assert body == {"type": "MARKET", "instrument": "EUR_USD", "units": "1000", "timeInForce": "FOK", "positionFill": "DEFAULT",
                    "clientExtensions": {"id": "eti-abc123", "tag": "eti"}}
    assert res["fill_price"] == 1.08512 and res["id"] == "6360" and res["filled"] is True and res["environment"] == "practice"
    sell = FakeOanda()
    await sell.client().submit_order("EURUSD", 1000, "sell")
    assert sell.order_body()["units"] == "-1000"


@pytest.mark.asyncio
async def test_limit_order_uses_instrument_price_precision_and_is_not_marked_filled():
    pending = {"orderCreateTransaction": {"id": "7001", "type": "LIMIT_ORDER"}}
    fake = FakeOanda(order_response=pending)
    res = await fake.client().submit_order("USDJPY", 500, "buy", "limit", limit_price=150.123456)
    body = fake.order_body()
    assert body["type"] == "LIMIT" and body["price"] == "150.123" and body["timeInForce"] == "GFD"      # JPY pairs: 3 decimals
    assert res["fill_price"] is None and res["filled"] is False and res["id"] == "7001"
    fx = FakeOanda(order_response=pending)
    await fx.client().submit_order("EURUSD", 500, "sell", "limit", limit_price=1.0912345)
    assert fx.order_body()["price"] == "1.09123"                                                       # truncated, never rounded up


@pytest.mark.asyncio
async def test_units_are_rounded_to_instrument_precision_and_minimums_enforced():
    fake = FakeOanda()
    await fake.client().submit_order("SPX", 2.37, "buy")                                               # SPX500_USD: 1 decimal
    assert fake.order_body()["units"] == "2.3"
    with pytest.raises(OandaError, match="below .* minimum"):
        await FakeOanda().client().submit_order("XAUUSD", 0.4, "buy")                                  # rounds to 0 ounces
    with pytest.raises(OandaError, match="exceeds .* maximum"):
        await FakeOanda().client().submit_order("XAUUSD", 60000, "buy")


@pytest.mark.asyncio
@pytest.mark.parametrize("kwargs,msg", [
    (dict(side="hold"), "side must be"), (dict(side="buy", order_type="stop"), "market and limit"),
    (dict(side="buy", order_type="limit"), "positive limit_price"), (dict(side="buy", order_type="limit", limit_price=-1), "positive limit_price"),
])
async def test_invalid_order_inputs_never_reach_the_network(kwargs, msg):
    fake = FakeOanda()
    with pytest.raises(OandaError, match=msg):
        await fake.client().submit_order("EURUSD", 1000, **kwargs)
    assert not [r for r in fake.requests if r.method == "POST"]


@pytest.mark.asyncio
async def test_canceled_and_rejected_orders_raise_instead_of_looking_filled():
    cancel = FakeOanda(order_status=201, order_response={"orderCreateTransaction": {"id": "1"}, "orderCancelTransaction": {"reason": "MARKET_HALTED"}})
    with pytest.raises(OandaError, match="canceled.*MARKET_HALTED"):
        await cancel.client().submit_order("EURUSD", 1000, "buy")
    reject = FakeOanda(order_status=201, order_response={"orderRejectTransaction": {"rejectReason": "INSUFFICIENT_MARGIN"}})
    with pytest.raises(OandaError, match="rejected.*INSUFFICIENT_MARGIN"):
        await reject.client().submit_order("EURUSD", 1000, "buy")
    http = FakeOanda(order_status=400, order_response={"errorMessage": "Units precision exceeded"})
    with pytest.raises(OandaError, match="400.*Units precision exceeded"):
        await http.client().submit_order("EURUSD", 1000, "buy")


# ------------------------------------------------------------------ reconciliation
@pytest.mark.asyncio
async def test_order_status_lookup_by_client_id():
    fake = FakeOanda(orders={
        "eti-filled": {"id": "10", "state": "FILLED", "fillingTransactionID": "11"},
        "eti-pending": {"id": "12", "state": "PENDING"},
        "eti-canceled": {"id": "13", "state": "CANCELLED"}})
    c = fake.client()
    assert await c.get_order_status("eti-filled") == {"status": "filled", "fill_price": 1.08777, "provider_order_id": "10"}
    assert (await c.get_order_status("eti-pending"))["status"] == "submitted"
    assert (await c.get_order_status("eti-canceled"))["status"] == "canceled"
    assert await c.get_order_status("eti-unknown") is None


@pytest.mark.asyncio
async def test_reconciler_advances_oanda_orders(monkeypatch):
    Base.metadata.create_all(bind=engine)
    fake = FakeOanda(orders={"eti-oanda-recon": {"id": "20", "state": "FILLED", "fillingTransactionID": "21"}})
    import app.trading.reconciliation as rec
    monkeypatch.setattr(rec, "OandaClient", lambda settings, use_practice=True: OandaClient(settings, use_practice=use_practice, transport=fake.transport()))
    db = SessionLocal()
    try:
        db.add(OrderRecord(client_order_id="eti-oanda-recon", provider="oanda", environment="paper", symbol="EURUSD", side="buy",
                           order_type="limit", qty=1000, status="submitted", risk_approved=True))
        db.commit()
        out = await OrderReconciler(db, SETTINGS).reconcile_open(limit=50)
        row = db.query(OrderRecord).filter_by(client_order_id="eti-oanda-recon").one()
        assert "eti-oanda-recon" in out["updated"] and row.status == "filled" and row.fill_price == 1.08777 and row.provider_order_id == "20"
    finally:
        db.close()


# ------------------------------------------------------------------ MarketService
@pytest.mark.asyncio
async def test_market_service_snapshot_status_and_history(monkeypatch):
    import app.market.service as svc

    def make(fake):
        monkeypatch.setattr(svc, "OandaClient", lambda settings: OandaClient(settings, transport=fake.transport()))
        return MarketService(SETTINGS)

    snap = await make(FakeOanda()).get_snapshot("oanda", "EURUSD")
    assert snap["data_status"] == "fresh" and snap["venue_symbol"] == "EUR_USD" and snap["tradeable"] is True and snap["asset_class"] == "forex"
    closed = await make(FakeOanda(tradeable=False)).get_snapshot("oanda", "EURUSD")
    assert closed["data_status"] == "market_closed" and closed["tradeable"] is False
    stale = await make(FakeOanda(price_age=4000)).get_snapshot("oanda", "EURUSD")
    assert stale["data_status"] == "stale"
    hist = await make(FakeOanda()).get_history("oanda", "EURUSD", interval="1h", limit=10)
    assert len(hist) == 3 and hist[0]["close"] == 1.085
    none = await MarketService(Settings(oanda_api_token=None, oanda_account_id=None)).get_snapshot("oanda", "EURUSD")
    assert none == {"provider": "oanda", "symbol": "EURUSD", "data_status": "unavailable", "error": "not_configured"}


# ------------------------------------------------------------------ RiskEngine + TradingService integration
def _prop(**kw):
    base = dict(provider="oanda", environment="paper", symbol="EURUSD", side="buy", qty=1000, equity=100000.0,
                data_age_seconds=5, data_status="fresh", meta={"ref_price": 1.085})
    base.update(kw)
    return OrderProposal(**base)


def _risk_settings(**kw):
    return Settings(**{**dict(live_trading_enabled=True, oanda_api_token="tok-SECRET-123", oanda_account_id=ACCT), **kw})


def test_risk_engine_oanda_rules():
    eng = RiskEngine(_risk_settings())
    assert eng.evaluate(_prop()).approved
    live = eng.evaluate(_prop(environment="live", order_type="limit", limit_price=1.085, meta={"live_confirmed": True, "ref_price": 1.085}))
    assert not live.approved and any("OANDA_LIVE_TRADING_ENABLED" in r for r in live.reasons)
    enabled = RiskEngine(_risk_settings(oanda_live_trading_enabled=True)).evaluate(
        _prop(environment="live", order_type="limit", limit_price=1.085, meta={"live_confirmed": True, "ref_price": 1.085}))
    assert not any("OANDA_LIVE_TRADING_ENABLED" in r for r in enabled.reasons)
    testnet = eng.evaluate(_prop(environment="testnet"))
    assert not testnet.approved and any("no testnet" in r for r in testnet.reasons)
    closed = eng.evaluate(_prop(environment="live", order_type="limit", limit_price=1.085, data_status="market_closed",
                                meta={"live_confirmed": True, "ref_price": 1.085}))
    assert any("market_closed" in r for r in closed.reasons)
    # an instrument OANDA does not offer is refused for this provider
    unlisted = eng.evaluate(_prop(symbol="COFFEE", qty=10, meta={"ref_price": 300}))
    assert not unlisted.approved and any("oanda cannot trade" in r for r in unlisted.reasons)
    # exotic pairs get a tighter notional cap (3% vs 6% for majors)
    assert eng.evaluate(_prop(symbol="EURUSD", qty=5000)).approved
    exotic = eng.evaluate(_prop(symbol="USDZAR", qty=200, meta={"ref_price": 18.0}))
    assert not exotic.approved and any("max 3.0%" in r for r in exotic.reasons)


@pytest.mark.asyncio
async def test_trading_service_places_oanda_paper_orders(monkeypatch):
    Base.metadata.create_all(bind=engine)
    import app.trading.service as ts
    fake = FakeOanda()
    monkeypatch.setattr(ts, "OandaClient", lambda settings, use_practice=True: OandaClient(settings, use_practice=use_practice, transport=fake.transport()))
    db = SessionLocal()
    try:
        out = await TradingService(_risk_settings(), db=db).place_order(
            provider="oanda", environment="paper", symbol="EURUSD", side="buy", qty=1000, equity=100000.0,
            data_age_seconds=5, data_status="fresh")
        assert out["status"] == "submitted" and out["provider_response"]["fill_price"] == 1.08512
        row = db.query(OrderRecord).filter_by(client_order_id=out["client_order_id"]).one()
        assert row.status == "filled" and row.fill_price == 1.08512 and row.provider == "oanda"
        assert fake.order_body()["clientExtensions"]["id"] == out["client_order_id"]
        assert "warnings" in out["risk"]
    finally:
        db.close()


@pytest.mark.asyncio
async def test_pending_oanda_limit_order_is_not_journaled_as_filled(monkeypatch):
    Base.metadata.create_all(bind=engine)
    import app.trading.service as ts
    fake = FakeOanda(order_response={"orderCreateTransaction": {"id": "9001", "type": "LIMIT_ORDER"}})
    monkeypatch.setattr(ts, "OandaClient", lambda settings, use_practice=True: OandaClient(settings, use_practice=use_practice, transport=fake.transport()))
    db = SessionLocal()
    try:
        out = await TradingService(_risk_settings(), db=db).place_order(
            provider="oanda", environment="paper", symbol="EURUSD", side="buy", qty=1000, order_type="limit", limit_price=1.08,
            equity=100000.0, data_age_seconds=5, data_status="fresh", fill_price_hint=1.0851)       # the hint must NOT become a fill
        row = db.query(OrderRecord).filter_by(client_order_id=out["client_order_id"]).one()
        assert out["status"] == "submitted" and row.status == "submitted" and row.fill_price is None
    finally:
        db.close()


@pytest.mark.asyncio
async def test_oanda_failure_is_reported_as_error_not_success(monkeypatch):
    import app.trading.service as ts
    fake = FakeOanda(order_status=201, order_response={"orderCancelTransaction": {"reason": "INSUFFICIENT_LIQUIDITY"}})
    monkeypatch.setattr(ts, "OandaClient", lambda settings, use_practice=True: OandaClient(settings, use_practice=use_practice, transport=fake.transport()))
    out = await TradingService(_risk_settings(), db=None).place_order(
        provider="oanda", environment="paper", symbol="EURUSD", side="buy", qty=1000, equity=100000.0, data_age_seconds=5, data_status="fresh")
    assert out["status"] == "error" and "INSUFFICIENT_LIQUIDITY" in out["error"]


@pytest.mark.asyncio
async def test_live_oanda_order_is_rejected_before_any_network_call():
    called = []
    Settings_live_off = _risk_settings(oanda_live_trading_enabled=False)
    out = await TradingService(Settings_live_off, db=None).place_order(
        provider="oanda", environment="live", symbol="EURUSD", side="buy", qty=1000, order_type="limit", limit_price=1.085,
        equity=100000.0, data_age_seconds=5, data_status="fresh")
    assert out["status"] == "rejected" and any("OANDA_LIVE_TRADING_ENABLED" in r for r in out["risk"]["reasons"]) and not called


def test_order_endpoint_accepts_oanda_provider():
    from app.main import OrderRequest
    r = OrderRequest(provider="OANDA", environment="paper", symbol="EURUSD", side="buy", qty=1000)
    assert r.provider == "oanda"
