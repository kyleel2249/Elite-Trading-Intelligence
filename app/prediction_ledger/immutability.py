"""Database-level append-only guards (SQLite + PostgreSQL triggers).

ORM listeners stop accidental ORM edits; triggers also stop bulk UPDATE/DELETE and raw SQL.
"""
from __future__ import annotations

from sqlalchemy import DDL, event

PG_FUNCTION = (
    "CREATE OR REPLACE FUNCTION eti_append_only() RETURNS trigger AS $$ "
    "BEGIN RAISE EXCEPTION 'append-only table: %% is immutable', TG_TABLE_NAME; END; "
    "$$ LANGUAGE plpgsql"
)


def sqlite_statements(table: str) -> list[str]:
    msg = f"append-only table: {table} is immutable"
    return [
        f"CREATE TRIGGER IF NOT EXISTS trg_{table}_no_update BEFORE UPDATE ON {table} "
        f"BEGIN SELECT RAISE(ABORT, '{msg}'); END",
        f"CREATE TRIGGER IF NOT EXISTS trg_{table}_no_delete BEFORE DELETE ON {table} "
        f"BEGIN SELECT RAISE(ABORT, '{msg}'); END",
    ]


def postgres_statements(table: str) -> list[str]:
    return [
        f"DROP TRIGGER IF EXISTS trg_{table}_append_only ON {table}",
        f"CREATE TRIGGER trg_{table}_append_only BEFORE UPDATE OR DELETE ON {table} "
        f"FOR EACH ROW EXECUTE FUNCTION eti_append_only()",
    ]


def install_on_create(table_obj) -> None:
    """Attach triggers to run right after the table is created via metadata.create_all()."""
    name = table_obj.name
    for stmt in sqlite_statements(name):
        event.listen(table_obj, "after_create", DDL(stmt.replace("%", "%%")).execute_if(dialect="sqlite"))
    event.listen(table_obj, "after_create", DDL(PG_FUNCTION).execute_if(dialect="postgresql"))
    for stmt in postgres_statements(name):
        event.listen(table_obj, "after_create", DDL(stmt.replace("%", "%%")).execute_if(dialect="postgresql"))
