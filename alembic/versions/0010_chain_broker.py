"""ETI broker wallet tables (funding + fees)

Revision ID: 0010_chain_broker
Revises: 0009_chain_wallet
"""
from alembic import op
import sqlalchemy as sa

revision = "0010_chain_broker"
down_revision = "0009_chain_wallet"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "eti_chain_funding",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("network", sa.String(24), nullable=False, index=True),
        sa.Column("tx_hash", sa.String(66), nullable=False, unique=True, index=True),
        sa.Column("from_address", sa.String(42), nullable=False),
        sa.Column("to_address", sa.String(42), nullable=False),
        sa.Column("value_wei", sa.String(80), nullable=False),
        sa.Column("block_number", sa.Integer(), nullable=False),
        sa.Column("confirmations", sa.Integer(), nullable=False),
        sa.Column("recorded_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "eti_chain_fees",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("network", sa.String(24), nullable=False, index=True),
        sa.Column("source_tx_id", sa.Integer(), nullable=False, unique=True, index=True),
        sa.Column("notional_wei", sa.String(80), nullable=False),
        sa.Column("fee_bps", sa.Integer(), nullable=False),
        sa.Column("fee_wei", sa.String(80), nullable=False),
        sa.Column("status", sa.String(12), nullable=False, index=True),
        sa.Column("paid_tx_id", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("paid_at", sa.DateTime(), nullable=True),
    )


def downgrade() -> None:
    import os
    # Funding and fee rows are the accounting record between ETI and the broker: do not drop them silently.
    if os.getenv("ALLOW_WALLET_DOWNGRADE") != "yes-destroy-wallet-record":
        raise RuntimeError("Refusing to drop the broker funding/fee tables. Set ALLOW_WALLET_DOWNGRADE=yes-destroy-wallet-record to force.")
    op.drop_table("eti_chain_fees")
    op.drop_table("eti_chain_funding")
