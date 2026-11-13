"""Offline execution lifecycle and routing regressions; no real credentials."""
import math
from unittest.mock import AsyncMock, patch
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from app.config import Settings
from app.database import Base
from app.models import Position, OrderRecord
from app.risk.engine import RiskEngine, OrderProposal
from app.trading.service import TradingService
from app.trading.portfolio import PortfolioService
from app.trading.reconciliation import OrderReconciler
from app.trading.executions import normalize_execution

@pytest.fixture
def db():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session
    engine.dispose()

def settings(**kw):
    args = dict(_env_file=None, alpaca_api_key=None, alpaca_secret_key=None,
                binance_api_key=None, binance_secret_key=None, live_trading_enabled=False)
    args.update(kw)
    return Settings(**args)

def proposal(**kw):
    args = dict(provider="binance", environment="paper", symbol="TEST", side="buy",
                qty=1, equity=10000, reference_price=100)
    args.update(kw)
    return OrderProposal(**args)

def event(db, cid="one", **kw):
    args = dict(client_order_id=cid, provider="binance", environment="paper", symbol="TEST",
                side="buy", qty=1, status="filled", fill_price=100, risk_approved=True)
    args.update(kw)
    return PortfolioService(db).record_order_event(**args)

@pytest.mark.parametrize("changes", [dict(qty=float("nan")), dict(qty=float("inf")),
    dict(equity=float("nan")), dict(reference_price=None), dict(reference_price=0),
    dict(qty=1e12), dict(estimated_risk_amount=-1), dict(estimated_risk_amount=float("nan")),
    dict(environment="mainnet"), dict(provider="unknown")])
def test_invalid_or_unbounded_risk_fails_closed(changes):
    assert not RiskEngine(settings()).evaluate(proposal(**changes)).approved

def test_estimate_cannot_understate_notional():
    assert not RiskEngine(settings()).evaluate(proposal(qty=2, estimated_risk_amount=0)).approved

@pytest.mark.asyncio
@pytest.mark.parametrize("env,paper,url", [
    ("testnet", False, "https://api.alpaca.markets"),
    ("paper", True, "https://api.alpaca.markets"),
    ("paper", True, "http://paper-api.alpaca.markets"),
    ("paper", False, "https://paper-api.alpaca.markets"),
])
async def test_alpaca_routing_cannot_bypass_live_gate(env, paper, url):
    svc = TradingService(settings(alpaca_paper=paper, alpaca_base_url=url))
    svc.alpaca.submit_order = AsyncMock()
    result = await svc.place_order(provider="alpaca", environment=env, symbol="AAPL", side="buy",
                                   qty=1, equity=10000, reference_price=100)
    assert result["status"] == "rejected"
    svc.alpaca.submit_order.assert_not_awaited()

@pytest.mark.asyncio
async def test_broker_new_order_not_filled_from_hint(db):
    svc = TradingService(settings(), db)
    svc._paper_resolution = lambda *a, **k: None   # exercise the exchange path, not the internal paper engine
    svc.alpaca.submit_order = AsyncMock(return_value={"id":"mock", "status":"new", "filled_qty":"0"})
    result = await svc.place_order(provider="alpaca", environment="paper", symbol="AAPL", side="buy",
        qty=1, equity=10000, order_type="limit", limit_price=90, fill_price_hint=100)
    assert result["status"] == "submitted"
    assert db.query(Position).count() == 0
    assert db.query(OrderRecord).one().status == "submitted"

@pytest.mark.asyncio
async def test_simulated_limit_requires_crossing(db):
    svc = TradingService(settings(), db)
    svc._paper_resolution = lambda *a, **k: None   # exercise the exchange path, not the internal paper engine
    result = await svc.place_order(provider="binance", environment="paper", symbol="TEST", side="buy",
        qty=1, equity=10000, order_type="limit", limit_price=90, fill_price_hint=100)
    assert result["status"] == "submitted"
    assert db.query(Position).count() == 0


def test_duplicate_execution_books_once(db):
    event(db); event(db)
    assert db.query(Position).one().qty == 1


def test_submitted_hint_never_books_a_fill(db):
    event(db, status="submitted")
    assert db.query(Position).count() == 0


def test_cumulative_execution_delta_prices_and_cancel(db):
    event(db, qty=10, status="partial", filled_qty=3, fill_price=100)
    event(db, qty=10, status="partial", filled_qty=3, fill_price=100)
    event(db, qty=10, status="canceled", filled_qty=5, fill_price=104)
    pos = db.query(Position).one()
    assert pos.qty == 5
    assert pos.avg_entry == pytest.approx(104)
    assert db.query(OrderRecord).one().status == "canceled"


def test_partial_close_immediately_revalues_equity(db):
    event(db)
    PortfolioService(db).mark_positions({("binance", "paper", "TEST"):120})
    event(db, cid="sell", side="sell", qty=.5, fill_price=120)
    assert PortfolioService(db).portfolio_summary()["net_pnl"] == pytest.approx(20)


