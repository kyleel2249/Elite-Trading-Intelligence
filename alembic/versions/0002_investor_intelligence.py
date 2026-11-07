"""investor activities, alerts, disclosure outcomes

Revision ID: 0002_investor
Revises: 0001_initial
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0002_investor"
down_revision: Union[str, None] = "0001_initial"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "investor_activities",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("activity_id", sa.String(64), nullable=False),
        sa.Column("category", sa.String(64)),
        sa.Column("investor_name", sa.String(256), nullable=True),
        sa.Column("institution", sa.String(256), nullable=True),
        sa.Column("ticker", sa.String(32), nullable=True),
        sa.Column("direction", sa.String(16), nullable=True),
        sa.Column("transaction_date", sa.String(64), nullable=True),
        sa.Column("filing_or_report_date", sa.String(64), nullable=True),
        sa.Column("publication_date", sa.String(64), nullable=True),
        sa.Column("amount_or_range", sa.String(128), nullable=True),
        sa.Column("source_provider", sa.String(64)),
        sa.Column("verification_status", sa.String(64)),
        sa.Column("significance", sa.String(32)),
        sa.Column("confidence", sa.Float()),
        sa.Column("notes", sa.JSON(), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("is_historical_snapshot", sa.Boolean(), default=False),
        sa.Column("retrieved_at", sa.DateTime()),
        sa.Column("created_at", sa.DateTime()),
    )
    op.create_index("ix_investor_activities_activity_id", "investor_activities", ["activity_id"], unique=True)
    op.create_table(
        "intelligence_alerts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("alert_id", sa.String(64), nullable=False),
        sa.Column("activity_id", sa.String(64), nullable=True),
        sa.Column("title", sa.String(512)),
        sa.Column("severity", sa.String(32)),
        sa.Column("ticker", sa.String(32), nullable=True),
        sa.Column("investor_name", sa.String(256), nullable=True),
        sa.Column("category", sa.String(64), nullable=True),
        sa.Column("summary", sa.Text()),
        sa.Column("recommended_action", sa.String(64)),
        sa.Column("source_provider", sa.String(64), nullable=True),
        sa.Column("verification_status", sa.String(64)),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("acknowledged", sa.Boolean(), default=False),
        sa.Column("created_at", sa.DateTime()),
    )
    op.create_index("ix_intelligence_alerts_alert_id", "intelligence_alerts", ["alert_id"], unique=True)
    op.create_table(
        "disclosure_outcomes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("activity_id", sa.String(64)),
        sa.Column("ticker", sa.String(32)),
        sa.Column("publication_date", sa.String(64), nullable=True),
        sa.Column("horizon_days", sa.Integer()),
        sa.Column("return_pct", sa.Float(), nullable=True),
        sa.Column("benchmark_return_pct", sa.Float(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime()),
    )


def downgrade() -> None:
    op.drop_table("disclosure_outcomes")
    op.drop_table("intelligence_alerts")
    op.drop_table("investor_activities")
