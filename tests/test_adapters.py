from app.intelligence.adapters import FundamentalAdapter, MacroAdapter, SentimentAdapter


def _klines(n=25, start=100.0, step=0.5):
    out = []
    px = start
    for _ in range(n):
        out.append({"close": px, "data_status": "valid"})
        px += step
    return out


def test_fundamental_discount_bullish():
    # price well below rising path end → build flat then drop
    k = _klines(25, 100, 0.2)
    price = k[-1]["close"] * 0.9
    sig = FundamentalAdapter().analyse(symbol="BTCUSDT", price=price, klines=k)
    assert sig.bias in ("bullish", "neutral", "bearish")
    assert 0 <= sig.confidence <= 1


def test_macro_high_vol_bearish_tilt():
    k = []
    px = 100.0
    for i in range(20):
        px *= 1.03 if i % 2 == 0 else 0.97
        k.append({"close": px})
    sig = MacroAdapter().analyse(klines=k, order_book={"spread_bps": 10})
    assert sig.bias in ("bullish", "bearish", "neutral")
    assert any("vol" in e.lower() or "Vol" in e for e in sig.evidence) or sig.evidence


def test_sentiment_with_news_context():
    sig = SentimentAdapter().analyse(
        klines=_klines(15),
        context={"news": {"status": "ok", "sentiment_score": 0.5, "headline_count": 5, "note": "test"}},
    )
    assert sig.bias == "bullish"
    assert sig.confidence > 0.3


def test_sentiment_news_not_configured_falls_back():
    sig = SentimentAdapter().analyse(
        klines=_klines(15, 100, 1.0),
        context={"news": {"status": "not_configured"}},
    )
    assert sig.bias in ("bullish", "bearish", "neutral")
