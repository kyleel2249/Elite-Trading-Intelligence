from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

from app.config import get_settings

settings = get_settings()

connect_args = {"check_same_thread": False} if settings.database_url.startswith("sqlite") else {}
engine = create_engine(settings.database_url, connect_args=connect_args)
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
    # Every module that owns tables must be imported here so create_all sees them.
    # Keep this list additive: several features register their tables in this function.
    from app import models  # noqa: F401
    from app.memory import models as _memory_models  # noqa: F401  (ETI memory + adaptive-edge tables)
    from app.prediction_ledger import models as _ledger_models  # noqa: F401  (append-only prediction ledger + triggers)
    from app.strategies import store as _strategy_store  # noqa: F401  (strategy_validation_runs)
    from app.execution import models as _execution_models  # noqa: F401  (execution engine tables)
    from app.paper import sql_store as _paper_tables  # noqa: F401  (internal paper exchange tables: paper_accounts, paper_audit_log)
    Base.metadata.create_all(bind=engine)
