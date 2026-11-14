"""Merge the parallel 0010 branches (broker wallet and futures paper simulation)

Revision ID: 0011_merge_heads
Revises: 0010_chain_broker, 0010_futures_paper
"""
revision = "0011_merge_heads"
down_revision = ("0010_chain_broker", "0010_futures_paper")
branch_labels = None
depends_on = None


def upgrade() -> None:
    """No schema change: the two branches touch disjoint tables."""


def downgrade() -> None:
    """No schema change."""
