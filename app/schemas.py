from pydantic import BaseModel


class HealthResponse(BaseModel):
    status: str
    version: str
    live_trading_enabled: bool
    alpaca_configured: bool
    binance_configured: bool
    