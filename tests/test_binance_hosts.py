"""Binance public-host failover: availability only, never Binance.US, honest about location blocks."""
from __future__ import annotations

import asyncio

import httpx
import pytest

from app.market import binance_hosts as bh


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    monkeypatch.delenv("ETI_BINANCE_PUBLIC_HOSTS", raising=False)
    bh.reset()
    yield
    bh.reset()


def make(plan):
    """plan: host -> status code, or "connect" to simulate a network failure. Unlisted hosts answer 200."""
    calls: list[str] = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req.url.host)
        v = plan.get(req.url.host, 200)
        if v == "connect":
            raise httpx.ConnectError("down", request=req)
        return httpx.Response(v, json={"ok": True})

    return httpx.MockTransport(handler), calls


def run(coro):
    return asyncio.run(coro)


def test_default_hosts_are_global_binance_only():
    hs = bh.hosts()
    assert hs[0] == "https://api.binance.com" and len(hs) >= 5
    assert all(h.startswith("https://") and "binance.us" not in h for h in hs)


def test_first_host_is_used_when_it_works():
    t, calls = make({})
    data, host = run(bh.get_json("/api/v3/ping", transport=t))
    assert data == {"ok": True} and host == "https://api.binance.com" and calls == ["api.binance.com"]


def test_fails_over_on_451_5xx_and_network_errors_then_remembers_the_good_host():
    t, calls = make({"api.binance.com": 451, "api-gcp.binance.com": 503, "api1.binance.com": "connect"})
    _, host = run(bh.get_json("/api/v3/ping", transport=t))
    assert host == "https://api2.binance.com" and calls == ["api.binance.com", "api-gcp.binance.com", "api1.binance.com", "api2.binance.com"]
    assert bh.last_good() == "https://api2.binance.com"
    calls.clear()
    run(bh.get_json("/api/v3/ping", transport=t))
    assert calls == ["api2.binance.com"]            # last good host is tried first
    st = bh.status()
    assert st["last_good"] == "https://api2.binance.com" and "binance.us" in st["excluded"]


@pytest.mark.parametrize("code", [400, 404])
def test_bad_request_is_not_retried_on_other_hosts(code):
    t, calls = make({"api.binance.com": code})
    with pytest.raises(bh.BinanceBadRequest) as exc:
        run(bh.get_json("/api/v3/klines", transport=t))
    assert exc.value.status == code and calls == ["api.binance.com"]


def test_all_hosts_451_reports_a_location_block_and_does_not_pretend():
    plan = {h.replace("https://", ""): 451 for h in bh.hosts()}
    t, calls = make(plan)
    with pytest.raises(bh.BinanceUnavailable) as exc:
        run(bh.get_json("/api/v3/ping", transport=t))
    assert len(calls) == len(bh.hosts())
    assert "location" in exc.value.public_message and "Run ETI in a region" in exc.value.public_message
    assert bh.last_good() is None


def test_all_hosts_down_reports_unreachable_not_a_location_block():
    plan = {h.replace("https://", ""): "connect" for h in bh.hosts()}
    t, _ = make(plan)
    with pytest.raises(bh.BinanceUnavailable) as exc:
        run(bh.get_json("/api/v3/ping", transport=t))
    assert "unreachable" in exc.value.public_message and "location" not in exc.value.public_message


def test_invalid_json_counts_as_a_host_failure():
    calls = []

    def handler(req):
        calls.append(req.url.host)
        if req.url.host == "api.binance.com":
            return httpx.Response(200, content=b"<html>not json</html>")
        return httpx.Response(200, json=[1])
    _, host = run(bh.get_json("/x", transport=httpx.MockTransport(handler)))
    assert host == "https://api-gcp.binance.com" and calls == ["api.binance.com", "api-gcp.binance.com"]


def test_env_override_drops_insecure_and_binance_us_hosts(monkeypatch):
    monkeypatch.setenv("ETI_BINANCE_PUBLIC_HOSTS",
                       "http://insecure.example, https://api.binance.us, https://www.binance.us, https://good.example.com/path")
    assert bh.hosts() == ["https://good.example.com"]
    monkeypatch.setenv("ETI_BINANCE_PUBLIC_HOSTS", "http://only-insecure.example,https://api.binance.us")
    assert bh.hosts() == list(bh.DEFAULT_HOSTS)      # nothing valid left: fall back to the defaults
