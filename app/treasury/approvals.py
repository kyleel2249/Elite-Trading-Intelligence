"""M-of-N withdrawal approval using real secp256k1 signatures.

A withdrawal request has a canonical digest. Each approver signs that digest with their own key; the signer is
*recovered* from the signature (never taken from the caller). A request is authorized only when `threshold`
distinct authorized approvers, none of whom is the requester, have signed an unexpired request. Authorization is
single-use: `consume()` marks it spent, so an approved request cannot be replayed into a second broadcast.
"""
from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional

from app.chain.crypto import is_address, keccak256, recover_address


class ApprovalError(Exception):
    def __init__(self, message: str, code: str = "approval_error"):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ApprovalPolicy:
    threshold: int
    approvers: frozenset
    ttl_seconds: int = 3600

    def __post_init__(self):
        approvers = frozenset(a.lower() for a in self.approvers)
        object.__setattr__(self, "approvers", approvers)
        if not all(is_address(a) for a in approvers):
            raise ApprovalError("every approver must be a valid address", "bad_policy")
        if not 1 <= self.threshold <= len(approvers):
            raise ApprovalError("threshold must be between 1 and the number of approvers", "bad_policy")
        if self.threshold < 2:
            raise ApprovalError("multi-signature requires a threshold of at least 2", "bad_policy")


@dataclass
class WithdrawalRequest:
    network: str
    to: str
    amount_wei: int
    requester: str
    nonce: str                      # caller-supplied unique id; part of the digest so identical sends stay distinct
    created_at: datetime
    expires_at: datetime
    signatures: dict = field(default_factory=dict)   # approver address (lower) -> (r, s, recid)
    consumed: bool = False

    def digest(self) -> bytes:
        payload = json.dumps([self.network, self.to.lower(), int(self.amount_wei), self.requester.lower(), self.nonce,
                              self.expires_at.isoformat()], separators=(",", ":"))
        return keccak256(b"ETI-WITHDRAWAL-V1|" + payload.encode())

    @property
    def request_id(self) -> str:
        return "0x" + self.digest().hex()


class MemoryApprovalStore:
    """Process-local store (tests/dev). Production uses SqlApprovalStore."""
    def __init__(self):
        self._reqs: dict[str, WithdrawalRequest] = {}

    def add(self, req: WithdrawalRequest) -> bool:
        if req.request_id in self._reqs:
            return False
        self._reqs[req.request_id] = req
        return True

    def get(self, request_id: str) -> Optional[WithdrawalRequest]:
        return self._reqs.get(request_id)

    def save_signature(self, req: WithdrawalRequest) -> None:
        pass

    def consume(self, request_id: str) -> bool:
        r = self._reqs[request_id]
        if r.consumed:
            return False
        r.consumed = True
        return True


class ApprovalBook:
    def __init__(self, policy: ApprovalPolicy, now=lambda: datetime.now(timezone.utc), store=None):
        self.policy, self._now = policy, now
        self.store = store or MemoryApprovalStore()
        self._lock = threading.RLock()

    def create(self, *, network: str, to: str, amount_wei: int, requester: str, nonce: str) -> WithdrawalRequest:
        if not is_address(to) or not is_address(requester):
            raise ApprovalError("invalid address", "bad_request")
        if not isinstance(amount_wei, int) or isinstance(amount_wei, bool) or amount_wei <= 0:
            raise ApprovalError("amount must be a positive integer", "bad_request")
        if not nonce:
            raise ApprovalError("nonce is required", "bad_request")
        now = self._now().replace(microsecond=0)
        req = WithdrawalRequest(network, to, amount_wei, requester, nonce, now, now + timedelta(seconds=self.policy.ttl_seconds))
        with self._lock:
            if not self.store.add(req):
                raise ApprovalError("a request with this nonce already exists", "duplicate_request")
        return req

    def get(self, request_id: str) -> WithdrawalRequest:
        req = self.store.get(request_id)
        if not req:
            raise ApprovalError("unknown request", "not_found")
        return req

    def approve(self, request_id: str, r: int, s: int, recid: int) -> str:
        """Record a signature. The approver is recovered from the signature; returns the recovered address."""
        with self._lock:
            req = self.get(request_id)
            if req.consumed:
                raise ApprovalError("request already executed", "already_consumed")
            if self._now() >= req.expires_at:
                raise ApprovalError("request expired", "expired")
            try:
                signer = recover_address(req.digest(), r, s, recid).lower()
            except ValueError:
                raise ApprovalError("invalid signature", "bad_signature")
            if signer not in self.policy.approvers:
                raise ApprovalError("signer is not an authorized approver", "unauthorized_signer")
            if signer == req.requester.lower():
                raise ApprovalError("the requester cannot approve their own withdrawal", "self_approval")
            if signer in req.signatures:
                raise ApprovalError("this approver has already signed", "duplicate_approval")
            req.signatures[signer] = (r, s, recid)
            self.store.save_signature(req)
            return signer

    def is_authorized(self, request_id: str) -> bool:
        req = self.get(request_id)
        return (not req.consumed and self._now() < req.expires_at and len(req.signatures) >= self.policy.threshold)

    def consume(self, request_id: str) -> WithdrawalRequest:
        """Atomically spend an authorization. Raises unless fully approved, unexpired and unspent."""
        with self._lock:
            req = self.get(request_id)
            if req.consumed:
                raise ApprovalError("request already executed", "already_consumed")
            if self._now() >= req.expires_at:
                raise ApprovalError("request expired", "expired")
            if len(req.signatures) < self.policy.threshold:
                raise ApprovalError(f"{len(req.signatures)} of {self.policy.threshold} required approvals", "insufficient_approvals")
            if not self.store.consume(request_id):       # atomic across processes for the SQL store
                raise ApprovalError("request already executed", "already_consumed")
            req.consumed = True
            return req


