"""Unit tests with a FAKE transport. These prove retry/breaker/normalisation logic only; they are NOT evidence of
live provider connectivity (that is scripts/live_provider_check.py)."""
import asyncio
import unittest
from datetime import date, datetime, timezone

from app.providers import fmp, intel, tokenomist
from app.providers.base import Capability, ProviderClient, ProviderError


def run(coro):
    return asyncio.run(coro)


class Script:
    def __init__(self, *responses):
        self.responses, self.calls = list(responses), []

    async def __call__(self, method, url, params, headers, timeout):
        self.calls.append((url, dict(params), dict(headers)))
        r = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        if isinstance(r, Exception):
            raise r
        return r


async def nosleep(_):
    return None


ECON = [{"date": "2026-11-12 13:30:00", "country": "US", "event": "CPI YoY (Oct)", "currency": "USD", "previous": 3.0,
         "estimate": 2.9, "actual": None, "change": None, "impact": "High"},
        {"date": "bad", "event": "x"}]


class Base(unittest.TestCase):
    def client(self, *responses, key="SECRETKEY123"):
        s = Script(*responses)
        return fmp.FMPClient(key, transport=s, sleep=nosleep), s

    def test_unconfigured(self):
        c, _ = self.client((200, [], {}), key=None)
        with self.assertRaises(ProviderError) as cm:
            run(c.economic_calendar(date(2026, 11, 1), date(2026, 11, 5)))
        self.assertEqual(cm.exception.kind, "not_configured")
        self.assertEqual(c.health_snapshot()["status"], "unconfigured")

    def test_retry_then_success_and_key_sent(self):
        c, s = self.client((503, None, {}), (200, ECON, {}))
        r = run(c.economic_calendar(date(2026, 11, 10), date(2026, 11, 20)))
        self.assertEqual(len(s.calls), 2)
        self.assertEqual(c.health.retries, 1)
        self.assertEqual(s.calls[0][1]["apikey"], "SECRETKEY123")
        self.assertEqual(len(r.data), 1)
        self.assertEqual(r.meta["rows_skipped_invalid"], 1)
        self.assertEqual(r.data[0]["category"], "inflation")
        self.assertEqual(c.health_snapshot()["status"], "ok")

    def test_no_retry_on_auth_and_plan(self):
        c, s = self.client((401, None, {}))
        with self.assertRaises(ProviderError) as cm:
            run(c.economic_calendar(date(2026, 11, 10), date(2026, 11, 11)))
        self.assertEqual((cm.exception.kind, len(s.calls)), ("auth", 1))
        c, s = self.client((200, {"Error Message": "Special endpoint: upgrade your subscription"}, {}))
        with self.assertRaises(ProviderError) as cm:
            run(c.economic_calendar(date(2026, 11, 10), date(2026, 11, 11)))
        self.assertEqual(cm.exception.kind, "plan_restricted")

    def test_attempts_are_bounded_and_breaker_opens(self):
        c, s = self.client((500, None, {}))
        c.breaker_threshold = 2
        for _ in range(2):
            with self.assertRaises(ProviderError):
                run(c.economic_calendar(date(2026, 11, 10), date(2026, 11, 11)))
        self.assertEqual(len(s.calls), 6)  # 2 calls x 3 attempts, never infinite
        with self.assertRaises(ProviderError) as cm:
            run(c.economic_calendar(date(2026, 11, 10), date(2026, 11, 11)))
        self.assertEqual(cm.exception.kind, "circuit_open")
        self.assertEqual(len(s.calls), 6)
        self.assertEqual(c.health_snapshot()["status"], "down")

    def test_cache_avoids_second_call(self):
        c, s = self.client((200, ECON, {}))
        run(c.economic_calendar(date(2026, 11, 10), date(2026, 11, 11)))
        r = run(c.economic_calendar(date(2026, 11, 10), date(2026, 11, 11)))
        self.assertTrue(r.from_cache)
        self.assertEqual(len(s.calls), 1)

    def test_secret_never_in_error_or_history(self):
        c, _ = self.client((500, None, {}))
        with self.assertRaises(ProviderError) as cm:
            run(c.economic_calendar(date(2026, 11, 10), date(2026, 11, 11)))
        self.assertNotIn("SECRETKEY123", str(cm.exception))
        self.assertNotIn("SECRETKEY123", str(c.health_snapshot()) + str(c.health.history))

    def test_range_limit(self):
        c, _ = self.client((200, [], {}))
        with self.assertRaises(ProviderError) as cm:
            run(c.economic_calendar(date(2026, 1, 1), date(2026, 6, 1)))
        self.assertEqual(cm.exception.kind, "bad_request")

    def test_failover(self):
        bad, _ = self.client((500, None, {}))
        good, _ = self.client((200, ECON, {}))
        r, attempts = run(Capability("calendar", [bad, good]).call("economic_calendar", date(2026, 11, 10), date(2026, 11, 11)))
        self.assertEqual(attempts, [{"provider": "fmp", "error": "upstream"}])
        self.assertEqual(len(r.data), 1)


TOKENS = {"metadata": {"credit": {"used": 10, "limit": 1000, "resetAt": "2026-12-01T00:00:00Z"}}, "status": True,
          "data": [{"id": "arbitrum", "symbol": "ARB", "name": "Arbitrum", "circulatingSupply": 1000.0, "maxSupply": 10000.0, "marketCap": 500.0}]}


