"""Whale Alert adapter, FMP fundamentals and base-client verification: unit tests with a FAKE transport (no network)."""
import asyncio
import unittest
from types import SimpleNamespace

from app.providers import whale_alert as wa
from app.providers.base import ProviderError
from app.providers.fmp import FMPClient
from app.providers.health import FeedStats, build_health_center, verify_all
from app.providers.tokenomist import TokenomistClient


def run(c):
    return asyncio.run(c)


async def nosleep(_):
    return None


class Routes:
    """Fake HTTP: URL-substring -> (status, body[, headers]) or a callable(params)."""

    def __init__(self, routes):
        self.routes, self.calls = routes, []

    async def __call__(self, method, url, params, headers, timeout):
        self.calls.append((url, dict(params), dict(headers)))
        for suffix, resp in sorted(self.routes.items(), key=lambda kv: -len(kv[0])):  # most specific route wins
            if suffix in url:
                r = resp(params) if callable(resp) else resp
                return (r[0], r[1], r[2] if len(r) > 2 else {})
        return 404, None, {}


def leg(owner, otype, amount="100", addr="a"):
    return {"amount": amount, "address": addr, "owner": owner, "owner_type": otype}


def tx(src, dst, symbol="USDT", ttype="transfer", price=1.0, amount="2000000", ts=1_700_000_000, h="0x1"):
    return {"height": 5, "timestamp": ts, "hash": h, "sub_transactions": [
        {"symbol": symbol, "unit_price_usd": price, "transaction_type": ttype, "inputs": [{**src, "amount": amount}], "outputs": [{**dst, "amount": amount}]}]}


BIN, KRK = leg("binance", "exchange"), leg("kraken", "exchange")
WALLET, UNK = leg("whale-1", "unknown"), {"amount": "1", "address": "u"}


class Flows(unittest.TestCase):
    def kind(self, src, dst, **kw):
        return wa.normalize_transaction(tx(src, dst, **kw), "ethereum")[0]["kind"]

    def test_classification(self):
        self.assertEqual(self.kind(BIN, WALLET), "exchange_outflow")
        self.assertEqual(self.kind(WALLET, BIN), "exchange_inflow")
        self.assertEqual(self.kind(BIN, leg("binance", "exchange")), "internal_exchange_transfer")
        self.assertEqual(self.kind(BIN, KRK), "exchange_to_exchange")
        self.assertEqual(self.kind(WALLET, UNK), "wallet_to_wallet")
        self.assertEqual(self.kind(UNK, UNK, ttype="mint"), "mint")

    def test_values_and_attribution(self):
        f = wa.normalize_transaction(tx(WALLET, BIN, price=2.0, amount="1000"), "ethereum")[0]
        self.assertEqual((f["amount"], f["amount_usd"], f["symbol"], f["attribution"]), (1000.0, 2000.0, "USDT", "attributed"))
        self.assertEqual(wa.normalize_transaction(tx(UNK, UNK), "ethereum")[0]["attribution"], "unattributed")
        self.assertIsNone(wa.normalize_transaction(tx(WALLET, BIN, price=None), "ethereum")[0]["amount_usd"])

    def test_summary_has_no_signal_and_excludes_unattributed_and_internal(self):
        flows = []
        for t in (tx(WALLET, BIN, amount="3000000"), tx(BIN, WALLET, amount="1000000"), tx(BIN, leg("binance", "exchange"), amount="9000000"), tx(UNK, UNK, amount="5000000")):
            flows += wa.normalize_transaction(t, "ethereum")
        s = wa.summarize_flows(flows)
        row = s["by_symbol"][0]
        self.assertEqual((row["exchange_inflow_usd"], row["exchange_outflow_usd"], row["net_exchange_flow_usd"]), (3000000.0, 1000000.0, 2000000.0))
        self.assertIsNone(s["signal"])
        self.assertTrue(any("not proof of selling" in n for n in s["notes"]))

    def test_alert_normalisation(self):
        a = {"timestamp": 1687389431, "blockchain": "ethereum", "transaction_type": "transfer", "from": "unknown wallet", "to": "unknown wallet",
             "amounts": [{"symbol": "USDC", "amount": 2.0, "value_usd": 2.1}], "transaction": {"hash": "0xabc"}}
        f = wa.normalize_alert(a)[0]
        self.assertEqual((f["kind"], f["attribution"], f["amount_usd"]), ("unclassified_transfer", "unattributed", 2.1))


