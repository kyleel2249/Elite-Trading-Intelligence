"""Server-side execution authorization.

Goals
-----
* INTERNAL PAPER starts with no manually supplied token or exchange key: the dashboard receives an
  opaque session in an HttpOnly cookie that JavaScript, bundles, localStorage and API bodies never see.
* Sessions are environment-scoped. A paper session cannot authorize an exchange-testnet order, and
  nothing can authorize a LIVE order (live is hard-disabled here).
* Tokens are random (256-bit), stored only as keyed HMAC hashes, expire (idle + absolute), rotate
  automatically, can be revoked, and every decision is audited without secrets.
* An order is authorized again at the execution boundary through a short-lived signed ticket bound to
  the environment and the exact order payload.
* Operator access (X-API-Key) keeps working unchanged for scripts and operator-only actions.

What this is not: user accounts. Anonymous dashboard visitors share the paper account, which holds
simulated money only. Set EXEC_AUTO_SESSIONS=false to make paper trading operator-key-only.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlparse

from fastapi import HTTPException, Request, Response
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import get_settings
from app.memory.util import as_utc, naive_utc, utcnow
from app.security.auth import PROTECTED_ENVS
from app.security.auth_models import ExecAuthEvent, ExecAuthToken

logger = logging.getLogger("eti.auth")

INTERNAL_PAPER = "internal_paper"
EXCHANGE_TESTNET = "exchange_testnet"
LIVE = "live"
ISSUABLE_ENVIRONMENTS = (INTERNAL_PAPER, EXCHANGE_TESTNET)
ENV_CODES = {INTERNAL_PAPER: "ip", EXCHANGE_TESTNET: "xt"}
COOKIE_NAMES = {INTERNAL_PAPER: "eti_session_ip", EXCHANGE_TESTNET: "eti_session_xt"}

_RAW_RE = re.compile(r"^eti_(ip|xt|lv)_([0-9a-f]{16})\.([A-Za-z0-9_-]{20,64})$")
FORBIDDEN_PATH_RE = re.compile(r"withdraw|transfer|payout|sapi/v1/capital|asset/transfer", re.I)


class AuthError(Exception):
    def __init__(self, code: str, status: int = 401, message: Optional[str] = None):
        super().__init__(message or code)
        self.code = code
        self.status = status
        self.message = message or code.replace("_", " ")

    def http(self, hint: Optional[str] = None) -> HTTPException:
        detail: dict[str, Any] = {"error": self.message, "code": self.code}
        if hint:
            detail["hint"] = hint
        return HTTPException(self.status, detail)


# ---------------------------------------------------------------------------------------- policy
@dataclass(frozen=True)
class AuthPolicy:
    idle_ttl: int
    absolute_ttl: int
    rotate_after: int
    grace: int
    max_active: int
    auto_sessions: bool


def _int_env(name: str, default: int, lo: int, hi: int) -> int:
    try:
        v = int(os.environ.get(name, default))
    except ValueError:
        v = default
    return max(lo, min(hi, v))


def load_policy() -> AuthPolicy:
    return AuthPolicy(
        idle_ttl=_int_env("EXEC_SESSION_IDLE_SECONDS", 900, 60, 86_400),
        absolute_ttl=_int_env("EXEC_SESSION_ABSOLUTE_SECONDS", 28_800, 300, 604_800),
        rotate_after=_int_env("EXEC_SESSION_ROTATE_SECONDS", 300, 30, 86_400),
        grace=_int_env("EXEC_SESSION_ROTATE_GRACE_SECONDS", 30, 0, 300),
        max_active=_int_env("EXEC_SESSION_MAX_ACTIVE", 500, 1, 100_000),
        auto_sessions=os.environ.get("EXEC_AUTO_SESSIONS", "true").strip().lower() not in ("0", "false", "no", "off"),
    )


# --------------------------------------------------------------------------------------- keyring
class AuthKeyring:
    """HMAC keys. ``current`` signs; ``previous`` keys only verify, so rotating the secret does not
    log everyone out at once."""

    def __init__(self, current: bytes, previous: Optional[list[bytes]] = None, source: str = "explicit"):
        if len(current) < 32:
            raise ValueError("auth key must be at least 32 bytes")
        self.current = current
        self.previous = list(previous or [])
        self.source = source

    @staticmethod
    def key_id_of(key: bytes) -> str:
        return hashlib.sha256(b"eti-key-id" + key).hexdigest()[:12]

    @property
    def current_id(self) -> str:
        return self.key_id_of(self.current)

    def lookup(self, key_id: str) -> Optional[bytes]:
        for k in [self.current, *self.previous]:
            if self.key_id_of(k) == key_id:
                return k
        return None

    @staticmethod
    def digest_with(key: bytes, token_id: str, secret: str) -> str:
        return hmac.new(key, f"{token_id}.{secret}".encode(), hashlib.sha256).hexdigest()

    def sign(self, data: str) -> str:
        return hmac.new(self.current, data.encode(), hashlib.sha256).hexdigest()

    def verify_signature(self, data: str, sig: str) -> bool:
        return any(hmac.compare_digest(hmac.new(k, data.encode(), hashlib.sha256).hexdigest(), sig)
                   for k in [self.current, *self.previous])


_keyring: Optional[AuthKeyring] = None
_keyring_lock = threading.Lock()


def load_keyring() -> AuthKeyring:
    """EXEC_AUTH_SECRET (from your secret store, e.g. Cloudflare/Render secrets) is preferred. Without it
    a random key is generated once and kept in a 0600 file outside the repo; if that is not writable the
    key lives in memory only (sessions then reset on restart and are simply re-issued)."""
    global _keyring
    with _keyring_lock:
        if _keyring is not None:
            return _keyring
        prev = [p.strip().encode() for p in os.environ.get("EXEC_AUTH_SECRET_PREVIOUS", "").split(",") if len(p.strip()) >= 32]
        env_secret = (os.environ.get("EXEC_AUTH_SECRET") or "").strip()
        if len(env_secret) >= 32:
            _keyring = AuthKeyring(env_secret.encode(), prev, "env")
            return _keyring
        path = Path(os.environ.get("EXEC_AUTH_KEY_FILE") or (Path.home() / ".eti" / "auth.key"))
        try:
            if path.exists():
                key = path.read_text().strip().encode()
                if len(key) >= 32:
                    _keyring = AuthKeyring(key, prev, "file")
                    return _keyring
            path.parent.mkdir(parents=True, exist_ok=True)
            key_text = secrets.token_urlsafe(48)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as fh:
                fh.write(key_text)
            _keyring = AuthKeyring(key_text.encode(), prev, "file")
        except Exception:
            logger.warning("auth key file unavailable; using an in-memory key (sessions reset on restart)")
            _keyring = AuthKeyring(secrets.token_urlsafe(48).encode(), prev, "ephemeral")
        return _keyring


def reset_keyring_for_tests(kr: Optional[AuthKeyring] = None) -> None:
    global _keyring
    _keyring = kr


# ---------------------------------------------------------------------------------- token service
class TokenService:
    def __init__(self, db: Session, keyring: Optional[AuthKeyring] = None, policy: Optional[AuthPolicy] = None,
                 now=None):
        self.db = db
        self.keyring = keyring or load_keyring()
        self.policy = policy or load_policy()
        self._now = now or utcnow

    def now(self) -> datetime:
        return self._now()

    # -- issue ---------------------------------------------------------------------------------
    def _create(self, environment: str, kind: str, subject: str) -> tuple[str, ExecAuthToken]:
        now = self.now()
        token_id = secrets.token_hex(8)
        secret = secrets.token_urlsafe(32)
        raw = f"eti_{ENV_CODES[environment]}_{token_id}.{secret}"
        row = ExecAuthToken(
            token_id=token_id, token_hash=self.keyring.digest_with(self.keyring.current, token_id, secret),
            key_id=self.keyring.current_id, environment=environment, kind=kind, subject=subject[:64],
            created_at=now, last_used_at=now, idle_expires_at=now + timedelta(seconds=self.policy.idle_ttl),
            absolute_expires_at=now + timedelta(seconds=self.policy.absolute_ttl),
        )
        self.db.add(row)
        self.db.commit()
        return raw, row

    @staticmethod
    def _check_environment(environment: str) -> None:
        if environment == LIVE:
            raise AuthError("live_disabled", 403, "Live trading is disabled; no credential can authorize it")
        if environment not in ISSUABLE_ENVIRONMENTS:
            raise AuthError("unknown_environment", 422, "environment must be internal_paper or exchange_testnet")

    def issue(self, environment: str, *, kind: str = "session", subject: str = "browser") -> tuple[str, ExecAuthToken]:
        self._check_environment(environment)
        if self.active_count() >= self.policy.max_active:
            self.purge()
            if self.active_count() >= self.policy.max_active:
                raise AuthError("session_capacity", 503, "Too many active sessions; try again shortly")
        return self._create(environment, kind, subject)

    # -- verify --------------------------------------------------------------------------------
    def verify(self, raw: Optional[str], environment: str) -> ExecAuthToken:
        m = _RAW_RE.match(raw or "")
        if not m:
            raise AuthError("malformed_token")
        code, token_id, secret = m.groups()
        if code == "lv" or environment == LIVE:
            raise AuthError("live_disabled", 403, "Live trading is disabled; no credential can authorize it")
        row = self.db.query(ExecAuthToken).filter(ExecAuthToken.token_id == token_id).one_or_none()
        if row is None:
            raise AuthError("unknown_token")
        key = self.keyring.lookup(row.key_id)
        if key is None or not hmac.compare_digest(row.token_hash, self.keyring.digest_with(key, token_id, secret)):
            raise AuthError("invalid_token")
        if row.environment != environment or ENV_CODES.get(environment) != code:
            raise AuthError("wrong_environment", 403, "This credential belongs to a different execution environment")
        if row.revoked_at is not None:
            raise AuthError("token_revoked")
        now = self.now()
        if as_utc(row.absolute_expires_at) <= now or as_utc(row.idle_expires_at) <= now:  # type: ignore[operator]
            raise AuthError("token_expired")
        return row

    def is_active(self, token_id: str) -> bool:
        row = self.db.query(ExecAuthToken).filter(ExecAuthToken.token_id == token_id).one_or_none()
        if row is None or row.revoked_at is not None:
            return False
        now = self.now()
        return as_utc(row.absolute_expires_at) > now and as_utc(row.idle_expires_at) > now  # type: ignore[operator]

    def slide(self, row: ExecAuthToken) -> None:
        """Idle-timeout slides on use (never for a superseded token, whose grace period is fixed)."""
        if row.replaced_by:
            return
        now = self.now()
        if row.last_used_at is not None and (now - as_utc(row.last_used_at)).total_seconds() < 30:  # type: ignore[operator]
            return
        row.last_used_at = now
        row.idle_expires_at = min(now + timedelta(seconds=self.policy.idle_ttl), as_utc(row.absolute_expires_at))  # type: ignore[type-var]
        self.db.commit()

    def needs_rotation(self, row: ExecAuthToken) -> bool:
        if row.replaced_by:
            return False
        base = as_utc(row.rotated_at or row.created_at)
        return (self.now() - base).total_seconds() >= self.policy.rotate_after  # type: ignore[operator]

    def seconds_left(self, row: ExecAuthToken) -> int:
        left = min(as_utc(row.idle_expires_at), as_utc(row.absolute_expires_at)) - self.now()  # type: ignore[operator]
        return max(0, int(left.total_seconds()))

    def seconds_until_rotation(self, row: ExecAuthToken) -> int:
        base = as_utc(row.rotated_at or row.created_at)
        return max(0, int(self.policy.rotate_after - (self.now() - base).total_seconds()))  # type: ignore[operator]

    # -- rotate / revoke -----------------------------------------------------------------------
    def rotate(self, row: ExecAuthToken) -> tuple[str, ExecAuthToken]:
        """Issue a successor; the old token lives only for a short grace period so concurrent in-flight
        requests do not fail. The successor inherits the old absolute lifetime (no unlimited chains)."""
        if row.revoked_at is not None:
            raise AuthError("token_revoked")
        raw, new = self._create(row.environment, row.kind, row.subject)
        new.absolute_expires_at = row.absolute_expires_at
        now = self.now()
        row.replaced_by = new.token_id
        row.rotated_at = now
        row.idle_expires_at = min(as_utc(row.idle_expires_at), now + timedelta(seconds=self.policy.grace))  # type: ignore[type-var]
        self.db.commit()
        return raw, new

    def revoke(self, token_id: str, reason: str = "revoked") -> bool:
        row = self.db.query(ExecAuthToken).filter(ExecAuthToken.token_id == token_id).one_or_none()
        if row is None or row.revoked_at is not None:
            return False
        row.revoked_at = self.now()
        row.revoked_reason = reason[:64]
        self.db.commit()
        return True

    def revoke_environment(self, environment: Optional[str], reason: str = "revoked") -> int:
        q = self.db.query(ExecAuthToken).filter(ExecAuthToken.revoked_at.is_(None))
        if environment:
            q = q.filter(ExecAuthToken.environment == environment)
        now = self.now()
        n = 0
        for row in q.all():
            row.revoked_at = now
            row.revoked_reason = reason[:64]
            n += 1
        self.db.commit()
        return n

    # -- housekeeping --------------------------------------------------------------------------
    def active_count(self, environment: Optional[str] = None) -> int:
        now = naive_utc(self.now())
        q = self.db.query(func.count(ExecAuthToken.id)).filter(
            ExecAuthToken.revoked_at.is_(None), ExecAuthToken.absolute_expires_at > now,
            ExecAuthToken.idle_expires_at > now)
        if environment:
            q = q.filter(ExecAuthToken.environment == environment)
        return int(q.scalar() or 0)

    def purge(self, retention_days: int = 7) -> int:
        """Delete tokens that ended more than ``retention_days`` ago, and audit events older than 30 days."""
        cutoff = naive_utc(self.now() - timedelta(days=retention_days))
        rows = self.db.query(ExecAuthToken).filter(
            (ExecAuthToken.absolute_expires_at < cutoff) | (ExecAuthToken.idle_expires_at < cutoff)
            | (ExecAuthToken.revoked_at < cutoff)
        ).all()
        for r in rows:
            self.db.delete(r)
        self.db.query(ExecAuthEvent).filter(ExecAuthEvent.ts < naive_utc(self.now() - timedelta(days=30))).delete()
        self.db.commit()
        return len(rows)


def audit(db: Session, event: str, *, environment: Optional[str], result: str, principal: Optional[str] = None,
          token_id: Optional[str] = None, reason: Optional[str] = None, path: Optional[str] = None) -> None:
    """Best-effort audit record. Contains the public token id only - never a secret, cookie or key."""
    try:
        db.add(ExecAuthEvent(event=event, environment=environment, token_id=token_id, principal=principal,
                             result=result, reason=reason[:64] if reason else None, path=path[:128] if path else None))
        db.commit()
    except Exception:
        db.rollback()
        logger.warning("auth audit write failed", exc_info=True)


# ------------------------------------------------------------------------------- rate limiting
class RateLimiter:
    def __init__(self, limit: int = 20, window: float = 60.0):
        self.limit, self.window = limit, window
        self._hits: dict[str, deque] = {}
        self._lock = threading.Lock()

    def allow(self, key: str, now: Optional[float] = None) -> bool:
        t = now if now is not None else time.monotonic()
        with self._lock:
            q = self._hits.setdefault(key, deque())
            while q and t - q[0] > self.window:
                q.popleft()
            if len(q) >= self.limit:
                return False
            q.append(t)
            if len(self._hits) > 5000:
                self._hits = {k: v for k, v in self._hits.items() if v and t - v[-1] <= self.window}
            return True


session_limiter = RateLimiter(limit=20, window=60.0)


# ----------------------------------------------------------------------------- execution tickets
@dataclass(frozen=True)
class Principal:
    kind: str  # session | operator | dev_open
    environment: str
    token_id: Optional[str] = None


def order_digest(payload: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str, separators=(",", ":")).encode()).hexdigest()


def make_ticket(principal: Principal, environment: str, digest: str, ttl: int = 30, keyring: Optional[AuthKeyring] = None) -> str:
    kr = keyring or load_keyring()
    exp = int(time.time()) + ttl
    body = f"{environment}|{principal.kind}|{principal.token_id or '-'}|{digest}|{exp}"
    return f"{body}|{kr.sign(body)}"


def verify_ticket(ticket: str, environment: str, digest: str, keyring: Optional[AuthKeyring] = None) -> str:
    """Return the token id ('-' for non-session principals) when the ticket is valid for exactly this
    environment and order payload; otherwise raise AuthError."""
    kr = keyring or load_keyring()
    parts = (ticket or "").split("|")
    if len(parts) != 6:
        raise AuthError("bad_ticket", 403)
    env, _kind, token_id, dig, exp, sig = parts
    if not kr.verify_signature("|".join(parts[:5]), sig):
        raise AuthError("bad_ticket", 403)
    if env != environment:
        raise AuthError("wrong_environment", 403, "Ticket is for a different execution environment")
    if dig != digest:
        raise AuthError("ticket_payload_mismatch", 403)
    if not exp.isdigit() or int(exp) < int(time.time()):
        raise AuthError("ticket_expired", 403)
    return token_id


def execution_gate(principal: Principal, environment: str, payload: dict[str, Any]) -> None:
    """Final check right before an order reaches an engine: re-validates the principal against the
    environment, binds it to this exact order, and re-checks that a session was not revoked meanwhile."""
    from app.database import SessionLocal

    if environment == LIVE:
        raise AuthError("live_disabled", 403, "Live trading is disabled").http()
    if principal.environment != environment:
        raise AuthError("wrong_environment", 403, "Principal is not authorized for this environment").http()
    digest = order_digest(payload)
    try:
        token_id = verify_ticket(make_ticket(principal, environment, digest), environment, digest)
    except AuthError as e:
        raise e.http()
    if principal.kind == "session" and token_id != "-":
        db = SessionLocal()
        try:
            if not TokenService(db).is_active(token_id):
                audit(db, "execution_gate", environment=environment, result="denied", principal="session",
                      token_id=token_id, reason="session_inactive")
                raise AuthError("token_revoked", 401, "Session ended before the order reached the engine").http()
        finally:
            db.close()


# -------------------------------------------------------------------------------- request layer
def is_protected_env() -> bool:
    return (get_settings().app_env or "").strip().lower() in PROTECTED_ENVS


def enforcement_active() -> bool:
    """Open access exists only for local development without an API_KEY (unchanged behaviour)."""
    return bool((get_settings().api_key or "").strip()) or is_protected_env()


def _secure_cookie(request: Request) -> bool:
    xfp = (request.headers.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    return request.url.scheme == "https" or xfp == "https" or is_protected_env()


def set_session_cookie(response: Response, request: Request, environment: str, raw: str, max_age: int) -> None:
    response.set_cookie(COOKIE_NAMES[environment], raw, max_age=max_age, httponly=True,
                        secure=_secure_cookie(request), samesite="strict", path="/api")


def clear_session_cookie(response: Response, environment: str) -> None:
    response.delete_cookie(COOKIE_NAMES[environment], path="/api")


def csrf_ok(request: Request) -> bool:
    """Cookie-authenticated state changes must come from the dashboard's own origin."""
    if request.method in ("GET", "HEAD", "OPTIONS"):
        return True
    sfs = request.headers.get("sec-fetch-site")
    if sfs:
        return sfs in ("same-origin", "none")
    origin = request.headers.get("origin")
    if origin:
        host = (request.headers.get("x-forwarded-host") or request.headers.get("host") or "").split(",")[0].strip()
        return urlparse(origin).netloc == host
    return True


