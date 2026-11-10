import unittest

from app.jobs.paper_autopilot import classify_action, normalize_confidence, size_buy


class AutopilotHelperTests(unittest.TestCase):
    def test_classify_action(self):
        self.assertEqual(classify_action("BUY"), "buy")
        self.assertEqual(classify_action("strong_buy"), "buy")
        self.assertEqual(classify_action("sell"), "sell")
        self.assertIsNone(classify_action("hold"))
        self.assertIsNone(classify_action("no_trade"))
        self.assertIsNone(classify_action(None))

    def test_confidence_normalised_from_percent_or_fraction(self):
        self.assertEqual(normalize_confidence(0.7), 0.7)
        self.assertEqual(normalize_confidence(70), 0.7)
        self.assertEqual(normalize_confidence("x"), 0.0)

    def test_buy_sizing_risks_one_percent_and_caps_notional(self):
        qty = size_buy(10_000, 100.0, 1.0)            # risk 100 on a 2% stop -> 5000 notional, capped at 20% = 2000
        self.assertAlmostEqual(qty * 100.0, 2000.0, places=3)
        self.assertAlmostEqual(size_buy(10_000, 100.0, 0.1) * 100.0, 500.0, places=3)
        self.assertEqual(size_buy(0, 100, 1), 0.0)
        self.assertEqual(size_buy(1000, 0, 1), 0.0)


if __name__ == "__main__":
    unittest.main()
