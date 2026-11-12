"""Broker-equity based loss tracking for execution accounts (daily loss and drawdown, unrealised included)."""
from __future__ import annotations

from datetime import datetime

from .store import AccountRecord


def update_equity_marks(acct: AccountRecord, equity: float, now: datetime) -> tuple:
    """Mutates `acct` (caller persists). Returns (daily_pnl_pct, drawdown_pct), both from live broker equity."""
    day = now.strftime("%Y-%m-%d")
    if acct.day_key != day or acct.day_start_equity <= 0:
        acct.day_key, acct.day_start_equity = day, equity
    acct.equity_hwm = max(acct.equity_hwm, equity)
    daily = (equity - acct.day_start_equity) / acct.day_start_equity * 100.0 if acct.day_start_equity > 0 else 0.0
    dd = (acct.equity_hwm - equity) / acct.equity_hwm * 100.0 if acct.equity_hwm > 0 else 0.0
    return daily, max(0.0, dd)
