"""initial schema

Revision ID: 0001_initial
Revises:
Create Date: 2026-11-06

Hand-authored initial revision matching app.models (create_all compatible).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "instruments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("provider", sa.String(32)),
        sa.Column("symbol", sa.String(64)),
        sa.Column("normalized_symbol", sa.String(64)),
        sa.Column("asset_class", sa.String(32)),
        sa.Column("exchange", sa.String(64), nullable=True),
        sa.Column("quote_currency", sa.String(16), nullable=True),
        sa.Column("tradable", sa.Boolean(), default=True),
        sa.Column("meta", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
    )
    op.create_table(
        "market_snapshots",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("provider", sa.String(32)),
        sa.Column("symbol", sa.String(64)),
        sa.Column("price", sa.Float()),
        sa.Column("bid", sa.Float(), nullable=True),
        sa.Column("ask", sa.Float(), nullable=True),
        sa.Column("volume", sa.Float(), nullable=True),
        sa.Column("ts_provider", sa.DateTime(), nullable=True),
        sa.Column("ts_utc", sa.DateTime()),
        sa.Column("retrieved_at", sa.DateTime()),
        sa.Column("data_status", sa.String(32)),
        sa.Column("quality_flags", sa.JSON(), nullable=True),
    )
    op.create_table(
        "orders",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("client_order_id", sa.String(64)),
        sa.Column("provider", sa.String(32)),
        sa.Column("environment", sa.String(16)),
        sa.Column("symbol", sa.String(64)),
        sa.Column("side", sa.String(8)),
        sa.Column("order_type", sa.String(16)),
        sa.Column("qty", sa.Float()),
        sa.Column("limit_price", sa.Float(), nullable=True),
        sa.Column("fill_price", sa.Float(), nullable=True),
        sa.Column("status", sa.String(32)),
        sa.Column("provider_order_id", sa.String(128), nullable=True),
        sa.Column("risk_approved", sa.Boolean()),
        sa.Column("risk_notes", sa.Text(), nullable=True),
        sa.Column("realized_pnl", sa.Float(), nullable=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
    )
    op.create_table(
        "positions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("provider", sa.String(32)),
        sa.Column("environment", sa.String(16)),
        sa.Column("symbol", sa.String(64)),
        sa.Column("side", sa.String(8)),
        sa.Column("qty", sa.Float()),
        sa.Column("avg_entry", sa.Float()),
        sa.Column("realized_pnl", sa.Float()),
        sa.Column("unrealized_pnl", sa.Float()),
        sa.Column("mark_price", sa.Float(), nullable=True),
        sa.Column("status", sa.String(16)),
        sa.Column("opened_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
        sa.Column("meta", sa.JSON(), nullable=True),
    )
    op.create_table(
        "journal_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("client_order_id", sa.String(64), nullable=True),
        sa.Column("provider", sa.String(32)),
        sa.Column("environment", sa.String(16)),
        sa.Column("symbol", sa.String(64)),
        sa.Column("side", sa.String(8)),
        sa.Column("qty", sa.Float()),
        sa.Column("price", sa.Float(), nullable=True),
        sa.Column("event", sa.String(32)),
        sa.Column("pnl", sa.Float(), nullable=True),
        sa.Column("thesis", sa.Text(), nullable=True),
        sa.Column("council_action", sa.String(32), nullable=True),
        sa.Column("risk_officer", sa.String(64), nullable=True),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime()),
    )
    op.create_table(
        "risk_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("event_type", sa.String(64)),
        sa.Column("severity", sa.String(16)),
        sa.Column("message", sa.Text()),
        sa.Column("context", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime()),
    )
    op.create_table(
        "council_decisions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("symbol", sa.String(64)),
        sa.Column("provider", sa.String(32)),
        sa.Column("action", sa.String(32)),
        sa.Column("confidence", sa.Float()),
        sa.Column("summary", sa.Text()),
        sa.Column("risk_veto", sa.Boolean()),
        sa.Column("data_quality", sa.String(32)),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime()),
    )
    op.create_table(
        "forecasts",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("symbol", sa.String(64)),
        sa.Column("provider", sa.String(32)),
        sa.Column("horizon", sa.String(32)),
        sa.Column("model_version", sa.String(32)),
        sa.Column("analyst", sa.String(64)),
        sa.Column("bull_price", sa.Float(), nullable=True),
        sa.Column("base_price", sa.Float(), nullable=True),
        sa.Column("bear_price", sa.Float(), nullable=True),
        sa.Column("expected_vol", sa.Float(), nullable=True),
        sa.Column("confidence", sa.Float()),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime()),
    )
    op.create_table(
        "forecast_accuracy",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("forecast_id", sa.Integer()),
        sa.Column("symbol", sa.String(64)),
        sa.Column("provider", sa.String(32)),
        sa.Column("horizon", sa.String(32)),
        sa.Column("predicted_base", sa.Float(), nullable=True),
        sa.Column("realized_price", sa.Float()),
        sa.Column("absolute_error", sa.Float(), nullable=True),
        sa.Column("pct_error", sa.Float(), nullable=True),
        sa.Column("in_scenario_range", sa.Boolean(), nullable=True),
        sa.Column("direction_correct", sa.Boolean(), nullable=True),
        sa.Column("analyst", sa.String(64)),
        sa.Column("model_version", sa.String(32)),
        sa.Column("created_at", sa.DateTime()),
    )


def downgrade() -> None:
    for t in [
        "forecast_accuracy",
        "forecasts",
        "council_decisions",
        "risk_events",
        "journal_entries",
        "positions",
        "orders",
        "market_snapshots",
        "instruments",
    ]:
        op.drop_table(t)
