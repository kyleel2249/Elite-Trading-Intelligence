from app.config import Settings


def test_postgres_scheme_is_normalized():
    assert Settings(database_url="postgres://u:p@h:5432/db").database_url == "postgresql+psycopg2://u:p@h:5432/db"
    assert Settings(database_url="postgresql://u:p@h/db").database_url == "postgresql+psycopg2://u:p@h/db"


def test_explicit_driver_and_sqlite_untouched():
    assert Settings(database_url="postgresql+psycopg2://u:p@h/db").database_url == "postgresql+psycopg2://u:p@h/db"
    assert Settings(database_url="sqlite:///./eti.db").database_url == "sqlite:///./eti.db"
