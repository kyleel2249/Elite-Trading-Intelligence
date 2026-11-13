"""Futures paper simulation: accounting invariant, risk gates, stop/TP/liquidation, funding, API wiring."""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta
from decimal import Decimal as D

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.database import Base
from app.futures import paper
from app.futures.models import FuturesAccount, FuturesEvent, FuturesPosition

TABLES = [FuturesAccount.__table__, FuturesPosition.__table__, FuturesEvent.__table__]


class Feed:
    def __init__(self, price="100", funding=None):
        self.price, self.funding, self.fail = D(price), funding, False

    async def __call__(self, symbol):
        if self.fail:
            raise paper.FeedError("feed down")
        return paper.Quote(self.price, "test_feed", self.funding, paper._now())


@pytest.fixture()
def session_factory():
    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine, tables=TABLES)
    return sessionmaker(bind=engine, autoflush=False)


@pytest.fixture()
def db(session_factory):
    s = session_factory()
    yield s
    s.close()


def run(coro):
    return asyncio.run(coro)


def acct(db, balance="10000"):
    return paper.create_account(db, "a1", D(balance))


def open_(db, feed, **kw):
    args = dict(symbol="BTCUSDT", direction="long", capital=D(1000), leverage=10)
    args.update(kw)
    return run(paper.open_position(db, "a1", args.pop("symbol"), args.pop("direction"), args.pop("capital"),
                                   args.pop("leverage"), args.pop("stop_price", None), args.pop("take_profit_price", None),
                                   feed=feed, **args))


def invariant(db):
    a = db.get(FuturesAccount, "a1")
    db.refresh(a)
    assert D(a.wallet_balance) == D(a.starting_balance) + D(a.realized_pnl) - D(a.fees_paid) - D(a.funding_paid)
    return a


def test_funding_boundaries_are_counted_exactly():
    f = paper.funding_intervals_crossed
    assert f(datetime(2026, 1, 1, 7), datetime(2026, 1, 1, 17)) == 2       # 08:00 and 16:00
    assert f(datetime(2026, 1, 1, 8), datetime(2026, 1, 1, 15, 59)) == 0
    assert f(datetime(2026, 1, 1, 23), datetime(2026, 1, 2, 0, 1)) == 1
    assert f(datetime(2026, 1, 2), datetime(2026, 1, 1)) == 0


def test_open_long_books_fee_margin_and_estimated_liquidation(db):
    acct(db)
    r = open_(db, Feed("100"))
    p = r["position"]
    assert p["simulated"] and p["status"] == "open" and p["price_source"] == "test_feed"
    assert D(p["entry_price"]) == D("100.05")                       # mark + 5 bps
    notional, margin = D(p["notional"]), D(p["margin"])
    assert abs(notional - 10000) < D("0.05") and abs(margin - 1000) < D("0.005")
    assert D(p["liquidation_price_estimate"]) < D(p["entry_price"])
    assert r["liquidation"]["authoritative"] is False
    a = invariant(db)
    assert D(a.fees_paid) == D(p["entry_fee"]) and abs(D(a.fees_paid) - 5) < D("0.01")
    s = paper.account_summary(db, a, {"BTCUSDT": D(100)})
    assert D(s["margin_in_use"]) == margin and D(s["available_balance"]) == D(a.wallet_balance) - margin


def test_round_trip_profit_and_invariant(db):
    acct(db)
    open_(db, Feed("100"))
    out = run(paper.close_position(db, "a1", "BTCUSDT", feed=Feed("110")))
    assert out["status"] == "closed" and D(out["gross_pnl"]) > 900 and D(out["net_pnl"]) < D(out["gross_pnl"])
    a = invariant(db)
    assert D(a.wallet_balance) > 10000 and not paper._open_positions(db, "a1")


