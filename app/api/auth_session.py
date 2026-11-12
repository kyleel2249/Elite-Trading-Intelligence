"""Automatic execution-session endpoints.

No endpoint here ever returns a token: sessions live in an HttpOnly cookie. Responses describe state
(who is authenticated for which environment, when it expires) and notices, never secrets.
"""
from __future__ import annotations

import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.database import SessionLocal
from app.security.auth import require_api_key
from app.security.auth_models import ExecAuthEvent
from app.security.exchange_credentials import ensure_env_testnet_account, get_credential_state
from app.security.execution_auth import (
    COOKIE_NAMES, EXCHANGE_TESTNET, INTERNAL_PAPER, LIVE, AuthError, TokenService, audit, clear_session_cookie,
    client_key, csrf_ok, enforcement_active, is_non_local_env, load_keyring, load_policy, operator_ok,
    session_limiter, set_session_cookie,
)

logger = logging.getLogger("eti.api.auth")

router = APIRouter(prefix="/api/auth", tags=["auth"])


class SessionBody(BaseModel):
    environment: Literal["internal_paper", "exchange_testnet", "live"] = "internal_paper"


class RevokeBody(BaseModel):
    environment: Optional[Literal["internal_paper", "exchange_testnet"]] = None
    token_id: Optional[str] = Field(default=None, max_length=24)
    all: bool = False
    reason: str = Field("operator revoke", max_length=64)


def _info(svc: TokenService, row) -> dict:
    return {"authenticated": True, "environment": row.environment, "expires_in": svc.seconds_left(row),
            "rotates_in": svc.seconds_until_rotation(row)}


def _reject_live(env: str) -> None:
    if env == LIVE:
        raise HTTPException(403, {"error": "Live trading is disabled; no session can authorize it", "code": "live_disabled"})


@router.post("/session")
async def start_session(body: SessionBody, request: Request, response: Response):
    """Start (or transparently renew) the session for one environment.

    internal_paper: automatic, no credentials. exchange_testnet: operator-authenticated only (it spends the
    operator's sandbox credentials). live: always refused."""
    env = body.environment
    _reject_live(env)
    op = operator_ok(request)
    if op is False:
        raise HTTPException(401, {"error": "Invalid X-API-Key", "code": "invalid_api_key"})
    operator_here = op is True or not enforcement_active()
    policy = load_policy()
    if env == EXCHANGE_TESTNET and not operator_here:
        raise HTTPException(401, {"error": "Exchange testnet sessions require the operator key", "code": "operator_required"})
    if env == INTERNAL_PAPER and not policy.auto_sessions and not operator_here:
        raise HTTPException(403, {"error": "Automatic paper sessions are disabled on this server", "code": "auto_sessions_disabled"})

    db = SessionLocal()
    try:
        svc = TokenService(db)
        existing = request.cookies.get(COOKIE_NAMES[env])
        if existing:
            try:
                row = svc.verify(existing, env)
                if svc.needs_rotation(row):
                    raw, row = svc.rotate(row)
                    set_session_cookie(response, request, env, raw, svc.seconds_left(row))
                    audit(db, "rotate", environment=env, result="ok", principal="session", token_id=row.token_id)
                else:
                    svc.slide(row)
                return _info(svc, row)
            except AuthError:
                pass  # expired/revoked/foreign cookie: fall through and issue a fresh session
        if not session_limiter.allow(client_key(request)):
            raise HTTPException(429, {"error": "Too many session requests", "code": "rate_limited"})
        try:
            raw, row = svc.issue(env, subject="operator-browser" if op is True else "browser")
        except AuthError as e:
            raise e.http()
        set_session_cookie(response, request, env, raw, svc.seconds_left(row))
        audit(db, "issue", environment=env, result="ok", principal="operator" if op is True else "anonymous", token_id=row.token_id)
        return _info(svc, row)
    finally:
        db.close()


@router.post("/refresh")
async def refresh_session(body: SessionBody, request: Request, response: Response):
    env = body.environment
    _reject_live(env)
    db = SessionLocal()
    try:
        svc = TokenService(db)
        try:
            row = svc.verify(request.cookies.get(COOKIE_NAMES.get(env, "")), env)
        except AuthError as e:
            raise e.http("POST /api/auth/session to start a new session")
        if not csrf_ok(request):
            raise HTTPException(403, {"error": "Cross-origin request refused", "code": "csrf"})
        raw, new = svc.rotate(row)
        set_session_cookie(response, request, env, raw, svc.seconds_left(new))
        audit(db, "rotate", environment=env, result="ok", principal="session", token_id=new.token_id)
        return _info(svc, new)
    finally:
        db.close()


@router.post("/logout")
async def logout(body: SessionBody, request: Request, response: Response):
    env = body.environment
    _reject_live(env)
    db = SessionLocal()
    try:
        svc = TokenService(db)
        revoked = False
        raw = request.cookies.get(COOKIE_NAMES.get(env, ""))
        if raw:
            try:
                row = svc.verify(raw, env)
                revoked = svc.revoke(row.token_id, "logout")
                audit(db, "revoke", environment=env, result="ok", principal="session", token_id=row.token_id, reason="logout")
            except AuthError:
                pass
        clear_session_cookie(response, env)
        return {"revoked": revoked}
    finally:
        db.close()


