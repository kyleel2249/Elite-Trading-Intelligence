"""Double-entry accounting engine (general ledger, AP/AR, statements, reconciliation).

The core (money, domain, ledger, reports, reconcile) is pure Python over a small Store protocol so it can be tested
without a database; `sql_store` persists it with SQLAlchemy. See docs/ACCOUNTING.md.
"""