class Client(unittest.TestCase):
    def client(self, routes, key="WA-SECRET-KEY"):
        t = Routes(routes)
        return wa.WhaleAlertClient(key, transport=t, sleep=nosleep), t

    def test_recent_transactions_pagination_filters_and_key_placement(self):
        page1 = {"transactions": [tx(WALLET, BIN, amount="2000000", h="0xa"), tx(WALLET, BIN, amount="10", h="0xsmall")], "count": 2,
                 "next": "https://leviathan.whale-alert.io/ethereum/transactions?start_height=1000&start_index=2&limit=100&api_key=LEAK"}
        page2 = {"transactions": [tx(BIN, WALLET, amount="3000000", h="0xb")], "count": 1}
        seen = []

        def txs(params):
            seen.append(dict(params))
            return (200, page2 if "start_index" in params else page1)

        c, t = self.client({"/ethereum/transactions": txs, "/ethereum/height_at_time/": (200, {"height": 1000, "timestamp": 1})})
        t.routes = {"/ethereum/transactions": txs}

        async def transport(method, url, params, headers, timeout):
            if "/height_at_time/" in url:
                return 200, {"height": 1000, "timestamp": 1}, {}
            return await t(method, url, params, headers, timeout)

        c._transport = transport
        r = run(c.recent_transactions("Ethereum", "USDT", lookback_minutes=30, min_usd=1_000_000))
        self.assertEqual([f["hash"] for f in r.data], ["0xa", "0xb"])          # small transfer filtered out
        self.assertEqual(r.meta["pages"], 2)
        self.assertEqual(seen[0]["symbol"], "usdt")
        self.assertEqual(seen[1]["start_index"], 2)                              # followed the `next` cursor
        self.assertEqual(seen[1]["api_key"], "WA-SECRET-KEY")                    # key travels as a parameter, never in a logged URL
        self.assertTrue(all("api_key" not in url for url, _, _ in t.calls))

    def test_error_mapping(self):
        c, _ = self.client({"/status": (200, {"error": "not authenticated"})})
        with self.assertRaises(ProviderError) as cm:
            run(c.blockchains())
        self.assertEqual(cm.exception.kind, "auth")
        c, _ = self.client({"/status": (200, {"error": "not allowed"})})
        with self.assertRaises(ProviderError) as cm:
            run(c.blockchains())
        self.assertEqual(cm.exception.kind, "plan_restricted")
        c, _ = self.client({"/ethereum/status": (403, None)})
        with self.assertRaises(ProviderError) as cm:
            run(c.chain_status("ethereum"))
        self.assertEqual(cm.exception.kind, "plan_restricted")

    def test_validation_and_secret_hygiene(self):
        c, _ = self.client({})
        for bad in ("../x", "eth ereum", ""):
            with self.assertRaises(ProviderError) as cm:
                run(c.chain_status(bad))
            self.assertEqual(cm.exception.kind, "bad_request")
        c, _ = self.client({"/status": (500, None)})
        with self.assertRaises(ProviderError) as cm:
            run(c.blockchains())
        self.assertNotIn("WA-SECRET-KEY", str(cm.exception) + str(c.health_snapshot()) + str(c.health.history))

    def test_probe_reports_plan_access(self):
        ok = {"/status": (200, [{"name": "ethereum", "symbols": ["ETH"]}]), "/ethereum/status": (200, {"start_height": 1, "end_height": 500, "min_plan_height": 100}),
              "/ethereum/transactions": (200, {"transactions": []})}
        c, _ = self.client(ok)
        self.assertEqual({k: v["status"] for k, v in run(c.verify())["endpoints"].items()}, {"status": "ok", "chain_status": "ok", "transactions": "ok"})
        denied = {**ok, "/ethereum/transactions": (403, None)}
        c, _ = self.client(denied)
        self.assertEqual(run(c.verify())["endpoints"]["transactions"]["status"], "plan_restricted")

    def test_local_rate_limit_blocks_before_sending(self):
        t = Routes({"/status": (200, [])})
        c = wa.WhaleAlertClient("k", transport=t, sleep=nosleep, clock=lambda: 0.0)
        c.rate_per_minute = 2
        run(c.request("/status")), run(c.request("/status")), 
        with self.assertRaises(ProviderError) as cm:
            run(c.request("/status"))
        self.assertEqual((cm.exception.kind, len(t.calls)), ("rate_limited", 2))


