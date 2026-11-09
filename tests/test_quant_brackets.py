import pytest

from app.config import Settings
from app.quant.controls import TradingControls
from app.quant.execution import ExecutionEngine, ExecutionSignal, PortfolioContext


class Sub:
    def __init__(self, resp):
        self.resp, self.calls = resp, []

    async def __call__(self, **kw):
        self.calls.append(kw)
        return self.resp


def sig():
    return ExecutionSignal(signal_id="b1", provider="alpaca", environment="paper", symbol="AAPL", side="buy",
                           quantity=10.0, entry_price=100.0, stop_price=98.0, take_profits=[104.0, 108.0],
                           mispricing_confirmed=True, data_age_seconds=5, data_status="fresh")


@pytest.mark.asyncio
async def test_stop_and_first_take_profit_are_forwarded_to_the_trading_service():
    sub = Sub({"status": "submitted", "client_order_id": "c", "provider_response": {"id": "x"}})
    e = ExecutionEngine(Settings(), sub, controls=TradingControls())
    await e.execute(sig(), PortfolioContext(equity=100_000.0))
    assert sub.calls[0]["stop_loss"] == 98.0 and sub.calls[0]["take_profit"] == 104.0


@pytest.mark.asyncio
async def test_protective_status_defaults_to_not_attached_and_only_changes_when_service_reports_it():
    plain = Sub({"status": "submitted", "client_order_id": "c1", "provider_response": {"id": "x"}})
    e = ExecutionEngine(Settings(), plain, controls=TradingControls())
    rec = await e.execute(sig(), PortfolioContext(equity=100_000.0))
    assert rec.protective_orders["status"] == "not_attached"

    ok = Sub({"status": "submitted", "client_order_id": "c2", "provider_response": {"id": "x"},
              "protective_orders": {"status": "attached", "method": "alpaca_bracket"}})
    e2 = ExecutionEngine(Settings(), ok, controls=TradingControls())
    s2 = sig()
    s2.signal_id = "b2"
    rec2 = await e2.execute(s2, PortfolioContext(equity=100_000.0))
    assert rec2.protective_orders == {"status": "attached", "method": "alpaca_bracket"}


# ---- Alpaca payload construction (pure, no network) ----
def test_alpaca_bracket_body_has_both_legs():
    from app.integrations.alpaca.client import build_order_body
    b = build_order_body("aapl", 10, "buy", "limit", limit_price=100.0, stop_loss=98.0, take_profit=104.0)
    assert b["order_class"] == "bracket" and b["qty"] == "10" and b["symbol"] == "AAPL"
    assert b["take_profit"] == {"limit_price": "104.0"} and b["stop_loss"] == {"stop_price": "98.0"}


def test_alpaca_single_exit_uses_oto_and_no_exit_is_plain():
    from app.integrations.alpaca.client import build_order_body
    assert build_order_body("AAPL", 5, "buy", stop_loss=98.0)["order_class"] == "oto"
    plain = build_order_body("AAPL", 5, "buy")
    assert "order_class" not in plain and "stop_loss" not in plain


def test_alpaca_fractional_bracket_is_refused_not_silently_unprotected():
    from app.integrations.alpaca.client import build_order_body
    with pytest.raises(ValueError):
        build_order_body("AAPL", 2.5, "buy", stop_loss=98.0, take_profit=104.0)


def test_protective_status_requires_legs_in_the_provider_response():
    from app.integrations.alpaca.client import protective_status
    assert protective_status({}, None, None)["status"] == "not_requested"
    assert protective_status({"id": "1"}, 98.0, 104.0)["status"] == "requested_unconfirmed"
    ok = protective_status({"order_class": "bracket", "legs": [{"id": "a", "type": "limit", "status": "held"}]}, 98.0, 104.0)
    assert ok["status"] == "attached"
