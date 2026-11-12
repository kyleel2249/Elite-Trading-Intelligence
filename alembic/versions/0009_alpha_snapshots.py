"""Global Alpha candidate snapshots (point-in-time discovery history) and known-asset baseline.

Revision ID: 0009_alpha_snapshots
Revises: 0008_exec_auth
"""
from alembic import op
import sqlalchemy as sa

revision = "0009_alpha_snapshots"
down_revision = "0008_exec_auth"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "alpha_candidate_snapshots", sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("candidate_id", sa.String(160), nullable=False), sa.Column("ts", sa.DateTime(), nullable=False),
        sa.Column("asset_class", sa.String(16), nullable=False), sa.Column("symbol", sa.String(64), nullable=False),
        sa.Column("status", sa.String(32), nullable=False), sa.Column("stage", sa.String(32)),
        sa.Column("early_alpha_score", sa.Float()), sa.Column("price", sa.Float(), nullable=False), sa.Column("bench_price", sa.Float()))
    for col in ("candidate_id", "ts", "asset_class", "status"):
        op.create_index(f"ix_alpha_candidate_snapshots_{col}", "alpha_candidate_snapshots", [col])
    op.create_index("ix_alpha_snap_cand_ts", "alpha_candidate_snapshots", ["candidate_id", "ts"])
    op.create_table("alpha_known_assets", sa.Column("id", sa.Integer(), primary_key=True), sa.Column("provider", sa.String(32), nullable=False),
                    sa.Column("symbol", sa.String(64), nullable=False), sa.Column("first_seen", sa.DateTime()), sa.Column("baseline", sa.Boolean()))
    op.create_index("ix_alpha_known_assets_first_seen", "alpha_known_assets", ["first_seen"])
    op.create_index("ix_alpha_known_pair", "alpha_known_assets", ["provider", "symbol"], unique=True)


def downgrade() -> None:
    op.drop_table("alpha_known_assets")
    op.drop_table("alpha_candidate_snapshots")
