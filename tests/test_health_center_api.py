"""Route-level tests for the Health Center, fundamentals and whale routes (TestClient, real app, fake provider HTTP).

These prove routing, auth wiring, status honesty and secret hygiene. They are NOT evidence of live provider connectivity.
"""
import unittest

from fastapi.testclient import TestClient

from app.main import app
from app.providers.registry import ProviderSettings, Registry, get_registry
from app.security.auth import require_api_key

client = TestClient(app)
BASE = "/api/analytics/intel"


class Routes:
    def __init__(self, routes):
        self.routes, self.calls = routes, []

    async def __call__(self, method, url, params, headers, timeout):
        self.calls.append((url, dict(params), dict(headers)))
        for suffix, resp in sorted(self.routes.items(), key=lambda kv: -len(kv[0])):
            if suffix in url:
                r = resp(params) if callable(resp) else resp
                return (r[0], r[1], r[2] if len(r) > 2 else {})
        return 404, None, {}


def registry(**kw):
    for k in ("fmp_api_key", "tokenomist_api_key", "whale_alert_api_key"):
        kw.setdefault(k, "")
    return Registry(ProviderSettings(_env_file=None, **kw))


FMP_OK = {"/economic-calendar": (200, []), "/earnings-calendar": (200, []), "/profile": (200, [{"symbol": "AAPL", "companyName": "Apple Inc.", "price": 1.0}]),
          "/quote": (200, [{"symbol": "AAPL", "price": 2.0}]), "/income-statement": (200, [{"date": "2025-09-27", "revenue": 10, "netIncome": 2}]),
          "/key-metrics": (200, [{"symbol": "AAPL", "date": "2025-09-27", "evToEBITDA": 20}])}


