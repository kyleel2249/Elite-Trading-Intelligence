"""Persistence contract for the engine plus an in-memory implementation (tests, single-process dev)."""
from __future__ import annotations

import copy
import threading
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from .domain import AccountPolicy, OrderStatus, utcnow
from .vault import scrub


@dataclass
class AccountRecord:
    account_id: str
    provider: str
    environment: str                       # paper | live
    label: str = ""
    policy: AccountPolicy = field(default_factory=AccountPolicy)
    halted: bool = False
    halted_reason: Optional[str] = None
    baseline: Optional[dict] = None        # {symbol: qty} broker positions not created by ETI
    credentials_ciphertext: Optional[str] = None
    equity_hwm: float = 0.0                # highest equity seen (drawdown reference)
    day_key: str = ""                      # UTC date of day_start_equity
    day_start_equity: float = 0.0
    created_at: datetime = field(default_factory=utcnow)


@dataclass
class OrderRow:
    client_order_id: str
    idempotency_key: str
    account_id: str
    provider: str
    environment: str
    symbol: str
    side: str
    qty: float
    order_type: str
    limit_price: Optional[float]
    status: str = OrderStatus.PENDING_SUBMIT.value
    filled_qty: float = 0.0
    avg_fill_price: Optional[float] = None
    provider_order_id: Optional[str] = None
    mode: str = ""
    origin: str = "autonomous"             # autonomous | approved | emergency
    strategy: str = ""
    thesis: Optional[str] = None
    error: Optional[str] = None
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)

    def to_dict(self) -> dict:
        d = dict(self.__dict__)
        d["created_at"] = self.created_at.isoformat()
        d["updated_at"] = self.updated_at.isoformat()
        return d


@dataclass
class ProposalRow:
    proposal_id: str
    account_id: str
    intent: dict
    status: str                            # pending_approval | executed | rejected | expired | failed
    created_at: datetime
    expires_at: datetime
    quote_snapshot: Optional[dict] = None
    decided_by: Optional[str] = None
    decided_at: Optional[datetime] = None
    result: Optional[dict] = None

    def to_dict(self) -> dict:
        d = dict(self.__dict__)
        for k in ("created_at", "expires_at", "decided_at"):
            d[k] = d[k].isoformat() if d[k] else None
        return d


class InMemoryStore:
    def __init__(self):
        self._lock = threading.RLock()
        self.accounts: dict = {}
        self.orders: dict = {}
        self.proposals: dict = {}
        self.logs: list = []

    # accounts
    def get_account(self, account_id):
        with self._lock:
            return copy.deepcopy(self.accounts.get(account_id))

    def save_account(self, rec: AccountRecord):
        with self._lock:
            self.accounts[rec.account_id] = copy.deepcopy(rec)

    def list_accounts(self):
        with self._lock:
            return [copy.deepcopy(a) for a in self.accounts.values()]

    # orders
    def reserve_order(self, row: OrderRow) -> tuple:
        """Atomic check-and-insert on idempotency_key. Returns (row, created)."""
        with self._lock:
            for r in self.orders.values():
                if r.idempotency_key == row.idempotency_key:
                    return copy.deepcopy(r), False
            self.orders[row.client_order_id] = copy.deepcopy(row)
            return copy.deepcopy(row), True

    def update_order(self, client_order_id, **fields):
        with self._lock:
            r = self.orders[client_order_id]
            for k, v in fields.items():
                setattr(r, k, v)
            r.updated_at = utcnow()
            return copy.deepcopy(r)

    def get_order(self, client_order_id):
        with self._lock:
            r = self.orders.get(client_order_id)
            return copy.deepcopy(r) if r else None

    def list_orders(self, account_id=None, statuses=None, since=None, symbol=None, side=None, limit=200):
        with self._lock:
            rows = [r for r in self.orders.values()
                    if (account_id is None or r.account_id == account_id)
                    and (statuses is None or r.status in statuses)
                    and (since is None or r.created_at >= since)
                    and (symbol is None or r.symbol == symbol.upper())
                    and (side is None or r.side == side)]
            rows.sort(key=lambda r: r.created_at, reverse=True)
            return [copy.deepcopy(r) for r in rows[:limit]]

    # proposals
    def save_proposal(self, p: ProposalRow):
        with self._lock:
            self.proposals[p.proposal_id] = copy.deepcopy(p)

    def get_proposal(self, proposal_id):
        with self._lock:
            p = self.proposals.get(proposal_id)
            return copy.deepcopy(p) if p else None

    def claim_proposal(self, proposal_id, decided_by, new_status) -> Optional[ProposalRow]:
        """Atomically move pending_approval -> new_status so a proposal can be decided exactly once."""
        with self._lock:
            p = self.proposals.get(proposal_id)
            if not p or p.status != "pending_approval":
                return None
            p.status, p.decided_by, p.decided_at = new_status, decided_by, utcnow()
            return copy.deepcopy(p)

    def update_proposal(self, proposal_id, **fields):
        with self._lock:
            p = self.proposals[proposal_id]
            for k, v in fields.items():
                setattr(p, k, v)

    def list_proposals(self, account_id=None, status=None, limit=100):
        with self._lock:
            rows = [p for p in self.proposals.values()
                    if (account_id is None or p.account_id == account_id) and (status is None or p.status == status)]
            rows.sort(key=lambda p: p.created_at, reverse=True)
            return [copy.deepcopy(p) for p in rows[:limit]]

    # logs
    def append_log(self, account_id, event, client_order_id=None, details=None):
        with self._lock:
            self.logs.append({"ts": utcnow(), "account_id": account_id, "event": event,
                              "client_order_id": client_order_id, "details": scrub(details or {})})

    def list_logs(self, account_id=None, event=None, limit=200):
        with self._lock:
            rows = [l for l in self.logs if (account_id is None or l["account_id"] == account_id)
                    and (event is None or l["event"] == event)]
            return list(reversed(rows))[:limit]
