from app.intelligence.investor_activity import _normalize_congress_row


def test_normalize_congress_buy():
    row = {
        "Representative": "Jane Doe",
        "Ticker": "AAPL",
        "Transaction": "Purchase",
        "TransactionDate": "2024-01-02",
        "ReportDate": "2024-02-01",
        "Range": "$1,001-$15,000",
    }
    act = _normalize_congress_row(row)
    assert act["direction"] == "buy"
    assert act["ticker"] == "AAPL"
    assert act["verification_status"] == "CREDIBLE_SECONDARY_SOURCE"
    assert act["source_provider"] == "quiver_quant"
    assert "Disclosure dates" in act["notes"][0] or "disclosure" in act["notes"][0].lower()
