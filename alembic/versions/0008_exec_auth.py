"""Execution authorization tables

Revision ID: 0008_exec_auth
Revises: 0007_internal_paper
"""
from alembic import op
import sqlalchemy as sa

revision = "0008_exec_auth"
down_revision = "0007_internal_paper"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "eti_exec_tokens",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("token_id", sa.String(24), nullable=False, unique=True, index=True),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("key_id", sa.String(16), nullable=False),
        sa.Column("environment", sa.String(24), nullable=False, index=True),
        sa.Column("kind", sa.String(16)),
        sa.Column("subject", sa.String(64)),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("last_used_at", sa.DateTime(), nullable=True),
        sa.Column("idle_expires_at", sa.DateTime(), nullable=False),
        sa.Column("absolute_expires_at", sa.DateTime(), nullable=False, index=True),
        sa.Column("rotated_at", sa.DateTime(), nullable=True),
        sa.Column("replaced_by", sa.String(24), nullable=True),
        sa.Column("revoked_at", sa.DateTime(), nullable=True, index=True),
        sa.Column("revoked_reason", sa.String(64), nullable=True),
    )
    op.create_table(
        "eti_exec_auth_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("ts", sa.DateTime(), index=True),
        sa.Column("event", sa.String(32), nullable=False, index=True),
        sa.Column("environment", sa.String(24), nullable=True, index=True),
        sa.Column("token_id", sa.String(24), nullable=True),
        sa.Column("principal", sa.String(16), nullable=True),
        sa.Column("result", sa.String(16), nullable=False),
        sa.Column("reason", sa.String(64), nullable=True),
        sa.Column("path", sa.String(128), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("eti_exec_auth_events")
    op.drop_table("eti_exec_tokens")
