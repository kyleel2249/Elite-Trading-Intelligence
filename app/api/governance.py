"""Security & compliance API (/api/security). Identity = X-API-Key (platform key or a per-principal key); privileged routes also
need X-MFA-Code. Nothing here returns a key, seed or passphrase except the one-time issuance responses, which are never stored."""
from __future__ import annotations

from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.chain.service import ChainError, ChainService
from app.config import Settings, get_settings
from app.database import get_db
from app.governance import allowlist, approvals, audit, dr, fraud, gate, keys, limits, mfa, posture, rbac
from app.governance.models import GovPrincipal
from app.governance.rbac import Principal, require

router = APIRouter(prefix="/api/security", tags=["security-governance"])


def _guard(fn):
    import functools

    @functools.wraps(fn)
    def w(*a, **k):
        try:
            return fn(*a, **k)
        except (approvals.ApprovalError, allowlist.AllowlistError, limits.LimitError, dr.DRError) as e:
            raise HTTPException(e.status, e.message)
        except keys.GovernanceKeyError as e:
            raise HTTPException(503, str(e))
    return w


def _guard_async(fn):
    import functools

    @functools.wraps(fn)
    async def w(*a, **k):
        try:
            return await fn(*a, **k)
        except (approvals.ApprovalError, allowlist.AllowlistError, limits.LimitError, dr.DRError) as e:
            raise HTTPException(e.status, e.message)
        except ChainError as e:
            raise HTTPException(e.status, e.message)
        except keys.GovernanceKeyError as e:
            raise HTTPException(503, str(e))
    return w


# ------------------------------------------------------------------ identity, posture, principals
@router.get("/me")
def me(p: Principal = Depends(require("security.read")), db: Session = Depends(get_db)) -> dict[str, Any]:
    row = rbac.get_principal_row(db, p.name)
    return {"name": p.name, "role": p.role, "via": p.via, "mfa_enrolled": bool(row and row.totp_enrolled), "mfa_required": rbac.mfa_required(),
            "permissions": sorted(k for k, roles in rbac.PERMISSIONS.items() if p.role in roles),
            "privileged_permissions": sorted(rbac.PRIVILEGED)}


@router.get("/posture")
@_guard
def get_posture(p: Principal = Depends(require("security.read")), db: Session = Depends(get_db)) -> dict[str, Any]:
    return posture.report(db)


class PrincipalIn(BaseModel):
    name: str = Field(..., pattern=rbac.NAME_RE.pattern)
    role: str = Field(..., max_length=24)


@router.get("/principals")
def principals(p: Principal = Depends(require("security.read")), db: Session = Depends(get_db)) -> dict[str, Any]:
    from sqlalchemy import select
    if not p.can("principal.manage") and not p.can("audit.read"):
        raise HTTPException(403, "not permitted to list principals")
    return {"principals": [{"name": r.name, "role": r.role, "active": bool(r.active), "mfa_enrolled": bool(r.totp_enrolled), "key_hint": r.key_hint,
                            "created_by": r.created_by, "created_at": r.created_at.isoformat()} for r in db.execute(select(GovPrincipal)).scalars()],
            "roles": list(rbac.ROLES)}


@router.post("/principals")
@_guard
def create_principal(body: PrincipalIn, p: Principal = Depends(require("principal.manage")), db: Session = Depends(get_db)) -> dict[str, Any]:
    if body.role not in rbac.ROLES:
        raise HTTPException(422, "role must be one of " + ", ".join(rbac.ROLES))
    if body.name in (rbac.MASTER, rbac.LOCAL) or rbac.get_principal_row(db, body.name):
        raise HTTPException(409, "a principal with that name already exists")
    if body.role == "admin" and p.role != "admin":
        raise HTTPException(403, "only an admin can create another admin")
    key = rbac.issue_key()
    db.add(GovPrincipal(name=body.name, role=body.role, key_hash=rbac.hash_key(key), key_hint=key[-4:], created_by=p.name))
    db.commit()
    audit.append(db, p.name, "principal.created", body.name, {"role": body.role})
    return {"name": body.name, "role": body.role, "api_key": key, "note": "Shown once and never stored in recoverable form. Give it to the principal; they then enrol MFA."}


def _target(db: Session, name: str) -> GovPrincipal:
    row = rbac.get_principal_row(db, name)
    if row is None:
        raise HTTPException(404, "principal not found")
    return row


