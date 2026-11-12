"""strategy validation runs

Revision ID: 0004_strategy_validation
Revises: 0003_adaptive_edge
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0004_strategy_validation"
down_revision: Union[str, None] = "0003_adaptive_edge"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "strategy_validation_runs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("strategy_id", sa.String(64), nullable=False),
        sa.Column("symbol", sa.String(32), nullable=False),
        sa.Column("provider", sa.String(32), nullable=False),
        sa.Column("interval", sa.String(8), nullable=False),
        sa.Column("status", sa.String(32), nullable=False),
        sa.Column("grade", sa.String(48), nullable=False),
        sa.Column("bars", sa.Integer(), nullable=False),
        sa.Column("params", sa.JSON(), nullable=True),
        sa.Column("report", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_strategy_validation_runs_strategy_id", "strategy_validation_runs", ["strategy_id"])
    op.create_index("ix_strategy_validation_runs_symbol", "strategy_validation_runs", ["symbol"])
    op.create_index("ix_strategy_validation_runs_grade", "strategy_validation_runs", ["grade"])
    op.create_index("ix_strategy_validation_runs_created_at", "strategy_validation_runs", ["created_at"])


def downgrade() -> None:
    op.drop_table("strategy_validation_runs")
