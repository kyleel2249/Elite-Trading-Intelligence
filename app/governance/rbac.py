"""Role-based access control with MFA step-up for privileged permissions.

Roles are assigned server-side only (a caller can never declare its own role). Identity comes from X-API-Key:
  * the platform API_KEY maps to the built-in principal "master" (role admin);
  * a per-principal key (issued once, stored only as a keyed hash) maps to that principal and its role;
  * with no API_KEY configured, local/test environments resolve to "local" (admin); every other environment fails closed (503).
Permissions in PRIVILEGED additionally need a fresh X-MFA-Code (TOTP or a recovery code) when MFA is enforced, which is the
default everywhere except local/test (GOV_MFA_REQUIRED overrides in both directions).
"""
from __future__ import annotations

import hmac
import os
import re
import secrets
from dataclasses import dataclass
from typing import Callable, Optional

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.governance import audit, keys, mfa
from app.governance.models import GovPrincipal

ROLES = ("viewer", "auditor", "trader", "operator", "treasurer", "approver", "security_admin", "admin")
_ALL = ROLES
PERMISSIONS: dict[str, tuple[str, ...]] = {
    "security.read": _ALL,
    "audit.read": ("auditor", "security_admin", "admin"),
    "fraud.read": ("auditor", "treasurer", "security_admin", "admin"),
    "fraud.resolve": ("security_admin", "admin"),
    "principal.manage": ("security_admin", "admin"),
    "approval.read": ("auditor", "trader", "operator", "treasurer", "approver", "security_admin", "admin"),
    "approval.request": ("trader", "operator", "treasurer", "admin"),
    "approval.vote": ("approver", "treasurer", "admin"),
    "allowlist.read": ("auditor", "operator", "treasurer", "approver", "security_admin", "admin"),
    "allowlist.manage": ("treasurer", "security_admin", "admin"),
    "limits.read": ("auditor", "operator", "treasurer", "security_admin", "admin"),
    "limits.manage": ("security_admin", "admin"),
    "chain.send": ("treasurer", "operator", "admin"),
    "dr.verify": ("auditor", "security_admin", "admin"),
    "dr.backup": ("security_admin", "admin"),
    "dr.restore": ("security_admin", "admin"),
}
PRIVILEGED = frozenset({"fraud.resolve", "principal.manage", "approval.vote", "allowlist.manage", "limits.manage", "chain.send",
                        "dr.backup", "dr.restore"})
NAME_RE = re.compile(r"^[A-Za-z0-9_.@-]{2,64}$")
MASTER, LOCAL = "master", "local"


@dataclass(frozen=True)
class Principal:
    name: str
    role: str
    via: str                  # master | key | local
    mfa_ok: bool = False

    def can(self, perm: str) -> bool:
        return self.role in PERMISSIONS.get(perm, ())


def mfa_required() -> bool:
    raw = (os.getenv("GOV_MFA_REQUIRED") or "").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return True
    if raw in ("0", "false", "no", "off"):
        return False
    return not keys.is_local()


def hash_key(api_key: str) -> str:
    return keys.mac("principal-key", api_key)


def issue_key() -> str:
    return "eti_" + secrets.token_urlsafe(32)


def get_principal_row(db: Session, name: str) -> Optional[GovPrincipal]:
    return db.execute(select(GovPrincipal).where(GovPrincipal.name == name)).scalar_one_or_none()


def ensure_builtin(db: Session, name: str) -> GovPrincipal:
    """The shared API_KEY (and the local dev identity) get a database row so they can enrol MFA like anyone else."""
    row = get_principal_row(db, name)
    if row is None:
        row = GovPrincipal(name=name, role="admin", created_by="system")
        db.add(row)
        try:
            db.commit()
        except IntegrityError:          # a concurrent first request created it: use that row
            db.rollback()
            row = get_principal_row(db, name)
    return row


def resolve(db: Session, api_key: Optional[str], client: str = "-") -> tuple[Principal, GovPrincipal]:
    s = get_settings()
    master = (getattr(s, "api_key", None) or "").strip()
    supplied = (api_key or "").strip()
    if supplied:
        if master and hmac.compare_digest(supplied.encode(), master.encode()):
            return Principal(MASTER, "admin", "master"), ensure_builtin(db, MASTER)
        row = db.execute(select(GovPrincipal).where(GovPrincipal.key_hash == hash_key(supplied))).scalar_one_or_none()
        if row is not None and row.active:
            return Principal(row.name, row.role, "key"), row
        audit.append(db, "anonymous", "auth.failed", "api_key", {"client": client, "reason": "unknown or disabled key"})
        raise HTTPException(401, "Invalid or missing X-API-Key")
    if not master and keys.is_local():
        return Principal(LOCAL, "admin", "local"), ensure_builtin(db, LOCAL)
    if not master and not keys.is_local():
        raise HTTPException(503, "API_KEY is not configured; governance endpoints are disabled in this environment")
    audit.append(db, "anonymous", "auth.failed", "api_key", {"client": client, "reason": "missing key"})
    raise HTTPException(401, "Invalid or missing X-API-Key")


def authorize(db: Session, perm: str, api_key: Optional[str], mfa_code: Optional[str], client: str = "-") -> Principal:
    """Resolve the caller, enforce the permission and, for privileged ones, the MFA step-up. Denials are audited."""
    p, row = resolve(db, api_key, client)
    if not p.can(perm):
        audit.append(db, p.name, "authz.denied", perm, {"role": p.role})
        raise HTTPException(403, f"role '{p.role}' is not permitted to {perm}")
    if perm in PRIVILEGED and mfa_required():
        if not row.totp_enrolled:
            raise HTTPException(403, "mfa_enrollment_required: enrol TOTP via POST /api/security/mfa/enroll before privileged actions")
        if not mfa.verify(db, row, mfa_code):
            audit.append(db, p.name, "authz.mfa_denied", perm)
            raise HTTPException(403, "mfa_required: send a valid, unused X-MFA-Code (or an unused recovery code)")
        return Principal(p.name, p.role, p.via, True)
    return p


def require(perm: str) -> Callable:
    if perm not in PERMISSIONS:
        raise KeyError(perm)

    def dep(request: Request, db: Session = Depends(get_db), x_api_key: Optional[str] = Header(default=None),
            x_mfa_code: Optional[str] = Header(default=None)) -> Principal:
        return authorize(db, perm, x_api_key, x_mfa_code, request.client.host if request.client else "-")
    return dep
