"""The send gate: every outgoing transfer/swap/approval passes through here before a key is ever used.

Order: fraud score (block -> refuse) -> role transaction limits -> withdrawal allowlist (transfers) -> m-of-n approval bound
to this exact quote (mainnet; `review` fraud verdicts need one extra signature). Testnets are exempt from allowlist/approval
unless GOV_ENFORCE_TESTNET=true, but are still scored and logged. Enforcement is on in every non-local environment and
opt-in locally via GOVERNANCE_ENFORCE=true, so existing local workflows keep working while production fails closed.
"""
from __future__ import annotations

import os
from typing import Optional

from sqlalchemy.orm import Session

from app.governance import allowlist, approvals, audit, fraud, keys, limits


class GateError(Exception):
    def __init__(self, message: str, status: int = 403):
        super().__init__(message)
        self.message, self.status = message, status


def enforced() -> bool:
    raw = (os.getenv("GOVERNANCE_ENFORCE") or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return not keys.is_local()


def send_params(q: dict) -> dict:
    """What approvers sign: the sealed quote's immutable fields (qid binds it to this one quote)."""
    import hashlib
    return {"qid": q["qid"], "network": q["network"], "kind": q["kind"], "to": q["to"], "value": str(q["value"]),
            "data_sha256": hashlib.sha256(str(q.get("data", "")).encode()).hexdigest(), "notional": str(q["notional"])}


def enforce_send(db: Session, *, net, q: dict, approval_id: Optional[int], actor: str, role: str) -> dict:
    if not enforced():
        return {"enforced": False}
    mainnet = bool(net.mainnet) or os.getenv("GOV_ENFORCE_TESTNET", "").lower() in ("1", "true", "yes")
    notional = int(q["notional"])
    subject = f"{net.key}:{q['kind']}:{q['to']}"
    verdict = fraud.evaluate_transfer(db, network=net.key, to=q["to"], notional=notional, kind=q["kind"], actor=actor)
    fraud.record(db, verdict, actor, subject)
    if verdict.level == "block":
        audit.append(db, actor, "gate.blocked", subject, {"reason": "fraud", "score": verdict.score})
        raise GateError("blocked by fraud detection: " + "; ".join(r["why"] for r in verdict.rules))
    over = limits.violations(db, role, net.key, notional)
    if over:
        audit.append(db, actor, "gate.blocked", subject, {"reason": "limits", "detail": over})
        raise GateError("transaction limit: " + "; ".join(over))
    if mainnet and q["kind"] == "transfer":
        ok, why = allowlist.check(db, net.key, q["to"])
        if not ok:
            audit.append(db, actor, "gate.blocked", subject, {"reason": "allowlist", "detail": why})
            raise GateError("withdrawal allowlist: " + why)
    if mainnet and not limits.approval_exempt(db, role, net.key, notional):
        try:
            a = approvals.get(db, approval_id) if approval_id else None
            if a is not None and verdict.level == "review" and a.required < approvals.required_for("chain.send") + 1:
                raise approvals.ApprovalError("fraud review: this transfer needs one additional approval signature (request a new approval)", 403)
            approvals.consume(db, approval_id, "chain.send", send_params(q), actor)
        except approvals.ApprovalError as e:
            audit.append(db, actor, "gate.blocked", subject, {"reason": "approval", "detail": e.message})
            raise GateError("multi-signature approval: " + e.message, e.status)
    audit.append(db, actor, "gate.allowed", subject, {"score": verdict.score, "level": verdict.level, "approval_id": approval_id})
    return {"enforced": True, "fraud": verdict.as_dict()}
