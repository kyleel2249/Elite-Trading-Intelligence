"""Wiring: builds the process-wide ExecutionEngine from settings, the database and the credential vault."""
from __future__ import annotations

from typing import Optional

from app.config import get_settings
from app.database import SessionLocal
from app.risk.engine import OrderProposal, RiskEngine
from app.risk.protection import AccountSnapshot, OpenPosition, OrderIntent as CpsIntent, assess_emergency
from app.risk.protection_policy import policy_from_settings
from app.risk.protection_service import CapitalProtectionService

from . import guards
from .adapters.registry import build_adapter
from .domain import Mode, OrderIntent, Side
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


def _positive(value) -> Optional[float]:
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    return v if v == v and 0 < v < float("inf") else None


def _cps_positions(acct: AccountRecord, positions) -> tuple:
    return tuple(
        OpenPosition(provider=acct.provider, symbol=p.symbol.upper(), side="long" if p.qty > 0 else "short",
                     qty=abs(p.qty), price=float(p.mark_price or p.avg_price or 0.0), avg_entry=float(p.avg_price or 0.0))
        for p in positions if abs(p.qty) > 0)


def _protection_verdict(settings, acct: AccountRecord, intent: OrderIntent, price: float, equity: float,
                        positions, daily_pct: float, dd_pct: float):
    """ETI CAPITAL PROTECTION SYSTEM check on broker-derived account state.

    Limits not trackable from broker data alone (weekly loss, loss streak, per-position stops) are not enforced here;
    see docs/CAPITAL_PROTECTION.md. The stop-loss, take-profit and ATR% are read from ``intent.meta`` and are validated,
    never trusted: they can only make a check stricter or fail it.
    """
    meta = intent.meta or {}
    snapshot = AccountSnapshot(equity=float(equity), peak_equity=max(float(acct.equity_hwm), float(equity)),
                               daily_pnl_pct=daily_pct, drawdown_pct=dd_pct,
                               positions=_cps_positions(acct, positions), source="broker")
    cps_intent = CpsIntent(
        provider=acct.provider, environment="live" if acct.environment == "live" else "paper",
        symbol=intent.symbol, side=intent.side.value, qty=intent.qty, price=price,
        stop_loss=_positive(meta.get("stop_loss")), take_profit=_positive(meta.get("take_profit")),
        strategy_id=(intent.strategy or None), atr_pct=_positive(meta.get("atr_pct")),
        order_type="limit", source="execution_engine")
    db = SessionLocal()
    try:
        return CapitalProtectionService(db, settings).check_with_account(cps_intent, snapshot)
    finally:
        db.close()


async def risk_gate(intent: OrderIntent, policy, quote, equity, positions, environment) -> tuple:
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
    verdict = _protection_verdict(settings, acct, intent, price, float(equity), positions, daily_pct, dd_pct)
    # Only an order that Capital Protection itself verified (from broker positions) as a strict reduction may use
    # the exit path through the loss / drawdown / position limits.
    proposal.reduces_exposure = bool(verdict.approved and verdict.reduces_exposure)
    decision = RiskEngine(settings).evaluate(proposal)
    reasons = list(decision.reasons) if not decision.approved else []
    if not verdict.approved:
        reasons += [f"[Capital Protection] {r}" for r in verdict.reasons]
    return (decision.approved and verdict.approved), reasons


def get_store() -> SqlStore:
    global _store
    if _store is None:
        _store = SqlStore(SessionLocal)
    return _store


def get_engine() -> ExecutionEngine:
    global _engine
    if _engine is None:
        _engine = ExecutionEngine(get_store(), adapter_for, risk_gate=risk_gate,
                                  kill_switch=lambda: bool(get_settings().kill_switch))
    return _engine


async def protection_tick(engine: Optional[ExecutionEngine] = None) -> dict:
    """Emergency rules for broker accounts: breach of the emergency drawdown / daily-loss threshold flattens the account.

    Uses the engine's own emergency machinery (halts the account, cancels working orders, sends reduce-only closes), which
    only ever reduces exposure. Run from the execution supervisor after each tick.
    """
    engine = engine or get_engine()
    store = get_store()
    policy = policy_from_settings(get_settings())
    report: dict = {}
    for acct in store.list_accounts():
        if acct.halted or acct.policy.mode == Mode.INTELLIGENCE_ONLY:
            continue
        try:
            adapter = engine._adapter(acct)
            equity = await engine._read(acct, adapter.get_equity)
            if equity is None or equity <= 0:
                continue
            from .domain import utcnow
            daily_pct, dd_pct = update_equity_marks(acct, float(equity), utcnow())
            store.save_account(acct)
            verdict = assess_emergency(AccountSnapshot(equity=float(equity), peak_equity=float(acct.equity_hwm),
                                                       daily_pnl_pct=daily_pct, drawdown_pct=dd_pct, source="broker"),
                                       policy)
            if verdict.triggered and policy.auto_liquidate_on_emergency:
                reason = "CAPITAL PROTECTION: " + "; ".join(verdict.reasons)
                db = SessionLocal()
                try:
                    CapitalProtectionService(db, get_settings()).audit(
                        "EXEC_EMERGENCY_FLATTEN", {"account_id": acct.account_id, "reasons": verdict.reasons})
                finally:
                    db.close()
                report[acct.account_id] = await engine.emergency_flatten(acct.account_id, reason, by="capital_protection")
        except Exception as e:  # one bad account must not stop the others
            report[acct.account_id] = {"error": f"{type(e).__name__}: {e}"[:200]}
    return report