@router.post("/principals/{name}/disable")
@_guard
def disable_principal(name: str, p: Principal = Depends(require("principal.manage")), db: Session = Depends(get_db)) -> dict[str, Any]:
    row = _target(db, name)
    if row.name == p.name:
        raise HTTPException(409, "you cannot disable yourself")
    row.active = False
    db.commit()
    audit.append(db, p.name, "principal.disabled", name)
    return {"name": name, "active": False}


@router.post("/principals/{name}/rotate-key")
@_guard
def rotate_key(name: str, p: Principal = Depends(require("principal.manage")), db: Session = Depends(get_db)) -> dict[str, Any]:
    row = _target(db, name)
    if row.name in (rbac.MASTER, rbac.LOCAL):
        raise HTTPException(409, "the platform key is rotated via the API_KEY secret, not here")
    key = rbac.issue_key()
    row.key_hash, row.key_hint = rbac.hash_key(key), key[-4:]
    db.commit()
    audit.append(db, p.name, "principal.key_rotated", name)
    return {"name": name, "api_key": key, "note": "The previous key stopped working immediately."}


@router.post("/principals/{name}/reset-mfa")
@_guard
def reset_mfa(name: str, p: Principal = Depends(require("principal.manage")), db: Session = Depends(get_db)) -> dict[str, Any]:
    mfa.reset(db, _target(db, name), p.name)
    return {"name": name, "mfa_enrolled": False}


# ------------------------------------------------------------------ MFA self-service
class CodeIn(BaseModel):
    code: str = Field(..., min_length=6, max_length=16)


def _self(db: Session, p: Principal) -> GovPrincipal:
    return rbac.ensure_builtin(db, p.name) if p.via != "key" else _target(db, p.name)


@router.post("/mfa/enroll")
@_guard
def mfa_enroll(p: Principal = Depends(require("security.read")), db: Session = Depends(get_db),
               x_mfa_code: Optional[str] = Header(default=None)) -> dict[str, Any]:
    row = _self(db, p)
    if row.totp_enrolled and not mfa.verify(db, row, x_mfa_code):
        raise HTTPException(403, "re-enrolling requires a valid current X-MFA-Code")
    return mfa.begin_enrollment(db, row)


