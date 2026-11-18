"""Tables for security governance. Registered in app.database.init_db and created by Alembic revision 0013_governance.

gov_audit is append-only: ORM guards plus database triggers (SQLite and PostgreSQL) reject UPDATE and DELETE, and every row
carries an HMAC that chains it to its predecessor, so tampering is detectable even by someone who bypasses the triggers.
Secrets (TOTP seeds) are stored only as Fernet ciphertext; principal API keys only as a keyed hash.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import DDL, Boolean, DateTime, Integer, String, Text, UniqueConstraint, event
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


def now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class GovPrincipal(Base):
    __tablename__ = "gov_principals"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    role: Mapped[str] = mapped_column(String(24), index=True)
    key_hash: Mapped[Optional[str]] = mapped_column(String(64), unique=True, nullable=True)   # keyed HMAC of the API key
    key_hint: Mapped[Optional[str]] = mapped_column(String(12), nullable=True)
    totp_sealed: Mapped[Optional[str]] = mapped_column(Text, nullable=True)                   # Fernet ciphertext of the TOTP seed
    totp_enrolled: Mapped[bool] = mapped_column(Boolean, default=False)
    totp_last_step: Mapped[int] = mapped_column(Integer, default=0)
    recovery_hashes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)               # JSON list of keyed hashes
    failed_mfa: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[str] = mapped_column(String(64), default="system")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class GovAudit(Base):
    __tablename__ = "gov_audit"
    seq: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    ts: Mapped[str] = mapped_column(String(32))
    actor: Mapped[str] = mapped_column(String(64), index=True)
    action: Mapped[str] = mapped_column(String(64), index=True)
    subject: Mapped[str] = mapped_column(String(128), default="")
    detail: Mapped[str] = mapped_column(Text, default="{}")
    prev_hash: Mapped[str] = mapped_column(String(64))
    hash: Mapped[str] = mapped_column(String(64), unique=True)
    kid: Mapped[str] = mapped_column(String(8))


class GovApproval(Base):
    __tablename__ = "gov_approvals"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    action: Mapped[str] = mapped_column(String(48), index=True)
    params: Mapped[str] = mapped_column(Text)                          # canonical JSON the approvers actually reviewed
    digest: Mapped[str] = mapped_column(String(64), index=True)        # sha256(action + params); execution must match it
    reason: Mapped[Optional[str]] = mapped_column(String(240), nullable=True)
    requester: Mapped[str] = mapped_column(String(64))
    required: Mapped[int] = mapped_column(Integer, default=2)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    decided_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    executed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class GovApprovalVote(Base):
    __tablename__ = "gov_approval_votes"
    __table_args__ = (UniqueConstraint("approval_id", "approver", name="uq_gov_vote"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    approval_id: Mapped[int] = mapped_column(Integer, index=True)
    approver: Mapped[str] = mapped_column(String(64))
    decision: Mapped[str] = mapped_column(String(8))                    # approve | reject
    comment: Mapped[Optional[str]] = mapped_column(String(240), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class GovAllowEntry(Base):
    __tablename__ = "gov_allowlist"
    __table_args__ = (UniqueConstraint("network", "address", name="uq_gov_allow"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    network: Mapped[str] = mapped_column(String(24), index=True)
    address: Mapped[str] = mapped_column(String(96), index=True)
    label: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)   # pending | cooling | revoked
    created_by: Mapped[str] = mapped_column(String(64))
    approval_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now)
    activates_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


class GovLimit(Base):
    __tablename__ = "gov_limits"
    __table_args__ = (UniqueConstraint("role", "network", name="uq_gov_limit"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    role: Mapped[str] = mapped_column(String(24))                       # a role, or "*" for the default
    network: Mapped[str] = mapped_column(String(24))
    per_tx_wei: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    daily_wei: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    approval_above_wei: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    updated_by: Mapped[str] = mapped_column(String(64), default="system")
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=now)


class GovFraudAlert(Base):
    __tablename__ = "gov_fraud_alerts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=now, index=True)
    verdict: Mapped[str] = mapped_column(String(10))                    # review | block
    score: Mapped[int] = mapped_column(Integer)
    actor: Mapped[str] = mapped_column(String(64))
    subject: Mapped[str] = mapped_column(String(128), default="")
    rules: Mapped[str] = mapped_column(Text, default="[]")
    status: Mapped[str] = mapped_column(String(12), default="open", index=True)   # open | resolved
    resolved_by: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    resolution: Mapped[Optional[str]] = mapped_column(String(240), nullable=True)


# --------------------------------------------------------------------------- immutability
class ImmutableAuditError(RuntimeError):
    pass


def _orm_block(mapper, connection, target):
    raise ImmutableAuditError("gov_audit is append-only: rows cannot be updated or deleted")


event.listen(GovAudit, "before_update", _orm_block)
event.listen(GovAudit, "before_delete", _orm_block)

SQLITE_TRIGGERS = [
    "CREATE TRIGGER IF NOT EXISTS gov_audit_no_update BEFORE UPDATE ON gov_audit BEGIN SELECT RAISE(ABORT, 'gov_audit is append-only'); END",
    "CREATE TRIGGER IF NOT EXISTS gov_audit_no_delete BEFORE DELETE ON gov_audit BEGIN SELECT RAISE(ABORT, 'gov_audit is append-only'); END",
]
PG_TRIGGERS = [
    "CREATE OR REPLACE FUNCTION gov_audit_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'gov_audit is append-only'; END; $$ LANGUAGE plpgsql",
    "DROP TRIGGER IF EXISTS gov_audit_no_mutation ON gov_audit",
    "CREATE TRIGGER gov_audit_no_mutation BEFORE UPDATE OR DELETE ON gov_audit FOR EACH ROW EXECUTE FUNCTION gov_audit_immutable()",
    "DROP TRIGGER IF EXISTS gov_audit_no_truncate ON gov_audit",
    "CREATE TRIGGER gov_audit_no_truncate BEFORE TRUNCATE ON gov_audit FOR EACH STATEMENT EXECUTE FUNCTION gov_audit_immutable()",
]
for _sql in SQLITE_TRIGGERS:
    event.listen(GovAudit.__table__, "after_create", DDL(_sql).execute_if(dialect="sqlite"))
for _sql in PG_TRIGGERS:
    event.listen(GovAudit.__table__, "after_create", DDL(_sql).execute_if(dialect="postgresql"))
