from app.intelligence.predictive import PredictiveEngine


def test_forecast_scaffold():
    engine = PredictiveEngine()
    klines = []
    px = 100.0
    for i in range(20):
        px *= 1.01 if i % 2 == 0 else 0.995
        klines.append({"close": px, "data_status": "valid"})
    fc = engine.forecast(symbol="BTCUSDT", provider="binance", klines=klines, horizon="intraday")
    assert fc is not None
    d = fc.to_dict()
    assert d["analyst"] == "Lars Hagen"
    assert "scenarios" in d
    assert d["scenarios"]["bull"] >= d["scenarios"]["bear"]
    assert "disclaimer" in d
    assert d["confidence"] <= 0.55


def test_forecast_insufficient_history():
    engine = PredictiveEngine()
    fc = engine.forecast(
        symbol="BTCUSDT",
        provider="binance",
        klines=[{"close": 1.0, "data_status": "valid"}] * 3,
    )
    assert fc is None
