"""Role- and network-scoped transaction limits (in base units, e.g. wei).

Resolution order for a (role, network): exact row, then (role, "*"), then ("*", network), then ("*", "*"). A missing limit means
"no extra governance cap" (the chain policy's own per-tx/daily caps still apply). Daily totals are computed from the signed/
pending/confirmed ledger, so a limit cannot be dodged by splitting a transfer into many small ones.
"""
from __future__ import annotations

from datetime import timedelta
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.chain.models import ChainTransaction
from app.chain.networks import NETWORKS
from app.chain.policy import fmt_units
from app.governance import audit
from app.governance.models import GovLimit, now


class LimitError(Exception):
    def __init__(self, message: str, status: int = 422):
        super().__init__(message)
        self.message, self.status = message, status


def _clean(v) -> Optional[str]:
    if v in (None, ""):
        return None
    s = str(v).strip()
    if not s.isdigit():
        raise LimitError("limits must be non-negative integers in base units (e.g. wei)")
    return str(int(s))


def set_limit(db: Session, role: str, network: str, per_tx, daily, approval_above, by: str) -> GovLimit:
    from app.governance.rbac import ROLES
    if role != "*" and role not in ROLES:
        raise LimitError("unknown role")
    if network != "*" and network not in NETWORKS:
        raise LimitError("unknown network")
    row = db.execute(select(GovLimit).where(GovLimit.role == role, GovLimit.network == network)).scalar_one_or_none()
    if row is None:
        row = GovLimit(role=role, network=network)
        db.add(row)
    row.per_tx_wei, row.daily_wei, row.approval_above_wei = _clean(per_tx), _clean(daily), _clean(approval_above)
    row.updated_by, row.updated_at = by, now()
    db.commit()
    audit.append(db, by, "limits.set", f"{role}:{network}", {"per_tx": row.per_tx_wei, "daily": row.daily_wei, "approval_above": row.approval_above_wei})
    return row


def delete_limit(db: Session, limit_id: int, by: str) -> None:
    row = db.get(GovLimit, limit_id)
    if row is None:
        raise LimitError("limit not found", 404)
    db.delete(row)
    db.commit()
    audit.append(db, by, "limits.deleted", f"{row.role}:{row.network}")


def effective(db: Session, role: str, network: str) -> Optional[GovLimit]:
    for r, n in ((role, network), (role, "*"), ("*", network), ("*", "*")):
        row = db.execute(select(GovLimit).where(GovLimit.role == r, GovLimit.network == n)).scalar_one_or_none()
        if row:
            return row
    return None


def sent_last_24h(db: Session, network: str) -> int:
    cut = now() - timedelta(days=1)
    rows = db.execute(select(ChainTransaction).where(ChainTransaction.network == network, ChainTransaction.created_at >= cut,
                                                     ChainTransaction.status.in_(["signed", "pending", "confirmed"]))).scalars()
    return sum(int(r.notional_wei) for r in rows)


def violations(db: Session, role: str, network: str, notional: int) -> list[str]:
    row = effective(db, role, network)
    out: list[str] = []
    if row is None:
        return out
    if row.per_tx_wei is not None and notional > int(row.per_tx_wei):
        out.append(f"exceeds the {role} per-transaction limit of {fmt_units(int(row.per_tx_wei))} on {network}")
    if row.daily_wei is not None and sent_last_24h(db, network) + notional > int(row.daily_wei):
        out.append(f"would exceed the 24h limit of {fmt_units(int(row.daily_wei))} on {network}")
    return out


def approval_exempt(db: Session, role: str, network: str, notional: int) -> bool:
    """True when the amount is at or below an explicit small-payment threshold, so m-of-n approval is not demanded."""
    row = effective(db, role, network)
    return bool(row and row.approval_above_wei is not None and notional <= int(row.approval_above_wei))


def listing(db: Session) -> list[dict]:
    return [{"id": r.id, "role": r.role, "network": r.network, "per_tx_wei": r.per_tx_wei, "daily_wei": r.daily_wei,
             "approval_above_wei": r.approval_above_wei, "updated_by": r.updated_by, "updated_at": r.updated_at.isoformat()}
            for r in db.execute(select(GovLimit).order_by(GovLimit.id)).scalars()]
