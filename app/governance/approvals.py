"""Multi-signature (m-of-n) approvals for treasury and security actions.

An approval request freezes the exact action and parameters; its digest (sha256 over the canonical JSON) is what execution
must present again, so approvers can never be tricked into signing one thing that later runs as another. Rules:
  * the requester can never vote on their own request, and each principal votes once (DB-unique);
  * `required` distinct approvers are needed (GOV_APPROVALS_REQUIRED, default 2; GOV_APPROVALS_BY_ACTION='{"chain.send":3}');
  * any single rejection vetoes; requests expire (GOV_APPROVAL_TTL_MINUTES, default 60);
  * an approval is consumed atomically exactly once, so replays are rejected.
"""
from __future__ import annotations

import hashlib
import json
import os
from datetime import timedelta
from typing import Any, Optional

from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.governance import audit
from app.governance.models import GovApproval, GovApprovalVote, now

ACTIONS = ("chain.send", "allowlist.add", "limits.set", "principal.create", "dr.restore")


class ApprovalError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message, self.status = message, status


def digest_of(action: str, params: dict) -> str:
    return hashlib.sha256(audit.canon({"action": action, "params": params}).encode()).hexdigest()


def required_for(action: str) -> int:
    try:
        by_action = json.loads(os.getenv("GOV_APPROVALS_BY_ACTION") or "{}")
    except ValueError:
        by_action = {}
    try:
        n = int(by_action.get(action, os.getenv("GOV_APPROVALS_REQUIRED", "2")))
    except (TypeError, ValueError):
        n = 2
    return max(2, n)          # a single signature is not multi-signature: never below two


def ttl() -> timedelta:
    try:
        return timedelta(minutes=max(1, int(os.getenv("GOV_APPROVAL_TTL_MINUTES", "60"))))
    except ValueError:
        return timedelta(minutes=60)


def _expire(db: Session, a: GovApproval) -> GovApproval:
    if a.status in ("pending", "approved") and a.expires_at <= now():
        a.status = "expired"
        db.commit()
        audit.append(db, "system", "approval.expired", str(a.id))
    return a


def get(db: Session, approval_id: int) -> GovApproval:
    a = db.get(GovApproval, approval_id)
    if a is None:
        raise ApprovalError("approval not found", 404)
    return _expire(db, a)


def votes(db: Session, approval_id: int) -> list[GovApprovalVote]:
    return list(db.execute(select(GovApprovalVote).where(GovApprovalVote.approval_id == approval_id).order_by(GovApprovalVote.id)).scalars())


def as_dict(db: Session, a: GovApproval) -> dict[str, Any]:
    vs = votes(db, a.id)
    return {"id": a.id, "action": a.action, "params": json.loads(a.params), "digest": a.digest, "reason": a.reason, "requester": a.requester,
            "required": a.required, "approvals": sum(v.decision == "approve" for v in vs), "status": a.status,
            "votes": [{"approver": v.approver, "decision": v.decision, "comment": v.comment, "at": v.created_at.isoformat()} for v in vs],
            "created_at": a.created_at.isoformat(), "expires_at": a.expires_at.isoformat()}


def request(db: Session, action: str, params: dict, requester: str, reason: Optional[str] = None, extra_required: int = 0) -> GovApproval:
    if action not in ACTIONS:
        raise ApprovalError(f"unsupported action; choose one of {', '.join(ACTIONS)}", 422)
    a = GovApproval(action=action, params=audit.canon(params), digest=digest_of(action, params), reason=(reason or "")[:240] or None,
                    requester=requester, required=required_for(action) + max(0, extra_required), expires_at=now() + ttl())
    db.add(a)
    db.commit()
    audit.append(db, requester, "approval.requested", str(a.id), {"action": action, "digest": a.digest, "required": a.required, "reason": reason})
    return a


def vote(db: Session, approval_id: int, approver: str, decision: str, comment: Optional[str] = None) -> GovApproval:
    a = get(db, approval_id)
    if decision not in ("approve", "reject"):
        raise ApprovalError("decision must be approve or reject", 422)
    if a.status != "pending":
        raise ApprovalError(f"approval is {a.status}; it can no longer be voted on", 409)
    if approver == a.requester:
        raise ApprovalError("separation of duties: the requester cannot vote on their own request", 403)
    db.add(GovApprovalVote(approval_id=a.id, approver=approver, decision=decision, comment=(comment or "")[:240] or None))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ApprovalError("this principal has already voted", 409)
    audit.append(db, approver, f"approval.{decision}", str(a.id), {"digest": a.digest})
    if decision == "reject":
        a.status, a.decided_at = "rejected", now()
    elif sum(v.decision == "approve" for v in votes(db, a.id)) >= a.required:
        a.status, a.decided_at = "approved", now()
    db.commit()
    if a.status != "pending":
        audit.append(db, "system", f"approval.{a.status}", str(a.id), {"digest": a.digest})
    return a


def cancel(db: Session, approval_id: int, by: str) -> GovApproval:
    a = get(db, approval_id)
    if a.status not in ("pending", "approved"):
        raise ApprovalError(f"approval is {a.status}", 409)
    a.status, a.decided_at = "cancelled", now()
    db.commit()
    audit.append(db, by, "approval.cancelled", str(a.id))
    return a


def consume(db: Session, approval_id: Optional[int], action: str, params: dict, actor: str) -> GovApproval:
    """Atomically spend an approved request for exactly this action and these parameters."""
    if not approval_id:
        raise ApprovalError("an approved multi-signature approval_id is required for this action", 403)
    a = get(db, approval_id)
    if a.action != action or a.digest != digest_of(action, params):
        audit.append(db, actor, "approval.mismatch", str(a.id), {"action": action})
        raise ApprovalError("approval does not match this action and its exact parameters", 403)
    if a.status != "approved":
        raise ApprovalError(f"approval is {a.status}, not approved", 403)
    done = db.execute(update(GovApproval).where(GovApproval.id == a.id, GovApproval.status == "approved")
                      .values(status="executed", executed_at=now())).rowcount
    db.commit()
    if done != 1:
        raise ApprovalError("approval was already used", 409)
    db.refresh(a)
    audit.append(db, actor, "approval.executed", str(a.id), {"action": action, "digest": a.digest})
    return a


def listing(db: Session, status: Optional[str] = None, limit: int = 100) -> list[dict]:
    q = select(GovApproval).order_by(GovApproval.id.desc()).limit(max(1, min(limit, 500)))
    if status:
        q = q.where(GovApproval.status == status)
    return [as_dict(db, _expire(db, a)) for a in db.execute(q).scalars()]
