"""merge parallel 0004 migrations (eti_memory, strategy_validation, prediction_ledger)

Three independent migrations all branched from 0003_adaptive_edge, which leaves Alembic with
multiple heads (`alembic upgrade head` fails). They touch disjoint tables, so this empty merge
revision joins them without changing any schema.

Revision ID: 0005_merge_0004_heads
Revises: 0004_eti_memory, 0004_strategy_validation, 0004_prediction_ledger
"""
from typing import Sequence, Union

revision: str = "0005_merge_0004_heads"
down_revision: Union[str, Sequence[str], None] = (
    "0004_eti_memory",
    "0004_strategy_validation",
    "0004_prediction_ledger",
)
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