@router.post("/revoke", dependencies=[Depends(require_api_key)])
async def revoke(body: RevokeBody):
    """Operator: end one session, every session of an environment, or everything."""
    if not (body.token_id or body.environment or body.all):
        raise HTTPException(422, "Specify token_id, environment or all=true")
    db = SessionLocal()
    try:
        svc = TokenService(db)
        if body.token_id:
            n = 1 if svc.revoke(body.token_id, body.reason) else 0
        else:
            n = svc.revoke_environment(body.environment, body.reason)
        audit(db, "revoke", environment=body.environment, result="ok", principal="operator",
              token_id=body.token_id, reason=body.reason)
        return {"revoked": n}
    finally:
        db.close()


@router.get("/events", dependencies=[Depends(require_api_key)])
async def events(limit: int = Query(100, ge=1, le=500)):
    db = SessionLocal()
    try:
        rows = db.query(ExecAuthEvent).order_by(ExecAuthEvent.id.desc()).limit(limit).all()
        return {"events": [{"ts": r.ts.isoformat() if r.ts else None, "event": r.event, "environment": r.environment,
                            "principal": r.principal, "result": r.result, "reason": r.reason, "path": r.path,
                            "token_id": r.token_id} for r in rows]}
    finally:
        db.close()


_REASONS = {
    "missing": "no exchange testnet credentials are configured",
    "invalid": "the exchange sandbox rejected the configured credentials",
    "unsafe_permissions": "the configured key has permissions ETI refuses to use (e.g. withdrawals)",
    "unverifiable": "the exchange sandbox could not be reached to verify the credentials",
    "valid": "credentials are verified but no execution account is approved for trading yet",
}


def _testnet_ready(settings: Settings) -> bool:
    """A registered execution account on the exchange sandbox with an approved (non intelligence-only) policy."""
    if not settings.execution_enabled:
        return False
    try:
        from app.execution.domain import Mode
        from app.execution.service import get_store

        return any(a.provider == "binance" and a.environment == "paper" and a.credentials_ciphertext
                   and a.policy.mode != Mode.INTELLIGENCE_ONLY for a in get_store().list_accounts())
    except Exception:
        return False


@router.get("/status")
async def status(request: Request, environment: Optional[str] = Query(default=None, max_length=32),
                 settings: Settings = Depends(get_settings)):
    """Environment detection + auth state + notices for the dashboard. Contains no secrets."""
    selected = (environment or INTERNAL_PAPER).strip().lower()
    if selected in ("testnet", "internal", "paper"):
        selected = EXCHANGE_TESTNET if selected == "testnet" else INTERNAL_PAPER
    if selected not in (INTERNAL_PAPER, EXCHANGE_TESTNET, LIVE):
        raise HTTPException(422, "environment must be internal_paper, exchange_testnet or live")

    cred = await get_credential_state(settings)
    provisioned = ensure_env_testnet_account(settings) if cred.status == "valid" else {"registered": False}
    testnet_ready = _testnet_ready(settings)

    sessions: dict = {}
    db = SessionLocal()
    try:
        svc = TokenService(db)
        for env, cookie in COOKIE_NAMES.items():
            raw = request.cookies.get(cookie)
            if not raw:
                sessions[env] = {"authenticated": False, "reason": "no_session"}
                continue
            try:
                sessions[env] = _info(svc, svc.verify(raw, env))
            except AuthError as e:
                sessions[env] = {"authenticated": False, "reason": e.code}
    finally:
        db.close()

    notices: list[dict] = []
    effective: Optional[str] = selected
    fallback = False
    if selected == LIVE:
        effective = None
        notices.append({"level": "error", "code": "LIVE_DISABLED",
                        "message": "LIVE TRADING is disabled. No credential or session can authorize a live order."})
    elif selected == EXCHANGE_TESTNET and not testnet_ready:
        effective, fallback = INTERNAL_PAPER, True
        notices.append({"level": "warn", "code": "TESTNET_FALLBACK",
                        "message": f"EXCHANGE TESTNET is unavailable: {_REASONS.get(cred.status, 'not connected')}. "
                                   "Orders use INTERNAL PAPER; nothing is sent to an exchange."})
    elif selected == EXCHANGE_TESTNET:
        notices.append({"level": "info", "code": "TESTNET_ACTIVE",
                        "message": "EXCHANGE TESTNET is connected (sandbox, operator-approved policy). Orders on this page "
                                   "are still INTERNAL PAPER; testnet orders go through the Execution Engine."})
    keyring = load_keyring()
    if is_non_local_env() and keyring.source != "env":
        notices.append({"level": "info", "code": "AUTH_KEY_LOCAL",
                        "message": "Session signing key is generated locally. Set EXEC_AUTH_SECRET from your secret store "
                                   "so sessions survive restarts and redeploys."})
    if not enforcement_active():
        notices.append({"level": "info", "code": "DEV_OPEN",
                        "message": "Local development without API_KEY: execution endpoints are open (unchanged behaviour)."})

    policy = load_policy()
    return {
        "selected": selected,
        "effective": effective,
        "fallback": fallback,
        "environments": {
            INTERNAL_PAPER: {"available": True, "credentials_required": False,
                             "auth": "automatic session" if policy.auto_sessions else "operator key"},
            EXCHANGE_TESTNET: {"available": testnet_ready, "credentials": cred.to_dict(),
                               "account_registered": bool(provisioned.get("registered")),
                               "auth": "operator-established session"},
            LIVE: {"available": False, "reason": "disabled"},
        },
        "sessions": sessions,
        "auth": {"enforced": enforcement_active(), "auto_sessions": policy.auto_sessions,
                 "operator_key_configured": bool((settings.api_key or "").strip()),
                 "signing_key_source": keyring.source, "idle_ttl_seconds": policy.idle_ttl,
                 "rotate_after_seconds": policy.rotate_after},
        "notices": notices,
        "withdrawals_and_transfers": "prohibited",
    }
