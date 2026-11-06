from app.intelligence.council import TradingCouncil, Action
from app.intelligence.traders import ELITE_TRADERS, list_trader_profiles


def test_twelve_elite_traders():
    assert len(ELITE_TRADERS) == 12
    assert len(list_trader_profiles()) == 12
    assert ELITE_TRADERS["risk"].veto_power is True
    assert ELITE_TRADERS["risk"].name == "Helena Frost"


def test_insufficient_data():
    c = TradingCouncil()
    d = c.analyse(
        symbol="BTCUSDT",
        provider="binance",
        price=None,
        bid=None,
        ask=None,
        data_status="unavailable",
    )
    assert d.action == Action.INSUFFICIENT_DATA
    assert d.risk_veto
    assert "Helena Frost" in d.risk_officer


def test_stale_data_blocks():
    c = TradingCouncil()
    d = c.analyse(
        symbol="BTCUSDT",
        provider="binance",
        price=50000.0,
        bid=49990.0,
        ask=50010.0,
        data_status="stale",
    )
    assert d.action in (Action.NO_TRADE, Action.WAIT)
    assert d.risk_veto or d.data_quality == "stale"


def test_council_named_specialists():
    c = TradingCouncil()
    klines = [
        {"open": 1, "high": 1.1, "low": 0.9, "close": 1.05, "data_status": "valid"},
        {"open": 1.05, "high": 1.2, "low": 1.0, "close": 1.15, "data_status": "valid"},
        {"open": 1.15, "high": 1.3, "low": 1.1, "close": 1.25, "data_status": "valid"},
        {"open": 1.25, "high": 1.4, "low": 1.2, "close": 1.35, "data_status": "valid"},
        {"open": 1.35, "high": 1.5, "low": 1.3, "close": 1.45, "data_status": "valid"},
    ]
    book = {"imbalance": 0.4, "spread_bps": 5.0, "bid_volume": 10, "ask_volume": 4}
    d = c.analyse(
        symbol="BTCUSDT",
        provider="binance",
        price=1.45,
        bid=1.44,
        ask=1.46,
        data_status="fresh",
        order_book=book,
        klines=klines,
    )
    assert d.action != Action.INSUFFICIENT_DATA
    names = {r.trader_name for r in d.specialist_reports}
    assert "Elena Varga" in names
    assert "Jamal Reed" in names
    assert "Helena Frost" in names
    assert any(r.methods_applied for r in d.specialist_reports)
