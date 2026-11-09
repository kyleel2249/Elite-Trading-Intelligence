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
    from app import models  # noqa: F401
    from app.memory import models as memory_models  # noqa: F401  (ETI memory + adaptive-edge tables)
    from app.prediction_ledger import models as _ledger_models  # noqa: F401  (append-only prediction ledger + triggers)
    from app.strategies import store as _strategy_store  # noqa: F401  (strategy_validation_runs)
    from app.alpha import db_models  # noqa: F401
    Base.metadata.create_all(bind=engine)
