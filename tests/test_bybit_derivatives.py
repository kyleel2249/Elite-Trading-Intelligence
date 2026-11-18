import httpx
import pytest

from app.integrations.bybit.client import BybitClient


def mock_async_client(handler):
    original = httpx.AsyncClient

    class MockClient:
        def __init__(self, *args, **kwargs):
            self.client = original(transport=httpx.MockTransport(handler))

        async def __aenter__(self):
            return self.client

        async def __aexit__(self, *args):
            await self.client.aclose()

    return original, MockClient


@pytest.mark.asyncio
async def test_funding_history_is_requested_for_linear_contract_and_normalized(monkeypatch):
    seen = {}

    def handler(request):
        seen.update(dict(request.url.params))
        return httpx.Response(200, json={"retCode": 0, "result": {"list": [
            {"symbol": "BTCUSDT", "fundingRate": "0.0001", "fundingRateTimestamp": "1700000000000"}
        ]}})

    original, mock = mock_async_client(handler)
    monkeypatch.setattr(httpx, "AsyncClient", mock)
    result = await BybitClient(category="linear").get_funding_rate("btcusdt")
    assert seen["category"] == "linear"
    assert seen["symbol"] == "BTCUSDT"
    assert result["funding_rate"] == 0.0001
    assert result["funding_time"] == 1700000000000


@pytest.mark.asyncio
async def test_open_interest_is_chronological_and_uses_derivative_category(monkeypatch):
    seen = {}

    def handler(request):
        seen.update(dict(request.url.params))
        return httpx.Response(200, json={"retCode": 0, "result": {"list": [
            {"timestamp": "2000", "openInterest": "12.5"},
            {"timestamp": "1000", "openInterest": "10"},
        ]}})

    original, mock = mock_async_client(handler)
    monkeypatch.setattr(httpx, "AsyncClient", mock)
    rows = await BybitClient(category="inverse").get_open_interest("BTCUSD", "1h", 2)
    assert seen["category"] == "inverse"
    assert seen["intervalTime"] == "1h"
    assert [row["timestamp"] for row in rows] == [1000, 2000]
    assert rows[0]["open_interest"] == 10.0


@pytest.mark.asyncio
async def test_spot_rejects_derivatives_only_context():
    client = BybitClient(category="spot")
    with pytest.raises(ValueError, match="Funding rates"):
        await client.get_funding_rate("BTCUSDT")
    with pytest.raises(ValueError, match="Open interest"):
        await client.get_open_interest("BTCUSDT")


@pytest.mark.asyncio
async def test_derivatives_context_rejects_unsupported_intervals():
    client = BybitClient(category="linear")
    with pytest.raises(ValueError, match="interval"):
        await client.get_open_interest("BTCUSDT", "2h")
