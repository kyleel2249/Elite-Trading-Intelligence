from app.intelligence.significance import score_significance, consensus_report


def test_score_congress_moderate():
    act = {
        "category": "congressional_trade",
        "direction": "buy",
        "amount_or_range": "$50,001-$100,000",
        "verification_status": "CREDIBLE_SECONDARY_SOURCE",
    }
    assert score_significance(act) in ("MODERATE", "HIGH", "INFORMATIONAL")


def test_unconfirmed_informational():
    assert score_significance({"verification_status": "UNCONFIRMED", "direction": "buy"}) == "INFORMATIONAL"


def test_consensus_overlap():
    acts = [
        {"ticker": "AAPL", "investor_name": "A", "direction": "buy"},
        {"ticker": "AAPL", "investor_name": "B", "direction": "buy"},
        {"ticker": "MSFT", "investor_name": "A", "direction": "sell"},
    ]
    r = consensus_report(acts)
    assert any(x["ticker"] == "AAPL" for x in r["tickers_with_overlap"])
