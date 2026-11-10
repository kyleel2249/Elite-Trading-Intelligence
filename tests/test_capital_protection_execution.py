"""ETI CAPITAL PROTECTION SYSTEM inside the broker-account execution engine (app.execution)."""
import asyncio
from datetime import datetime, timezone

import pytest

import app.execution.service as svc
from app.config import Settings
from app.database import SessionLocal, init_db
from app.execution.domain import AccountPolicy, BrokerPosition, Mode, OrderIntent, OrderType, Quote, Side
from app.execution.store import AccountRecord
from app.models import ProtectionAuditRecord, ProtectionNewsEvent, ProtectionStateRecord, StrategyQuarantineRecord

NOW = datetime.now(timezone.utc)


class _Store:
    def __init__(self, acct):
        self.acct = acct

    def get_account(self, account_id):
        return self.acct

    def save_account(self, acct):
        self.acct = acct

    def list_accounts(self):
        return [self.acct]


class _Approving:
    """Stand-in for the legacy RiskEngine so these tests isolate Capital Protection. Records the proposal."""
    last = None

    def __init__(self, settings):
        pass

    def evaluate(self, proposal):
        type(self).last = proposal

        class D:
            approved, reasons = True, []
        return D()


@pytest.fixture(autouse=True)
def clean_db():
    init_db()
    s = SessionLocal()
    for m in (ProtectionAuditRecord, ProtectionNewsEvent, ProtectionStateRecord, StrategyQuarantineRecord):
        s.query(m).delete()
    s.commit()
    s.close()
    yield


@pytest.fixture
def gate(monkeypatch):
    settings = Settings(live_trading_enabled=False)
    monkeypatch.setattr(svc, "get_settings", lambda: settings)
    monkeypatch.setattr(svc, "RiskEngine", _Approving)
    _Approving.last = None

    def make(acct):
        monkeypatch.setattr(svc, "get_store", lambda: _Store(acct))
        return acct
    return make


def account(**kw):
    base = dict(account_id="acct-1", provider="binance", environment="paper", equity_hwm=10_000.0,
                day_key=NOW.strftime("%Y-%m-%d"), day_start_equity=10_000.0, policy=AccountPolicy())
    base.update(kw)
    return AccountRecord(**base)


def intent(side=Side.BUY, qty=5.0, **meta):
    return OrderIntent(account_id="acct-1", symbol="BTCUSDT", side=side, qty=qty, order_type=OrderType.LIMIT,
                       limit_price=100.0, strategy="s1", meta=meta)


def quote():
    return Quote(provider="binance", symbol="BTCUSDT", bid=99.9, ask=100.1, ts=datetime.now(timezone.utc))


def run_gate(i, acct, equity=10_000.0, positions=()):
    return asyncio.run(svc.risk_gate(i, acct.policy, quote(), equity, list(positions), acct.environment))


def test_entry_without_stop_is_refused(gate):
    ok, reasons = run_gate(intent(), gate(account()))
    assert not ok and any("[Capital Protection]" in r and "stop-loss" in r.lower() for r in reasons)


def test_entry_with_valid_stop_is_approved(gate):
    ok, reasons = run_gate(intent(stop_loss=98.0, atr_pct=2.0), gate(account()))
    assert ok, reasons


def test_oversized_entry_is_refused_even_if_legacy_engine_approves(gate):
    ok, reasons = run_gate(intent(qty=50.0, stop_loss=98.0, atr_pct=2.0), gate(account()))
    assert not ok and any("notional" in r.lower() for r in reasons)


def test_client_supplied_stop_cannot_game_the_risk_limit(gate):
    # a stop 0.01% away would make "risk" tiny; the minimum stop distance rule refuses it
    ok, reasons = run_gate(intent(qty=5.0, stop_loss=99.99, atr_pct=2.0), gate(account()))
    assert not ok


def test_drawdown_blocks_entries_but_not_verified_exits(gate):
    acct = gate(account(equity_hwm=12_000.0))  # $10,000 equity is a 16.7% drawdown
    ok, reasons = run_gate(intent(stop_loss=98.0, atr_pct=2.0), acct)
    assert not ok and any("drawdown" in r.lower() for r in reasons)

    held = [BrokerPosition(symbol="BTCUSDT", qty=1.0, avg_price=100.0, mark_price=100.0)]
    ok, reasons = run_gate(intent(side=Side.SELL, qty=1.0), acct, positions=held)
    assert ok, reasons
    assert _Approving.last.reduces_exposure is True


def test_unverified_order_never_gets_the_exit_path(gate):
    run_gate(intent(stop_loss=98.0, atr_pct=2.0), gate(account()))
    assert _Approving.last.reduces_exposure is False


def test_live_manual_order_needs_a_registered_strategy(gate):
    acct = gate(account(environment="live"))
    ok, reasons = run_gate(intent(stop_loss=98.0, atr_pct=2.0), acct)
    assert not ok and any("registered" in r.lower() or "news calendar" in r.lower() for r in reasons)


# ------------------------------------------------------------------ emergency tick
class _Adapter:
    def __init__(self, equity):
        self.equity = equity

    async def get_equity(self):
        return self.equity


class _Engine:
    def __init__(self, equity):
        self.adapter = _Adapter(equity)
        self.flattened = []

    def _adapter(self, acct):
        return self.adapter

    async def _read(self, acct, fn):
        return await fn()

    async def emergency_flatten(self, account_id, reason, by="system", scope="eti_managed"):
        self.flattened.append((account_id, reason, by))
        return {"status": "flattening"}


def test_emergency_daily_loss_flattens_the_account(monkeypatch):
    acct = account(policy=AccountPolicy(mode=Mode.AUTONOMOUS))
    monkeypatch.setattr(svc, "get_store", lambda: _Store(acct))
    monkeypatch.setattr(svc, "get_settings", lambda: Settings())
    engine = _Engine(equity=9_500.0)  # -5% on the day, beyond the 4% emergency threshold
    report = asyncio.run(svc.protection_tick(engine))
    assert engine.flattened and engine.flattened[0][2] == "capital_protection"
    assert "CAPITAL PROTECTION" in engine.flattened[0][1] and "acct-1" in report


def test_healthy_halted_and_intelligence_only_accounts_are_not_flattened(monkeypatch):
    monkeypatch.setattr(svc, "get_settings", lambda: Settings())
    for acct, equity in ((account(policy=AccountPolicy(mode=Mode.AUTONOMOUS)), 10_000.0),
                         (account(policy=AccountPolicy(mode=Mode.AUTONOMOUS), halted=True), 5_000.0),
                         (account(policy=AccountPolicy(mode=Mode.INTELLIGENCE_ONLY)), 5_000.0)):
        monkeypatch.setattr(svc, "get_store", lambda a=acct: _Store(a))
        engine = _Engine(equity=equity)
        asyncio.run(svc.protection_tick(engine))
        assert engine.flattened == []
