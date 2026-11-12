"""Capability failover keeps the real error kind (unit tests, fake transport)."""
import asyncio
import unittest
from datetime import date

from app.providers.base import Capability, ProviderError
from app.providers.fmp import FMPClient


class T:
    def __init__(self, status, body):
        self.status, self.body = status, body

    async def __call__(self, *a, **k):
        return self.status, self.body, {}


async def nosleep(_):
    return None


def call(cap):
    return asyncio.run(cap.call("economic_calendar", date(2026, 11, 10), date(2026, 11, 11)))


class CapabilityKinds(unittest.TestCase):
    def test_single_unconfigured_provider_keeps_kind(self):
        with self.assertRaises(ProviderError) as cm:
            call(Capability("calendar", [FMPClient(None)]))
        self.assertEqual(cm.exception.kind, "not_configured")

    def test_same_kind_from_all_providers_is_preserved(self):
        caps = Capability("calendar", [FMPClient("a", transport=T(401, None), sleep=nosleep), FMPClient("b", transport=T(401, None), sleep=nosleep)])
        with self.assertRaises(ProviderError) as cm:
            call(caps)
        self.assertEqual(cm.exception.kind, "auth")

    def test_mixed_kinds_become_upstream_with_detail(self):
        caps = Capability("calendar", [FMPClient(None), FMPClient("b", transport=T(401, None), sleep=nosleep)])
        with self.assertRaises(ProviderError) as cm:
            call(caps)
        self.assertEqual(cm.exception.kind, "upstream")
        self.assertIn("fmp=not_configured", cm.exception.detail)

    def test_success_after_failure_reports_attempts(self):
        rows = [{"date": "2026-11-10 13:30:00", "event": "CPI", "currency": "USD", "impact": "High"}]
        caps = Capability("calendar", [FMPClient(None), FMPClient("b", transport=T(200, rows), sleep=nosleep)])
        res, attempts = call(caps)
        self.assertEqual(len(res.data), 1)
        self.assertEqual(attempts, [{"provider": "fmp", "error": "not_configured"}])


if __name__ == "__main__":
    unittest.main()
