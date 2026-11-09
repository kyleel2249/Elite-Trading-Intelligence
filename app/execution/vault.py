"""Encrypted credential storage. Secrets exist in plaintext only inside backend memory.

The vault key (EXECUTION_VAULT_KEY, a Fernet key) is a separate secret from the database, so a database
leak alone does not expose broker credentials. API responses only ever carry `mask()` output.
"""
from __future__ import annotations

import json
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken


class VaultError(Exception):
    pass


class CredentialVault:
    def __init__(self, key: Optional[str]):
        if not key:
            raise VaultError("EXECUTION_VAULT_KEY is not set; credentials cannot be stored or read")
        try:
            self._fernet = Fernet(key.encode() if isinstance(key, str) else key)
        except Exception as e:  # malformed key
            raise VaultError("EXECUTION_VAULT_KEY is not a valid Fernet key") from e

    @staticmethod
    def generate_key() -> str:
        return Fernet.generate_key().decode()

    def seal(self, credentials: dict) -> str:
        if not isinstance(credentials, dict) or not credentials:
            raise VaultError("credentials must be a non-empty object")
        return self._fernet.encrypt(json.dumps(credentials, sort_keys=True).encode()).decode()

    def open(self, ciphertext: str) -> dict:
        try:
            return json.loads(self._fernet.decrypt(ciphertext.encode()).decode())
        except InvalidToken as e:
            raise VaultError("Credential ciphertext cannot be decrypted with the configured key") from e

    @staticmethod
    def mask(credentials: dict) -> dict:
        """Safe-to-display hint: field names plus last four characters of identifiers only."""
        out = {}
        for k, v in credentials.items():
            s = str(v)
            out[k] = ("…" + s[-4:]) if len(s) > 8 else "set"
        return out


_SENSITIVE = ("secret", "key", "token", "signature", "password", "passphrase", "authorization")


def scrub(obj):
    """Recursively redact anything that looks like a credential before it reaches logs or the API."""
    if isinstance(obj, dict):
        return {k: (v if str(k).lower() == "idempotency_key" else
                    "***" if any(w in str(k).lower() for w in _SENSITIVE) else scrub(v)) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [scrub(v) for v in obj]
    return obj