def test_flip_and_close_zero_stale_unrealized(db):
    event(db)
    PortfolioService(db).mark_positions({("binance", "paper", "TEST"):120})
    event(db, cid="flip", side="sell", qty=2, fill_price=120)
    pos = db.query(Position).one()
    assert (pos.side, pos.qty, pos.unrealized_pnl) == ("short", 1, 0)
    event(db, cid="close", side="buy", qty=1, fill_price=110)
    assert pos.unrealized_pnl == 0
    assert PortfolioService(db).portfolio_summary()["net_pnl"] == pytest.approx(30)


def test_client_id_cannot_mutate_order_identity(db):
    event(db)
    with pytest.raises(ValueError, match="different order"):
        event(db, qty=2)


def test_binance_market_uses_quote_total_not_limit_price_zero():
    result = normalize_execution("binance", {"status":"FILLED", "price":"0", "executedQty":"1",
        "cummulativeQuoteQty":"100", "orderId":123})
    assert result["filled_qty"] == 1
    assert result["fill_price"] == 100

@pytest.mark.parametrize("payload", [
    {"status":"FILLED", "price":"0", "executedQty":"1"},
    {"status":"FILLED", "executedQty":"0"},
    {"status":"FILLED"},
    {"status":"PARTIALLY_FILLED", "executedQty":"nan"},
])
def test_invalid_execution_data_fails_closed(payload):
    with pytest.raises(ValueError):
        normalize_execution("binance", payload)

@pytest.mark.asyncio
async def test_reconcile_partial_same_status_then_cancel(db):
    event(db, qty=10, status="submitted", fill_price=None)
    rec = OrderReconciler(db, settings())
    rec._fetch_status = AsyncMock(side_effect=[
        dict(status="partial", filled_qty=3, fill_price=100),
        dict(status="partial", filled_qty=5, fill_price=100),
        dict(status="canceled", filled_qty=5, fill_price=100)])
    for _ in range(3):
        assert not (await rec.reconcile_open())["errors"]
    assert db.query(Position).one().qty == 5
    assert db.query(OrderRecord).one().status == "canceled"

@pytest.mark.asyncio
async def test_invalid_final_execution_remains_retryable(db):
    event(db, status="submitted", fill_price=None)
    rec = OrderReconciler(db, settings())
    rec._fetch_status = AsyncMock(return_value=dict(status="filled", filled_qty=1, fill_price=None))
    assert (await rec.reconcile_open())["errors"]
    assert db.query(OrderRecord).one().status == "submitted"
    assert db.query(Position).count() == 0

@pytest.mark.asyncio
async def test_binance_limit_payload_has_price_and_time_in_force():
    from app.integrations.binance import BinanceClient
    from unittest.mock import Mock
    client = BinanceClient(settings(binance_api_key="fake", binance_secret_key="fake"))
    http = AsyncMock()
    http.__aenter__.return_value = http
    http.post.return_value = Mock(status_code=200, json=lambda: {"orderId":1})
    with patch("httpx.AsyncClient", return_value=http):
        await client.submit_order("BTCUSDT", "buy", 0.000000001, "LIMIT", limit_price=90)
    params = http.post.call_args.kwargs["params"]
    assert params["price"] == "90"
    assert params["timeInForce"] == "GTC"
    assert params["quantity"] == "0.000000001"

@pytest.mark.asyncio
async def test_ambiguous_submission_retains_reconcilable_intent(db):
    svc = TradingService(settings(), db)
    svc._paper_resolution = lambda *a, **k: None   # exercise the exchange path, not the internal paper engine
    svc.alpaca.submit_order = AsyncMock(side_effect=TimeoutError("mock timeout"))
    result = await svc.place_order(provider="alpaca", environment="paper", symbol="AAPL", side="buy",
                                   qty=1, equity=10000, reference_price=100)
    assert result["status"] == "submission_unknown"
    row = db.query(OrderRecord).one()
    assert row.client_order_id == result["client_order_id"]
    assert row.status == "pending"
    assert db.query(Position).count() == 0


def test_pending_order_reserves_position_slot(db):
    from app.trading.risk_context import build_risk_context
    event(db, status="pending", fill_price=None)
    ctx = build_risk_context(db, settings(), environment="paper", snapshot=None)
    assert ctx.current_open_positions == 1

@pytest.mark.asyncio
@pytest.mark.parametrize("stamp", [None, "bad-timestamp", "2026-01-01T00:00:00"])
async def test_alpaca_unknown_timestamp_is_not_fresh(stamp):
    from app.integrations.alpaca import AlpacaClient
    from unittest.mock import Mock
    http = AsyncMock()
    http.__aenter__.return_value = http
    http.get.return_value = Mock(status_code=200, json=lambda: {"trade":{"p":100,"t":stamp}})
    client = AlpacaClient(settings(alpaca_api_key="fake", alpaca_secret_key="fake"))
    with patch("httpx.AsyncClient", return_value=http):
        quote = await client.get_quote("AAPL")
    assert quote.data_status == "invalid"
    assert quote.ts_provider is None
