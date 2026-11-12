"""Role-based access for Global Alpha routes.

Roles (low to high): analyst < trader < admin.
  analyst  scans, validation, research, strategy lab, labelling, qualification (spends data quotas, no orders)
  trader   analyst + paper/testnet order execution and the position monitor
  admin    everything, including live-environment attempts (which are additionally gated by operator flags)
The existing API_KEY remains the admin key. Extra keys come from ALPHA_ROLE_KEYS="key:role,key:role" (keys >= 16 chars).
Same fail-closed behaviour as app.security.auth: with no keys configured, production/staging return 503, local dev is open.
Keys are compared in constant time and are never logged; audit entries carry a short fingerprint only."""
from __future__ import annotations

import hashlib
import hmac
import logging
from dataclasses import dataclass
from typing import Callable, Optional

from fastapi import Header, HTTPException, status

import app.security.auth as auth

logger = logging.getLogger("eti.alpha")
ROLES = {"analyst": 1, "trader": 2, "admin": 3}
MIN_KEY_LEN = 16


@dataclass(frozen=True)
class Access:
    role: str
    key_id: str  # short, non-reversible fingerprint (never the key)


def fingerprint(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()[:8]


def parse_role_keys(raw: Optional[str]) -> tuple[dict[str, str], list[str]]:
    """Return ({key: role}, problems). Invalid entries are dropped (fail closed), never granted."""
    keys: dict[str, str] = {}
    problems: list[str] = []
    for raw_part in (raw or "").split(","):
        part = raw_part.strip()
        if not part:
            continue
        key, _, role = part.rpartition(":")
        key, role = key.strip(), role.strip().lower()
        if role not in ROLES or role == "admin":
            problems.append("role must be analyst or trader (admin is the API_KEY)")
        elif len(key) < MIN_KEY_LEN:
            problems.append(f"{role} key shorter than {MIN_KEY_LEN} characters")
        elif key in keys:
            problems.append("duplicate key")
        else:
            keys[key] = role
    return keys, problems


def resolve(supplied: Optional[str], settings) -> Optional[Access]:
    """Match against every configured key without early exit (constant-time per key)."""
    master = (getattr(settings, "api_key", None) or "").strip()
    role_keys, _ = parse_role_keys(getattr(settings, "alpha_role_keys", None))
    s = (supplied or "").encode()
    found: Optional[Access] = None
    if master:
        if s and hmac.compare_digest(s, master.encode()):
            found = Access("admin", fingerprint(master))
    for key, role in role_keys.items():
        if s and hmac.compare_digest(s, key.encode()) and key != master and found is None:
            found = Access(role, fingerprint(key))
    return found


def require_alpha_role(minimum: str) -> Callable[..., Access]:
    need = ROLES[minimum]

    async def dep(x_api_key: Optional[str] = Header(default=None)) -> Access:
        settings = auth.get_settings()
        master = (getattr(settings, "api_key", None) or "").strip()
        role_keys, problems = parse_role_keys(getattr(settings, "alpha_role_keys", None))
        if problems:
            logger.warning("ALPHA_ROLE_KEYS entries ignored: %s", "; ".join(sorted(set(problems))))
        if not master and not role_keys:
            if (settings.app_env or "").strip().lower() in auth.PROTECTED_ENVS:
                raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "no API keys configured; protected routes are disabled in this environment")
            return Access("admin", "dev-open")  # local development only
        who = resolve(x_api_key, settings)
        if who is None:
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or missing X-API-Key")
        if ROLES[who.role] < need:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"role '{who.role}' cannot perform this action; '{minimum}' required")
        return who

    return dep
