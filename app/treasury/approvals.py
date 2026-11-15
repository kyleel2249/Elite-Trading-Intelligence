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


class ApprovalBook:
    def __init__(self, policy: ApprovalPolicy, now=lambda: datetime.now(timezone.utc)):
        self.policy, self._now = policy, now
        self._reqs: dict[str, WithdrawalRequest] = {}
        self._lock = threading.RLock()

    def create(self, *, network: str, to: str, amount_wei: int, requester: str, nonce: str) -> WithdrawalRequest:
        if not is_address(to) or not is_address(requester):
            raise ApprovalError("invalid address", "bad_request")
        if not isinstance(amount_wei, int) or isinstance(amount_wei, bool) or amount_wei <= 0:
            raise ApprovalError("amount must be a positive integer", "bad_request")
        if not nonce:
            raise ApprovalError("nonce is required", "bad_request")
        now = self._now()
        req = WithdrawalRequest(network, to, amount_wei, requester, nonce, now, now + timedelta(seconds=self.policy.ttl_seconds))
        with self._lock:
            if req.request_id in self._reqs:
                raise ApprovalError("a request with this nonce already exists", "duplicate_request")
            self._reqs[req.request_id] = req
        return req

    def get(self, request_id: str) -> WithdrawalRequest:
        req = self._reqs.get(request_id)
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
            req.consumed = True
            return req
