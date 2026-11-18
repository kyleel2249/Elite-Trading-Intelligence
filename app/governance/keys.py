"""Governance key material: one master secret, per-purpose subkeys, and Fernet sealing for secrets stored at rest.

GOVERNANCE_KEY (falls back to EXECUTION_VAULT_KEY) is never written to the database, logs or API responses. Subkeys are derived
with HMAC-SHA256 so the audit chain, principal-key hashing and sealing never share a key. GOVERNANCE_KEY_PREVIOUS keeps old
ciphertexts and audit rows verifiable while a rotation is in progress. Production fails closed when no key is configured;
development/test fall back to a fixed, clearly-unsafe key that the posture check reports as a failure.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings
from app.security.auth import LOCAL_ENVS

DEV_KEY = b"eti-local-dev-governance-key-NOT-FOR-PRODUCTION"


class GovernanceKeyError(RuntimeError):
    pass


def env_name() -> str:
    return (get_settings().app_env or "").strip().lower()


def is_local() -> bool:
    return env_name() in LOCAL_ENVS


def _material(name: str) -> Optional[bytes]:
    raw = (os.getenv(name) or "").strip()
    if name == "GOVERNANCE_KEY" and not raw:
        raw = (get_settings().execution_vault_key or "").strip()
    return raw.encode() if raw else None


def current_material() -> bytes:
    m = _material("GOVERNANCE_KEY")
    if m:
        return m
    if is_local():
        return DEV_KEY
    raise GovernanceKeyError("GOVERNANCE_KEY (or EXECUTION_VAULT_KEY) is not set; governance controls cannot run in this environment")


def is_dev_key() -> bool:
    return _material("GOVERNANCE_KEY") is None


def _materials() -> list[bytes]:
    out = [current_material()]
    prev = _material("GOVERNANCE_KEY_PREVIOUS")
    if prev and prev not in out:
        out.append(prev)
    return out


def kid(material: Optional[bytes] = None) -> str:
    return hashlib.sha256(b"kid|" + (material or current_material())).hexdigest()[:8]


def derive(purpose: str, material: Optional[bytes] = None) -> bytes:
    return hmac.new(material or current_material(), purpose.encode(), hashlib.sha256).digest()


def derive_for_kid(purpose: str, key_id: str) -> Optional[bytes]:
    for m in _materials():
        if kid(m) == key_id:
            return derive(purpose, m)
    return None


def mac(purpose: str, text: str) -> str:
    return hmac.new(derive(purpose), text.encode(), hashlib.sha256).hexdigest()


def _fernet(material: bytes) -> Fernet:
    return Fernet(base64.urlsafe_b64encode(derive("seal", material)))


def seal(text: str) -> str:
    return _fernet(current_material()).encrypt(text.encode()).decode()


def unseal(token: str) -> str:
    for m in _materials():
        try:
            return _fernet(m).decrypt(token.encode()).decode()
        except InvalidToken:
            continue
    raise GovernanceKeyError("sealed value cannot be opened with the configured governance key(s)")


def reseal(token: str) -> str:
    """Re-encrypt a sealed value under the current key (used after a rotation)."""
    return seal(unseal(token))
