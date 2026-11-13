"""Futures paper-simulation tables; also merges the two 0009 heads into one history.

Revision ID: 0010_futures_paper
Revises: 0009_alpha_snapshots, 0009_chain_wallet
"""
from alembic import op
import sqlalchemy as sa

revision = "0010_futures_paper"
down_revision = ("0009_alpha_snapshots", "0009_chain_wallet")
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "futures_paper_accounts",
        sa.Column("account_id", sa.String(64), primary_key=True),
        sa.Column("currency", sa.String(10), nullable=False),
        sa.Column("starting_balance", sa.String(48), nullable=False),
        sa.Column("wallet_balance", sa.String(48), nullable=False),
        sa.Column("realized_pnl", sa.String(48), nullable=False),
        sa.Column("fees_paid", sa.String(48), nullable=False),
        sa.Column("funding_paid", sa.String(48), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "futures_paper_positions",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("account_id", sa.String(64), nullable=False, index=True),
        sa.Column("symbol", sa.String(32), nullable=False, index=True),
        sa.Column("direction", sa.String(5), nullable=False),
        sa.Column("leverage", sa.Integer(), nullable=False),
        sa.Column("margin_mode", sa.String(10), nullable=False),
        sa.Column("status", sa.String(12), nullable=False, index=True),
        sa.Column("qty", sa.String(48), nullable=False),
        sa.Column("entry_price", sa.String(48), nullable=False),
        sa.Column("reference_price", sa.String(48), nullable=False),
        sa.Column("notional", sa.String(48), nullable=False),
        sa.Column("margin", sa.String(48), nullable=False),
        sa.Column("mmr", sa.String(24), nullable=False),
        sa.Column("liq_price", sa.String(48), nullable=True),
        sa.Column("stop_price", sa.String(48), nullable=True),
        sa.Column("take_profit_price", sa.String(48), nullable=True),
        sa.Column("entry_fee", sa.String(48), nullable=False),
        sa.Column("exit_price", sa.String(48), nullable=True),
        sa.Column("exit_fee", sa.String(48), nullable=False),
        sa.Column("funding", sa.String(48), nullable=False),
        sa.Column("gross_pnl", sa.String(48), nullable=True),
        sa.Column("realized_pnl", sa.String(48), nullable=True),
        sa.Column("price_source", sa.String(64), nullable=False),
        sa.Column("opened_at", sa.DateTime(), nullable=False),
        sa.Column("last_funding_at", sa.DateTime(), nullable=False),
        sa.Column("closed_at", sa.DateTime(), nullable=True),
        sa.Column("close_reason", sa.String(24), nullable=True),
    )
    op.create_index("uq_futures_open_position", "futures_paper_positions", ["account_id", "symbol"], unique=True,
                    sqlite_where=sa.text("status = 'open'"), postgresql_where=sa.text("status = 'open'"))
    op.create_table(
        "futures_paper_events",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("account_id", sa.String(64), nullable=False, index=True),
        sa.Column("ts", sa.DateTime(), nullable=False, index=True),
        sa.Column("event", sa.String(32), nullable=False, index=True),
        sa.Column("position_id", sa.Integer(), nullable=True),
        sa.Column("detail", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("futures_paper_events")
    op.drop_index("uq_futures_open_position", table_name="futures_paper_positions")
    op.drop_table("futures_paper_positions")
    op.drop_table("futures_paper_accounts")