class Fundamentals(unittest.TestCase):
    def test_profile_quote_statements_and_validation(self):
        t = Routes({"/profile": (200, [{"symbol": "AAPL", "companyName": "Apple Inc.", "marketCap": 3.0e12, "price": 200.5, "sector": "Technology"}]),
                    "/quote": (200, [{"symbol": "AAPL", "price": 201.0, "changePercentage": 1.2, "volume": 100}]),
                    "/income-statement": (200, [{"date": "2025-09-27", "fiscalYear": "2025", "period": "FY", "revenue": 400e9, "netIncome": 100e9, "epsDiluted": 6.5}]),
                    "/key-metrics": (200, [{"symbol": "AAPL", "date": "2025-09-27", "marketCap": 3e12, "evToEBITDA": 22.1}])})
        c = FMPClient("K", transport=t, sleep=nosleep)
        self.assertEqual(run(c.company_profile("aapl")).data["name"], "Apple Inc.")
        self.assertEqual(run(c.quote("AAPL")).data["change_pct"], 1.2)
        self.assertEqual(run(c.income_statements("AAPL", "FY", 1)).data[0]["net_income"], 100e9)
        self.assertEqual(run(c.key_metrics("AAPL")).data[0]["evToEBITDA"], 22.1)
        self.assertEqual(t.calls[0][1], {"symbol": "AAPL", "apikey": "K"})
        for bad in (lambda: c.company_profile("A;B"), lambda: c.income_statements("AAPL", "XX", 1), lambda: c.key_metrics("AAPL", "FY", 99)):
            with self.assertRaises(ProviderError) as cm:
                run(bad())
            self.assertEqual(cm.exception.kind, "bad_request")

    def test_empty_profile_is_none_not_fabricated(self):
        c = FMPClient("K", transport=Routes({"/profile": (200, [])}), sleep=nosleep)
        self.assertIsNone(run(c.company_profile("ZZZZ")).data)


class StatusHonesty(unittest.TestCase):
    def test_present_key_is_unverified_until_a_real_request_succeeds(self):
        c = FMPClient("K", transport=Routes({"/quote": (401, None)}), sleep=nosleep)
        self.assertEqual(c.health_snapshot()["status"], "unverified")
        with self.assertRaises(ProviderError):
            run(c.quote("AAPL"))
        self.assertEqual(c.health_snapshot()["status"], "unauthorized")
        c2 = FMPClient("K", transport=Routes({"/quote": (200, [{"symbol": "AAPL", "price": 1}])}), sleep=nosleep)
        run(c2.quote("AAPL"))
        self.assertEqual(c2.health_snapshot()["status"], "ok")
        self.assertEqual(FMPClient(None).health_snapshot()["status"], "unconfigured")

    def test_rejected_key_across_many_endpoints_stays_unauthorized_not_down(self):
        c = FMPClient("K", transport=Routes({"/": (401, None)}), sleep=nosleep)
        run(c.verify())                      # six endpoints, all rejected
        snap = c.health_snapshot()
        self.assertEqual(snap["status"], "unauthorized")
        self.assertFalse(snap["circuit_open"])
        self.assertEqual(snap["verification"]["endpoints"]["quote"]["status"], "auth")

    def test_key_revoked_after_success_is_unauthorized(self):
        ok = Routes({"/quote": (200, [{"symbol": "AAPL", "price": 1}])})
        c = FMPClient("K", transport=ok, sleep=nosleep)
        run(c.quote("AAPL"))
        c._cache.clear()
        ok.routes = {"/quote": (401, None)}
        with self.assertRaises(ProviderError):
            run(c.quote("AAPL"))
        self.assertEqual(c.health_snapshot()["status"], "unauthorized")

    def test_plan_restricted_and_verification_ttl(self):
        c = FMPClient("K", transport=Routes({"/economic-calendar": (402, None)}), sleep=nosleep)
        with self.assertRaises(ProviderError):
            run(c.economic_calendar(__import__("datetime").date(2026, 11, 1), __import__("datetime").date(2026, 11, 2)))
        self.assertEqual(c.health_snapshot()["status"], "plan_restricted")
        self.assertTrue(c.needs_verification())
        run(c.verify())
        self.assertFalse(c.needs_verification())
        self.assertFalse(FMPClient(None).needs_verification())