def test_short_profits_when_price_falls(db):
    acct(db)
    open_(db, Feed("100"), direction="short")
    out = run(paper.close_position(db, "a1", "BTCUSDT", feed=Feed("90")))
    assert D(out["gross_pnl"]) > 900
    invariant(db)


def test_high_leverage_requires_a_stop(db):
    acct(db)
    with pytest.raises(paper.PaperError) as e:
        open_(db, Feed("100"), leverage=25)
    assert e.value.status == 422 and "stop_price" in e.value.message
    assert paper._open_positions(db, "a1") == []


def test_150x_is_allowed_with_a_valid_stop_and_warns(db):
    acct(db)
    r = open_(db, Feed("100"), capital=D(100), leverage=150, stop_price=D("99.95"))
    assert r["position"]["leverage"] == 150
    assert any(w["code"] == "extreme_leverage" for w in r["risk"]["warnings"])
    invariant(db)


def test_stop_beyond_liquidation_and_wrong_side_are_rejected_with_violations(db):
    acct(db)
    with pytest.raises(paper.PaperError) as e:
        open_(db, Feed("100"), capital=D(100), leverage=150, stop_price=D("90"))
    assert {v["code"] for v in e.value.violations} & {"stop_beyond_liquidation"}
    with pytest.raises(paper.PaperError) as e:
        open_(db, Feed("100"), stop_price=D("120"))
    assert any(v["code"] == "stop_wrong_side" for v in e.value.violations)
    assert paper._open_positions(db, "a1") == []


def test_insufficient_balance_is_rejected(db):
    acct(db, "500")
    with pytest.raises(paper.PaperError) as e:
        open_(db, Feed("100"), capital=D(1000), leverage=1)
    assert e.value.status == 422
    assert D(db.get(FuturesAccount, "a1").wallet_balance) == 500


def test_one_open_position_per_symbol_and_kill_switch(db):
    acct(db)
    open_(db, Feed("100"))
    with pytest.raises(paper.PaperError) as e:
        open_(db, Feed("100"))
    assert e.value.status == 409
    with pytest.raises(paper.PaperError) as e:
        open_(db, Feed("100"), symbol="ETHUSDT", kill_switch=True)
    assert e.value.status == 409 and "Kill switch" in e.value.message


def test_feed_failure_refuses_to_open_and_does_not_guess_a_price(db):
    acct(db)
    f = Feed("100")
    f.fail = True
    with pytest.raises(paper.FeedError):
        open_(db, f)
    assert paper._open_positions(db, "a1") == [] and D(db.get(FuturesAccount, "a1").wallet_balance) == 10000


def test_take_profit_and_stop_trigger_on_mark(db):
    acct(db)
    open_(db, Feed("100"), stop_price=D("95"), take_profit_price=D("110"))
    out = run(paper.mark_account(db, "a1", feed=Feed("105")))
    assert out["actions"] == [] and out["checked"] == 1
    out = run(paper.mark_account(db, "a1", feed=Feed("111")))
    assert out["actions"][0]["action"] == "take_profit"
    invariant(db)
    open_(db, Feed("100"), stop_price=D("95"))
    out = run(paper.mark_account(db, "a1", feed=Feed("94")))
    assert out["actions"][0]["action"] == "stop_loss" and D(out["actions"][0]["net_pnl"]) < 0
    invariant(db)


def test_liquidation_loses_exactly_the_margin_and_wallet_never_goes_negative(db):
    acct(db)
    r = open_(db, Feed("100"))
    margin = D(r["position"]["margin"])
    out = run(paper.mark_account(db, "a1", feed=Feed("1")))     # a crash far beyond liquidation
    act = out["actions"][0]
    assert act["status"] == "liquidated" and D(act["gross_pnl"]) == -margin
    a = invariant(db)
    assert D(a.wallet_balance) == 10000 - margin - D(r["position"]["entry_fee"]) and D(a.wallet_balance) > 0


