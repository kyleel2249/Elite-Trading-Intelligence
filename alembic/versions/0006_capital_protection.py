"""ETI Capital Protection System and strategy quarantine tables

Revision ID: 0006_capital_protection
Revises: 0005_merge_0004_heads
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0006_capital_protection"
down_revision: Union[str, None] = "0005_merge_0004_heads"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "protection_state",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("key", sa.String(64), nullable=False),
        sa.Column("value", sa.JSON(), nullable=True),
        sa.Column("updated_at", sa.DateTime()),
    )
    op.create_index("ix_protection_state_key", "protection_state", ["key"], unique=True)

    op.create_table(
        "protection_news_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("title", sa.String(256), nullable=False),
        sa.Column("impact", sa.String(16)),
        sa.Column("scope", sa.JSON(), nullable=True),
        sa.Column("event_at", sa.DateTime(), nullable=False),
        sa.Column("created_by", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime()),
    )
    op.create_index("ix_protection_news_events_event_at", "protection_news_events", ["event_at"])

    op.create_table(
        "strategy_quarantine",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("strategy_id", sa.String(128), nullable=False),
        sa.Column("status", sa.String(32)),
        sa.Column("expectations", sa.JSON(), nullable=True),
        sa.Column("reasons", sa.JSON(), nullable=True),
        sa.Column("quarantined_at", sa.DateTime(), nullable=True),
        sa.Column("baseline_at", sa.DateTime(), nullable=True),
        sa.Column("review", sa.JSON(), nullable=True),
        sa.Column("history", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
    )
    op.create_index("ix_strategy_quarantine_strategy_id", "strategy_quarantine", ["strategy_id"], unique=True)
    op.create_index("ix_strategy_quarantine_status", "strategy_quarantine", ["status"])

    op.create_table(
        "strategy_trade_log",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("strategy_id", sa.String(128), nullable=False),
        sa.Column("environment", sa.String(16), nullable=False),
        sa.Column("provider", sa.String(32)),
        sa.Column("symbol", sa.String(64)),
        sa.Column("side", sa.String(8)),
        sa.Column("qty", sa.Float()),
        sa.Column("reference_price", sa.Float(), nullable=True),
        sa.Column("fill_price", sa.Float(), nullable=True),
        sa.Column("slippage_bps", sa.Float(), nullable=True),
        sa.Column("outcome", sa.String(24), nullable=False),
        sa.Column("client_order_id", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime()),
    )
    op.create_index("ix_strategy_trade_log_strategy_id", "strategy_trade_log", ["strategy_id"])
    op.create_index("ix_strategy_trade_log_environment", "strategy_trade_log", ["environment"])
    op.create_index("ix_strategy_trade_log_outcome", "strategy_trade_log", ["outcome"])
    op.create_index("ix_strategy_trade_log_created_at", "strategy_trade_log", ["created_at"])

    op.create_table(
        "protection_audit",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("event_type", sa.String(48), nullable=False),
        sa.Column("actor", sa.String(64)),
        sa.Column("detail", sa.JSON(), nullable=True),
        sa.Column("prev_hash", sa.String(64)),
        sa.Column("hash", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime()),
    )
    op.create_index("ix_protection_audit_event_type", "protection_audit", ["event_type"])
    op.create_index("ix_protection_audit_hash", "protection_audit", ["hash"])
    op.create_index("ix_protection_audit_created_at", "protection_audit", ["created_at"])


def downgrade() -> None:
    for table in ("protection_audit", "strategy_trade_log", "strategy_quarantine",
                  "protection_news_events", "protection_state"):
        op.drop_table(table)
