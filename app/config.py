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
    # Global kill switch — rejects all order submission when true.
    kill_switch: bool = False
    default_risk_per_trade_pct: float = 1.0
    max_daily_loss_pct: float = 3.0
    max_portfolio_drawdown_pct: float = 10.0
    max_open_positions: int = 8
    max_correlated_exposure_pct: float = 25.0
    # Hard notional cap per position as % of equity (product rule).
    max_position_notional_pct: float = 6.0
    require_live_confirmation: bool = True

    # --- ETI CAPITAL PROTECTION SYSTEM (independent of the LLM / signal engines) ---
    # Conservative defaults. Every value is clamped to a hard ceiling in
    # app/risk/protection_policy.py; there is no flag that disables the system.
    cps_max_risk_per_trade_pct: float = 0.5
    cps_max_daily_loss_pct: float = 2.0
    cps_max_weekly_loss_pct: float = 5.0
    cps_max_drawdown_pct: float = 10.0
    cps_max_open_positions: int = 5
    cps_max_correlated_exposure_pct: float = 20.0
    cps_max_leverage: float = 1.0
    cps_max_position_notional_pct: float = 6.0
    cps_max_consecutive_losses: int = 3
    cps_consecutive_loss_cooldown_minutes: int = 240
    cps_emergency_drawdown_pct: float = 12.0
    cps_emergency_daily_loss_pct: float = 4.0
    cps_target_volatility_pct: float = 2.0
    cps_extreme_volatility_pct: float = 12.0
    cps_min_stop_distance_pct: float = 0.1
    cps_max_stop_distance_pct: float = 10.0
    cps_session_restrictions_enabled: bool = True
    cps_equity_session_buffer_minutes: int = 15
    cps_blocked_windows_utc: str = ""  # e.g. "23:55-00:05,21:55-22:05"
    cps_news_blackout_before_minutes: int = 30
    cps_news_blackout_after_minutes: int = 30
    cps_news_calendar_required_for_live: bool = True
    cps_require_strategy_attribution_live: bool = True
    cps_auto_liquidate_on_stop_breach: bool = True
    cps_auto_liquidate_on_emergency: bool = True
    # Separate secret for releasing halts / quarantines. Never give it to an AI agent.
    cps_admin_key: Optional[str] = None

    # Server-side equity baselines used by the risk engine (never taken from requests).
    # Paper/testnet equity = paper_starting_equity + realized + unrealized PnL.
    paper_starting_equity: float = 10000.0
    # Optional override when broker equity sync is unavailable.
    live_account_equity: Optional[float] = None
    use_broker_equity_for_live: bool = True

    alpaca_api_key: Optional[str] = None
    alpaca_secret_key: Optional[str] = None
    alpaca_paper: bool = True
    alpaca_base_url: str = "https://paper-api.alpaca.markets"
    alpaca_live_base_url: str = "https://api.alpaca.markets"

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
    adaptive_edge_interval_seconds: int = 900

    data_max_age_seconds: int = 300
    require_fresh_data_for_live_orders: bool = True
    default_timezone: str = "Africa/Accra"

    # --- ETI persistent memory & learning ---------------------------------------------------
    # Estimated per-side transaction cost applied to every closed trade (paper fills carry no
    # real fees). Same default as the backtest engine so live and simulated costs compare.
    memory_fee_bps: float = 5.0
    # Entry slippage above this (adverse, vs the signal's reference price) is flagged.
    memory_slippage_alert_bps: float = 10.0
    # Horizon given to a directional signal that did not declare one (recorded on the signal).
    memory_default_signal_horizon_seconds: int = 14400
    # An order may only be linked to a signal created within this window before the fill.
    memory_signal_link_window_minutes: int = 360
    # A 'flat' signal is correct when |move| stays inside this band (percent).
    memory_flat_band_pct: float = 0.5
    # Closed live/paper trades required before the learning loop may even propose a change.
    memory_min_trades_for_change: int = 20
    memory_proposal_cooldown_hours: int = 72
    # Regime observations older than this are not used to label a trade/signal.
    memory_regime_max_age_seconds: int = 21600
    # Identical open signals (same source/symbol/direction) inside this window are de-duplicated.
    memory_signal_dedupe_seconds: int = 300

    @field_validator("database_url", mode="after")
    @classmethod
    def _normalize_database_url(cls, v: str) -> str:
        """Hosts hand out postgres:// or postgresql://; SQLAlchemy needs an explicit psycopg2 driver."""
        v = (v or "").strip()
        for prefix in ("postgres://", "postgresql://"):
            if v.startswith(prefix):
                return "postgresql+psycopg2://" + v[len(prefix):]
        return v

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
