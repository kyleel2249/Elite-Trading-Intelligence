"""Executive Command Centre: departmental budgets, payment/withdrawal approval register, reserve policy, audit trail.

Revision ID: 0013_executive_centre
Revises: 0012_accounting
"""
from alembic import op
import sqlalchemy as sa

from app.prediction_ledger.immutability import postgres_statements, sqlite_statements

revision = "0013_executive_centre"
down_revision = "0012_accounting"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "exec_budgets",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("department", sa.String(40), nullable=False),
        sa.Column("period", sa.String(7), nullable=False),
        sa.Column("currency", sa.String(10), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("set_by", sa.String(64), nullable=False),
        sa.Column("updated_at", sa.String(32), nullable=False),
        sa.UniqueConstraint("department", "period", "currency", name="uq_exec_budget"),
    )
    op.create_index("ix_exec_budgets_department", "exec_budgets", ["department"])
    op.create_table(
        "exec_payment_requests",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("reference", sa.String(64), nullable=False, unique=True),
        sa.Column("idem_key", sa.String(120), unique=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("payee", sa.String(128), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(10), nullable=False),
        sa.Column("department", sa.String(40)),
        sa.Column("due_date", sa.String(10), nullable=False),
        sa.Column("status", sa.String(12), nullable=False),
        sa.Column("document_id", sa.String(300)),
        sa.Column("expense_account", sa.String(8)),
        sa.Column("from_account", sa.String(8)),
        sa.Column("to_account", sa.String(8)),
        sa.Column("requested_by", sa.String(64), nullable=False),
        sa.Column("requested_at", sa.String(32), nullable=False),
        sa.Column("decided_by", sa.String(64)),
        sa.Column("decided_at", sa.String(32)),
        sa.Column("decision_note", sa.Text()),
        sa.Column("paid_by", sa.String(64)),
        sa.Column("paid_at", sa.String(32)),
        sa.Column("payment_ref", sa.String(190)),
        sa.Column("ledger_entry", sa.String(16)),
        sa.Column("ledger_booked", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_index("ix_exec_payment_requests_kind", "exec_payment_requests", ["kind"])
    op.create_index("ix_exec_payment_requests_status", "exec_payment_requests", ["status"])
    op.create_index("ix_exec_payment_requests_document_id", "exec_payment_requests", ["document_id"])
    op.create_table(
        "exec_reserve_policy",
        sa.Column("currency", sa.String(10), primary_key=True),
        sa.Column("target", sa.BigInteger(), nullable=False),
        sa.Column("months_of_burn", sa.Integer(), nullable=False),
        sa.Column("updated_by", sa.String(64), nullable=False),
        sa.Column("updated_at", sa.String(32), nullable=False),
    )
    op.create_table(
        "exec_audit",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("ts", sa.String(32), nullable=False),
        sa.Column("actor", sa.String(64), nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("action", sa.String(48), nullable=False),
        sa.Column("subject", sa.String(96), nullable=False),
        sa.Column("detail", sa.JSON(), nullable=False),
    )
    op.create_index("ix_exec_audit_ts", "exec_audit", ["ts"])
    op.create_index("ix_exec_audit_action", "exec_audit", ["action"])
    dialect = op.get_bind().dialect.name
    if dialect == "sqlite":
        for stmt in sqlite_statements("exec_audit"):
            op.execute(sa.text(stmt))
    elif dialect == "postgresql":          # the trigger function was created by 0012_accounting
        for stmt in postgres_statements("exec_audit"):
            op.execute(sa.text(stmt))


def downgrade() -> None:
    import os
    if os.getenv("ALLOW_LEDGER_DOWNGRADE") != "yes-destroy-accounting-history":
        raise RuntimeError("Refusing to drop the executive audit trail. Set ALLOW_LEDGER_DOWNGRADE=yes-destroy-accounting-history to force.")
    if op.get_bind().dialect.name == "sqlite":
        op.execute(sa.text("DROP TRIGGER IF EXISTS trg_exec_audit_no_update"))
        op.execute(sa.text("DROP TRIGGER IF EXISTS trg_exec_audit_no_delete"))
    for t in ("exec_audit", "exec_reserve_policy", "exec_payment_requests", "exec_budgets"):
        op.drop_table(t)
