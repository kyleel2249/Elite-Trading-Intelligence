"""Central configuration. Secrets only from environment."""
from functools import lru_cache
from typing import Literal, Optional

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

    app_env: Literal["development", "test", "local", "production", "prod", "staging"] = "production"
    debug: bool = False
    secret_key: str = "change-me"
    api_key: Optional[str] = None
    database_url: str = "sqlite:///./eti.db"
    # Optional Redis (redis://[:password@]host:port/db) for the cache and task queue; blank = feature disabled, nothing else changes.
    redis_url: str = ""

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

    # Autonomous execution engine (docs/EXECUTION_ENGINE.md). Off by default.
    execution_enabled: bool = False
    # Fernet key that encrypts broker credentials at rest. Keep it separate from DATABASE_URL.
    execution_vault_key: Optional[str] = None
    execution_supervisor_interval_seconds: int = 15

    # Internal paper-trading engine (docs/PAPER_TRADING.md). Needs no exchange credentials.
    paper_taker_fee_bps: float = 10.0
    paper_maker_fee_bps: float = 10.0
    paper_extra_slippage_bps: float = 1.0
    paper_max_position_notional_pct: float = 25.0
    paper_tick_interval_seconds: int = 5
    # Simulated autonomous trading from Trading Council signals. Off by default; paper money only.
    paper_autopilot_enabled: bool = False
    paper_autopilot_symbols: str = "BTCUSDT,ETHUSDT"
    paper_autopilot_interval_seconds: int = 120
    paper_autopilot_min_confidence: float = 0.6

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

    # OANDA v20 (forex, spot metals, index/commodity CFDs). Paper = OANDA practice account.
    oanda_api_token: Optional[str] = None
    oanda_account_id: Optional[str] = None
    oanda_live_trading_enabled: bool = False

    fred_api_key: Optional[str] = None
    newsapi_key: Optional[str] = Field(default=None, validation_alias=AliasChoices("newsapi_key", "news_api_key"))

    # Quiver Quant — research only (never execution)
    quiver_api_key: Optional[str] = None

    # Liquid — only user-validated base URL; no assumed exchange endpoints
    liquid_api_key: Optional[str] = None
    liquid_api_base_url: Optional[str] = None

    mtm_interval_seconds: int = Field(60, ge=1)
    reconcile_interval_seconds: int = Field(120, ge=1)
    investor_monitor_interval_seconds: int = Field(1800, ge=1)
    adaptive_edge_interval_seconds: int = 900

    # --- Global Alpha Intelligence ---
    alpha_research_enabled: bool = True
    alpha_research_interval_seconds: int = 3600
    alpha_crypto_scan_limit: int = 40
    alpha_equity_universe: str = ""  # comma separated tickers to always scan
    alpha_validation_max_age_hours: int = 24
    alpha_max_participation_pct: float = 1.0  # max order size as % of average daily dollar volume
    # Live alpha execution needs BOTH flags plus per-request confirmation; default is paper/testnet only.
    alpha_live_execution_authorized: bool = False
    # Extra Global Alpha keys: "key:analyst,key:trader" (each key >= 16 chars). API_KEY stays the admin key.
    alpha_role_keys: Optional[str] = None
    # Base URL of the deployed Worker that serves GET /api/omnisignal (Swift/Gainz/OMNISIGNAL X). Empty = engine unavailable.
    omnisignal_base_url: Optional[str] = None
    alpha_explorer_base_url: Optional[str] = None  # Etherscan-compatible endpoint chosen by the operator
    alpha_explorer_api_key: Optional[str] = None
    sec_user_agent: str = "EliteTradingIntelligence/1.0 (set SEC_USER_AGENT to a contact address)"

    data_max_age_seconds: int = 300
    require_fresh_data_for_live_orders: bool = True
    default_timezone: str = "Africa/Accra"

    @field_validator("api_key", mode="before")
    @classmethod
    def normalize_api_key(cls, value):
        return value.strip() or None if isinstance(value, str) else value

    @field_validator("app_env", mode="before")
    @classmethod
    def normalize_app_env(cls, value):
        return value.strip().lower() if isinstance(value, str) else value
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
    def oanda_configured(self) -> bool:
        return bool(self.oanda_api_token and self.oanda_account_id)

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
