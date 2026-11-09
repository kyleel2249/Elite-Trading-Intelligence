"""prediction ledger (append-only predictions, outcomes, monthly reports)

Revision ID: 0004_prediction_ledger
Revises: 0003_adaptive_edge
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from app.prediction_ledger.immutability import PG_FUNCTION, postgres_statements, sqlite_statements

revision: str = "0004_prediction_ledger"
down_revision: Union[str, None] = "0003_adaptive_edge"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

TABLES = ("predictions", "prediction_outcomes", "prediction_reports")


def upgrade() -> None:
    op.create_table(
        "predictions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("prediction_uid", sa.String(36), nullable=False),
        sa.Column("idempotency_key", sa.String(160), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("asset", sa.String(64), nullable=False),
        sa.Column("market", sa.String(32), nullable=False),
        sa.Column("provider", sa.String(32), nullable=True),
        sa.Column("direction", sa.String(8), nullable=False),
        sa.Column("entry_reference", sa.Float(), nullable=False),
        sa.Column("horizon_label", sa.String(32), nullable=False),
        sa.Column("horizon_seconds", sa.Integer(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("target_low", sa.Float(), nullable=True),
        sa.Column("target_high", sa.Float(), nullable=True),
        sa.Column("target_base", sa.Float(), nullable=True),
        sa.Column("probability", sa.Float(), nullable=False),
        sa.Column("reasoning", sa.Text(), nullable=False),
        sa.Column("sources", sa.JSON(), nullable=False),
        sa.Column("invalidation_criteria", sa.Text(), nullable=False),
        sa.Column("invalidation_price", sa.Float(), nullable=True),
        sa.Column("market_regime", sa.String(48), nullable=True),
        sa.Column("strategy", sa.String(96), nullable=True),
        sa.Column("model_version", sa.String(48), nullable=False),
        sa.Column("analyst", sa.String(64), nullable=True),
        sa.Column("legacy_forecast_id", sa.Integer(), nullable=True),
        sa.Column("content_hash", sa.String(64), nullable=False),
    )
    op.create_index("ix_predictions_prediction_uid", "predictions", ["prediction_uid"], unique=True)
    op.create_unique_constraint("uq_predictions_idempotency_key", "predictions", ["idempotency_key"])
    for col in ("created_at", "asset", "market", "horizon_label", "expires_at", "market_regime", "strategy"):
        op.create_index(f"ix_predictions_{col}", "predictions", [col])

    op.create_table(
        "prediction_outcomes",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("prediction_id", sa.Integer(), nullable=False),
        sa.Column("evaluated_at", sa.DateTime(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("realized_price", sa.Float(), nullable=False),
        sa.Column("price_source", sa.String(64), nullable=False),
        sa.Column("observed_at", sa.DateTime(), nullable=False),
        sa.Column("late_seconds", sa.Float(), nullable=False),
        sa.Column("return_pct", sa.Float(), nullable=True),
        sa.Column("direction_correct", sa.Boolean(), nullable=True),
        sa.Column("in_target_range", sa.Boolean(), nullable=True),
        sa.Column("abs_error", sa.Float(), nullable=True),
        sa.Column("pct_error", sa.Float(), nullable=True),
        sa.Column("invalidated", sa.Boolean(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
    )
    op.create_index("ix_prediction_outcomes_prediction_id", "prediction_outcomes", ["prediction_id"], unique=True)
    op.create_index("ix_prediction_outcomes_evaluated_at", "prediction_outcomes", ["evaluated_at"])
    op.create_index("ix_prediction_outcomes_status", "prediction_outcomes", ["status"])

    op.create_table(
        "prediction_reports",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("period", sa.String(7), nullable=False),
        sa.Column("generated_at", sa.DateTime(), nullable=False),
        sa.Column("summary", sa.JSON(), nullable=False),
        sa.Column("markdown", sa.Text(), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
    )
    op.create_index("ix_prediction_reports_period", "prediction_reports", ["period"], unique=True)

    dialect = op.get_bind().dialect.name
    if dialect == "sqlite":
        for t in TABLES:
            for stmt in sqlite_statements(t):
                op.execute(sa.text(stmt))
    elif dialect == "postgresql":
        op.execute(sa.text(PG_FUNCTION.replace("%%", "%")))
        for t in TABLES:
            for stmt in postgres_statements(t):
                op.execute(sa.text(stmt))


def downgrade() -> None:
    # Dropping the ledger destroys accountability history; refuse unless explicitly forced.
    import os
    if os.getenv("ALLOW_LEDGER_DOWNGRADE") != "yes-destroy-prediction-history":
        raise RuntimeError("Refusing to drop the prediction ledger. Set ALLOW_LEDGER_DOWNGRADE=yes-destroy-prediction-history to force.")
    dialect = op.get_bind().dialect.name
    for t in reversed(TABLES):
        if dialect == "sqlite":
            op.execute(sa.text(f"DROP TRIGGER IF EXISTS trg_{t}_no_update"))
            op.execute(sa.text(f"DROP TRIGGER IF EXISTS trg_{t}_no_delete"))
        op.drop_table(t)