def test_short_liquidates_when_price_spikes(db):
    acct(db)
    open_(db, Feed("100"), direction="short")
    out = run(paper.mark_account(db, "a1", feed=Feed("500")))
    assert out["actions"][0]["status"] == "liquidated"
    invariant(db)


def test_mark_skips_positions_when_the_feed_is_down(db):
    acct(db)
    open_(db, Feed("100"), stop_price=D("95"))
    f = Feed("1")
    f.fail = True
    out = run(paper.mark_account(db, "a1", feed=f))
    assert out["checked"] == 0 and out["actions"] == [] and out["errors"][0]["error"] == "feed down"
    assert len(paper._open_positions(db, "a1")) == 1


def test_funding_is_charged_once_per_boundary_and_keeps_the_invariant(db):
    acct(db)
    open_(db, Feed("100"))
    pos = paper._open_positions(db, "a1")[0]
    pos.last_funding_at = paper._now() - timedelta(hours=17)
    db.commit()
    n = paper.funding_intervals_crossed(pos.last_funding_at, paper._now())
    assert n in (2, 3)
    out = run(paper.mark_account(db, "a1", feed=Feed("100", funding=D("0.0001"))))
    charge = D(out["actions"][0]["charge"])
    assert out["actions"][0]["intervals"] == n and charge == pytest.approx(D(pos.qty) * 100 * D("0.0001") * n, abs=D("1e-6"))
    a = invariant(db)
    assert D(a.funding_paid) == charge
    again = run(paper.mark_account(db, "a1", feed=Feed("100", funding=D("0.0001"))))
    assert again["actions"] == []                         # idempotent: nothing new to charge


def test_short_receives_funding_when_the_rate_is_positive(db):
    acct(db)
    open_(db, Feed("100"), direction="short")
    pos = paper._open_positions(db, "a1")[0]
    pos.last_funding_at = paper._now() - timedelta(hours=9)
    db.commit()
    out = run(paper.mark_account(db, "a1", feed=Feed("100", funding=D("0.0001"))))
    assert D(out["actions"][0]["charge"]) < 0
    invariant(db)


def test_missing_funding_rate_does_not_advance_the_clock(db):
    acct(db)
    open_(db, Feed("100"))
    pos = paper._open_positions(db, "a1")[0]
    old = paper._now() - timedelta(hours=17)
    pos.last_funding_at = old
    db.commit()
    out = run(paper.mark_account(db, "a1", feed=Feed("100", funding=None)))
    assert out["errors"] and db.get(FuturesPosition, pos.id).last_funding_at == old


def test_account_validation_and_duplicates(db):
    with pytest.raises(paper.PaperError):
        paper.create_account(db, "bad id!", D(100))
    with pytest.raises(paper.PaperError):
        paper.create_account(db, "a1", D(0))
    acct(db)
    with pytest.raises(paper.PaperError) as e:
        acct(db)
    assert e.value.status == 409


def test_one_open_position_is_enforced_by_the_database_too(db):
    acct(db)
    open_(db, Feed("100"))
    from sqlalchemy.exc import IntegrityError
    clone = db.scalar(__import__("sqlalchemy").select(FuturesPosition))
    dup = FuturesPosition(**{c.name: getattr(clone, c.name) for c in FuturesPosition.__table__.columns if c.name != "id"})
    db.add(dup)
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()


# ---------------------------------------------------------------------------------------------- feed + API

