import unittest

from app.providers import fmp
from app.providers.feed import to_readiness_events


class Feed(unittest.TestCase):
    def test_mapping_matches_readiness_schema(self):
        evs = [fmp.normalize_economic(r) for r in [
            {"date": "2026-11-12 13:30:00", "event": "CPI YoY", "currency": "usd", "impact": "High"},
            {"date": "2026-11-12 19:00:00", "event": "FOMC Interest Rate Decision", "currency": "USD", "impact": "High"},
            {"date": "2026-11-11 08:00:00", "event": "Holiday", "currency": "JPY", "impact": "None"},
            {"date": "2026-11-11 09:00:00", "event": "Trade Balance", "currency": "EUR", "impact": "Medium"}]]
        out = to_readiness_events(evs)
        self.assertEqual(out["skipped_unrecognised_impact_or_malformed"], 1)
        self.assertEqual([r["time"] for r in out["events"]], sorted(r["time"] for r in out["events"]))
        cpi = next(r for r in out["events"] if r["title"] == "CPI YoY")
        self.assertEqual(cpi, {"title": "CPI YoY", "time": "2026-11-12T13:30:00Z", "impact": "high", "category": "economic", "currency": "USD"})
        self.assertEqual(next(r for r in out["events"] if "FOMC" in r["title"])["category"], "central_bank")

    def test_unknown_impact_is_never_defaulted(self):
        self.assertEqual(to_readiness_events([{"event": "x", "timestamp_utc": "2026-11-12T00:00:00+00:00", "impact": "unknown"}])["events"], [])


if __name__ == "__main__":
    unittest.main()
