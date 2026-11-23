"""Security posture: an honest, evidence-based checklist of the controls this deployment actually has right now.

Statuses: pass (verified here), warn (works but weak/unverified), fail (a control is missing). Things the application cannot
observe from inside - e.g. disk encryption of a managed database volume - are reported as `unverified`, never as pass.
"""
from __future__ import annotations

from datetime import timedelta
from urllib.parse import parse_qs, urlparse

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.chain.networks import NETWORKS, chain_enabled, load_limits, rpc_url
from app.config import get_settings
from app.governance import audit, gate, keys, rbac
from app.governance.models import GovAudit, GovPrincipal, now
from app.governance.transport import https_enforced


def _c(cid: str, title: str, status: str, detail: str) -> dict:
    return {"id": cid, "title": title, "status": status, "detail": detail}


def last_action_age(db: Session, action: str):
    ts = db.execute(select(func.max(GovAudit.ts)).where(GovAudit.action == action)).scalar()
    if not ts:
        return None
    from datetime import datetime
    return now() - datetime.fromisoformat(ts).replace(tzinfo=None)


def report(db: Session) -> dict:
    s = get_settings()
    checks: list[dict] = []
    api = (s.api_key or "").strip()
    checks.append(_c("api_key", "API key configured", "pass" if len(api) >= 24 else "fail" if not api else "warn",
                     "set and 24+ chars" if len(api) >= 24 else "not set" if not api else "set but shorter than 24 characters"))
    checks.append(_c("governance_key", "Governance key separate from the API key",
                     "fail" if keys.is_dev_key() else "warn" if keys._material("GOVERNANCE_KEY") == (api.encode() or None) else "pass",
                     "using the built-in development key - set GOVERNANCE_KEY (or EXECUTION_VAULT_KEY)" if keys.is_dev_key()
                     else "audit chain, principal keys and sealed secrets use a configured key"))
    vault = (s.execution_vault_key or "").strip()
    checks.append(_c("vault_key", "Credential vault key (EXECUTION_VAULT_KEY)", "pass" if vault else "warn",
                     "configured; wallet and broker secrets are Fernet-sealed at rest" if vault else "not set - wallet/broker secrets cannot be stored"))
    chain = audit.verify(db)
    checks.append(_c("audit_chain", "Audit log integrity", "pass" if chain["ok"] else "fail",
                     f"{chain['rows']} rows verified" if chain["ok"] else f"BROKEN at seq {chain['broken_at']}: {chain['reason']}"))
    mfa_on = rbac.mfa_required()
    checks.append(_c("mfa_enforced", "MFA enforced for privileged actions", "pass" if mfa_on else "warn",
                     "TOTP required for approvals, allowlist, limits, sends, backups" if mfa_on else "disabled (local/test default or GOV_MFA_REQUIRED=false)"))
    people = db.execute(select(GovPrincipal).where(GovPrincipal.active == True)).scalars().all()  # noqa: E712
    unenrolled = [p.name for p in people if not p.totp_enrolled and p.role in ("admin", "security_admin", "treasurer", "approver")]
    checks.append(_c("mfa_enrolled", "Privileged principals have MFA", "pass" if people and not unenrolled else "warn",
                     "all privileged principals enrolled" if people and not unenrolled else
                     ("no principals yet" if not people else "not enrolled: " + ", ".join(unenrolled))))
    signers = {p.name for p in people if p.role in ("approver", "treasurer", "admin")}
    need = 2
    checks.append(_c("multisig_ready", "Enough distinct approvers for m-of-n", "pass" if len(signers) >= need else "fail",
                     f"{len(signers)} approver-capable principals (need {need}+); the shared API key counts as one"))
    checks.append(_c("enforcement", "Send gate enforced", "pass" if gate.enforced() else "warn",
                     "allowlist + limits + fraud + m-of-n run before any key is used" if gate.enforced() else "off (local default); set GOVERNANCE_ENFORCE=true"))
    url = s.database_url
    if url.startswith("postgres"):
        q = {k.lower(): v[0].lower() for k, v in parse_qs(urlparse(url).query).items()}
        tls = q.get("sslmode") in ("require", "verify-ca", "verify-full")
        checks.append(_c("db_transport", "Database connection encrypted in transit", "pass" if tls else "warn",
                         f"sslmode={q.get('sslmode')}" if tls else "add ?sslmode=require (or verify-full) to DATABASE_URL"))
    else:
        checks.append(_c("db_transport", "Database connection encrypted in transit", "warn", "SQLite/local file: no network transport"))
    checks.append(_c("db_at_rest", "Database storage encrypted at rest", "unverified",
                     "cannot be observed from the application; confirm provider volume encryption (e.g. managed Postgres) - "
                     "secrets and TOTP seeds are additionally application-encrypted (Fernet) regardless"))
    checks.append(_c("https", "HTTPS enforced and security headers sent", "pass" if https_enforced() else "warn",
                     "HTTP is redirected to HTTPS, HSTS sent" if https_enforced() else "not enforced here (local/test or GOV_ENFORCE_HTTPS=false)"))
    insecure = [k for k in NETWORKS if (rpc_url(k) or "").startswith("http://")]
    checks.append(_c("rpc_tls", "Chain RPC endpoints use TLS", "fail" if insecure else "pass", "plain-HTTP RPC: " + ", ".join(insecure) if insecure else "all https"))
    if chain_enabled():
        lim = load_limits()
        checks.append(_c("mainnet_send", "Mainnet sends", "pass" if not lim.mainnet_send_enabled else "warn",
                         "disabled (default)" if not lim.mainnet_send_enabled else "ENABLED: the gate must stay enforced"))
        checks.append(_c("chain_allowlist", "Chain policy requires an allowlist", "pass" if lim.require_allowlist else "fail",
                         "yes" if lim.require_allowlist else "CHAIN_REQUIRE_ALLOWLIST is off"))
    for aid, label, days in (("dr_backup", "Encrypted backup in the last 7 days", 7), ("dr_drill", "Recovery drill in the last 30 days", 30)):
        age = last_action_age(db, "dr.backup" if aid == "dr_backup" else "dr.drill")
        ok = age is not None and age <= timedelta(days=days)
        checks.append(_c(aid, label, "pass" if ok else "warn", f"last {age.days}d ago" if age is not None else "never performed"))
    tally = {k: sum(c["status"] == k for c in checks) for k in ("pass", "warn", "fail", "unverified")}
    return {"environment": keys.env_name(), "summary": tally, "ok": tally["fail"] == 0, "checks": checks}
