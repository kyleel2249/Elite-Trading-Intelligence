"""Route-level tests for /api/analytics (FastAPI TestClient against the real app).

Market data and provider HTTP are replaced by fakes, so these prove routing, validation, auth, error mapping and
wiring. They are NOT evidence of live provider or exchange connectivity.
"""
import random
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest import mock

from fastapi.testclient import TestClient

from app.main import app
from app.providers.registry import ProviderSettings, Registry, get_registry

client = TestClient(app)


def candles(n, drift=0.002, vol=0.01, seed=1):
    r = random.Random(seed)
    px, out = 100.0, []
    for _ in range(n):
        o = px
        px *= 1 + drift + r.gauss(0, vol)
        out.append({"open": o, "high": max(o, px) * 1.003, "low": min(o, px) * 0.997, "close": px, "volume": 1000.0 * (1 + r.random() * 0.1)})
    return out


class FakeMarket:
    def __init__(self, settings):
        pass

    async def get_history(self, provider, symbol, interval="1h", limit=100):
        if symbol.upper().startswith("FAIL"):
            raise RuntimeError("upstream exploded")
        return candles(limit, drift=0.01 if symbol.upper().startswith("UP") else 0.0, vol=0.002 if symbol.upper().startswith("UP") else 0.01,
                       seed=abs(hash(symbol)) % 1000)


class FakeHTTP:
    """Transport double: maps a URL suffix to (status, body)."""

    def __init__(self, routes):
        self.routes, self.calls = routes, []

    async def __call__(self, method, url, params, headers, timeout):
        self.calls.append((url, dict(params), dict(headers)))
        for suffix, resp in self.routes.items():
            if url.endswith(suffix):
                return resp(params) if callable(resp) else resp
        return 404, None, {}


def registry(**kw):
    kw.setdefault("fmp_api_key", "")
    kw.setdefault("tokenomist_api_key", "")
    return Registry(ProviderSettings(_env_file=None, **kw))


