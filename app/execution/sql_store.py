"""SQLAlchemy-backed store implementing the same contract as InMemoryStore.

Each call uses its own short session. Atomicity that the engine relies on lives in the database:
- reserve_order: unique constraint on idempotency_key
- claim_proposal: conditional UPDATE ... WHERE status='pending_approval'
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import update
from sqlalchemy.exc import IntegrityError

from .domain import AccountPolicy, utcnow
from .models import ExecutionAccount, ExecutionLog, ExecutionOrder, ExecutionProposal
from .store import AccountRecord, OrderRow, ProposalRow
from .vault import scrub


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is not None and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


_ORDER_FIELDS = ("client_order_id", "idempotency_key", "account_id", "provider", "environment", "symbol", "side", "qty",
                 "order_type", "limit_price", "status", "filled_qty", "avg_fill_price", "provider_order_id", "mode",
                 "origin", "strategy", "thesis", "error")


def _order(m: ExecutionOrder) -> OrderRow:
    row = OrderRow(**{f: getattr(m, f) for f in _ORDER_FIELDS})
    row.created_at, row.updated_at = _aware(m.created_at), _aware(m.updated_at)
    return row


def _proposal(m: ExecutionProposal) -> ProposalRow:
    return ProposalRow(m.proposal_id, m.account_id, m.intent, m.status, _aware(m.created_at), _aware(m.expires_at),
                       m.quote_snapshot, m.decided_by, _aware(m.decided_at), m.result)


def _account(m: ExecutionAccount) -> AccountRecord:
    return AccountRecord(m.account_id, m.provider, m.environment, m.label or "", AccountPolicy.from_dict(m.policy or {}),
                         bool(m.halted), m.halted_reason, m.baseline, m.credentials_ciphertext, m.equity_hwm or 0.0,
                         m.day_key or "", m.day_start_equity or 0.0, _aware(m.created_at))


class SqlStore:
    def __init__(self, session_factory):
        self._sf = session_factory

    # accounts
    def get_account(self, account_id):
        with self._sf() as db:
            m = db.get(ExecutionAccount, account_id)
            return _account(m) if m else None

    def save_account(self, rec: AccountRecord):
        with self._sf() as db:
            m = db.get(ExecutionAccount, rec.account_id) or ExecutionAccount(account_id=rec.account_id,
                                                                            created_at=rec.created_at)
            m.provider, m.environment, m.label = rec.provider, rec.environment, rec.label
            m.policy, m.halted, m.halted_reason = rec.policy.to_dict(), rec.halted, rec.halted_reason
            m.baseline, m.credentials_ciphertext = rec.baseline, rec.credentials_ciphertext
            m.equity_hwm, m.day_key, m.day_start_equity = rec.equity_hwm, rec.day_key, rec.day_start_equity
            db.add(m)
            db.commit()

    def list_accounts(self):
        with self._sf() as db:
            return [_account(m) for m in db.query(ExecutionAccount).order_by(ExecutionAccount.created_at).all()]

    # orders
    def reserve_order(self, row: OrderRow) -> tuple:
        with self._sf() as db:
            db.add(ExecutionOrder(**{f: getattr(row, f) for f in _ORDER_FIELDS},
                                  created_at=row.created_at, updated_at=row.updated_at))
            try:
                db.commit()
                return row, True
            except IntegrityError:
                db.rollback()
                m = (db.query(ExecutionOrder).filter(ExecutionOrder.idempotency_key == row.idempotency_key).first()
                     or db.get(ExecutionOrder, row.client_order_id))
                return _order(m), False

    def update_order(self, client_order_id, **fields):
        with self._sf() as db:
            m = db.get(ExecutionOrder, client_order_id)
            for k, v in fields.items():
                setattr(m, k, v)
            m.updated_at = utcnow()
            db.commit()
            db.refresh(m)
            return _order(m)

    def get_order(self, client_order_id):
        with self._sf() as db:
            m = db.get(ExecutionOrder, client_order_id)
            return _order(m) if m else None

    def list_orders(self, account_id=None, statuses=None, since=None, symbol=None, side=None, limit=200):
        with self._sf() as db:
            q = db.query(ExecutionOrder)
            if account_id is not None:
                q = q.filter(ExecutionOrder.account_id == account_id)
            if statuses is not None:
                q = q.filter(ExecutionOrder.status.in_(list(statuses)))
            if since is not None:
                q = q.filter(ExecutionOrder.created_at >= since)
            if symbol is not None:
                q = q.filter(ExecutionOrder.symbol == symbol.upper())
            if side is not None:
                q = q.filter(ExecutionOrder.side == side)
            return [_order(m) for m in q.order_by(ExecutionOrder.created_at.desc()).limit(limit).all()]

    # proposals
    def save_proposal(self, p: ProposalRow):
        with self._sf() as db:
            db.add(ExecutionProposal(proposal_id=p.proposal_id, account_id=p.account_id, intent=p.intent,
                                     status=p.status, created_at=p.created_at, expires_at=p.expires_at,
                                     quote_snapshot=p.quote_snapshot))
            db.commit()

    def get_proposal(self, proposal_id):
        with self._sf() as db:
            m = db.get(ExecutionProposal, proposal_id)
            return _proposal(m) if m else None

    def claim_proposal(self, proposal_id, decided_by, new_status):
        with self._sf() as db:
            res = db.execute(update(ExecutionProposal)
                             .where(ExecutionProposal.proposal_id == proposal_id,
                                    ExecutionProposal.status == "pending_approval")
                             .values(status=new_status, decided_by=decided_by, decided_at=utcnow()))
            db.commit()
            if res.rowcount != 1:
                return None
            return _proposal(db.get(ExecutionProposal, proposal_id))

    def update_proposal(self, proposal_id, **fields):
        with self._sf() as db:
            m = db.get(ExecutionProposal, proposal_id)
            for k, v in fields.items():
                setattr(m, k, v)
            db.commit()

    def list_proposals(self, account_id=None, status=None, limit=100):
        with self._sf() as db:
            q = db.query(ExecutionProposal)
            if account_id is not None:
                q = q.filter(ExecutionProposal.account_id == account_id)
            if status is not None:
                q = q.filter(ExecutionProposal.status == status)
            return [_proposal(m) for m in q.order_by(ExecutionProposal.created_at.desc()).limit(limit).all()]

    # logs
    def append_log(self, account_id, event, client_order_id=None, details=None):
        clean = json.loads(json.dumps(scrub(details or {}), default=str))
        with self._sf() as db:
            db.add(ExecutionLog(account_id=account_id, event=event, client_order_id=client_order_id, details=clean))
            db.commit()

    def list_logs(self, account_id=None, event=None, limit=200):
        with self._sf() as db:
            q = db.query(ExecutionLog)
            if account_id is not None:
                q = q.filter(ExecutionLog.account_id == account_id)
            if event is not None:
                q = q.filter(ExecutionLog.event == event)
            return [{"ts": _aware(m.ts), "account_id": m.account_id, "event": m.event,
                     "client_order_id": m.client_order_id, "details": m.details}
                    for m in q.order_by(ExecutionLog.id.desc()).limit(limit).all()]
