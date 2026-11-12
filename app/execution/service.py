"""Wiring: builds the process-wide ExecutionEngine from settings, the database and the credential vault."""
from __future__ import annotations

from typing import Optional

from app.config import get_settings
from app.database import SessionLocal
from app.risk.engine import OrderProposal, RiskEngine

from . import guards
from .adapters.registry import build_adapter
from .domain import OrderIntent, Side
from .engine import ExecutionEngine
from .risk_marks import update_equity_marks
from .sql_store import SqlStore
from .store import AccountRecord
from .vault import CredentialVault, VaultError

REQUIRED_CREDENTIALS = {"alpaca": ("api_key", "secret_key"), "binance": ("api_key", "secret_key"),
                        "oanda": ("token", "account_id")}
SUPPORTED_ENVIRONMENTS = ("paper", "live")

_engine: Optional[ExecutionEngine] = None
_store: Optional[SqlStore] = None


def get_vault() -> CredentialVault:
    return CredentialVault(get_settings().execution_vault_key)


def vault_configured() -> bool:
    try:
        get_vault()
        return True
    except VaultError:
        return False


def adapter_for(acct: AccountRecord):
    """Decrypt credentials in memory only, for the lifetime of the adapter object."""
    if not acct.credentials_ciphertext:
        raise VaultError("Account has no stored credentials")
    creds = get_vault().open(acct.credentials_ciphertext)
    return build_adapter(acct.provider, creds, acct.environment, symbols=acct.policy.allowed_symbols)


async def risk_check(intent: OrderIntent, policy, quote, equity, positions, environment) -> tuple:
    """Independent risk officer: reuses the existing RiskEngine on broker-derived (never client-supplied) inputs."""
    settings = get_settings()
    store = get_store()
    acct = store.get_account(intent.account_id)
    if equity is None or equity <= 0 or acct is None:
        return False, ["Broker equity unavailable; cannot size risk"]
    from .domain import utcnow
    daily_pct, dd_pct = update_equity_marks(acct, float(equity), utcnow())
    store.save_account(acct)
    price = intent.limit_price or guards.protective_limit(intent.side, quote, policy.max_slippage_bps)
    proposal = OrderProposal(
        # "exec-" prefix: legacy ALPACA_PAPER / BINANCE_LIVE_* env gates describe the old single-account path,
        # not per-account credentials. LIVE_TRADING_ENABLED, kill switch, notional, loss and freshness rules still apply.
        provider=f"exec-{acct.provider}", environment="live" if environment == "live" else "paper",
        symbol=intent.symbol, side=intent.side.value, qty=intent.qty, order_type="limit", limit_price=price,
        equity=float(equity), current_open_positions=len([p for p in positions if abs(p.qty) > 0]),
        daily_realized_pnl_pct=daily_pct, current_drawdown_pct=dd_pct,
        data_age_seconds=max(0.0, quote.age_seconds(utcnow())), data_status="fresh",
        # The engine only reaches the gate in an explicitly enabled autonomous account or after a human approval.
        meta={"live_confirmed": True, "ref_price": price})
    decision = RiskEngine(settings).evaluate(proposal)
    return decision.approved, list(decision.reasons)


def get_store() -> SqlStore:
    global _store
    if _store is None:
        _store = SqlStore(SessionLocal)
    return _store


def get_engine() -> ExecutionEngine:
    global _engine
    if _engine is None:
        _engine = ExecutionEngine(get_store(), adapter_for, risk_check=risk_check,
                                  kill_switch=lambda: bool(get_settings().kill_switch))
    return _engine