class AnalyticsRoutes(unittest.TestCase):
    def tearDown(self):
        app.dependency_overrides.clear()

    def use_registry(self, reg):
        app.dependency_overrides[get_registry] = lambda: reg
        return reg

    def test_routes_registered(self):
        paths = client.get("/openapi.json").json()["paths"]
        for p in ["/api/analytics/scan", "/api/analytics/regime", "/api/analytics/unusual-volume", "/api/analytics/volatility-breakout",
                  "/api/analytics/correlation", "/api/analytics/monte-carlo", "/api/analytics/stress", "/api/analytics/scenario",
                  "/api/analytics/walk-forward", "/api/analytics/strategy-lab/compare", "/api/analytics/tax/realized-gains",
                  "/api/analytics/portfolio/multi-currency", "/api/analytics/live-vs-backtest", "/api/analytics/risk-alerts",
                  "/api/analytics/research", "/api/analytics/query", "/api/analytics/intel/providers",
                  "/api/analytics/intel/calendar/economic", "/api/analytics/intel/calendar/feed", "/api/analytics/intel/calendar/earnings",
                  "/api/analytics/intel/event-risk", "/api/analytics/intel/unlocks/{token_id}"]:
            self.assertIn(p, paths)

    def test_stress_and_validation(self):
        ok = client.post("/api/analytics/stress", json={"positions": [{"symbol": "BTC", "market_value": 1000, "asset_class": "crypto"}],
                                                       "scenarios": {"s": {"crypto": -0.5}}})
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(ok.json()["scenarios"][0]["pnl"], -500.0)
        bad = client.post("/api/analytics/stress", json={"positions": [{"symbol": "X", "market_value": 1, "asset_class": "nonsense"}]})
        self.assertEqual(bad.status_code, 422)
        self.assertEqual(client.post("/api/analytics/stress", json={"positions": []}).status_code, 422)

    def test_tax_and_scenario_probability_error(self):
        tx = [{"id": "1", "ts": "2024-01-01T00:00:00Z", "symbol": "BTC", "side": "buy", "qty": 1, "price": 100},
              {"id": "2", "ts": "2024-02-01T00:00:00Z", "symbol": "BTC", "side": "sell", "qty": 1, "price": 150}]
        r = client.post("/api/analytics/tax/realized-gains", json={"transactions": tx, "csv": True})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["totals"]["net_gain"], 50.0)
        self.assertIn("symbol,sell_id", r.json()["csv"])
        bad = client.post("/api/analytics/scenario", json={"positions": [{"symbol": "A", "market_value": 10}],
                                                           "scenarios": [{"name": "a", "probability": 0.5, "shocks": {}}]})
        self.assertEqual(bad.status_code, 422)

    def test_query_router(self):
        r = client.post("/api/analytics/query", json={"text": "Is BTCUSDT trending on the 4h?"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual((r.json()["intent"], r.json()["endpoint"]), ("regime", "/api/analytics/regime"))
        self.assertEqual(client.post("/api/analytics/query", json={"text": ""}).status_code, 422)
        self.assertEqual(client.post("/api/analytics/query", json={"text": "tell me a joke"}).json()["status"], "unrecognized")

    def test_market_routes_with_fake_market(self):
        with mock.patch("app.api.analytics.MarketService", FakeMarket):
            scan = client.get("/api/analytics/scan", params={"symbols": "UPUSDT,FAILUSDT", "interval": "1h"})
            self.assertEqual(scan.status_code, 200)
            body = scan.json()
            self.assertEqual(body["scanned"], 1)
            self.assertIn("FAILUSDT", body["failed"])
            self.assertEqual(body["ranked"][0]["symbol"], "UPUSDT")
            reg = client.get("/api/analytics/regime", params={"symbol": "UPUSDT", "limit": 300})
            self.assertEqual((reg.status_code, reg.json()["status"]), (200, "ok"))
            self.assertEqual(client.get("/api/analytics/regime", params={"symbol": "FAILUSDT"}).status_code, 502)
            self.assertEqual(client.get("/api/analytics/correlation", params={"symbols": "ONEUSDT"}).status_code, 422)
            corr = client.get("/api/analytics/correlation", params={"symbols": "AAAUSDT,BBBUSDT", "interval": "1d"})
            self.assertEqual((corr.status_code, corr.json()["status"]), (200, "ok"))

    def test_compute_limits(self):
        with mock.patch("app.api.analytics.MarketService", FakeMarket):
            big = client.get("/api/analytics/monte-carlo", params={"paths": 10000, "horizon": 2000})
            self.assertEqual(big.status_code, 422)
            ok = client.get("/api/analytics/monte-carlo", params={"paths": 200, "horizon": 30})
            self.assertEqual((ok.status_code, ok.json()["status"]), (200, "ok"))
            grid = {"fast": list(range(2, 12)), "slow": list(range(20, 27))}  # 70 combinations
            self.assertEqual(client.post("/api/analytics/walk-forward", json={"grid": grid}).status_code, 422)
            wf = client.post("/api/analytics/walk-forward", json={"grid": {"fast": [5, 10], "slow": [30, 50]}, "train_bars": 300, "test_bars": 100})
            self.assertEqual(wf.status_code, 200)
            self.assertIn(wf.json()["status"], ("ok", "no_valid_folds"))

    def test_provider_status_unconfigured(self):
        self.use_registry(registry())
        r = client.get("/api/analytics/intel/providers")
        self.assertEqual(r.status_code, 200)
        by = {p["provider"]: p for p in r.json()["providers"]}
        self.assertEqual((by["fmp"]["status"], by["tokenomist"]["status"]), ("unconfigured", "unconfigured"))
        self.assertEqual({m["env"] for m in r.json()["missing_credentials"]}, {"FMP_API_KEY", "TOKENOMIST_API_KEY"})

    def test_calendar_unconfigured_is_503_not_fake_success(self):
        self.use_registry(registry())
        r = client.get("/api/analytics/intel/calendar/economic")
        self.assertEqual(r.status_code, 503)
        self.assertEqual(r.json()["detail"]["error"], "not_configured")

    def test_feed_auth(self):
        self.use_registry(registry(event_feed_token="tok-1234567890"))
        url = "/api/analytics/intel/calendar/feed"
        self.assertEqual(client.get(url).status_code, 401)
        self.assertEqual(client.get(url, headers={"Authorization": "Bearer nope"}).status_code, 401)
        # correct token passes auth and then reports the unconfigured provider (503), never a fake empty feed
        self.assertEqual(client.get(url, headers={"Authorization": "Bearer tok-1234567890"}).status_code, 503)

    def test_feed_fails_closed_in_production_without_token(self):
        self.use_registry(registry())
        with mock.patch("app.api.intel.get_settings", return_value=SimpleNamespace(app_env="production")):
            r = client.get("/api/analytics/intel/calendar/feed")
        self.assertEqual(r.status_code, 503)
        self.assertIn("EVENT_FEED_TOKEN", r.json()["detail"])

    def fmp_rows(self):
        soon = (datetime.now(timezone.utc) + timedelta(hours=1)).strftime("%Y-%m-%d %H:%M:%S")
        return [{"date": soon, "country": "US", "event": "CPI YoY", "currency": "USD", "previous": 3.0, "estimate": 2.9, "actual": None, "impact": "High"},
                {"date": soon, "country": "JP", "event": "Bank Holiday", "currency": "JPY", "impact": "None"}]

    def test_feed_and_event_risk_with_fake_fmp(self):
        reg = self.use_registry(registry(fmp_api_key="SECRET-FMP-KEY", event_feed_token="tok-1234567890"))
        http = FakeHTTP({"/economic-calendar": (200, self.fmp_rows(), {})})
        reg.fmp._transport = http
        feed = client.get("/api/analytics/intel/calendar/feed", headers={"Authorization": "Bearer tok-1234567890"})
        self.assertEqual(feed.status_code, 200)
        j = feed.json()
        self.assertEqual([e["title"] for e in j["events"]], ["CPI YoY"])
        self.assertEqual(j["events"][0]["impact"], "high")
        self.assertEqual(j["skipped_unrecognised_impact_or_malformed"], 1)
        self.assertNotIn("SECRET-FMP-KEY", feed.text)
        self.assertEqual(http.calls[0][1]["apikey"], "SECRET-FMP-KEY")
        risk = client.get("/api/analytics/intel/event-risk", params={"symbol": "BTCUSDT"})
        self.assertEqual(risk.status_code, 200)
        self.assertEqual(risk.json()["risk_state"], "elevated")
        self.assertFalse(risk.json()["corroboration"]["may_trigger_automation"])

    def test_provider_errors_map_to_http(self):
        reg = self.use_registry(registry(fmp_api_key="k"))
        reg.fmp._transport = FakeHTTP({"/economic-calendar": (401, None, {})})
        r = client.get("/api/analytics/intel/calendar/economic")
        self.assertEqual((r.status_code, r.json()["detail"]["error"]), (502, "auth"))
        reg2 = self.use_registry(registry(fmp_api_key="k"))
        reg2.fmp._transport = FakeHTTP({"/economic-calendar": (200, {"Error Message": "upgrade your subscription"}, {})})
        r2 = client.get("/api/analytics/intel/calendar/economic")
        self.assertEqual(r2.json()["detail"]["error"], "plan_restricted")

    def test_token_unlocks_with_fake_tokenomist(self):
        reg = self.use_registry(registry(tokenomist_api_key="TKEY"))
        when = (datetime.now(timezone.utc) + timedelta(days=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
        tokens = {"metadata": {"credit": {"used": 5, "limit": 1000}}, "status": True,
                  "data": [{"id": "arbitrum", "symbol": "ARB", "name": "Arbitrum", "circulatingSupply": 1000.0, "maxSupply": 10000.0, "marketCap": 500.0}]}
        events = {"metadata": {"page": 1, "totalPages": 1, "credit": {"used": 6, "limit": 1000}}, "status": True,
                  "data": [{"unlockDate": when, "tokenSymbol": "ARB", "tokenName": "Arbitrum",
                            "cliffUnlocks": {"cliffAmount": 100.0, "cliffValue": 50.0, "valueToMarketCap": 10.0, "allocationBreakdown": [
                                {"allocationName": "Investors", "standardAllocationName": "Private Investors", "cliffAmount": 100.0, "cliffValue": 50.0}]}}]}
        http = FakeHTTP({"/v5/token/list": (200, tokens, {}), "/v5/unlock/events/arbitrum": (200, events, {})})
        reg.tokenomist._transport = http
        r = client.get("/api/analytics/intel/unlocks/arbitrum", params={"days": 30})
        self.assertEqual(r.status_code, 200)
        row = r.json()["events"][0]
        self.assertEqual((row["severity"], row["insider_share_of_value"]), ("major", 1.0))
        self.assertEqual(http.calls[0][2], {"x-api-key": "TKEY"})
        self.assertNotIn("TKEY", r.text)
        self.assertEqual(client.get("/api/analytics/intel/unlocks/bad%2Fid").status_code, 404)


if __name__ == "__main__":
    unittest.main()
