"""ETI on-chain wallet tables

Revision ID: 0009_chain_wallet
Revises: 0008_exec_auth
"""
from alembic import op
import sqlalchemy as sa

revision = "0009_chain_wallet"
down_revision = "0008_exec_auth"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "eti_chain_wallets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("address", sa.String(42), nullable=False, unique=True, index=True),
        sa.Column("key_ciphertext", sa.Text(), nullable=False),
        sa.Column("label", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "eti_chain_allowlist",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("network", sa.String(24), nullable=False, index=True),
        sa.Column("address", sa.String(42), nullable=False, index=True),
        sa.Column("kind", sa.String(16), nullable=False, index=True),
        sa.Column("label", sa.String(64), nullable=True),
        sa.Column("symbol", sa.String(16), nullable=True),
        sa.Column("decimals", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("network", "address", "kind", name="uq_chain_allow"),
    )
    op.create_table(
        "eti_chain_txs",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("quote_id", sa.String(32), nullable=False, unique=True),
        sa.Column("wallet_address", sa.String(42), nullable=False, index=True),
        sa.Column("network", sa.String(24), nullable=False, index=True),
        sa.Column("kind", sa.String(16), nullable=False, index=True),
        sa.Column("to_address", sa.String(42), nullable=False),
        sa.Column("value_wei", sa.String(80), nullable=False),
        sa.Column("notional_wei", sa.String(80), nullable=False),
        sa.Column("data_hex", sa.Text(), nullable=False),
        sa.Column("nonce", sa.Integer(), nullable=False),
        sa.Column("gas_limit", sa.Integer(), nullable=False),
        sa.Column("tx_hash", sa.String(66), nullable=False, unique=True, index=True),
        sa.Column("status", sa.String(20), nullable=False, index=True),
        sa.Column("summary", sa.String(240), nullable=False),
        sa.Column("error", sa.String(240), nullable=True),
        sa.Column("gas_used", sa.Integer(), nullable=True),
        sa.Column("block_number", sa.Integer(), nullable=True),
        sa.Column("policy", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False, index=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "eti_chain_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("ts", sa.DateTime(), nullable=False, index=True),
        sa.Column("event", sa.String(32), nullable=False, index=True),
        sa.Column("network", sa.String(24), nullable=True),
        sa.Column("tx_hash", sa.String(66), nullable=True),
        sa.Column("detail", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    import os
    # The wallet table holds the only copy of the encrypted key: refuse to drop it silently.
    if os.getenv("ALLOW_WALLET_DOWNGRADE") != "yes-destroy-wallet-record":
        raise RuntimeError("Refusing to drop the ETI wallet tables. Set ALLOW_WALLET_DOWNGRADE=yes-destroy-wallet-record to force.")
    for t in ("eti_chain_events", "eti_chain_txs", "eti_chain_allowlist", "eti_chain_wallets"):
        op.drop_table(t)
