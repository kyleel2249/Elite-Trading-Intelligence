import httpx
import pytest

from app.integrations.bybit.client import BybitClient


@pytest.mark.asyncio
async def test_bybit_public_klines_map_category_and_sort_oldest_first():
    seen = {}
    def handler(request):
        seen.update(dict(request.url.params))
        return httpx.Response(200, json={"retCode": 0, "result": {"list": [
            ["2000", "2", "3", "1", "2.5", "20"],
            ["1000", "1", "2", "0.5", "1.5", "10"],
        ]}})
    client = BybitClient()
    client.base_url = "https://api.bybit.com"
    # Inject an HTTPX transport through the client constructor seam by patching AsyncClient.
    original = httpx.AsyncClient
    class MockClient:
        def __init__(self, *args, **kwargs):
            self.client = original(transport=httpx.MockTransport(handler))
        async def __aenter__(self): return self.client
        async def __aexit__(self, *args): await self.client.aclose()
    import unittest.mock
    with unittest.mock.patch("httpx.AsyncClient", MockClient):
        rows = await client.get_klines("BTCUSDT", "1m", 2, category="linear")
    assert seen["category"] == "linear"
    assert [row["open_time"] for row in rows] == [1000, 2000]
    assert rows[0]["close_time"] == 60999


@pytest.mark.asyncio
async def test_bybit_public_ticker_is_normalized():
    def handler(request):
        return httpx.Response(200, json={"retCode": 0, "result": {"list": [{
            "bid1Price": "99", "ask1Price": "101", "lastPrice": "100", "volume24h": "42"
        }]}})
    original = httpx.AsyncClient
    class MockClient:
        def __init__(self, *args, **kwargs): self.client = original(transport=httpx.MockTransport(handler))
        async def __aenter__(self): return self.client
        async def __aexit__(self, *args): await self.client.aclose()
    import unittest.mock
    with unittest.mock.patch("httpx.AsyncClient", MockClient):
        quote = await BybitClient().get_quote("BTCUSDT")
    assert quote.provider == "bybit"
    assert quote.price == 100
    assert quote.bid == 99 and quote.ask == 101