# ---------------------------------------------------------------------------------- SQL store + environment policy
class SqlApprovalStore:
    def __init__(self, db):
        self.db = db

    @staticmethod
    def _to_req(row) -> WithdrawalRequest:
        ts = lambda v: datetime.fromtimestamp(v, timezone.utc)  # noqa: E731
        return WithdrawalRequest(row.network, row.to_address, int(row.amount_wei), row.requester, row.nonce, ts(row.created_at),
                                 ts(row.expires_at), {k: (int(v[0], 16), int(v[1], 16), int(v[2])) for k, v in (row.signatures or {}).items()},
                                 bool(row.consumed))

    def add(self, req: WithdrawalRequest) -> bool:
        from sqlalchemy.exc import IntegrityError
        from app.treasury.models import WithdrawalApproval
        self.db.add(WithdrawalApproval(request_id=req.request_id, network=req.network, to_address=req.to, amount_wei=str(req.amount_wei),
                                       requester=req.requester, nonce=req.nonce, created_at=int(req.created_at.timestamp()),
                                       expires_at=int(req.expires_at.timestamp()), signatures={}, consumed=False))
        try:
            self.db.commit()
            return True
        except IntegrityError:
            self.db.rollback()
            return False

    def _row(self, request_id: str):
        from sqlalchemy import select
        from app.treasury.models import WithdrawalApproval
        return self.db.execute(select(WithdrawalApproval).where(WithdrawalApproval.request_id == request_id)).scalar_one_or_none()

    def get(self, request_id: str) -> Optional[WithdrawalRequest]:
        self.db.expire_all()
        row = self._row(request_id)
        return self._to_req(row) if row else None

    def save_signature(self, req: WithdrawalRequest) -> None:
        row = self._row(req.request_id)
        row.signatures = {k: [f"{v[0]:x}", f"{v[1]:x}", int(v[2])] for k, v in req.signatures.items()}
        self.db.commit()

    def consume(self, request_id: str) -> bool:
        from sqlalchemy import update
        from app.treasury.models import WithdrawalApproval
        res = self.db.execute(update(WithdrawalApproval).where(WithdrawalApproval.request_id == request_id,
                                                               WithdrawalApproval.consumed.is_(False)).values(consumed=True))
        self.db.commit()
        return res.rowcount == 1


def load_policy() -> Optional[ApprovalPolicy]:
    """CHAIN_MULTISIG_APPROVERS (comma-separated addresses) + CHAIN_MULTISIG_THRESHOLD (>=2). None when not configured."""
    import os
    raw = [a.strip() for a in os.getenv("CHAIN_MULTISIG_APPROVERS", "").split(",") if a.strip()]
    if not raw:
        return None
    try:
        return ApprovalPolicy(int(os.getenv("CHAIN_MULTISIG_THRESHOLD", "2")), frozenset(raw),
                              int(os.getenv("CHAIN_MULTISIG_TTL_SECONDS", "3600")))
    except (ValueError, ApprovalError):
        return None     # an invalid policy is treated as "not configured": sends that require approval then fail closed
