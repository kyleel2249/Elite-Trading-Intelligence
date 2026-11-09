"""global scanner, valuation, sizing and execution tables

Revision ID: 0003_quant
Revises: 0002_investor
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0003_quant"
down_revision: Union[str, None] = "0002_investor"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _id():
    return sa.Column("id", sa.Integer(), primary_key=True)


def upgrade() -> None:
    op.create_table("scan_runs", _id(),
        sa.Column("started_at", sa.DateTime()), sa.Column("duration_seconds", sa.Float()),
        sa.Column("universe_size", sa.Integer()), sa.Column("scanned_ok", sa.Integer()),
        sa.Column("stale", sa.Integer()), sa.Column("unavailable", sa.Integer()),
        sa.Column("requests", sa.Integer()), sa.Column("retries", sa.Integer()),
        sa.Column("failovers", sa.Integer()), sa.Column("completion_pct", sa.Float()),
        sa.Column("within_interval", sa.Boolean()), sa.Column("per_provider", sa.JSON(), nullable=True))
    op.create_index("ix_scan_runs_started_at", "scan_runs", ["started_at"])
    op.create_table("market_coverage", _id(),
        sa.Column("symbol", sa.String(64), nullable=False), sa.Column("asset_class", sa.String(32)),
        sa.Column("exchange", sa.String(64), nullable=True), sa.Column("provider", sa.String(32), nullable=True),
        sa.Column("failover_provider", sa.String(32), nullable=True), sa.Column("status", sa.String(16)),
        sa.Column("price", sa.Float(), nullable=True), sa.Column("data_age_seconds", sa.Float(), nullable=True),
        sa.Column("quality_score", sa.Float()), sa.Column("fields", sa.JSON(), nullable=True),
        sa.Column("last_success_ts", sa.String(40), nullable=True),
        sa.Column("last_valid_data_ts", sa.String(40), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True), sa.Column("consecutive_failures", sa.Integer()),
        sa.Column("updated_at", sa.DateTime()))
    op.create_index("ix_market_coverage_symbol", "market_coverage", ["symbol"], unique=True)
    op.create_index("ix_market_coverage_status", "market_coverage", ["status"])
    op.create_index("ix_market_coverage_asset_class", "market_coverage", ["asset_class"])
    op.create_index("ix_market_coverage_exchange", "market_coverage", ["exchange"])
    op.create_table("fair_value_estimates", _id(),
        sa.Column("symbol", sa.String(64)), sa.Column("asset_class", sa.String(32)),
        sa.Column("market_price", sa.Float()), sa.Column("fair_value", sa.Float(), nullable=True),
        sa.Column("lower_bound", sa.Float(), nullable=True), sa.Column("upper_bound", sa.Float(), nullable=True),
        sa.Column("confidence", sa.Float()), sa.Column("supported", sa.Boolean()),
        sa.Column("model_version", sa.String(32)), sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime()))
    op.create_index("ix_fair_value_estimates_symbol", "fair_value_estimates", ["symbol"])
    op.create_index("ix_fair_value_estimates_created_at", "fair_value_estimates", ["created_at"])
    op.create_table("mispricing_alerts", _id(),
        sa.Column("symbol", sa.String(64)), sa.Column("direction", sa.String(16)),
        sa.Column("mispricing_pct", sa.Float()), sa.Column("band", sa.String(16)),
        sa.Column("confirmed", sa.Boolean()), sa.Column("market_price_at_discovery", sa.Float()),
        sa.Column("fair_value_at_discovery", sa.Float()), sa.Column("failed_checks", sa.JSON(), nullable=True),
        sa.Column("unverified_checks", sa.JSON(), nullable=True), sa.Column("status", sa.String(16)),
        sa.Column("converged_at", sa.DateTime(), nullable=True), sa.Column("created_at", sa.DateTime()))
    op.create_index("ix_mispricing_alerts_symbol", "mispricing_alerts", ["symbol"])
    op.create_index("ix_mispricing_alerts_status", "mispricing_alerts", ["status"])
    op.create_index("ix_mispricing_alerts_created_at", "mispricing_alerts", ["created_at"])
    op.create_index("ix_mispricing_symbol_status", "mispricing_alerts", ["symbol", "status"])
    op.create_table("prediction_ledger", _id(),
        sa.Column("prediction_key", sa.String(64), nullable=False), sa.Column("symbol", sa.String(64)),
        sa.Column("market_price", sa.Float()), sa.Column("fair_value", sa.Float()),
        sa.Column("mispricing_pct", sa.Float()), sa.Column("confidence", sa.Float()),
        sa.Column("horizon_days", sa.Float()), sa.Column("expected_direction", sa.String(8)),
        sa.Column("invalidation", sa.JSON(), nullable=True), sa.Column("model_version", sa.String(32)),
        sa.Column("strategy", sa.String(64), nullable=True), sa.Column("asset_class", sa.String(32), nullable=True),
        sa.Column("created_at", sa.DateTime()))
    op.create_index("ix_prediction_ledger_prediction_key", "prediction_ledger", ["prediction_key"], unique=True)
    op.create_index("ix_prediction_ledger_symbol", "prediction_ledger", ["symbol"])
    op.create_index("ix_prediction_ledger_created_at", "prediction_ledger", ["created_at"])
    op.create_table("prediction_outcomes", _id(),
        sa.Column("prediction_id", sa.Integer()), sa.Column("evaluated_at", sa.DateTime()),
        sa.Column("realized_price", sa.Float()), sa.Column("direction_correct", sa.Boolean()),
        sa.Column("converged", sa.Boolean()), sa.Column("return_pct", sa.Float()))
    op.create_index("ix_prediction_outcomes_prediction_id", "prediction_outcomes", ["prediction_id"])
    op.create_table("kelly_calculations", _id(),
        sa.Column("symbol", sa.String(64), nullable=True), sa.Column("approved", sa.Boolean()),
        sa.Column("final_allocation_pct", sa.Float()), sa.Column("inputs", sa.JSON(), nullable=True),
        sa.Column("result", sa.JSON(), nullable=True), sa.Column("created_at", sa.DateTime()))
    op.create_index("ix_kelly_calculations_symbol", "kelly_calculations", ["symbol"])
    op.create_index("ix_kelly_calculations_created_at", "kelly_calculations", ["created_at"])
    op.create_table("sentiment_assessments", _id(),
        sa.Column("symbol", sa.String(64)), sa.Column("score", sa.Float(), nullable=True),
        sa.Column("label", sa.String(24)), sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime()))
    op.create_index("ix_sentiment_assessments_symbol", "sentiment_assessments", ["symbol"])
    op.create_index("ix_sentiment_assessments_created_at", "sentiment_assessments", ["created_at"])
    op.create_table("execution_events", _id(),
        sa.Column("signal_id", sa.String(80), nullable=False), sa.Column("client_order_id", sa.String(64), nullable=True),
        sa.Column("symbol", sa.String(64)), sa.Column("environment", sa.String(16)), sa.Column("state", sa.String(24)),
        sa.Column("latency_ms", sa.JSON(), nullable=True), sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime()), sa.Column("updated_at", sa.DateTime()))
    op.create_index("ix_execution_events_signal_id", "execution_events", ["signal_id"], unique=True)
    op.create_index("ix_execution_events_client_order_id", "execution_events", ["client_order_id"])
    op.create_index("ix_execution_events_symbol", "execution_events", ["symbol"])
    op.create_index("ix_execution_events_state", "execution_events", ["state"])
    op.create_index("ix_execution_events_created_at", "execution_events", ["created_at"])
    op.create_table("audit_events", _id(),
        sa.Column("event_type", sa.String(64)), sa.Column("actor", sa.String(64)),
        sa.Column("detail", sa.JSON(), nullable=True), sa.Column("created_at", sa.DateTime()))
    op.create_index("ix_audit_events_event_type", "audit_events", ["event_type"])
    op.create_index("ix_audit_events_created_at", "audit_events", ["created_at"])


def downgrade() -> None:
    for t in ("audit_events", "execution_events", "sentiment_assessments", "kelly_calculations",
              "prediction_outcomes", "prediction_ledger", "mispricing_alerts", "fair_value_estimates",
              "market_coverage", "scan_runs"):
        op.drop_table(t)
