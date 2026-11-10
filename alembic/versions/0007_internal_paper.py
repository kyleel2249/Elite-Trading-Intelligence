"""Internal paper exchange: persistent simulated accounts + append-only audit log.

Revision ID: 0007_internal_paper
Revises: 0006_global_alpha
"""
from alembic import op
import sqlalchemy as sa

revision = "0007_internal_paper"
down_revision = "0006_global_alpha"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "paper_accounts",
        sa.Column("account_id", sa.String(64), primary_key=True),
        sa.Column("state", sa.JSON(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "paper_audit_log",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("account_id", sa.String(64), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("ts", sa.String(40), nullable=False),
        sa.Column("event", sa.String(48), nullable=False),
        sa.Column("order_id", sa.String(32)),
        sa.Column("detail", sa.JSON()),
    )
    op.create_index("ix_paper_audit_log_account_id", "paper_audit_log", ["account_id"])
    op.create_index("ix_paper_audit_log_event", "paper_audit_log", ["event"])
    op.create_index("ix_paper_audit_log_order_id", "paper_audit_log", ["order_id"])


def downgrade() -> None:
    op.drop_table("paper_audit_log")
    op.drop_table("paper_accounts")
