from datetime import datetime
from typing import Any, Optional
from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    status: str
    version: str
    live_trading_enabled: bool
    alpaca_configured: bool
    binance_configured: bool
    