@router.post("/mfa/confirm")
@_guard
def mfa_confirm(body: CodeIn, p: Principal = Depends(require("security.read")), db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        return mfa.confirm_enrollment(db, _self(db, p), body.code)
    except PermissionError as e:
        raise HTTPException(403, str(e))


# ------------------------------------------------------------------ audit
@router.get("/audit")
@_guard
def audit_log(limit: int = Query(100, ge=1, le=1000), action: Optional[str] = Query(None, max_length=64), actor: Optional[str] = Query(None, max_length=64),
              p: Principal = Depends(require("audit.read")), db: Session = Depends(get_db)) -> dict[str, Any]:
    return {"entries": audit.recent(db, limit, action, actor)}


@router.get("/audit/verify")
@_guard
def audit_verify(p: Principal = Depends(require("audit.read")), db: Session = Depends(get_db)) -> dict[str, Any]:
    return audit.verify(db)


@router.get("/audit/head")
@_guard
def audit_head(p: Principal = Depends(require("audit.read")), db: Session = Depends(get_db)) -> dict[str, Any]:
    return audit.head(db)


# ------------------------------------------------------------------ multi-signature approvals
class ApprovalIn(BaseModel):
    action: str = Field(..., max_length=48)
    params: dict[str, Any] = Field(default_factory=dict)
    quote_id: Optional[str] = Field(None, max_length=4000, description="chain.send only: the sealed quote the approvers will sign")
    reason: Optional[str] = Field(None, max_length=240)


class VoteIn(BaseModel):
    decision: Literal["approve", "reject"]
    comment: Optional[str] = Field(None, max_length=240)


@router.get("/approvals")
@_guard
def list_approvals(status: Optional[str] = Query(None, max_length=16), p: Principal = Depends(require("approval.read")),
                   db: Session = Depends(get_db)) -> dict[str, Any]:
    return {"approvals": approvals.listing(db, status), "required_default": approvals.required_for("chain.send")}


@router.post("/approvals")
@_guard
def request_approval(body: ApprovalIn, p: Principal = Depends(require("approval.request")), db: Session = Depends(get_db),
                     settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    params, extra = body.params, 0
    if body.action not in approvals.ACTIONS:
        raise HTTPException(422, "action must be one of " + ", ".join(approvals.ACTIONS))
    if body.action == "chain.send":
        if not body.quote_id:
            raise HTTPException(422, "quote_id is required for chain.send")
        q = ChainService(db, settings)._unseal(body.quote_id)          # raises ChainError if forged or expired
        params = gate.send_params(q)
        verdict = fraud.evaluate_transfer(db, network=q["network"], to=q["to"], notional=int(q["notional"]), kind=q["kind"], actor=p.name)
        extra = 1 if verdict.level == "review" else 0
    elif body.action in ("allowlist.add", "limits.set", "principal.create", "dr.restore"):
        raise HTTPException(422, f"{body.action} approvals are created by their own endpoint")
    a = approvals.request(db, body.action, params, p.name, body.reason, extra_required=extra)
    return approvals.as_dict(db, a)


@router.post("/approvals/{approval_id}/vote")
@_guard
def vote(approval_id: int, body: VoteIn, p: Principal = Depends(require("approval.vote")), db: Session = Depends(get_db)) -> dict[str, Any]:
    return approvals.as_dict(db, approvals.vote(db, approval_id, p.name, body.decision, body.comment))


@router.post("/approvals/{approval_id}/cancel")
@_guard
def cancel(approval_id: int, p: Principal = Depends(require("approval.request")), db: Session = Depends(get_db)) -> dict[str, Any]:
    a = approvals.get(db, approval_id)
    if a.requester != p.name and p.role != "admin":
        raise HTTPException(403, "only the requester or an admin can cancel")
    return approvals.as_dict(db, approvals.cancel(db, approval_id, p.name))


# ------------------------------------------------------------------ withdrawal allowlist
class AllowIn(BaseModel):
    network: str = Field(..., max_length=24)
    address: str = Field(..., min_length=26, max_length=96)
    label: Optional[str] = Field(None, max_length=64)


class ActivateIn(BaseModel):
    approval_id: int = Field(..., ge=1)


@router.get("/allowlist")
@_guard
def allow_list(p: Principal = Depends(require("allowlist.read")), db: Session = Depends(get_db)) -> dict[str, Any]:
    return {"entries": allowlist.listing(db), "cooldown_hours": allowlist.cooldown().total_seconds() / 3600}


@router.post("/allowlist")
@_guard
def allow_propose(body: AllowIn, p: Principal = Depends(require("allowlist.manage")), db: Session = Depends(get_db)) -> dict[str, Any]:
    entry, appr = allowlist.propose(db, body.network, body.address, body.label, p.name)
    return {"entry": allowlist.as_dict(entry), "approval": approvals.as_dict(db, appr),
            "next": "Obtain the required approver votes, then POST /api/security/allowlist/{id}/activate with the approval_id."}


@router.post("/allowlist/{entry_id}/activate")
@_guard
def allow_activate(entry_id: int, body: ActivateIn, p: Principal = Depends(require("allowlist.manage")), db: Session = Depends(get_db)) -> dict[str, Any]:
    return allowlist.as_dict(allowlist.activate(db, entry_id, body.approval_id, p.name))


@router.delete("/allowlist/{entry_id}")
@_guard
def allow_revoke(entry_id: int, p: Principal = Depends(require("allowlist.manage")), db: Session = Depends(get_db)) -> dict[str, Any]:
    return allowlist.as_dict(allowlist.revoke(db, entry_id, p.name))


# ------------------------------------------------------------------ transaction limits
class LimitIn(BaseModel):
    role: str = Field("*", max_length=24)
    network: str = Field("*", max_length=24)
    per_tx_wei: Optional[str] = Field(None, pattern=r"^\d{1,60}$")
    daily_wei: Optional[str] = Field(None, pattern=r"^\d{1,60}$")
    approval_above_wei: Optional[str] = Field(None, pattern=r"^\d{1,60}$")


@router.get("/limits")
@_guard
def get_limits(p: Principal = Depends(require("limits.read")), db: Session = Depends(get_db)) -> dict[str, Any]:
    return {"limits": limits.listing(db)}


@router.put("/limits")
@_guard
def put_limit(body: LimitIn, p: Principal = Depends(require("limits.manage")), db: Session = Depends(get_db)) -> dict[str, Any]:
    r = limits.set_limit(db, body.role, body.network, body.per_tx_wei, body.daily_wei, body.approval_above_wei, p.name)
    return {"id": r.id, "role": r.role, "network": r.network}


@router.delete("/limits/{limit_id}")
@_guard
def del_limit(limit_id: int, p: Principal = Depends(require("limits.manage")), db: Session = Depends(get_db)) -> dict[str, Any]:
    limits.delete_limit(db, limit_id, p.name)
    return {"deleted": limit_id}


# ------------------------------------------------------------------ fraud
class EvalIn(BaseModel):
    network: str = Field(..., max_length=24)
    to: str = Field(..., max_length=96)
    notional_wei: str = Field(..., pattern=r"^\d{1,60}$")
    kind: Literal["transfer", "swap", "approval"] = "transfer"


class ResolveIn(BaseModel):
    resolution: str = Field(..., min_length=3, max_length=240)


@router.get("/fraud/alerts")
@_guard
def fraud_alerts(status: Optional[str] = Query(None, max_length=12), p: Principal = Depends(require("fraud.read")),
                 db: Session = Depends(get_db)) -> dict[str, Any]:
    return {"alerts": fraud.alerts(db, status), "account_signals": fraud.scan_accounts(db)}


@router.post("/fraud/evaluate")
@_guard
def fraud_eval(body: EvalIn, p: Principal = Depends(require("fraud.read")), db: Session = Depends(get_db)) -> dict[str, Any]:
    return fraud.evaluate_transfer(db, network=body.network, to=body.to, notional=int(body.notional_wei), kind=body.kind, actor=p.name).as_dict()


@router.post("/fraud/alerts/{alert_id}/resolve")
@_guard
def fraud_resolve(alert_id: int, body: ResolveIn, p: Principal = Depends(require("fraud.resolve")), db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        a = fraud.resolve_alert(db, alert_id, p.name, body.resolution)
    except KeyError:
        raise HTTPException(404, "alert not found")
    return {"id": a.id, "status": a.status}


# ------------------------------------------------------------------ gated send for per-principal keys
class GatedSendIn(BaseModel):
    quote_id: str = Field(..., max_length=4000)
    confirm: str = Field(..., max_length=8)
    approval_id: Optional[int] = Field(None, ge=1)


@router.post("/chain/send")
@_guard_async
async def gated_send(body: GatedSendIn, p: Principal = Depends(require("chain.send")), db: Session = Depends(get_db),
                     settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    tx = await ChainService(db, settings).send(body.quote_id, body.confirm, approval_id=body.approval_id, actor=p.name, role=p.role)
    return {"transaction": tx}


# ------------------------------------------------------------------ disaster recovery
class BackupIn(BaseModel):
    passphrase: str = Field(..., min_length=dr.MIN_PASSPHRASE, max_length=256)


class RestoreIn(BackupIn):
    backup: dict[str, Any]


@router.get("/dr/status")
@_guard
def dr_status(p: Principal = Depends(require("dr.verify")), db: Session = Depends(get_db)) -> dict[str, Any]:
    out = {}
    for k in ("dr.backup", "dr.drill", "dr.restored"):
        rows = audit.recent(db, 1, k)
        out[k.split(".")[1]] = rows[0]["ts"] if rows else None
    return {"last": out, "kdf_iterations": dr.iterations(), "min_passphrase": dr.MIN_PASSPHRASE,
            "scope": [m.__tablename__ for m in dr.TABLES]}


@router.post("/dr/backup")
@_guard
def dr_backup(body: BackupIn, p: Principal = Depends(require("dr.backup")), db: Session = Depends(get_db)) -> dict[str, Any]:
    return dr.backup(db, body.passphrase, p.name)


@router.post("/dr/verify")
@_guard
def dr_verify(body: RestoreIn, p: Principal = Depends(require("dr.verify")), db: Session = Depends(get_db)) -> dict[str, Any]:
    out = dr.verify(body.backup, body.passphrase)
    audit.append(db, p.name, "dr.verified", "backup", {"ok": out["ok"]})
    return out


@router.post("/dr/drill")
@_guard
def dr_drill(body: BackupIn, p: Principal = Depends(require("dr.backup")), db: Session = Depends(get_db)) -> dict[str, Any]:
    return dr.drill(db, body.passphrase, p.name)


@router.post("/dr/restore")
@_guard
def dr_restore(body: RestoreIn, p: Principal = Depends(require("dr.restore")), db: Session = Depends(get_db)) -> dict[str, Any]:
    return dr.restore(db, body.backup, body.passphrase, p.name)
