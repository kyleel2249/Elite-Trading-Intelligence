"""Merge the capital-protection and governance migration branches.

Both branches contain independent schema changes; this merge has no schema operations.
"""
from typing import Sequence, Union

revision: str = "0015_merge_capital_protection_governance"
down_revision: Union[str, Sequence[str], None] = ("0011_capital_protection", "0014_governance")
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """No schema change: both parent revisions are already applied."""


def downgrade() -> None:
    """No schema change."""
