"""adaptive edge events and strategy registry

Revision ID: 0003_adaptive_edge
Revises: 0002_investor
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "0003_adaptive_edge"
down_revision: Union[str, None] = "0002_investor"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "adaptive_edge_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("event_type", sa.String(64)),
        sa.Column("ref_id", sa.String(128)),
        sa.Column("payload", sa.JSON(), nullable=True),
        sa.Column("tags", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime()),
    )
    op.create_index("ix_adaptive_edge_events_event_type", "adaptive_edge_events", ["event_type"])
    op.create_index("ix_adaptive_edge_events_ref_id", "adaptive_edge_events", ["ref_id"])
    op.create_index("ix_adaptive_edge_events_created_at", "adaptive_edge_events", ["created_at"])

    op.create_table(
        "strategy_registry",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("strategy_id", sa.String(128), nullable=False),
        sa.Column("name", sa.String(256)),
        sa.Column("family", sa.String(64)),
        sa.Column("stage", sa.String(64)),
        sa.Column("health_status", sa.String(32)),
        sa.Column("allocation_pct", sa.Float()),
        sa.Column("params", sa.JSON(), nullable=True),
        sa.Column("meta", sa.JSON(), nullable=True),
        sa.Column("suspended", sa.Boolean()),
        sa.Column("version", sa.Integer()),
        sa.Column("updated_at", sa.DateTime()),
        sa.Column("created_at", sa.DateTime()),
    )
    op.create_index("ix_strategy_registry_strategy_id", "strategy_registry", ["strategy_id"], unique=True)
    op.create_index("ix_strategy_registry_stage", "strategy_registry", ["stage"])
    op.create_index("ix_strategy_registry_health_status", "strategy_registry", ["health_status"])


def downgrade() -> None:
    op.drop_table("strategy_registry")
    op.drop_table("adaptive_edge_events")
