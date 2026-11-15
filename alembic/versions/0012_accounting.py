"""Double-entry accounting engine: chart of accounts, append-only journal, periods, external txns, recon runs.

Revision ID: 0012_accounting
Revises: 0011_merge_heads
"""
from alembic import op
import sqlalchemy as sa

from app.prediction_ledger.immutability import PG_FUNCTION, postgres_statements, sqlite_statements

revision = "0012_accounting"
down_revision = "0011_merge_heads"
branch_labels = None
depends_on = None

APPEND_ONLY = ("acct_entries", "acct_lines", "acct_periods", "acct_recon_runs")


def upgrade() -> None:
    op.create_table(
        "acct_accounts",
        sa.Column("code", sa.String(8), primary_key=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("type", sa.String(12), nullable=False),
        sa.Column("parent", sa.String(8)),
        sa.Column("postable", sa.Boolean(), nullable=False),
        sa.Column("cash", sa.Boolean(), nullable=False),
        sa.Column("cashflow", sa.String(12), nullable=False),
        sa.Column("group_name", sa.String(64), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
    )
    op.create_table(
        "acct_entries",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("entry_date", sa.String(10), nullable=False),
        sa.Column("period", sa.String(7), nullable=False),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("source_id", sa.String(200), nullable=False),
        sa.Column("memo", sa.Text(), nullable=False),
        sa.Column("environment", sa.String(12), nullable=False),
        sa.Column("reverses", sa.Integer(), unique=True),
        sa.Column("document_id", sa.String(300)),
        sa.Column("meta", sa.JSON(), nullable=False),
        sa.Column("posted_by", sa.String(64), nullable=False),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.Column("digest", sa.String(64), nullable=False),
        sa.Column("prev_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("entry_hash", sa.String(64), nullable=False, unique=True),
        sa.UniqueConstraint("source", "source_id", name="uq_acct_entries_source_key"),
    )
    op.create_index("ix_acct_entries_entry_date", "acct_entries", ["entry_date"])
    op.create_index("ix_acct_entries_period", "acct_entries", ["period"])
    op.create_index("ix_acct_entries_environment", "acct_entries", ["environment"])
    op.create_index("ix_acct_entries_document_id", "acct_entries", ["document_id"])
    op.create_table(
        "acct_lines",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("entry_id", sa.Integer(), sa.ForeignKey("acct_entries.id"), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("account", sa.String(8), nullable=False),
        sa.Column("debit", sa.BigInteger(), nullable=False),
        sa.Column("credit", sa.BigInteger(), nullable=False),
        sa.Column("currency", sa.String(10), nullable=False),
        sa.Column("department", sa.String(40)),
        sa.Column("symbol", sa.String(64)),
        sa.Column("strategy", sa.String(64)),
        sa.Column("counterparty", sa.String(128)),
        sa.Column("external_ref", sa.String(200)),
        sa.Column("memo", sa.Text(), nullable=False),
    )
    op.create_index("ix_acct_lines_entry_id", "acct_lines", ["entry_id"])
    op.create_index("ix_acct_lines_account", "acct_lines", ["account"])
    op.create_index("ix_acct_lines_external_ref", "acct_lines", ["external_ref"])
    op.create_table(
        "acct_periods",
        sa.Column("period", sa.String(7), primary_key=True),
        sa.Column("closed_by", sa.String(64), nullable=False),
        sa.Column("closed_at", sa.String(32), nullable=False),
    )
    op.create_table(
        "acct_ext_txns",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("source", sa.String(64), nullable=False),
        sa.Column("ext_id", sa.String(200), nullable=False),
        sa.Column("ts", sa.String(10), nullable=False),
        sa.Column("account", sa.String(8), nullable=False),
        sa.Column("currency", sa.String(10), nullable=False),
        sa.Column("amount", sa.BigInteger(), nullable=False),
        sa.Column("fee", sa.BigInteger(), nullable=False),
        sa.Column("kind", sa.String(12), nullable=False),
        sa.Column("counterparty", sa.String(128)),
        sa.Column("confirmations", sa.Integer()),
        sa.Column("meta", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.String(32), nullable=False),
        sa.UniqueConstraint("source", "ext_id", name="uq_acct_ext_txn"),
    )
    op.create_index("ix_acct_ext_txns_ts", "acct_ext_txns", ["ts"])
    op.create_index("ix_acct_ext_txns_account", "acct_ext_txns", ["account"])
    op.create_table(
        "acct_recon_runs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("source", sa.String(64), nullable=False),
        sa.Column("account", sa.String(8), nullable=False),
        sa.Column("date_from", sa.String(10)),
        sa.Column("date_to", sa.String(10)),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("counts", sa.JSON(), nullable=False),
        sa.Column("ran_at", sa.String(32), nullable=False),
        sa.Column("result", sa.JSON(), nullable=False),
    )
    op.create_index("ix_acct_recon_runs_kind", "acct_recon_runs", ["kind"])

    dialect = op.get_bind().dialect.name
    if dialect == "sqlite":
        for t in APPEND_ONLY:
            for stmt in sqlite_statements(t):
                op.execute(sa.text(stmt))
    elif dialect == "postgresql":
        op.execute(sa.text(PG_FUNCTION.replace("%%", "%")))
        for t in APPEND_ONLY:
            for stmt in postgres_statements(t):
                op.execute(sa.text(stmt))


def downgrade() -> None:
    # Dropping the journal destroys the financial record; refuse unless explicitly forced.
    import os
    if os.getenv("ALLOW_LEDGER_DOWNGRADE") != "yes-destroy-accounting-history":
        raise RuntimeError("Refusing to drop the accounting journal. Set ALLOW_LEDGER_DOWNGRADE=yes-destroy-accounting-history to force.")
    dialect = op.get_bind().dialect.name
    for t in ("acct_recon_runs", "acct_ext_txns", "acct_periods", "acct_lines", "acct_entries", "acct_accounts"):
        if dialect == "sqlite" and t in APPEND_ONLY:
            op.execute(sa.text(f"DROP TRIGGER IF EXISTS trg_{t}_no_update"))
            op.execute(sa.text(f"DROP TRIGGER IF EXISTS trg_{t}_no_delete"))
        op.drop_table(t)
