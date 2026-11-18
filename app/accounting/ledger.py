"""General ledger: validated, idempotent, immutable, hash-chained journal postings."""
from __future__ import annotations

import threading
from collections import defaultdict
from datetime import datetime, timezone
from typing import Iterable, Optional

from app.accounting.coa import DEFAULT_ACCOUNTS, RETAINED
from app.accounting.domain import (SCOPES, Account, DuplicateConflict, DuplicateReference, Entry, EntrySpec, Line,
                                   NotFound, PeriodClosedError, StoreConflict, UnbalancedError, ValidationError,
                                   chain_hash, check_currency, check_department, content_digest, parse_date)
from app.accounting.store import Store

_LOCK = threading.RLock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class PostResult:
    def __init__(self, entry: Entry, duplicate: bool):
        self.entry, self.duplicate = entry, duplicate


class Ledger:
    def __init__(self, store: Store):
        self.store = store

    # ------------------------------------------------------------------ chart of accounts
    def seed_chart(self) -> int:
        n = 0
        for a in DEFAULT_ACCOUNTS:
            if self.store.get_account(a.code) is None:
                self.store.put_account(a)
                n += 1
        return n

    def add_account(self, acct: Account) -> Account:
        acct.validate()
        if self.store.get_account(acct.code):
            raise ValidationError(f"account {acct.code} already exists")
        if acct.parent and not self.store.get_account(acct.parent):
            raise ValidationError(f"parent account {acct.parent} does not exist")
        self.store.put_account(acct)
        return acct

    def deactivate_account(self, code: str) -> Account:
        a = self.store.get_account(code)
        if not a:
            raise NotFound(f"account {code} not found")
        d, c = self.raw_balance(code)
        if d != c:
            raise ValidationError("account has a non-zero balance; reverse or transfer it before deactivating")
        a2 = Account(**{**a.__dict__, "active": False})
        self.store.put_account(a2)
        return a2

    def accounts(self) -> dict[str, Account]:
        return {a.code: a for a in self.store.list_accounts()}

    # ------------------------------------------------------------------ posting
    def _validate(self, spec: EntrySpec, accts: dict) -> tuple[str, tuple]:
        if not spec.source or not spec.source_id:
            raise ValidationError("source and source_id are required (they are the idempotency key)")
        if spec.environment not in SCOPES["all"]:
            raise ValidationError(f"environment must be one of {SCOPES['all']}")
        d = parse_date(spec.date)
        if len(spec.lines) < 2:
            raise ValidationError("an entry needs at least two lines")
        lines, totals = [], defaultdict(int)
        for raw in spec.lines:
            ln = raw if isinstance(raw, Line) else Line(**raw)
            if not isinstance(ln.debit, int) or not isinstance(ln.credit, int) or isinstance(ln.debit, bool):
                raise ValidationError("line amounts must be integer units (use money.to_units)")
            if ln.debit < 0 or ln.credit < 0 or (ln.debit > 0) == (ln.credit > 0):
                raise ValidationError("each line must carry exactly one positive amount, either debit or credit")
            a = accts.get(ln.account)
            if a is None:
                raise ValidationError(f"unknown account {ln.account}")
            if not a.postable or not a.active:
                raise ValidationError(f"account {ln.account} cannot be posted to (header or inactive)")
            cur = check_currency(ln.currency)
            dep = check_department(ln.department)
            ref = ln.external_ref.strip() if ln.external_ref else None
            lines.append(Line(ln.account, ln.debit, ln.credit, cur, dep, ln.symbol, ln.strategy, ln.counterparty,
                              ref or None, ln.memo or ""))
            totals[cur] += ln.debit - ln.credit
        bad = {c: v for c, v in totals.items() if v != 0}
        if bad:
            raise UnbalancedError(f"entry is not balanced per currency (debits - credits): {bad}")
        return d.isoformat(), tuple(lines)

    def post(self, spec: EntrySpec) -> PostResult:
        accts = self.accounts()
        date, lines = self._validate(spec, accts)
        period = date[:7]
        digest = content_digest(date, spec.source, spec.source_id, spec.memo, spec.environment, lines,
                                spec.document_id, spec.meta, spec.reverses)
        for _ in range(5):
            with _LOCK:
                existing = self.store.find_entry(spec.source, spec.source_id)
                if existing is not None:
                    if existing.digest != digest:
                        raise DuplicateConflict(
                            f"{spec.source}/{spec.source_id} was already posted with different content "
                            f"({existing.entry_no}); post a reversal and a new source_id to correct it")
                    return PostResult(existing, True)
                if not spec.allow_closed and period in self.store.closed_periods():
                    raise PeriodClosedError(f"period {period} is closed")
                if spec.source != "reversal":
                    for ln in lines:
                        if ln.external_ref:
                            for other in self.store.refs_on_account(ln.account, ln.external_ref):
                                if other.source != "reversal" and self.store.reversal_of(other.id) is None:
                                    raise DuplicateReference(
                                        f"external reference {ln.external_ref} is already booked on account "
                                        f"{ln.account} in {other.entry_no}")
                created = _now()
                prev = self.store.last_hash()
                e = Entry(None, date, period, spec.source, spec.source_id, spec.memo, spec.environment, lines, spec.reverses,
                          spec.document_id, dict(spec.meta), spec.posted_by, created, digest, prev,
                          chain_hash(prev, digest, created))
                try:
                    return PostResult(self.store.append_entry(e), False)
                except StoreConflict:
                    continue
        raise StoreConflict("could not append entry after retries")

    def reverse(self, entry_id: int, date: str, reason: str, by: str = "system") -> PostResult:
        orig = self.store.get_entry(entry_id)
        if orig is None:
            raise NotFound(f"entry {entry_id} not found")
        if orig.reverses is not None:
            raise ValidationError("a reversal entry cannot itself be reversed; post a new entry instead")
        flipped = [Line(l.account, l.credit, l.debit, l.currency, l.department, l.symbol, l.strategy, l.counterparty,
                        l.external_ref, f"reversal: {l.memo}".strip()) for l in orig.lines]
        spec = EntrySpec(date, "reversal", str(entry_id), flipped, f"Reversal of {orig.entry_no}: {reason}".strip(),
                         orig.environment, orig.document_id, dict(orig.meta, reverses=entry_id), by, reverses=entry_id)
        return self.post(spec)

    # ------------------------------------------------------------------ periods
    def close_period(self, period: str, by: str = "system") -> bool:
        if len(period) != 7 or period[4] != "-":
            raise ValidationError("period must be YYYY-MM")
        parse_date(period + "-01")
        return self.store.close_period(period, by, _now())

    def close_year(self, year: int, by: str = "system", environment: str = "internal") -> Optional[PostResult]:
        """Moves each currency's net income for `year` into Retained Earnings (one closing entry per scope/currency)."""
        from app.accounting.reports import trial_balance
        prior = self.store.find_entry("year_close", f"{year}:{environment}")
        if prior is not None:
            return PostResult(prior, True)
        tb = trial_balance(self, f"{year}-12-31", date_from=f"{year}-01-01", scope="all", environment_only=environment)
        accts = self.accounts()
        lines, by_cur = [], defaultdict(int)
        for r in tb["rows"]:
            a = accts[r["account"]]
            if a.type not in ("revenue", "expense"):
                continue
            net = r["debit_units"] - r["credit_units"]
            if net == 0:
                continue
            lines.append(Line(a.code, 0 if net > 0 else -net, net if net > 0 else 0, r["currency"]))
            by_cur[r["currency"]] += net
        if not lines:
            return None
        for cur, net in by_cur.items():
            lines.append(Line(RETAINED, net if net > 0 else 0, 0 if net > 0 else -net, cur))
        return self.post(EntrySpec(f"{year}-12-31", "year_close", f"{year}:{environment}", lines,
                                   f"Close {year} {environment} net income to retained earnings", environment,
                                   posted_by=by, allow_closed=True))

    # ------------------------------------------------------------------ queries
    def raw_balance(self, code: str) -> tuple[int, int]:
        d = c = 0
        for e in self.store.entries():
            for l in e.lines:
                if l.account == code:
                    d += l.debit
                    c += l.credit
        return d, c

    def verify_chain(self) -> dict:
        prev, n = "GENESIS", 0
        for e in self.store.entries():
            n += 1
            ok_digest = content_digest(e.date, e.source, e.source_id, e.memo, e.environment, e.lines, e.document_id,
                                       e.meta, e.reverses) == e.digest
            if e.prev_hash != prev or not ok_digest or chain_hash(e.prev_hash, e.digest, e.created_at) != e.hash:
                return {"ok": False, "entries": n, "first_bad_entry": e.entry_no}
            prev = e.hash
        return {"ok": True, "entries": n, "head": prev}
