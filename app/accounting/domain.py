from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import date as _date
from typing import Optional

ENVIRONMENTS = ("internal", "live", "testnet", "paper")
SCOPES = {"real": ("internal", "live"), "simulated": ("testnet", "paper"), "all": ENVIRONMENTS}
ACCOUNT_TYPES = ("asset", "liability", "equity", "revenue", "expense")
DEBIT_NORMAL = ("asset", "expense")
CASHFLOW = ("operating", "investing", "financing")
_DEPT_RE = re.compile(r"^[A-Za-z][A-Za-z0-9 &_-]{0,39}$")
_CUR_RE = re.compile(r"^[A-Z][A-Z0-9]{1,9}$")
_CODE_RE = re.compile(r"^[0-9]{4,8}$")


class AccountingError(Exception):
    code = "accounting_error"

    def __init__(self, message: str, code: Optional[str] = None):
        super().__init__(message)
        if code:
            self.code = code


class ValidationError(AccountingError):
    code = "validation_error"


class UnbalancedError(ValidationError):
    code = "unbalanced_entry"


class PeriodClosedError(AccountingError):
    code = "period_closed"


class DuplicateConflict(AccountingError):
    """Same (source, source_id) re-posted with different content."""
    code = "duplicate_conflict"


class DuplicateReference(AccountingError):
    code = "duplicate_external_reference"


class NotFound(AccountingError):
    code = "not_found"


class StoreConflict(Exception):
    """Concurrent append lost the race (hash chain / unique key); the ledger retries."""


@dataclass(frozen=True)
class Account:
    code: str
    name: str
    type: str                      # asset | liability | equity | revenue | expense
    parent: Optional[str] = None
    postable: bool = True
    cash: bool = False             # cash / cash-equivalent for the cash-flow statement
    cashflow: str = "operating"    # category when this account is the counter-side of a cash movement
    group: str = ""
    active: bool = True

    @property
    def debit_normal(self) -> bool:
        return self.type in DEBIT_NORMAL

    def validate(self) -> None:
        if not _CODE_RE.match(self.code):
            raise ValidationError("account code must be 4-8 digits")
        if self.type not in ACCOUNT_TYPES:
            raise ValidationError(f"account type must be one of {ACCOUNT_TYPES}")
        if self.cashflow not in CASHFLOW:
            raise ValidationError(f"cashflow must be one of {CASHFLOW}")
        if not self.name.strip():
            raise ValidationError("account name required")
        if self.cash and self.type != "asset":
            raise ValidationError("only asset accounts can be cash accounts")


@dataclass(frozen=True)
class Line:
    account: str
    debit: int = 0
    credit: int = 0
    currency: str = "USD"
    department: Optional[str] = None
    symbol: Optional[str] = None
    strategy: Optional[str] = None
    counterparty: Optional[str] = None
    external_ref: Optional[str] = None
    memo: str = ""

    def canon(self) -> list:
        return [self.account, self.debit, self.credit, self.currency, self.department, self.symbol, self.strategy,
                self.counterparty, self.external_ref, self.memo]


@dataclass
class EntrySpec:
    """What a caller submits. `source` + `source_id` are the idempotency key (mandatory)."""
    date: str
    source: str
    source_id: str
    lines: list
    memo: str = ""
    environment: str = "internal"
    document_id: Optional[str] = None
    meta: dict = field(default_factory=dict)
    posted_by: str = "system"
    allow_closed: bool = False     # internal: year-end closing entries only
    reverses: Optional[int] = None


@dataclass
class Entry:
    id: Optional[int]
    date: str
    period: str
    source: str
    source_id: str
    memo: str
    environment: str
    lines: tuple
    reverses: Optional[int]
    document_id: Optional[str]
    meta: dict
    posted_by: str
    created_at: str
    digest: str
    prev_hash: str
    hash: str

    @property
    def entry_no(self) -> str:
        return f"JE-{self.id:07d}" if self.id is not None else "JE-pending"


def content_digest(date: str, source: str, source_id: str, memo: str, environment: str, lines, document_id, meta,
                   reverses=None) -> str:
    payload = json.dumps([date, source, source_id, memo, environment, [l.canon() for l in lines], document_id,
                          meta or {}, reverses], sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode()).hexdigest()


def chain_hash(prev_hash: str, digest: str, created_at: str) -> str:
    return hashlib.sha256(f"{prev_hash}|{digest}|{created_at}".encode()).hexdigest()


def parse_date(s: str) -> _date:
    try:
        return _date.fromisoformat(str(s)[:10])
    except ValueError:
        raise ValidationError(f"invalid date {s!r}; use YYYY-MM-DD")


def check_department(d: Optional[str]) -> Optional[str]:
    if d is None or d == "":
        return None
    if not _DEPT_RE.match(d):
        raise ValidationError(f"invalid department {d!r}")
    return d


def check_currency(c: str) -> str:
    c = (c or "").upper()
    if not _CUR_RE.match(c):
        raise ValidationError(f"invalid currency {c!r}")
    return c
