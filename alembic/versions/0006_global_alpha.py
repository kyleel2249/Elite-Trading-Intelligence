"""Global Alpha Intelligence tables.

Revision ID: 0006_global_alpha
Revises: 0005_merge_0004_heads
"""
from alembic import op
import sqlalchemy as sa

revision = "0006_global_alpha"
down_revision = "0005_merge_0004_heads"
branch_labels = None
depends_on = None


def _id():
    return sa.Column("id", sa.Integer(), primary_key=True)


def upgrade() -> None:
    op.create_table(
        "alpha_candidates", _id(),
        sa.Column("candidate_id", sa.String(160), nullable=False), sa.Column("asset_class", sa.String(16), nullable=False),
        sa.Column("symbol", sa.String(64), nullable=False), sa.Column("name", sa.String(256)), sa.Column("exchange", sa.String(64)),
        sa.Column("chain", sa.String(32)), sa.Column("contract", sa.String(128)), sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("status", sa.String(32), nullable=False), sa.Column("stage", sa.String(32)),
        sa.Column("early_alpha_score", sa.Float()), sa.Column("overall_rank_score", sa.Float()),
        sa.Column("scores", sa.JSON()), sa.Column("reasons", sa.JSON()), sa.Column("rejection_reasons", sa.JSON()),
        sa.Column("evidence", sa.JSON()), sa.Column("plan", sa.JSON()), sa.Column("last_price", sa.Float()),
        sa.Column("market_cap", sa.Float()), sa.Column("volume_24h", sa.Float()), sa.Column("data_status", sa.String(24)),
        sa.Column("scan_count", sa.Integer()), sa.Column("first_seen", sa.DateTime()), sa.Column("last_seen", sa.DateTime()),
        sa.Column("validated_at", sa.DateTime()))
    op.create_index("ix_alpha_candidates_candidate_id", "alpha_candidates", ["candidate_id"], unique=True)
    for col in ("asset_class", "symbol", "contract", "status", "early_alpha_score", "overall_rank_score", "last_seen"):
        op.create_index(f"ix_alpha_candidates_{col}", "alpha_candidates", [col])

    op.create_table("alpha_source_status", _id(), sa.Column("provider", sa.String(48), nullable=False), sa.Column("last_success", sa.DateTime()),
                    sa.Column("last_error_at", sa.DateTime()), sa.Column("last_error", sa.String(300)),
                    sa.Column("calls", sa.Integer()), sa.Column("failures", sa.Integer()))
    op.create_index("ix_alpha_source_status_provider", "alpha_source_status", ["provider"], unique=True)

    op.create_table("alpha_strategy_runs", _id(), sa.Column("strategy_id", sa.String(64), nullable=False), sa.Column("asset_class", sa.String(16), nullable=False),
                    sa.Column("symbol", sa.String(64), nullable=False), sa.Column("timeframe", sa.String(8), nullable=False), sa.Column("bars", sa.Integer(), nullable=False),
                    sa.Column("in_sample", sa.JSON()), sa.Column("out_of_sample", sa.JSON()), sa.Column("folds", sa.JSON()),
                    sa.Column("verdict", sa.String(24), nullable=False), sa.Column("reasons", sa.JSON()), sa.Column("created_at", sa.DateTime()))
    for col in ("strategy_id", "asset_class", "created_at"):
        op.create_index(f"ix_alpha_strategy_runs_{col}", "alpha_strategy_runs", [col])

    op.create_table("alpha_strategy_state", _id(), sa.Column("strategy_id", sa.String(64), nullable=False), sa.Column("asset_class", sa.String(16), nullable=False),
                    sa.Column("status", sa.String(16)), sa.Column("version", sa.Integer()), sa.Column("consecutive_passes", sa.Integer()),
                    sa.Column("consecutive_fails", sa.Integer()), sa.Column("live_trades", sa.Integer()), sa.Column("live_pnl", sa.Float()),
                    sa.Column("updated_at", sa.DateTime()))
    op.create_index("ix_alpha_state_pair", "alpha_strategy_state", ["strategy_id", "asset_class"], unique=True)

    op.create_table("alpha_trader_qualifications", _id(), sa.Column("name", sa.String(160), nullable=False), sa.Column("category", sa.String(48), nullable=False),
                    sa.Column("evidence", sa.JSON()), sa.Column("criteria", sa.JSON()), sa.Column("status", sa.String(16), nullable=False),
                    sa.Column("reasons", sa.JSON()), sa.Column("decided_at", sa.DateTime()))
    op.create_index("ix_alpha_trader_qualifications_name", "alpha_trader_qualifications", ["name"])
    op.create_index("ix_alpha_trader_qualifications_status", "alpha_trader_qualifications", ["status"])

    op.create_table("alpha_profile_versions", _id(), sa.Column("trader_id", sa.String(96), nullable=False), sa.Column("version", sa.Integer(), nullable=False),
                    sa.Column("field", sa.String(64), nullable=False), sa.Column("old_value", sa.JSON()), sa.Column("new_value", sa.JSON()),
                    sa.Column("change_reason", sa.Text(), nullable=False), sa.Column("sources", sa.JSON()), sa.Column("created_at", sa.DateTime()))
    op.create_index("ix_alpha_pv", "alpha_profile_versions", ["trader_id", "version"])
    op.create_index("ix_alpha_profile_versions_trader_id", "alpha_profile_versions", ["trader_id"])

    op.create_table("alpha_wallet_labels", _id(), sa.Column("chain", sa.String(32), nullable=False), sa.Column("address", sa.String(96), nullable=False),
                    sa.Column("label", sa.String(160), nullable=False), sa.Column("entity_type", sa.String(32), nullable=False),
                    sa.Column("source", sa.String(300), nullable=False), sa.Column("confidence", sa.Float(), nullable=False),
                    sa.Column("verified", sa.Boolean()), sa.Column("created_at", sa.DateTime()))
    op.create_index("ix_alpha_wallet", "alpha_wallet_labels", ["chain", "address"], unique=True)

    op.create_table("alpha_trade_plans", _id(), sa.Column("plan_id", sa.String(48), nullable=False), sa.Column("candidate_id", sa.String(160), nullable=False),
                    sa.Column("symbol", sa.String(64), nullable=False), sa.Column("provider", sa.String(16), nullable=False),
                    sa.Column("environment", sa.String(16), nullable=False), sa.Column("side", sa.String(8), nullable=False),
                    sa.Column("entry", sa.Float(), nullable=False), sa.Column("stop", sa.Float(), nullable=False), sa.Column("tp1", sa.Float(), nullable=False),
                    sa.Column("tp2", sa.Float(), nullable=False), sa.Column("tp3", sa.Float(), nullable=False), sa.Column("qty", sa.Float(), nullable=False),
                    sa.Column("remaining_qty", sa.Float()), sa.Column("realized_pnl", sa.Float()), sa.Column("stop_current", sa.Float()),
                    sa.Column("status", sa.String(16), nullable=False), sa.Column("client_order_id", sa.String(64)), sa.Column("tp_hits", sa.Integer()),
                    sa.Column("decision", sa.JSON()), sa.Column("attribution", sa.JSON()), sa.Column("close_reason", sa.String(32)),
                    sa.Column("close_price", sa.Float()), sa.Column("pnl", sa.Float()), sa.Column("strategy_ids", sa.JSON()),
                    sa.Column("created_at", sa.DateTime()), sa.Column("closed_at", sa.DateTime()))
    op.create_index("ix_alpha_trade_plans_plan_id", "alpha_trade_plans", ["plan_id"], unique=True)
    for col in ("candidate_id", "symbol", "status", "client_order_id", "created_at"):
        op.create_index(f"ix_alpha_trade_plans_{col}", "alpha_trade_plans", [col])

    op.create_table("alpha_audit_log", _id(), sa.Column("ts", sa.DateTime()), sa.Column("actor", sa.String(32), nullable=False),
                    sa.Column("action", sa.String(64), nullable=False), sa.Column("detail", sa.JSON()))
    op.create_index("ix_alpha_audit_log_ts", "alpha_audit_log", ["ts"])
    op.create_index("ix_alpha_audit_log_action", "alpha_audit_log", ["action"])

    op.create_table("alpha_research_runs", _id(), sa.Column("kind", sa.String(32), nullable=False), sa.Column("status", sa.String(16), nullable=False),
                    sa.Column("started_at", sa.DateTime()), sa.Column("finished_at", sa.DateTime()), sa.Column("summary", sa.JSON()))
    op.create_index("ix_alpha_research_runs_kind", "alpha_research_runs", ["kind"])
    op.create_index("ix_alpha_research_runs_started_at", "alpha_research_runs", ["started_at"])

    op.create_table("alpha_13f_holdings", _id(), sa.Column("filer_cik", sa.String(12), nullable=False), sa.Column("filer_name", sa.String(256), nullable=False),
                    sa.Column("accession", sa.String(32), nullable=False), sa.Column("period_of_report", sa.String(16)), sa.Column("filing_date", sa.String(16)),
                    sa.Column("issuer", sa.String(256), nullable=False), sa.Column("cusip", sa.String(12), nullable=False), sa.Column("title_of_class", sa.String(64)),
                    sa.Column("value_usd", sa.Float()), sa.Column("shares", sa.Float()), sa.Column("put_call", sa.String(8)))
    op.create_index("ix_alpha_13f_holdings_filer_cik", "alpha_13f_holdings", ["filer_cik"])
    op.create_index("ix_alpha_13f_holdings_accession", "alpha_13f_holdings", ["accession"])
    op.create_index("ix_alpha_13f_holdings_cusip", "alpha_13f_holdings", ["cusip"])
    op.create_index("ix_alpha_13f_unique", "alpha_13f_holdings", ["accession", "cusip", "put_call", "shares"])


def downgrade() -> None:
    for t in ("alpha_13f_holdings", "alpha_research_runs", "alpha_audit_log", "alpha_trade_plans", "alpha_wallet_labels", "alpha_profile_versions",
              "alpha_trader_qualifications", "alpha_strategy_state", "alpha_strategy_runs", "alpha_source_status", "alpha_candidates"):
        op.drop_table(t)