def test_binance_feed_parses_mark_and_funding_and_reports_location_blocks():
    import httpx

    def ok(req):
        assert req.url.path == "/fapi/v1/premiumIndex" and req.url.params["symbol"] == "BTCUSDT"
        return httpx.Response(200, json={"symbol": "BTCUSDT", "markPrice": "65000.12", "lastFundingRate": "0.00010000"})
    q = run(paper.binance_perp_feed("BTCUSDT", transport=httpx.MockTransport(ok)))
    assert q.price == D("65000.12") and q.funding_rate == D("0.0001") and q.source == "binance_usdm_mark_price"
    with pytest.raises(paper.FeedError) as e:
        run(paper.binance_perp_feed("BTCUSDT", transport=httpx.MockTransport(lambda r: httpx.Response(451))))
    assert "location" in e.value.message
    with pytest.raises(paper.FeedError) as e:
        run(paper.binance_perp_feed("NOPE", transport=httpx.MockTransport(lambda r: httpx.Response(400))))
    assert e.value.status == 404
    with pytest.raises(paper.FeedError):
        run(paper.binance_perp_feed("BTCUSDT", transport=httpx.MockTransport(lambda r: httpx.Response(200, json={"markPrice": "0"}))))


@pytest.fixture()
def client(session_factory):
    from fastapi.testclient import TestClient
    from app.database import get_db
    from app.main import app

    def override():
        s = session_factory()
        try:
            yield s
        finally:
            s.close()
    app.dependency_overrides[get_db] = override
    paper.set_feed(Feed("100"))
    yield TestClient(app)
    app.dependency_overrides.pop(get_db, None)
    paper.set_feed(None)


def test_api_flow_create_order_mark_close(client):
    assert "/api/futures-paper/accounts" in client.get("/openapi.json").json()["paths"]
    r = client.post("/api/futures-paper/accounts", json={"account_id": "demo", "starting_balance": "5000"})
    assert r.status_code == 201 and r.json()["simulated"] is True
    assert client.post("/api/futures-paper/accounts", json={"account_id": "demo", "starting_balance": "5000"}).status_code == 409
    o = client.post("/api/futures-paper/accounts/demo/orders",
                    json={"symbol": "btcusdt", "direction": "long", "capital_usdt": "500", "leverage": 5})
    assert o.status_code == 200 and o.json()["position"]["symbol"] == "BTCUSDT"
    s = client.get("/api/futures-paper/accounts/demo").json()
    assert len(s["open_positions"]) == 1 and s["unrealized_pnl"] is not None
    assert client.post("/api/futures-paper/accounts/demo/mark").json()["checked"] == 1
    c = client.post("/api/futures-paper/accounts/demo/positions/BTCUSDT/close")
    assert c.status_code == 200 and c.json()["status"] == "closed"
    assert len(client.get("/api/futures-paper/accounts/demo/positions", params={"status": "closed"}).json()) == 1
    assert [e["event"] for e in client.get("/api/futures-paper/accounts/demo/events").json()][-1] == "account_created"


def test_api_rejects_bad_orders_and_client_cannot_supply_a_price(client):
    client.post("/api/futures-paper/accounts", json={"account_id": "demo", "starting_balance": "5000"})
    base = {"symbol": "BTCUSDT", "direction": "long", "capital_usdt": "500", "leverage": 5}
    assert client.post("/api/futures-paper/accounts/demo/orders", json={**base, "price": "1"}).status_code == 422
    assert client.post("/api/futures-paper/accounts/demo/orders", json={**base, "leverage": 151}).status_code == 422
    r = client.post("/api/futures-paper/accounts/demo/orders", json={**base, "leverage": 50})
    assert r.status_code == 422 and "stop_price" in r.json()["detail"]
    r = client.post("/api/futures-paper/accounts/demo/orders", json={**base, "stop_price": "150"})
    assert r.status_code == 422 and r.json()["detail"]["violations"]
    assert client.post("/api/futures-paper/accounts/nope/orders", json=base).status_code == 404


def test_api_feed_outage_is_502_not_a_guess(client):
    f = Feed("100")
    f.fail = True
    paper.set_feed(f)
    client.post("/api/futures-paper/accounts", json={"account_id": "demo", "starting_balance": "5000"})
    r = client.post("/api/futures-paper/accounts/demo/orders",
                    json={"symbol": "BTCUSDT", "direction": "long", "capital_usdt": "500", "leverage": 5})
    assert r.status_code == 502
