"""Central configuration. Secrets only from environment."""
from functools import lru_cache
from typing import Optional

from pydantic import AliasChoices, Field, field_validator

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
        # A blank value in .env (e.g. "LIVE_ACCOUNT_EQUITY=") means "unset", not a parse error.
        env_ignore_empty=True,
    )

    app_env: str = "development"
    debug: bool = False
    secret_key: str = "change-me"
    api_key: Optional[str] = None
    database_url: str = "sqlite:///./eti.db"

    live_trading_enabled: bool = False
    default_risk_per_trade_pct: float = 1.0
    max_daily_loss_pct: float = 3.0
    max_portfolio_drawdown_pct: float = 10.0
    max_open_positions: int = 8
    max_correlated_exposure_pct: float = 25.0
    # Absolute per-position allocation ceiling (% of equity). Values above 6 are clamped to 6.
    max_position_allocation_pct: float = 6.0
    max_total_exposure_pct: float = 60.0
    max_sector_exposure_pct: float = 25.0
    # Fractional Kelly, clamped to [0.25, 0.50]; 0.25 until out-of-sample evidence supports more.
    kelly_fraction: float = 0.25

    # Global market scanner (disabled by default; enable explicitly).
    scan_enabled: bool = False
    scan_interval_seconds: int = 600
    scan_binance_top_n: int = 1000
    # Comma-separated tickers scanned through Alpaca (requires Alpaca keys), e.g. "AAPL,MSFT,SPY".
    scan_equity_symbols: Optional[str] = None

    # Server-side equity baselines used by the risk engine (never taken from requests).
    # Paper/testnet equity = paper_starting_equity + realized + unrealized PnL.
    paper_starting_equity: float = 10000.0
    # Live equity must be set explicitly until broker account sync exists; unset => live orders rejected.
    live_account_equity: Optional[float] = None

    alpaca_api_key: Optional[str] = None
    alpaca_secret_key: Optional[str] = None
    alpaca_paper: bool = True
    alpaca_base_url: str = "https://paper-api.alpaca.markets"

    binance_api_key: Optional[str] = None
    binance_secret_key: Optional[str] = None
    binance_testnet_enabled: bool = True
    binance_live_trading_enabled: bool = False

    fred_api_key: Optional[str] = None
    newsapi_key: Optional[str] = Field(default=None, validation_alias=AliasChoices("newsapi_key", "news_api_key"))

    # Quiver Quant — research only (never execution)
    quiver_api_key: Optional[str] = None

    # Liquid — only user-validated base URL; no assumed exchange endpoints
    liquid_api_key: Optional[str] = None
    liquid_api_base_url: Optional[str] = None

    mtm_interval_seconds: int = 60
    reconcile_interval_seconds: int = 120
    investor_monitor_interval_seconds: int = 1800

    data_max_age_seconds: int = 300
    require_fresh_data_for_live_orders: bool = True
    default_timezone: str = "Africa/Accra"

    @field_validator("database_url", mode="after")
    @classmethod
    def _normalize_database_url(cls, v: str) -> str:
        """Hosts hand out postgres:// or postgresql://; SQLAlchemy needs an explicit psycopg2 driver."""
        v = (v or "").strip()
        for prefix in ("postgres://", "postgresql://"):
            if v.startswith(prefix):
                return "postgresql+psycopg2://" + v[len(prefix):]
        return v

    @field_validator("max_position_allocation_pct", mode="after")
    @classmethod
    def _clamp_position_cap(cls, v: float) -> float:
        """The 6% single-position ceiling can be lowered by configuration but never raised."""
        return max(0.0, min(float(v), 6.0))

    @field_validator("kelly_fraction", mode="after")
    @classmethod
    def _clamp_kelly_fraction(cls, v: float) -> float:
        return max(0.25, min(float(v), 0.50))

    @property
    def alpaca_configured(self) -> bool:
        return bool(self.alpaca_api_key and self.alpaca_secret_key)

    @property
    def binance_configured(self) -> bool:
        return bool(self.binance_api_key and self.binance_secret_key)

    @property
    def fred_configured(self) -> bool:
        return bool(self.fred_api_key)

    @property
    def news_configured(self) -> bool:
        return bool(self.newsapi_key)

    @property
    def quiver_configured(self) -> bool:
        return bool(self.quiver_api_key)

    @property
    def liquid_configured(self) -> bool:
        return bool(self.liquid_api_key and self.liquid_api_base_url)

    @property
    def is_live_allowed(self) -> bool:
        return self.live_trading_enabled


@lru_cache
def get_settings() -> Settings:
    return Settings()
