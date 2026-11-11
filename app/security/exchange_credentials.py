"""Exchange-testnet credentials: loaded server-side from environment secrets, verified, never exposed.

Sources (first match wins)
  1. BINANCE_TESTNET_API_KEY + BINANCE_TESTNET_SECRET_KEY   (preferred, testnet-only)
  2. BINANCE_API_KEY + BINANCE_SECRET_KEY, only while BINANCE_TESTNET_ENABLED=true AND
     BINANCE_LIVE_TRADING_ENABLED=false (so a live key is never reinterpreted as a testnet key)

In production these variables are populated from your secret store (Cloudflare / Render secrets). ETI
never generates, derives or substitutes exchange credentials. Verification reuses the execution
engine's adapter, which refuses withdrawal-capable keys, and only ever talks to the sandbox.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

from app.config import Settings, get_settings

logger = logging.getLogger("eti.credentials")

TESTNET_ACCOUNT_ID = "env-binance-testnet"
VALID_TTL = 300.0
INVALID_TTL = 60.0


@dataclass
class CredentialState:
    status: str  # valid | missing | invalid | unsafe_permissions | unverifiable
    source: Optional[str]
    checked_at: float
    detail: str

    def to_dict(self) -> dict[str, Any]:
        # Deliberately no key material of any kind (not even a suffix).
        return {"status": self.status, "source": self.source, "detail": self.detail,
                "checked_seconds_ago": max(0, int(time.time() - self.checked_at))}


def load_testnet_credentials(settings: Optional[Settings] = None) -> Optional[tuple[dict[str, str], str]]:
    s = settings or get_settings()
    k = (os.environ.get("BINANCE_TESTNET_API_KEY") or "").strip()
    sec = (os.environ.get("BINANCE_TESTNET_SECRET_KEY") or "").strip()
    if k and sec:
        return {"api_key": k, "secret_key": sec}, "env:BINANCE_TESTNET_*"
    if s.binance_api_key and s.binance_secret_key and s.binance_testnet_enabled and not s.binance_live_trading_enabled:
        return {"api_key": s.binance_api_key.strip(), "secret_key": s.binance_secret_key.strip()}, "env:BINANCE_*"
    return None


async def validate_credentials(creds: dict[str, str], *, adapter_factory: Optional[Callable[[dict], Any]] = None,
                               timeout: float = 10.0) -> tuple[str, str]:
    """Return (status, detail). Network/venue problems are 'unverifiable', never 'valid'."""
    from app.execution.errors import (PermanentProviderError, PermissionPolicyError, ProviderUnavailableError,
                                      TransientProviderError)

    adapter = None
    try:
        if adapter_factory is None:
            from app.execution.adapters.registry import build_adapter

            adapter = build_adapter("binance", creds, "paper")
        else:
            adapter = adapter_factory(creds)
        await asyncio.wait_for(adapter.verify_permissions(), timeout)
        await asyncio.wait_for(adapter.get_equity(), timeout)
        return "valid", "Authenticated against the exchange sandbox."
    except PermissionPolicyError:
        return "unsafe_permissions", "Key carries permissions ETI refuses to use (e.g. withdrawals)."
    except PermanentProviderError:
        return "invalid", "The exchange sandbox rejected these credentials."
    except (TransientProviderError, ProviderUnavailableError, asyncio.TimeoutError):
        return "unverifiable", "Could not reach the exchange sandbox to verify the credentials."
    except Exception:
        logger.warning("credential verification failed unexpectedly", exc_info=False)
        return "unverifiable", "Credential verification failed unexpectedly."
    finally:
        close = getattr(adapter, "aclose", None) or getattr(adapter, "close", None)
        if close is not None:
            try:
                res = close()
                if asyncio.iscoroutine(res):
                    await res
            except Exception:
                pass


_cache: Optional[CredentialState] = None
_lock = asyncio.Lock()


def reset_cache() -> None:
    global _cache
    _cache = None


async def get_credential_state(settings: Optional[Settings] = None, *, force: bool = False,
                               adapter_factory: Optional[Callable[[dict], Any]] = None) -> CredentialState:
    global _cache
    s = settings or get_settings()
    loaded = load_testnet_credentials(s)
    if loaded is None:
        _cache = CredentialState("missing", None, time.time(), "No exchange testnet credentials are configured.")
        return _cache
    creds, source = loaded
    now = time.time()
    if not force and _cache is not None and _cache.source == source:
        ttl = VALID_TTL if _cache.status == "valid" else INVALID_TTL
        if now - _cache.checked_at < ttl:
            return _cache
    async with _lock:
        status, detail = await validate_credentials(creds, adapter_factory=adapter_factory)
        _cache = CredentialState(status, source, time.time(), detail)
        return _cache


def ensure_env_testnet_account(settings: Optional[Settings] = None) -> dict[str, Any]:
    """Register the verified environment credentials as an execution account (sealed in the vault).

    This provisions *authentication only*. The account is created intelligence-only: the operator still
    approves symbols, capital limits and mode through the execution policy before any order can be sent.
    """
    s = settings or get_settings()
    if not s.execution_enabled:
        return {"registered": False, "reason": "EXECUTION_ENABLED is false"}
    loaded = load_testnet_credentials(s)
    if loaded is None or _cache is None or _cache.status != "valid":
        return {"registered": False, "reason": "no verified testnet credentials"}
    from app.execution.domain import AccountPolicy
    from app.execution.service import get_store, get_vault
    from app.execution.store import AccountRecord
    from app.execution.vault import CredentialVault, VaultError

    store = get_store()
    if store.get_account(TESTNET_ACCOUNT_ID) is not None:
        return {"registered": True, "created": False, "account_id": TESTNET_ACCOUNT_ID}
    creds, source = loaded
    try:
        sealed = get_vault().seal(creds)
    except VaultError:
        return {"registered": False, "reason": "EXECUTION_VAULT_KEY is not configured"}
    rec = AccountRecord(TESTNET_ACCOUNT_ID, "binance", "paper", "Binance testnet (from environment secrets)",
                        AccountPolicy(), credentials_ciphertext=sealed)
    store.save_account(rec)
    store.append_log(TESTNET_ACCOUNT_ID, "account_registered",
                     details={"by": "auto-provision", "source": source, "credentials": CredentialVault.mask(creds)})
    return {"registered": True, "created": True, "account_id": TESTNET_ACCOUNT_ID}
