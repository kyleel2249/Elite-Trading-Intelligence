"""Persistence protocol + in-memory implementation (used by tests and as the reference behaviour)."""
from __future__ import annotations

import threading
from typing import Optional, Protocol

from app.accounting.domain import Account, Entry, StoreConflict


class ExtTxn:
    """External transaction (bank / exchange / blockchain) as reported by the outside world."""
    __slots__ = ("source", "ext_id", "ts", "account", "currency", "amount", "fee", "kind", "counterparty",
                 "confirmations", "meta", "created_at")

    def __init__(self, source, ext_id, ts, account, currency, amount, fee=0, kind="bank", counterparty=None,
                 confirmations=None, meta=None, created_at=""):
        self.source, self.ext_id, self.ts, self.account, self.currency = source, ext_id, ts, account, currency
        self.amount, self.fee, self.kind, self.counterparty = int(amount), int(fee), kind, counterparty
        self.confirmations, self.meta, self.created_at = confirmations, meta or {}, created_at

    def as_dict(self) -> dict:
        return {k: getattr(self, k) for k in self.__slots__}


class Store(Protocol):
    def list_accounts(self) -> list[Account]: ...
    def get_account(self, code: str) -> Optional[Account]: ...
    def put_account(self, acct: Account) -> None: ...
    def find_entry(self, source: str, source_id: str) -> Optional[Entry]: ...
    def get_entry(self, entry_id: int) -> Optional[Entry]: ...
    def reversal_of(self, entry_id: int) -> Optional[Entry]: ...
    def last_hash(self) -> str: ...
    def append_entry(self, entry: Entry) -> Entry: ...
    def entries(self, date_from: Optional[str] = None, date_to: Optional[str] = None) -> list[Entry]: ...
    def refs_on_account(self, account: str, ref: str) -> list[Entry]: ...
    def closed_periods(self) -> dict: ...
    def close_period(self, period: str, by: str, ts: str) -> bool: ...
    def add_ext_txn(self, t: ExtTxn) -> bool: ...
    def ext_txns(self, source: Optional[str] = None, account: Optional[str] = None) -> list[ExtTxn]: ...
    def save_run(self, run: dict) -> dict: ...
    def runs(self, kind: Optional[str] = None, limit: int = 50) -> list[dict]: ...


class MemoryStore:
    def __init__(self):
        self._lock = threading.RLock()
        self._accounts: dict[str, Account] = {}
        self._entries: list[Entry] = []
        self._by_key: dict[tuple, Entry] = {}
        self._periods: dict[str, dict] = {}
        self._ext: dict[tuple, ExtTxn] = {}
        self._runs: list[dict] = []

    def list_accounts(self):
        return sorted(self._accounts.values(), key=lambda a: a.code)

    def get_account(self, code):
        return self._accounts.get(code)

    def put_account(self, acct):
        self._accounts[acct.code] = acct

    def find_entry(self, source, source_id):
        return self._by_key.get((source, source_id))

    def get_entry(self, entry_id):
        return next((e for e in self._entries if e.id == entry_id), None)

    def reversal_of(self, entry_id):
        return next((e for e in self._entries if e.reverses == entry_id), None)

    def last_hash(self):
        return self._entries[-1].hash if self._entries else "GENESIS"

    def append_entry(self, entry):
        with self._lock:
            if (entry.source, entry.source_id) in self._by_key or entry.prev_hash != self.last_hash():
                raise StoreConflict()
            entry.id = len(self._entries) + 1
            self._entries.append(entry)
            self._by_key[(entry.source, entry.source_id)] = entry
            return entry

    def entries(self, date_from=None, date_to=None):
        return [e for e in self._entries if (not date_from or e.date >= date_from) and (not date_to or e.date <= date_to)]

    def refs_on_account(self, account, ref):
        r = ref.lower()
        return [e for e in self._entries if any(l.account == account and (l.external_ref or "").lower() == r for l in e.lines)]

    def closed_periods(self):
        return dict(self._periods)

    def close_period(self, period, by, ts):
        if period in self._periods:
            return False
        self._periods[period] = {"period": period, "closed_by": by, "closed_at": ts}
        return True

    def add_ext_txn(self, t):
        k = (t.source, t.ext_id)
        if k in self._ext:
            return False
        self._ext[k] = t
        return True

    def ext_txns(self, source=None, account=None):
        return [t for t in self._ext.values() if (not source or t.source == source) and (not account or t.account == account)]

    def save_run(self, run):
        run = dict(run, id=len(self._runs) + 1)
        self._runs.append(run)
        return run

    def runs(self, kind=None, limit=50):
        rows = [r for r in self._runs if not kind or r.get("kind") == kind]
        return list(reversed(rows))[:limit]
