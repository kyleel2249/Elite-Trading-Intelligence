"""Live trading and broker integration safety gates."""
from __future__ import annotations

from app.config import Settings
from app.risk.engine import RiskEngine, OrderProposal


def _settings(**kwargs) -> Settings:
    base = dict(
        live_trading_enabled=False,
        kill_switch=False,
        alpaca_paper=True,
        binance_live_trading_enabled=False,
        require_live_confirmation=True,
        max_position_notional_pct=6.0,
        paper_starting_equity=10000.0,
    )
    base.update(kwargs)
    return Settings(**base)


def test_kill_switch_blocks_paper():
    eng = RiskEngine(_settings(kill_switch=True))
    d = eng.evaluate(
        OrderProposal(
            provider="binance",
            environment="paper",
            symbol="BTCUSDT",
            side="buy",
            qty=0.01,
            equity=10000,
            data_status="fresh",
            data_age_seconds=5,
        )
    )
    assert not d.approved
    assert any("KILL_SWITCH" in r for r in d.reasons)


def test_live_requires_flags_limit_and_confirmation():
    eng = RiskEngine(
        _settings(
            live_trading_enabled=True,
            alpaca_paper=False,
            binance_live_trading_enabled=True,
        )
    )
    d = eng.evaluate(
        OrderProposal(
            provider="binance",
            environment="live",
            symbol="BTCUSDT",
            side="buy",
            qty=0.01,
            order_type="market",
            equity=10000,
            data_status="fresh",
            data_age_seconds=5,
            meta={"live_confirmed": True, "ref_price": 50000},
        )
    )
    assert not d.approved

    d2 = eng.evaluate(
        OrderProposal(
            provider="binance",
            environment="live",
            symbol="BTCUSDT",
            side="buy",
            qty=0.01,
            order_type="limit",
            limit_price=50000,
            equity=10000,
            data_status="fresh",
            data_age_seconds=5,
            meta={"live_confirmed": False, "ref_price": 50000},
        )
    )
    assert not d2.approved

    d3 = eng.evaluate(
        OrderProposal(
            provider="binance",
            environment="live",
            symbol="BTCUSDT",
            side="buy",
            qty=0.02,
            order_type="limit",
            limit_price=50000,
            equity=10000,
            data_status="fresh",
            data_age_seconds=5,
            meta={"live_confirmed": True, "ref_price": 50000},
        )
    )
    assert not d3.approved
    assert any("notional" in r.lower() for r in d3.reasons)


def test_live_approved_when_all_gates_pass():
    eng = RiskEngine(
        _settings(
            live_trading_enabled=True,
            alpaca_paper=False,
            binance_live_trading_enabled=True,
        )
    )
    d = eng.evaluate(
        OrderProposal(
            provider="binance",
            environment="live",
            symbol="BTCUSDT",
            side="buy",
            qty=0.01,
            order_type="limit",
            limit_price=50000,
            equity=10000,
            data_status="fresh",
            data_age_seconds=5,
            meta={"live_confirmed": True, "ref_price": 50000},
        )
    )
    assert d.approved


def test_alpaca_paper_blocks_live_provider_path():
    eng = RiskEngine(
        _settings(live_trading_enabled=True, alpaca_paper=True, binance_live_trading_enabled=True)
    )
    d = eng.evaluate(
        OrderProposal(
            provider="alpaca",
            environment="live",
            symbol="AAPL",
            side="buy",
            qty=1,
            order_type="limit",
            limit_price=150,
            equity=10000,
            data_status="fresh",
            data_age_seconds=5,
            meta={"live_confirmed": True, "ref_price": 150},
        )
    )
    assert not d.approved
    assert any("ALPACA_PAPER" in r for r in d.reasons)