class HealthCenterRoutes(unittest.TestCase):
    def tearDown(self):
        app.dependency_overrides.clear()

    def use(self, reg):
        app.dependency_overrides[get_registry] = lambda: reg
        app.dependency_overrides[require_api_key] = lambda: None
        return reg

    def test_routes_and_page_registered(self):
        paths = client.get("/openapi.json").json()["paths"]
        for p in (f"{BASE}/health-center", f"{BASE}/health-center/verify", f"{BASE}/fundamentals/{{symbol}}", f"{BASE}/whales/{{blockchain}}/{{symbol}}"):
            self.assertIn(p, paths)
        page = client.get("/static/integration_health.html")
        self.assertEqual(page.status_code, 200)
        self.assertIn("Integration Health Center", page.text)

    def test_intel_routes_are_mounted_once_under_api_analytics(self):
        paths = client.get("/openapi.json").json()["paths"]
        self.assertFalse([p for p in paths if p.startswith("/intel/")], "intel router must not also be mounted at /intel")
        self.assertFalse([p for p in paths if p.startswith("/api/analytics/api/")])

    def test_nothing_configured_is_reported_honestly(self):
        self.use(registry())
        j = client.get(f"{BASE}/health-center", params={"auto_verify": "false"}).json()
        self.assertEqual({i["id"]: i["status"] for i in j["integrations"]},
                         {"fmp": "unconfigured", "tokenomist": "unconfigured", "whale_alert": "unconfigured", "event_feed": "unconfigured"})
        self.assertFalse(j["summary"]["all_configured_operational"])
        self.assertEqual(j["auto_verification_scheduled"], [])

    def test_key_present_is_unverified_then_operational_after_real_request(self):
        reg = self.use(registry(fmp_api_key="FMPSECRET"))
        reg.fmp._transport = Routes(FMP_OK)
        j = client.get(f"{BASE}/health-center", params={"auto_verify": "false"}).json()
        self.assertEqual({i["id"]: i for i in j["integrations"]}["fmp"]["status"], "unverified")
        v = client.post(f"{BASE}/health-center/verify", params={"only": "fmp"})
        self.assertEqual(v.status_code, 200)
        fmp = {i["id"]: i for i in v.json()["integrations"]}["fmp"]
        self.assertEqual((fmp["status"], fmp["subscription_access"]["level"]), ("ok", "full"))
        self.assertNotIn("FMPSECRET", v.text)

    def test_auto_verify_schedules_only_unverified_configured_providers(self):
        reg = self.use(registry(fmp_api_key="k"))
        reg.fmp._transport = Routes({})   # keep the background probe off the network
        j = client.get(f"{BASE}/health-center").json()
        self.assertEqual(j["auto_verification_scheduled"], ["fmp"])

    def test_unauthorized_key_is_detected(self):
        reg = self.use(registry(fmp_api_key="bad"))
        reg.fmp._transport = Routes({"/economic-calendar": (401, None), "/earnings-calendar": (401, None), "/profile": (401, None),
                                     "/quote": (401, None), "/income-statement": (401, None), "/key-metrics": (401, None)})
        v = client.post(f"{BASE}/health-center/verify", params={"only": "fmp"}).json()
        fmp = {i["id"]: i for i in v["integrations"]}["fmp"]
        self.assertEqual(fmp["status"], "unauthorized")
        self.assertEqual(fmp["subscription_access"]["level"], "none")

    def test_event_feed_becomes_operational_only_after_worker_fetch(self):
        reg = self.use(registry(fmp_api_key="k", event_feed_token="feed-token-123456"))
        reg.fmp._transport = Routes({"/economic-calendar": (200, [])})
        status = lambda: {i["id"]: i for i in client.get(f"{BASE}/health-center", params={"auto_verify": "false"}).json()["integrations"]}["event_feed"]["status"]
        self.assertEqual(status(), "not_verified_by_worker")
        self.assertEqual(client.get(f"{BASE}/calendar/feed", headers={"Authorization": "Bearer wrong"}).status_code, 401)
        self.assertEqual(status(), "not_verified_by_worker")
        ok = client.get(f"{BASE}/calendar/feed", headers={"Authorization": "Bearer feed-token-123456"})
        self.assertEqual(ok.status_code, 200)
        self.assertEqual(status(), "ok")

    def test_fundamentals_sections_are_independent(self):
        reg = self.use(registry(fmp_api_key="k"))
        reg.fmp._transport = Routes({**FMP_OK, "/income-statement": (402, None)})
        r = client.get(f"{BASE}/fundamentals/AAPL")
        self.assertEqual(r.status_code, 200)
        s = r.json()["sections"]
        self.assertEqual((s["profile"]["status"], s["quote"]["status"], s["key_metrics"]["status"]), ("ok", "ok", "ok"))
        self.assertEqual((s["income_statements"]["status"], s["income_statements"]["error"]), ("error", "plan_restricted"))
        reg2 = self.use(registry(fmp_api_key="k"))
        reg2.fmp._transport = Routes({k: (401, None) for k in FMP_OK})
        self.assertEqual(client.get(f"{BASE}/fundamentals/AAPL").status_code, 502)
        self.use(registry())
        self.assertEqual(client.get(f"{BASE}/fundamentals/AAPL").status_code, 503)
        reg3 = self.use(registry(fmp_api_key="k"))
        reg3.fmp._transport = Routes(FMP_OK)
        self.assertEqual(client.get(f"{BASE}/fundamentals/A%3BB").status_code, 422)

    def test_whale_route(self):
        reg = self.use(registry(whale_alert_api_key="WAKEY"))
        sub = {"symbol": "USDT", "unit_price_usd": 1.0, "transaction_type": "transfer",
               "inputs": [{"amount": "2000000", "owner": "whale-1", "owner_type": "unknown"}], "outputs": [{"amount": "2000000", "owner": "binance", "owner_type": "exchange"}]}
        reg.whale._transport = Routes({"/ethereum/height_at_time/": (200, {"height": 10}), "/ethereum/transactions": (200, {"transactions": [{"hash": "0x1", "timestamp": 1700000000, "sub_transactions": [sub]}]})})
        r = client.get(f"{BASE}/whales/ethereum/usdt", params={"min_usd": 1000000})
        self.assertEqual(r.status_code, 200)
        j = r.json()
        self.assertEqual(j["flows"][0]["kind"], "exchange_inflow")
        self.assertIsNone(j["summary"]["signal"])
        self.assertNotIn("WAKEY", r.text)
        reg.whale._transport = Routes({"/ethereum/height_at_time/": (403, None)})
        reg.whale._cache.clear()
        self.assertEqual(client.get(f"{BASE}/whales/ethereum/usdt").status_code, 502)
        self.use(registry())
        self.assertEqual(client.get(f"{BASE}/whales/ethereum/usdt").status_code, 503)
        self.assertEqual(client.get(f"{BASE}/whales/..%2Fx/usdt").status_code, 404)


if __name__ == "__main__":
    unittest.main()
