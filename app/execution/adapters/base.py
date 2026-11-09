"""Broker adapter contract. One implementation per venue; the engine never touches venue specifics."""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional

from ..domain import (BrokerOrder, BrokerPosition, InstrumentRules, OrderBook, OrderType, Quote, Side)
from ..errors import ProviderUnavailableError


@dataclass(frozen=True)
class AdapterInfo:
    name: str
    asset_classes: tuple
    supports_order_book: bool
    supports_short: bool
    status: str                 # "implemented" | "not_implemented"
    notes: str = ""


class BrokerAdapter(ABC):
    name: str = ""
    environment: str = "paper"          # paper | live  (what these credentials point at)
    supports_order_book = False
    supports_short = True

    # ---- market data ----
    @abstractmethod
    async def get_quote(self, symbol: str) -> Quote: ...

    async def get_order_book(self, symbol: str, depth: int = 20) -> Optional[OrderBook]:
        return None

    async def get_rules(self, symbol: str) -> InstrumentRules:
        return InstrumentRules()

    # ---- account ----
    @abstractmethod
    async def get_equity(self) -> Optional[float]: ...

    @abstractmethod
    async def get_positions(self) -> list: ...

    async def verify_permissions(self) -> None:
        """Raise PermissionPolicyError if the credentials can do more than trade (e.g. withdraw)."""
        return None

    async def ping(self) -> bool:
        """Cheap liveness probe used by downtime detection. Raise TransientProviderError on failure."""
        await self.get_equity()
        return True

    async def market_open(self, symbol: str) -> bool:
        return True

    # ---- orders ----
    @abstractmethod
    async def submit_order(self, *, client_order_id: str, symbol: str, side: Side, qty: float,
                           order_type: OrderType, limit_price: Optional[float],
                           reduce_only: bool = False) -> BrokerOrder: ...

    @abstractmethod
    async def get_order_by_client_id(self, symbol: str, client_order_id: str) -> Optional[BrokerOrder]:
        """Return None ONLY when the venue definitively reports the order does not exist."""

    @abstractmethod
    async def cancel_order(self, symbol: str, client_order_id: str, provider_order_id: Optional[str]) -> None: ...

    @abstractmethod
    async def list_open_orders(self) -> list: ...


class UnavailableAdapter(BrokerAdapter):
    """Registered for venues ETI does not yet support. Every call fails loudly; nothing is simulated."""

    def __init__(self, name: str, reason: str):
        self.name, self.reason = name, reason

    def _no(self, *_a, **_k):
        raise ProviderUnavailableError(f"{self.name}: {self.reason}")

    get_quote = get_equity = get_positions = submit_order = _no
    get_order_by_client_id = cancel_order = list_open_orders = _no
