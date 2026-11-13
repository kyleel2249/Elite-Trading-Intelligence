import os

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

from app.config import get_settings

settings = get_settings()


def is_postgres_url(url: str) -> bool:
    return (url or "").strip().lower().startswith("postgresql")


def require_postgres_if_configured(url: str, env=None) -> None:
    """Fail fast when ETI_REQUIRE_POSTGRES is set but DATABASE_URL is not PostgreSQL.

    Used by the Fly deployment so a missing DATABASE_URL secret stops the app instead of falling back to a
    local SQLite file that disappears with the machine.
    """
    env = os.environ if env is None else env
    flag = str(env.get("ETI_REQUIRE_POSTGRES", "")).strip().lower() in ("1", "true", "yes", "on")
    if flag and not is_postgres_url(url):
        raise RuntimeError("ETI_REQUIRE_POSTGRES is set but DATABASE_URL is not a PostgreSQL URL. "
                           "Set the DATABASE_URL secret (see docs/POSTGRES_FRANKFURT.md).")


if settings.database_url.startswith("sqlite"):
    connect_args = {"check_same_thread": False}
    engine_kwargs: dict = {}
else:
    connect_args = {}
    # Managed Postgres closes idle connections; pre-ping replaces a dead pooled connection instead of failing a request.
    engine_kwargs = {"pool_pre_ping": True, "pool_recycle": 1800}
engine = create_engine(settings.database_url, connect_args=connect_args, **engine_kwargs)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    require_postgres_if_configured(settings.database_url)
    # Every module that owns tables must be imported here so create_all sees them.
    # Keep this list additive: several features register their tables in this function.
    from app import models  # noqa: F401
    from app.memory import models as _memory_models  # noqa: F401  (ETI memory + adaptive-edge tables)
    from app.prediction_ledger import models as _ledger_models  # noqa: F401  (append-only prediction ledger + triggers)
    from app.strategies import store as _strategy_store  # noqa: F401  (strategy_validation_runs)
    from app.execution import models as _execution_models  # noqa: F401  (execution engine tables)
    from app.paper import sql_store as _paper_tables  # noqa: F401  (internal paper exchange tables: paper_accounts, paper_audit_log)
    from app.security import auth_models as _auth_models  # noqa: F401  (execution sessions + auth audit)
    from app.futures import models as _futures_models  # noqa: F401  (futures paper simulation tables)
    Base.metadata.create_all(bind=engine)
