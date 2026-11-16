"""TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30 s) with replay protection, lockout and single-use recovery codes.

The seed is stored only as Fernet ciphertext. A code is accepted at most once (a per-principal step high-water mark), and five
consecutive failures lock MFA for 15 minutes so a six-digit code cannot be brute-forced.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import struct
import time
from datetime import timedelta
from typing import Optional
from urllib.parse import quote

from sqlalchemy.orm import Session

from app.governance import audit, keys
from app.governance.models import GovPrincipal, now

STEP, DIGITS, WINDOW = 30, 6, 1
MAX_FAILS, LOCK_MINUTES = 5, 15
RECOVERY_CODES = 8


def new_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def code_for(secret_b32: str, counter: int) -> str:
    key = base64.b32decode(secret_b32 + "=" * (-len(secret_b32) % 8), casefold=True)
    h = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    o = h[-1] & 0x0F
    return str((struct.unpack(">I", h[o:o + 4])[0] & 0x7FFFFFFF) % 10 ** DIGITS).zfill(DIGITS)


def totp_now(secret_b32: str, at: Optional[float] = None) -> str:
    return code_for(secret_b32, int((time.time() if at is None else at) // STEP))


def otpauth_uri(secret: str, name: str, issuer: str = "ETI") -> str:
    return f"otpauth://totp/{quote(issuer)}:{quote(name)}?secret={secret}&issuer={quote(issuer)}&algorithm=SHA1&digits={DIGITS}&period={STEP}"


def _recovery_hash(code: str) -> str:
    return keys.mac("recovery", code.strip().lower().replace("-", ""))


def _locked(p: GovPrincipal) -> bool:
    return bool(p.locked_until and p.locked_until > now())


def begin_enrollment(db: Session, p: GovPrincipal) -> dict:
    secret = new_secret()
    p.totp_sealed, p.totp_enrolled, p.totp_last_step = keys.seal(secret), False, 0
    db.commit()
    audit.append(db, p.name, "mfa.enroll_begin", p.name)
    return {"secret": secret, "otpauth_uri": otpauth_uri(secret, p.name), "digits": DIGITS, "period": STEP}


def _check_totp(p: GovPrincipal, code: str) -> Optional[int]:
    if not p.totp_sealed or not code or not code.isdigit() or len(code) != DIGITS:
        return None
    secret = keys.unseal(p.totp_sealed)
    cur = int(time.time() // STEP)
    for c in range(cur - WINDOW, cur + WINDOW + 1):
        if c > (p.totp_last_step or 0) and hmac.compare_digest(code_for(secret, c), code):
            return c
    return None


def _fail(db: Session, p: GovPrincipal, why: str) -> None:
    p.failed_mfa = (p.failed_mfa or 0) + 1
    if p.failed_mfa >= MAX_FAILS:
        p.locked_until, p.failed_mfa = now() + timedelta(minutes=LOCK_MINUTES), 0
        db.commit()
        audit.append(db, p.name, "mfa.locked", p.name, {"minutes": LOCK_MINUTES})
    else:
        db.commit()
    audit.append(db, p.name, "mfa.failed", p.name, {"reason": why})


def confirm_enrollment(db: Session, p: GovPrincipal, code: str) -> dict:
    if _locked(p):
        raise PermissionError("MFA is temporarily locked after repeated failures")
    step = _check_totp(p, code)
    if step is None:
        _fail(db, p, "enrollment code rejected")
        raise PermissionError("invalid code")
    codes = [secrets.token_hex(5) for _ in range(RECOVERY_CODES)]
    p.totp_enrolled, p.totp_last_step, p.failed_mfa = True, step, 0
    p.recovery_hashes = json.dumps([_recovery_hash(c) for c in codes])
    db.commit()
    audit.append(db, p.name, "mfa.enrolled", p.name)
    return {"enrolled": True, "recovery_codes": [f"{c[:5]}-{c[5:]}" for c in codes]}


def verify(db: Session, p: GovPrincipal, code: Optional[str]) -> bool:
    """True when the code is valid. A TOTP code is single-use; a recovery code is consumed."""
    code = (code or "").strip()
    if not p.totp_enrolled or not code or _locked(p):
        return False
    step = _check_totp(p, code)
    if step is not None:
        p.totp_last_step, p.failed_mfa = step, 0
        db.commit()
        return True
    hashes = json.loads(p.recovery_hashes or "[]")
    h = _recovery_hash(code)
    if h in hashes:
        hashes.remove(h)
        p.recovery_hashes, p.failed_mfa = json.dumps(hashes), 0
        db.commit()
        audit.append(db, p.name, "mfa.recovery_used", p.name, {"remaining": len(hashes)})
        return True
    _fail(db, p, "code rejected")
    return False


def reset(db: Session, target: GovPrincipal, by: str) -> None:
    target.totp_sealed, target.totp_enrolled, target.totp_last_step = None, False, 0
    target.recovery_hashes, target.failed_mfa, target.locked_until = None, 0, None
    db.commit()
    audit.append(db, by, "mfa.reset", target.name)
