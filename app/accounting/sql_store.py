"""SQLAlchemy implementation of the accounting Store."""
from __future__ import annotations

from typing import Callable, Optional

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.accounting.domain import Account, Entry, Line, StoreConflict
from app.accounting.models import (AcctAccount, AcctEntry, AcctExtTxn, AcctLine, AcctPeriod, AcctReconRun)
from app.accounting.store import ExtTxn


def _entry(r: AcctEntry) -> Entry:
    lines = tuple(Line(l.account, int(l.debit), int(l.credit), l.currency, l.department, l.symbol, l.strategy,
                       l.counterparty, l.external_ref, l.memo or "") for l in r.lines)
    return Entry(r.id, r.entry_date, r.period, r.source, r.source_id, r.memo or "", r.environment, lines, r.reverses,
                 r.document_id, dict(r.meta or {}), r.posted_by, r.created_at, r.digest, r.prev_hash, r.entry_hash)


def _acct(r: AcctAccount) -> Account:
    return Account(r.code, r.name, r.type, r.parent, r.postable, r.cash, r.cashflow, r.group_name or "", r.active)


class SqlStore:
    def __init__(self, session_factory: Callable):
        self._sf = session_factory

    def _run(self, fn):
        db = self._sf()
        try:
            return fn(db)
        finally:
            db.close()

    # accounts ---------------------------------------------------------------------------------------------
    def list_accounts(self):
        return self._run(lambda db: [_acct(r) for r in db.scalars(select(AcctAccount).order_by(AcctAccount.code))])

    def get_account(self, code):
        return self._run(lambda db: (lambda r: _acct(r) if r else None)(db.get(AcctAccount, code)))

    def put_account(self, a: Account):
        def go(db):
            r = db.get(AcctAccount, a.code) or AcctAccount(code=a.code)
            r.name, r.type, r.parent, r.postable, r.cash = a.name, a.type, a.parent, a.postable, a.cash
            r.cashflow, r.group_name, r.active = a.cashflow, a.group, a.active
            db.add(r)
            db.commit()
        self._run(go)

    # entries ----------------------------------------------------------------------------------------------
    def find_entry(self, source, source_id):
        return self._run(lambda db: (lambda r: _entry(r) if r else None)(
            db.scalar(select(AcctEntry).where(AcctEntry.source == source, AcctEntry.source_id == source_id))))

    def get_entry(self, entry_id):
        return self._run(lambda db: (lambda r: _entry(r) if r else None)(db.get(AcctEntry, entry_id)))

    def reversal_of(self, entry_id):
        return self._run(lambda db: (lambda r: _entry(r) if r else None)(
            db.scalar(select(AcctEntry).where(AcctEntry.reverses == entry_id))))

    def last_hash(self):
        return self._run(lambda db: db.scalar(select(AcctEntry.entry_hash).order_by(AcctEntry.id.desc()).limit(1)) or "GENESIS")

    def append_entry(self, e: Entry):
        def go(db):
            row = AcctEntry(entry_date=e.date, period=e.period, source=e.source, source_id=e.source_id, memo=e.memo,
                            environment=e.environment, reverses=e.reverses, document_id=e.document_id, meta=e.meta,
                            posted_by=e.posted_by, created_at=e.created_at, digest=e.digest, prev_hash=e.prev_hash,
                            entry_hash=e.hash)
            for i, l in enumerate(e.lines):
                row.lines.append(AcctLine(seq=i, account=l.account, debit=l.debit, credit=l.credit, currency=l.currency,
                                          department=l.department, symbol=l.symbol, strategy=l.strategy,
                                          counterparty=l.counterparty, external_ref=l.external_ref, memo=l.memo))
            db.add(row)
            try:
                db.commit()
            except IntegrityError:
                db.rollback()
                raise StoreConflict()
            db.refresh(row)
            return _entry(row)
        return self._run(go)

    def entries(self, date_from=None, date_to=None):
        def go(db):
            q = select(AcctEntry).order_by(AcctEntry.id)
            if date_from:
                q = q.where(AcctEntry.entry_date >= date_from)
            if date_to:
                q = q.where(AcctEntry.entry_date <= date_to)
            return [_entry(r) for r in db.scalars(q)]
        return self._run(go)

    def refs_on_account(self, account, ref):
        def go(db):
            ids = db.scalars(select(AcctLine.entry_id).where(AcctLine.account == account,
                                                             func.lower(AcctLine.external_ref) == ref.lower()).distinct()).all()
            return [_entry(db.get(AcctEntry, i)) for i in ids]
        return self._run(go)

    # periods ----------------------------------------------------------------------------------------------
    def closed_periods(self):
        return self._run(lambda db: {r.period: {"period": r.period, "closed_by": r.closed_by, "closed_at": r.closed_at}
                                     for r in db.scalars(select(AcctPeriod))})

    def close_period(self, period, by, ts):
        def go(db):
            if db.get(AcctPeriod, period):
                return False
            db.add(AcctPeriod(period=period, closed_by=by, closed_at=ts))
            db.commit()
            return True
        return self._run(go)

    # external transactions --------------------------------------------------------------------------------
    def add_ext_txn(self, t: ExtTxn):
        def go(db):
            db.add(AcctExtTxn(source=t.source, ext_id=t.ext_id, ts=t.ts, account=t.account, currency=t.currency,
                              amount=t.amount, fee=t.fee, kind=t.kind, counterparty=t.counterparty,
                              confirmations=t.confirmations, meta=t.meta, created_at=t.created_at))
            try:
                db.commit()
                return True
            except IntegrityError:
                db.rollback()
                return False
        return self._run(go)

    def ext_txns(self, source=None, account=None):
        def go(db):
            q = select(AcctExtTxn).order_by(AcctExtTxn.id)
            if source:
                q = q.where(AcctExtTxn.source == source)
            if account:
                q = q.where(AcctExtTxn.account == account)
            return [ExtTxn(r.source, r.ext_id, r.ts, r.account, r.currency, int(r.amount), int(r.fee), r.kind,
                           r.counterparty, r.confirmations, dict(r.meta or {}), r.created_at) for r in db.scalars(q)]
        return self._run(go)

    # reconciliation runs ----------------------------------------------------------------------------------
    def save_run(self, run: dict):
        def go(db):
            r = AcctReconRun(kind=run["kind"], source=run.get("source", ""), account=run.get("account", ""),
                             date_from=run.get("from"), date_to=run.get("to"), status=run["status"],
                             counts=run.get("counts", {}), ran_at=run["ran_at"], result=run.get("result", {}))
            db.add(r)
            db.commit()
            return dict(run, id=r.id)
        return self._run(go)

    def runs(self, kind=None, limit=50):
        def go(db):
            q = select(AcctReconRun).order_by(AcctReconRun.id.desc()).limit(limit)
            if kind:
                q = q.where(AcctReconRun.kind == kind)
            return [{"id": r.id, "kind": r.kind, "source": r.source, "account": r.account, "from": r.date_from,
                     "to": r.date_to, "status": r.status, "counts": r.counts, "ran_at": r.ran_at, "result": r.result}
                    for r in db.scalars(q)]
        return self._run(go)
