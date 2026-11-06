"""Central configuration. All secrets and trading flags come from environment."""
from functools import lru_cache
from typing import Optional

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # App
    app_env: str = "development"
    debug: bool = False
    secret_key: str = "change-me"
    database_url: str = "sqlite:///./eti.db"

    # Global trading
    live_trading_enabled: bool = True
    default_risk_per_trade_pct: float = 1.0
    max_daily_loss_pct: float = 3.0
    max_portfolio_drawdown_pct: float = 10.0
    max_open_positions: int = 8
    max_correlated_exposure_pct: float = 25.0

    # Alpaca
    alpaca_api_key: Optional[str] = None
    alpaca_secret_key: Optional[str] = None
    alpaca_paper: bool = True
    alpaca_base_url: str = "https://paper-api.alpaca.markets"

    # Binance
    binance_api_key: Optional[str] = None
    binance_secret_key: Optional[str] = None
    binance_testnet_enabled: bool = True
    binance_live_trading_enabled: bool = True

    # Data quality
    data_max_age_seconds: int = 300
    require_fresh_data_for_live_orders: bool = True

    # Display
    default_timezone: str = "Africa/Accra"

    @property
    def alpaca_configured(self) -> bool:
        return bool(self.alpaca_api_key and self.alpaca_secret_key)

    @property
    def binance_configured(self) -> bool:
        return bool(self.binance_api_key and self.binance_secret_key)

    @property
    def is_live_allowed(self) -> bool:
        """Global gate. Provider-specific and risk gates still apply."""
        return self.live_trading_enabled


@lru_cache
def get_settings() -> Settings:
    return Settings()