class HealthCenter(unittest.TestCase):
    def reg(self, fmp_routes=None, tk_routes=None, token=None):
        r = SimpleNamespace(fmp=FMPClient("K" if fmp_routes is not None else None, transport=Routes(fmp_routes or {}), sleep=nosleep),
                            tokenomist=TokenomistClient("T" if tk_routes is not None else None, transport=Routes(tk_routes or {}), sleep=nosleep),
                            whale=wa.WhaleAlertClient(None), feed=FeedStats(), event_feed_token=token)
        return r

    def test_nothing_configured(self):
        hc = build_health_center(self.reg())
        self.assertEqual({i["id"]: i["status"] for i in hc["integrations"]},
                         {"fmp": "unconfigured", "tokenomist": "unconfigured", "whale_alert": "unconfigured", "event_feed": "unconfigured"})
        self.assertFalse(hc["summary"]["all_configured_operational"])
        self.assertEqual([m["required"] for m in hc["summary"]["missing_credentials"]], [True, True, False, True])

    def test_verified_integrations_and_access_levels(self):
        fmp = {"/economic-calendar": (200, []), "/earnings-calendar": (200, []), "/profile": (200, [{"symbol": "AAPL"}]),
               "/quote": (200, [{"symbol": "AAPL"}]), "/income-statement": (402, None), "/key-metrics": (402, None)}
        tk = {"/v5/token/list": (200, {"status": True, "metadata": {"credit": {"used": 20, "limit": 1000, "resetAt": "2026-12-01"}}, "data": [{"id": "arbitrum"}]}),
              "/v5/unlock/events/arbitrum": (200, {"status": True, "metadata": {"totalPages": 1, "credit": {"used": 21, "limit": 1000}}, "data": []})}
        r = self.reg(fmp, tk, token="tok")
        out = run(verify_all(r))
        self.assertEqual(set(out), {"fmp", "tokenomist"})                       # unconfigured providers are not probed
        hc = {i["id"]: i for i in build_health_center(r)["integrations"]}
        self.assertEqual(hc["fmp"]["subscription_access"]["level"], "partial")
        self.assertEqual(hc["fmp"]["subscription_access"]["endpoints"]["income_statement"], "plan_restricted")
        self.assertEqual(hc["tokenomist"]["subscription_access"]["level"], "full")
        self.assertEqual((hc["tokenomist"]["quota"]["remaining"], hc["tokenomist"]["quota"]["limit"]), (979, 1000))
        self.assertEqual(hc["tokenomist"]["status"], "ok")
        self.assertEqual(hc["event_feed"]["status"], "not_verified_by_worker")   # token alone proves nothing
        r.feed.record_ok(12)
        hc = {i["id"]: i for i in build_health_center(r)["integrations"]}
        self.assertEqual((hc["event_feed"]["status"], hc["event_feed"]["last_event_count"]), ("ok", 12))
        r.feed.record_rejected()
        self.assertEqual({i["id"]: i for i in build_health_center(r)["integrations"]}["event_feed"]["status"], "degraded")

    def test_no_secret_in_payload(self):
        r = self.reg({"/profile": (401, None)}, {"/v5/token/list": (401, None)}, token="FEED-TOKEN-VALUE")
        run(verify_all(r))
        self.assertNotIn("FEED-TOKEN-VALUE", str(build_health_center(r)))
        self.assertNotIn('"K"', str(build_health_center(r)))

    def test_one_provider_failure_does_not_affect_others(self):
        r = self.reg({"/economic-calendar": (500, None)}, {"/v5/token/list": (200, {"status": True, "data": []}), "/v5/unlock/events/arbitrum": (200, {"status": True, "data": []})})
        r.fmp.max_attempts = 1
        run(verify_all(r))
        hc = {i["id"]: i for i in build_health_center(r)["integrations"]}
        self.assertEqual(hc["tokenomist"]["status"], "ok")
        self.assertNotEqual(hc["fmp"]["status"], "ok")


if __name__ == "__main__":
    unittest.main()
