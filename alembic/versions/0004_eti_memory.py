"""ETI persistent memory & learning tables

Revision ID: 0004_eti_memory
Revises: 0003_adaptive_edge
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0004_eti_memory"
down_revision: Union[str, None] = "0003_adaptive_edge"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "eti_memory_entries",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("kind", sa.String(32), nullable=False, index=True),
        sa.Column("key", sa.String(128), nullable=False, index=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, index=True),
        sa.Column("title", sa.String(256), nullable=True),
        sa.Column("content", sa.JSON(), nullable=True),
        sa.Column("tags", sa.JSON(), nullable=True),
        sa.Column("source", sa.String(64), nullable=False),
        sa.Column("content_sha256", sa.String(64), nullable=False),
        sa.Column("supersedes_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), index=True),
        sa.UniqueConstraint("kind", "key", "version", name="uq_eti_memory_kind_key_version"),
    )

    op.create_table(
        "eti_signals",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("signal_id", sa.String(64), nullable=False, unique=True, index=True),
        sa.Column("source", sa.String(32), nullable=False, index=True),
        sa.Column("strategy_id", sa.String(64), nullable=True, index=True),
        sa.Column("strategy_version", sa.Integer(), nullable=True),
        sa.Column("symbol", sa.String(64), nullable=False, index=True),
        sa.Column("provider", sa.String(32), nullable=False, index=True),
        sa.Column("direction", sa.String(8), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("reference_price", sa.Float(), nullable=True),
        sa.Column("stop_price", sa.Float(), nullable=True),
        sa.Column("target_price", sa.Float(), nullable=True),
        sa.Column("horizon_seconds", sa.Integer(), nullable=True),
        sa.Column("regime", sa.String(64), nullable=True),
        sa.Column("assumptions", sa.JSON(), nullable=True),
        sa.Column("analysis", sa.JSON(), nullable=True),
        sa.Column("analysis_sha256", sa.String(64), nullable=False),
        sa.Column("as_of", sa.DateTime(), nullable=False, index=True),
        sa.Column("data_partition", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, index=True),
        sa.Column("trade_id", sa.String(64), nullable=True, index=True),
        sa.Column("outcome_status", sa.String(24), nullable=False, index=True),
        sa.Column("outcome", sa.String(16), nullable=True),
        sa.Column("outcome_price", sa.Float(), nullable=True),
        sa.Column("outcome_ts", sa.DateTime(), nullable=True),
        sa.Column("outcome_return_pct", sa.Float(), nullable=True),
        sa.Column("resolution_lag_seconds", sa.Float(), nullable=True),
        sa.Column("outcome_note", sa.String(256), nullable=True),
        sa.Column("created_at", sa.DateTime(), index=True),
    )

    op.create_table(
        "eti_trades",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("trade_id", sa.String(64), nullable=False, unique=True, index=True),
        sa.Column("signal_id", sa.String(64), nullable=True, index=True),
        sa.Column("strategy_id", sa.String(64), nullable=False, index=True),
        sa.Column("strategy_version", sa.Integer(), nullable=True),
        sa.Column("provider", sa.String(32), nullable=False, index=True),
        sa.Column("environment", sa.String(16), nullable=False, index=True),
        sa.Column("symbol", sa.String(64), nullable=False, index=True),
        sa.Column("side", sa.String(8), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, index=True),
        sa.Column("data_partition", sa.String(16), nullable=False),
        sa.Column("entry_qty", sa.Float()),
        sa.Column("open_qty", sa.Float()),
        sa.Column("entry_avg_price", sa.Float()),
        sa.Column("entry_notional", sa.Float()),
        sa.Column("expected_entry_price", sa.Float(), nullable=True),
        sa.Column("entry_slippage_bps", sa.Float(), nullable=True),
        sa.Column("entry_fills", sa.JSON(), nullable=True),
        sa.Column("exit_qty_total", sa.Float()),
        sa.Column("exit_notional", sa.Float()),
        sa.Column("exit_avg_price", sa.Float(), nullable=True),
        sa.Column("expected_exit_price", sa.Float(), nullable=True),
        sa.Column("exit_deviation_bps", sa.Float(), nullable=True),
        sa.Column("exit_deviation_kind", sa.String(16), nullable=True),
        sa.Column("exit_fills", sa.JSON(), nullable=True),
        sa.Column("gross_pnl", sa.Float(), nullable=True),
        sa.Column("fees", sa.Float(), nullable=True),
        sa.Column("net_pnl", sa.Float(), nullable=True),
        sa.Column("return_pct", sa.Float(), nullable=True),
        sa.Column("slippage_cost", sa.Float(), nullable=True),
        sa.Column("fee_bps_assumed", sa.Float()),
        sa.Column("fees_estimated", sa.Boolean()),
        sa.Column("reported_pnl", sa.Float(), nullable=True),
        sa.Column("pnl_reconciliation_diff", sa.Float(), nullable=True),
        sa.Column("mfe_price", sa.Float(), nullable=True),
        sa.Column("mae_price", sa.Float(), nullable=True),
        sa.Column("regime_entry", sa.String(64), nullable=True),
        sa.Column("regime_exit", sa.String(64), nullable=True),
        sa.Column("analysis_snapshot", sa.JSON(), nullable=True),
        sa.Column("analysis_sha256", sa.String(64), nullable=True),
        sa.Column("analysis_integrity", sa.String(16)),
        sa.Column("learning", sa.JSON(), nullable=True),
        sa.Column("classification", sa.String(16), nullable=True, index=True),
        sa.Column("thesis", sa.Text(), nullable=True),
        sa.Column("council_action", sa.String(32), nullable=True),
        sa.Column("client_order_ids", sa.JSON(), nullable=True),
        sa.Column("opened_at", sa.DateTime(), nullable=False, index=True),
        sa.Column("closed_at", sa.DateTime(), nullable=True, index=True),
        sa.Column("holding_seconds", sa.Float(), nullable=True),
        sa.Column("created_at", sa.DateTime()),
    )

    op.create_table(
        "eti_backtests",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("run_id", sa.String(64), nullable=False, unique=True, index=True),
        sa.Column("strategy_id", sa.String(64), nullable=False, index=True),
        sa.Column("strategy_version", sa.Integer(), nullable=True),
        sa.Column("symbol", sa.String(64), nullable=False, index=True),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("interval", sa.String(16), nullable=True),
        sa.Column("bars", sa.Integer()),
        sa.Column("data_start", sa.String(64), nullable=True),
        sa.Column("data_end", sa.String(64), nullable=True),
        sa.Column("partition", sa.String(16), nullable=False, index=True),
        sa.Column("trades", sa.Integer()),
        sa.Column("win_rate", sa.Float(), nullable=True),
        sa.Column("total_return_pct", sa.Float()),
        sa.Column("max_drawdown_pct", sa.Float()),
        sa.Column("fee_bps", sa.Float(), nullable=True),
        sa.Column("params", sa.JSON(), nullable=True),
        sa.Column("result", sa.JSON(), nullable=True),
        sa.Column("leakage_audit", sa.JSON(), nullable=True),
        sa.Column("validation_eligible", sa.Boolean(), index=True),
        sa.Column("created_at", sa.DateTime(), index=True),
    )

    op.create_table(
        "eti_strategy_versions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("strategy_id", sa.String(64), nullable=False, index=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, index=True),
        sa.Column("config", sa.JSON(), nullable=True),
        sa.Column("config_sha256", sa.String(64)),
        sa.Column("parent_version", sa.Integer(), nullable=True),
        sa.Column("change_reason", sa.Text(), nullable=True),
        sa.Column("change_diff", sa.JSON(), nullable=True),
        sa.Column("evidence", sa.JSON(), nullable=True),
        sa.Column("created_by", sa.String(64)),
        sa.Column("approved_by", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("status_changed_at", sa.DateTime()),
        sa.Column("activated_at", sa.DateTime(), nullable=True),
        sa.UniqueConstraint("strategy_id", "version", name="uq_eti_strategy_version"),
    )

    op.create_table(
        "eti_lessons",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("lesson_key", sa.String(160), nullable=False, unique=True, index=True),
        sa.Column("strategy_id", sa.String(64), nullable=True, index=True),
        sa.Column("category", sa.String(24), nullable=False, index=True),
        sa.Column("subject", sa.String(128), nullable=True),
        sa.Column("text", sa.Text()),
        sa.Column("supporting_count", sa.Integer()),
        sa.Column("contradicting_count", sa.Integer()),
        sa.Column("status", sa.String(16), index=True),
        sa.Column("confidence", sa.Float()),
        sa.Column("trade_ids", sa.JSON(), nullable=True),
        sa.Column("context", sa.JSON(), nullable=True),
        sa.Column("first_seen", sa.DateTime()),
        sa.Column("last_seen", sa.DateTime(), index=True),
    )

    op.create_table(
        "eti_research_priorities",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("topic_key", sa.String(160), nullable=False, unique=True, index=True),
        sa.Column("kind", sa.String(16), nullable=False, index=True),
        sa.Column("strategy_id", sa.String(64), nullable=True, index=True),
        sa.Column("title", sa.String(256)),
        sa.Column("rationale", sa.JSON(), nullable=True),
        sa.Column("weight", sa.Float()),
        sa.Column("score", sa.Float(), index=True),
        sa.Column("evidence_count", sa.Integer()),
        sa.Column("status", sa.String(16), index=True),
        sa.Column("last_trade_id", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
    )

    op.create_table(
        "eti_regime_history",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("symbol", sa.String(64), nullable=False, index=True),
        sa.Column("provider", sa.String(32), nullable=False, index=True),
        sa.Column("as_of", sa.DateTime(), nullable=False, index=True),
        sa.Column("primary_regime", sa.String(64), nullable=False, index=True),
        sa.Column("coexisting", sa.JSON(), nullable=True),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("metrics", sa.JSON(), nullable=True),
        sa.Column("source", sa.String(32)),
        sa.Column("created_at", sa.DateTime()),
    )


def downgrade() -> None:
    for table in (
        "eti_regime_history", "eti_research_priorities", "eti_lessons", "eti_strategy_versions",
        "eti_backtests", "eti_trades", "eti_signals", "eti_memory_entries",
    ):
        op.drop_table(table)