def events_page(page, total):
    return {"metadata": {"page": page, "totalPages": total, "credit": {"used": 11 + page, "limit": 1000}}, "status": True,
            "data": [{"unlockDate": "2026-11-20T13:00:00Z", "tokenSymbol": "ARB", "tokenName": "Arbitrum", "dataSource": "Whitepaper",
                      "cliffUnlocks": {"cliffAmount": 100.0, "cliffValue": 50.0, "valueToMarketCap": 10.0, "allocationBreakdown": [
                          {"allocationName": "Investors", "standardAllocationName": "Private Investors", "cliffAmount": 60.0, "cliffValue": 30.0,
                           "unlockPrecision": "day", "committedClaim": None},
                          {"allocationName": "DAO", "standardAllocationName": "Community", "cliffAmount": 40.0, "cliffValue": 20.0}]}}]}


class Tokenomist(unittest.TestCase):
    def test_pagination_header_and_quota(self):
        s = Script((200, events_page(1, 2), {}), (200, events_page(2, 2), {}))
        c = tokenomist.TokenomistClient("K", transport=s, sleep=nosleep)
        r = run(c.unlock_events("arbitrum"))
        self.assertEqual(len(r.data), 2)
        self.assertEqual(s.calls[0][2], {"x-api-key": "K"})
        self.assertEqual(s.calls[1][1]["page"], 2)
        self.assertEqual(c.health.quota["used"], 13)
        self.assertTrue(r.data[0]["allocations"][0]["insider"])
        self.assertFalse(r.data[0]["allocations"][1]["insider"])

    def test_credit_reserve_blocks_spending(self):
        s = Script((200, TOKENS, {}))
        c = tokenomist.TokenomistClient("K", transport=s, sleep=nosleep, credit_reserve=0.10)
        run(c.token_list(["arbitrum"]))
        c.health.quota = {"used": 950, "limit": 1000}
        with self.assertRaises(ProviderError) as cm:
            run(c.unlock_events("arbitrum"))
        self.assertEqual(cm.exception.kind, "rate_limited")
        self.assertEqual(len(s.calls), 1)

    def test_rejects_bad_token_id_and_status_false(self):
        c = tokenomist.TokenomistClient("K", transport=Script((200, {"status": False}, {})), sleep=nosleep)
        with self.assertRaises(ProviderError):
            run(c.unlock_events("../x"))
        with self.assertRaises(ProviderError) as cm:
            run(c.token_list())
        self.assertEqual(cm.exception.kind, "bad_response")


NOW = datetime(2026, 11, 10, 12, 0, tzinfo=timezone.utc)


class Intel(unittest.TestCase):
    def evts(self):
        return [fmp.normalize_economic(r) for r in [
            {"date": "2026-11-10 13:30:00", "country": "US", "event": "Nonfarm Payrolls", "currency": "USD", "previous": 150, "estimate": 160, "impact": "High"},
            {"date": "2026-11-14 13:30:00", "country": "EU", "event": "Trade Balance", "currency": "EUR", "impact": "Low"},
            {"date": "2026-11-10 10:30:00", "country": "US", "event": "CPI MoM", "currency": "USD", "estimate": 0.2, "actual": 0.3, "impact": "High"}]]

    def test_event_risk_states(self):
        r = intel.event_risk(self.evts(), NOW)
        self.assertEqual(r["risk_state"], "elevated")
        self.assertEqual([e["event"] for e in r["events"]][0], "CPI MoM")
        self.assertEqual(r["events"][0]["surprise_pct_vs_forecast"], 50.0)
        self.assertEqual(intel.event_risk(self.evts(), NOW, currencies=["EUR"])["risk_state"], "normal")
        self.assertEqual(intel.event_risk([], NOW)["risk_state"], "normal")

    def test_classify_and_currency(self):
        self.assertEqual(fmp.classify_event("ECB Interest Rate Decision"), "rate_decision")
        self.assertEqual(fmp.classify_event("Unemployment Rate"), "employment")
        self.assertEqual(intel.currencies_for_symbol("BTCUSDT"), ["USD"])
        self.assertEqual(intel.currencies_for_symbol("EURUSD"), ["EUR", "USD"])

    def test_unlock_risk(self):
        ev = tokenomist.normalize_unlock_event(events_page(1, 1)["data"][0])
        r = intel.unlock_risk([ev], {"symbol": "ARB", "circulating_supply": 1000.0, "max_supply": 10000.0}, NOW)
        row = r["events"][0]
        self.assertEqual((row["severity"], row["pct_of_circulating"], row["pct_of_max_supply"]), ("major", 10.0, 1.0))
        self.assertEqual(row["insider_share_of_value"], 0.6)
        self.assertTrue(any("not a price forecast" in n for n in r["notes"]))
        self.assertEqual(intel.unlock_risk([ev], None, NOW, horizon_days=2)["events"], [])

    def test_single_source_cannot_automate(self):
        r = intel.corroborate([{"provider": "tokenomist"}])
        self.assertFalse(r["corroborated"])
        self.assertFalse(r["may_trigger_automation"])


if __name__ == "__main__":
    unittest.main()