def operator_ok(request: Request) -> Optional[bool]:
    """True = valid operator key, False = a key was sent and is wrong, None = no key sent / none configured."""
    supplied = request.headers.get("x-api-key")
    expected = (get_settings().api_key or "").strip()
    if not supplied or not expected:
        return None
    return hmac.compare_digest(supplied.encode(), expected.encode())


def client_key(request: Request) -> str:
    fwd = (request.headers.get("cf-connecting-ip") or request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    return fwd or (request.client.host if request.client else "unknown")


async def authorize(request: Request, response: Response, environment: str) -> Principal:
    """Authenticate a request for one execution environment. Order of acceptance:
    operator key -> environment session cookie -> open local development (no API_KEY, not production)."""
    from app.database import SessionLocal

    path = request.url.path
    if FORBIDDEN_PATH_RE.search(path):
        raise AuthError("operation_prohibited", 403, "Withdrawals and transfers are prohibited in ETI").http()
    if environment == LIVE:
        raise AuthError("live_disabled", 403, "Live trading is disabled").http()
    if environment not in ISSUABLE_ENVIRONMENTS:
        raise AuthError("unknown_environment", 422).http()

    op = operator_ok(request)
    if op is False:
        raise HTTPException(401, {"error": "Invalid X-API-Key", "code": "invalid_api_key"})
    if op is True:
        return Principal("operator", environment)

    db = SessionLocal()
    try:
        raw = request.cookies.get(COOKIE_NAMES[environment])
        if raw:
            svc = TokenService(db)
            try:
                row = svc.verify(raw, environment)
            except AuthError as e:
                audit(db, "authorize", environment=environment, result="denied", principal="session", reason=e.code, path=path)
                raise e.http("POST /api/auth/session to start a new session")
            if not csrf_ok(request):
                audit(db, "authorize", environment=environment, result="denied", principal="session",
                      token_id=row.token_id, reason="csrf", path=path)
                raise HTTPException(403, {"error": "Cross-origin request refused", "code": "csrf"})
            svc.slide(row)
            if svc.needs_rotation(row):
                new_raw, new_row = svc.rotate(row)
                set_session_cookie(response, request, environment, new_raw, svc.seconds_left(new_row))
                audit(db, "rotate", environment=environment, result="ok", principal="session", token_id=new_row.token_id)
                return Principal("session", environment, new_row.token_id)
            return Principal("session", environment, row.token_id)
        if not enforcement_active():
            return Principal("dev_open", environment)
        audit(db, "authorize", environment=environment, result="denied", reason="no_credentials", path=path)
    finally:
        db.close()
    raise HTTPException(401, {"error": "No execution session", "code": "session_required",
                              "hint": "POST /api/auth/session to start one automatically"})


# ------------------------------------------------------------------------------ log redaction
_TOKEN_RE = re.compile(r"(eti_(?:ip|xt|lv)_[0-9a-f]{16}\.)[A-Za-z0-9_-]{8,}")
_HEADER_RE = re.compile(r"(?i)\b(x-api-key|authorization|set-cookie|cookie)(\s*[:=]\s*)([^\s,;]+)")


def redact(text: str) -> str:
    text = _TOKEN_RE.sub(r"\1[REDACTED]", text)
    return _HEADER_RE.sub(r"\1\2[REDACTED]", text)


_redaction_installed = False


def install_log_redaction() -> None:
    """Wrap the log-record factory so no token, API key or cookie value reaches any log handler."""
    global _redaction_installed
    if _redaction_installed:
        return
    previous = logging.getLogRecordFactory()

    def factory(*args: Any, **kwargs: Any) -> logging.LogRecord:
        record = previous(*args, **kwargs)
        try:
            msg = record.getMessage()
            red = redact(msg)
            if red != msg:
                record.msg, record.args = red, ()
        except Exception:
            pass
        return record

    logging.setLogRecordFactory(factory)
    _redaction_installed = True


install_log_redaction()
