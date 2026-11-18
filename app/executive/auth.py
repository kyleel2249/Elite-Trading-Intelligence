"""Role resolution for the Executive Command Centre.

* API_KEY (master) unlocks every view; the caller declares a role with X-Executive-Role and a label with X-Actor.
  These two headers are self-declared (the platform has one shared key), so they record who acted but do not prove it.
* EXECUTIVE_ROLE_KEYS="finance:<key>,auditor:<key>" (keys >= 16 chars) issues per-role keys. A role key can only use its own
  role; its actor identity is fixed to "role:<name>", so one key can never approve what it requested.
* No keys configured: open in development/test/local only; production fails closed (503), like require_api_key.
"""
from __future__ import annotations

import hmac
import os
import re
from dataclasses import dataclass
from typing import Optional

from fastapi import Header, HTTPException

from app.config import get_settings
from app.security.auth import LOCAL_ENVS

ROLES = ("executive", "finance", "trading", "operations", "auditor")
PERMISSIONS = {
    "budget.set": ("executive", "finance"),
    "request.create": ("executive", "finance", "operations"),
    "request.approve": ("executive", "finance"),
    "request.cancel": ("executive", "finance", "operations"),
    "request.pay": ("finance",),
    "reserve.policy": ("executive", "finance"),
    "reserve.transfer": ("finance",),
    "audit.read": ("executive", "finance", "auditor"),
    "blockchain.read": ("executive", "finance", "operations", "auditor"),
}
MIN_ROLE_KEY_LEN = 16
_ACTOR_RE = re.compile(r"^[A-Za-z0-9 _.@:+-]{1,64}$")


@dataclass(frozen=True)
class Principal:
    role: str
    actor: str
    via: str          # master | role_key | local

    def can_view(self, role: str) -> bool:
        return self.via != "role_key" or self.role == role

    def can(self, perm: str) -> bool:
        return self.role in PERMISSIONS.get(perm, ())


def role_keys() -> dict:
    out = {}
    for part in (os.getenv("EXECUTIVE_ROLE_KEYS") or "").split(","):
        role, sep, key = part.strip().partition(":")
        role, key = role.strip().lower(), key.strip()
        if sep and role in ROLES and len(key) >= MIN_ROLE_KEY_LEN:
            out[role] = key
    return out


def resolve(api_key: Optional[str], declared_role: Optional[str], actor: Optional[str]) -> Principal:
    s = get_settings()
    master = (getattr(s, "api_key", None) or "").strip()
    keys = role_keys()
    supplied = (api_key or "").encode()

    def same(k: str) -> bool:
        return bool(supplied) and hmac.compare_digest(supplied, k.encode())

    label = actor.strip() if actor and _ACTOR_RE.match(actor.strip()) else None
    declared = (declared_role or "").strip().lower()
    if declared and declared not in ROLES:
        raise HTTPException(422, f"role must be one of {', '.join(ROLES)}")
    if master and same(master):
        role = declared or "executive"
        return Principal(role, label or f"{role}@api-key", "master")
    for role, key in keys.items():
        if same(key):
            if declared and declared != role:
                raise HTTPException(403, "this key is limited to the " + role + " role")
            return Principal(role, f"role:{role}", "role_key")
    if master or keys:
        raise HTTPException(401, "Invalid or missing X-API-Key")
    if (s.app_env or "").strip().lower() not in LOCAL_ENVS:
        raise HTTPException(503, "API_KEY is not configured; the executive centre is disabled in this environment")
    role = declared or "executive"
    return Principal(role, label or f"{role}@local", "local")


async def principal(x_api_key: Optional[str] = Header(default=None), x_executive_role: Optional[str] = Header(default=None),
                    x_actor: Optional[str] = Header(default=None)) -> Principal:
    return resolve(x_api_key, x_executive_role, x_actor)
