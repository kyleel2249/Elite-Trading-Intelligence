from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Optional


@dataclass
class NormalizedQuote:
    provider: str
    symbol: str
    normalized_symbol: str
    asset_class: str
    price: float
    bid: Optional[float]
    ask: Optional[float]
    volume: Optional[float]
    ts_provider: Optional[datetime]
    ts_utc: datetime
    retrieved_at: datetime
    data_status: str
    exchange: Optional[str] = None
    quote_currency: Optional[str] = None
    meta: Optional[dict[str, Any]] = None


class BaseProvider(ABC):
    name: str

    @abstractmethod
    async def health(self) -> dict[str, Any]:
        ...

    @abstractmethod
    async def get_quote(self, symbol: str) -> NormalizedQuote:
        ...
