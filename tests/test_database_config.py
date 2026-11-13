"""Database configuration: Postgres URL normalisation and the ETI_REQUIRE_POSTGRES startup guard."""
import pytest

from app.config import Settings
from app.database import is_postgres_url, require_postgres_if_configured


@pytest.mark.parametrize("raw", ["postgres://u:p@host:5432/db", "postgresql://u:p@host:5432/db"])
def test_host_postgres_urls_get_an_explicit_driver(raw):
    s = Settings(_env_file=None, database_url=raw)
    assert s.database_url == "postgresql+psycopg2://u:p@host:5432/db"
    assert is_postgres_url(s.database_url)


def test_guard_is_off_by_default_so_local_sqlite_still_works():
    require_postgres_if_configured("sqlite:///./eti.db", env={})


def test_guard_refuses_sqlite_when_postgres_is_required():
    with pytest.raises(RuntimeError, match="DATABASE_URL"):
        require_postgres_if_configured("sqlite:////data/eti.db", env={"ETI_REQUIRE_POSTGRES": "true"})


def test_guard_accepts_postgres_when_required():
    require_postgres_if_configured("postgresql+psycopg2://u:p@h/db", env={"ETI_REQUIRE_POSTGRES": "1"})


def test_fly_config_is_frankfurt_with_no_sqlite_volume():
    from pathlib import Path
    text = (Path(__file__).resolve().parents[1] / "fly.toml").read_text()
    assert 'primary_region = "fra"' in text
    assert "[mounts]" not in text and "sqlite" not in text.lower().replace("throw-away sqlite", "")
    assert 'ETI_REQUIRE_POSTGRES = "true"' in text
