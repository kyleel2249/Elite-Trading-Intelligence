"""Security governance: RBAC principals, tamper-evident audit chain, m-of-n approvals, withdrawal allowlist, limits, fraud alerts.

Revision ID: 0013_governance
Revises: 0012_accounting
"""
from alembic import op
import sqlalchemy as sa

from app.governance.models import PG_TRIGGERS, SQLITE_TRIGGERS

revision = "0013_governance"
down_revision = "0012_accounting"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table("gov_principals",
        sa.Column("id", sa.Integer, primary_key=True), sa.Column("name", sa.String(64), nullable=False, unique=True),
        sa.Column("role", sa.String(24), nullable=False), sa.Column("key_hash", sa.String(64), unique=True),
        sa.Column("key_hint", sa.String(12)), sa.Column("totp_sealed", sa.Text), sa.Column("totp_enrolled", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.Column("totp_last_step", sa.Integer, nullable=False, server_default="0"), sa.Column("recovery_hashes", sa.Text),
        sa.Column("failed_mfa", sa.Integer, nullable=False, server_default="0"), sa.Column("locked_until", sa.DateTime),
        sa.Column("active", sa.Boolean, nullable=False, server_default=sa.true()), sa.Column("created_by", sa.String(64), nullable=False, server_default="system"),
        sa.Column("created_at", sa.DateTime, nullable=False))
    op.create_index("ix_gov_principals_name", "gov_principals", ["name"])
    op.create_index("ix_gov_principals_role", "gov_principals", ["role"])
    op.create_table("gov_audit",
        sa.Column("seq", sa.Integer, primary_key=True, autoincrement=False), sa.Column("ts", sa.String(32), nullable=False),
        sa.Column("actor", sa.String(64), nullable=False), sa.Column("action", sa.String(64), nullable=False),
        sa.Column("subject", sa.String(128), nullable=False, server_default=""), sa.Column("detail", sa.Text, nullable=False, server_default="{}"),
        sa.Column("prev_hash", sa.String(64), nullable=False), sa.Column("hash", sa.String(64), nullable=False, unique=True), sa.Column("kid", sa.String(8), nullable=False))
    op.create_index("ix_gov_audit_actor", "gov_audit", ["actor"])
    op.create_index("ix_gov_audit_action", "gov_audit", ["action"])
    op.create_table("gov_approvals",
        sa.Column("id", sa.Integer, primary_key=True), sa.Column("action", sa.String(48), nullable=False), sa.Column("params", sa.Text, nullable=False),
        sa.Column("digest", sa.String(64), nullable=False), sa.Column("reason", sa.String(240)), sa.Column("requester", sa.String(64), nullable=False),
        sa.Column("required", sa.Integer, nullable=False, server_default="2"), sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime, nullable=False), sa.Column("expires_at", sa.DateTime, nullable=False),
        sa.Column("decided_at", sa.DateTime), sa.Column("executed_at", sa.DateTime))
    op.create_index("ix_gov_approvals_action", "gov_approvals", ["action"])
    op.create_index("ix_gov_approvals_digest", "gov_approvals", ["digest"])
    op.create_index("ix_gov_approvals_status", "gov_approvals", ["status"])
    op.create_table("gov_approval_votes",
        sa.Column("id", sa.Integer, primary_key=True), sa.Column("approval_id", sa.Integer, nullable=False), sa.Column("approver", sa.String(64), nullable=False),
        sa.Column("decision", sa.String(8), nullable=False), sa.Column("comment", sa.String(240)), sa.Column("created_at", sa.DateTime, nullable=False),
        sa.UniqueConstraint("approval_id", "approver", name="uq_gov_vote"))
    op.create_index("ix_gov_approval_votes_approval_id", "gov_approval_votes", ["approval_id"])
    op.create_table("gov_allowlist",
        sa.Column("id", sa.Integer, primary_key=True), sa.Column("network", sa.String(24), nullable=False), sa.Column("address", sa.String(96), nullable=False),
        sa.Column("label", sa.String(64)), sa.Column("status", sa.String(16), nullable=False, server_default="pending"), sa.Column("created_by", sa.String(64), nullable=False),
        sa.Column("approval_id", sa.Integer), sa.Column("created_at", sa.DateTime, nullable=False), sa.Column("activates_at", sa.DateTime),
        sa.UniqueConstraint("network", "address", name="uq_gov_allow"))
    op.create_index("ix_gov_allowlist_network", "gov_allowlist", ["network"])
    op.create_index("ix_gov_allowlist_address", "gov_allowlist", ["address"])
    op.create_index("ix_gov_allowlist_status", "gov_allowlist", ["status"])
    op.create_table("gov_limits",
        sa.Column("id", sa.Integer, primary_key=True), sa.Column("role", sa.String(24), nullable=False), sa.Column("network", sa.String(24), nullable=False),
        sa.Column("per_tx_wei", sa.String(80)), sa.Column("daily_wei", sa.String(80)), sa.Column("approval_above_wei", sa.String(80)),
        sa.Column("updated_by", sa.String(64), nullable=False, server_default="system"), sa.Column("updated_at", sa.DateTime, nullable=False),
        sa.UniqueConstraint("role", "network", name="uq_gov_limit"))
    op.create_table("gov_fraud_alerts",
        sa.Column("id", sa.Integer, primary_key=True), sa.Column("created_at", sa.DateTime, nullable=False), sa.Column("verdict", sa.String(10), nullable=False),
        sa.Column("score", sa.Integer, nullable=False), sa.Column("actor", sa.String(64), nullable=False), sa.Column("subject", sa.String(128), nullable=False, server_default=""),
        sa.Column("rules", sa.Text, nullable=False, server_default="[]"), sa.Column("status", sa.String(12), nullable=False, server_default="open"),
        sa.Column("resolved_by", sa.String(64)), sa.Column("resolution", sa.String(240)))
    op.create_index("ix_gov_fraud_alerts_created_at", "gov_fraud_alerts", ["created_at"])
    op.create_index("ix_gov_fraud_alerts_status", "gov_fraud_alerts", ["status"])
    dialect = op.get_bind().dialect.name
    for stmt in (SQLITE_TRIGGERS if dialect == "sqlite" else PG_TRIGGERS if dialect == "postgresql" else []):
        op.execute(stmt)


def downgrade() -> None:
    dialect = op.get_bind().dialect.name
    if dialect == "postgresql":     # the audit log is deliberately hard to remove: drop its guards only inside an explicit downgrade
        op.execute("DROP TRIGGER IF EXISTS gov_audit_no_mutation ON gov_audit")
        op.execute("DROP TRIGGER IF EXISTS gov_audit_no_truncate ON gov_audit")
        op.execute("DROP FUNCTION IF EXISTS gov_audit_immutable()")
    elif dialect == "sqlite":
        op.execute("DROP TRIGGER IF EXISTS gov_audit_no_update")
        op.execute("DROP TRIGGER IF EXISTS gov_audit_no_delete")
    for t in ("gov_fraud_alerts", "gov_limits", "gov_allowlist", "gov_approval_votes", "gov_approvals", "gov_audit", "gov_principals"):
        op.drop_table(t)
