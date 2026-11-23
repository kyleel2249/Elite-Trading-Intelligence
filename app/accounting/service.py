"""Wiring: the shared ledger on the app database, plus syncs from existing ETI records."""
from __future__ import annotations

import threading

from app.accounting import events
from app.accounting.domain import ENVIRONMENTS
from app.accounting.ledger import Ledger
from app.accounting.money import to_units

_seed_lock = threading.Lock()
_seeded = False


def get_ledger() -> Ledger:
    global _seeded
    from app.database import SessionLocal
    from app.accounting.sql_store import SqlStore
    led = Ledger(SqlStore(SessionLocal))
    if not _seeded:
        with _seed_lock:
            if not _seeded:
                led.seed_chart()          # idempotent: only adds missing default accounts
                _seeded = True
    return led


def sync_orders(ledger: Ledger, currency: str = "USD", limit: int = 5000) -> dict:
    """Books realized P&L of filled orders (orders table) as `trade` entries, keyed by client_order_id.

    Fees are NOT invented: the orders table has no fee column, so fees are booked as 0 until supplied through
    POST /api/accounting/events/trade or a statement import. Environment comes from the order itself."""
    from app.database import SessionLocal
    from app.models import OrderRecord
    db = SessionLocal()
    posted = dup = skipped = 0
    reasons: dict[str, int] = {}
    try:
        rows = db.query(OrderRecord).filter(OrderRecord.realized_pnl.isnot(None)).order_by(OrderRecord.id).limit(limit).all()
        for r in rows:
            env = (r.environment or "").lower()
            if env not in ENVIRONMENTS or env == "internal" or r.status not in ("filled", "closed"):
                skipped += 1
                key = "environment/status not bookable"
                reasons[key] = reasons.get(key, 0) + 1
                continue
            when = (r.updated_at or r.created_at).date().isoformat()
            spec = events.trade_closed(r.client_order_id, when, r.symbol, None, env, to_units(repr(float(r.realized_pnl))),
                                       0, currency, by="sync_orders")
            if spec is None:
                skipped += 1
                reasons["zero P&L"] = reasons.get("zero P&L", 0) + 1
                continue
            res = ledger.post(spec)
            dup += 1 if res.duplicate else 0
            posted += 0 if res.duplicate else 1
    finally:
        db.close()
    return {"posted": posted, "already_booked": dup, "skipped": skipped, "skip_reasons": reasons,
            "fees": "not available in the orders table; booked as 0"}
