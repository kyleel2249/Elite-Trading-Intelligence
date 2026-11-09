"""Plain data types shared by the engine, adapters and stores (stdlib only)."""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Optional


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Mode(str, Enum):
    INTELLIGENCE_ONLY = "intelligence_only"   # MODE 1: analysis only, never an order
    ASSISTED = "assisted"                     # MODE 2: propose, wait for human approval
    AUTONOMOUS = "autonomous"                 # MODE 3: execute inside user-approved limits


class Side(str, Enum):
    BUY = "buy"
    SELL = "sell"


class OrderType(str, Enum):
    MARKET = "market"
    LIMIT = "limit"


class OrderStatus(str, Enum):
    PENDING_SUBMIT = "pending_submit"
    SUBMITTED = "submitted"
    PARTIALLY_FILLED = "partially_filled"
    FILLED = "filled"
    CANCELED = "canceled"
    REJECTED = "rejected"
    EXPIRED = "expired"
    UNKNOWN = "unknown"     # outcome could not be established; reconciliation must resolve it

    @property
    def terminal(self) -> bool:
        return self in (OrderStatus.FILLED, OrderStatus.CANCELED, OrderStatus.REJECTED, OrderStatus.EXPIRED)

    @property
    def working(self) -> bool:
        return self in (OrderStatus.PENDING_SUBMIT, OrderStatus.SUBMITTED, OrderStatus.PARTIALLY_FILLED, OrderStatus.UNKNOWN)


def _finite_pos(x: Optional[float]) -> bool:
    return x is not None and isinstance(x, (int, float)) and math.isfinite(x) and x > 0


@dataclass(frozen=True)
class Quote:
    provider: str
    symbol: str
    bid: float
    ask: float
    ts: datetime                      # venue timestamp when available, else retrieval time
    last: Optional[float] = None

    @property
    def valid(self) -> bool:
        return _finite_pos(self.bid) and _finite_pos(self.ask) and self.ask >= self.bid

    @property
    def mid(self) -> float:
        return (self.bid + self.ask) / 2.0

    @property
    def spread_bps(self) -> float:
        return (self.ask - self.bid) / self.mid * 1e4 if self.valid else float("inf")

    def age_seconds(self, now: datetime) -> float:
        return (now - self.ts).total_seconds()


@dataclass(frozen=True)
class OrderBook:
    symbol: str
    bids: tuple          # ((price, qty), ...) best first
    asks: tuple          # ((price, qty), ...) best first
    ts: datetime


@dataclass(frozen=True)
class InstrumentRules:
    tick_size: float = 0.0       # 0 = no constraint known
    step_size: float = 0.0
    min_qty: float = 0.0
    min_notional: float = 0.0


@dataclass
class OrderIntent:
    account_id: str
    symbol: str
    side: Side
    qty: float
    order_type: OrderType = OrderType.MARKET
    limit_price: Optional[float] = None
    strategy: str = "manual"
    thesis: Optional[str] = None
    signal_id: Optional[str] = None          # caller-supplied idempotency anchor
    idempotency_key: Optional[str] = None
    reduce_only: bool = False
    meta: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "account_id": self.account_id, "symbol": self.symbol, "side": self.side.value, "qty": self.qty,
            "order_type": self.order_type.value, "limit_price": self.limit_price, "strategy": self.strategy,
            "thesis": self.thesis, "signal_id": self.signal_id, "idempotency_key": self.idempotency_key,
            "reduce_only": self.reduce_only, "meta": dict(self.meta),
        }

    @staticmethod
    def from_dict(d: dict) -> "OrderIntent":
        return OrderIntent(
            account_id=d["account_id"], symbol=d["symbol"], side=Side(d["side"]), qty=float(d["qty"]),
            order_type=OrderType(d.get("order_type", "market")), limit_price=d.get("limit_price"),
            strategy=d.get("strategy", "manual"), thesis=d.get("thesis"), signal_id=d.get("signal_id"),
            idempotency_key=d.get("idempotency_key"), reduce_only=bool(d.get("reduce_only", False)),
            meta=dict(d.get("meta") or {}),
        )


@dataclass
class BrokerOrder:
    client_order_id: str
    provider_order_id: Optional[str]
    status: OrderStatus
    qty: float
    filled_qty: float = 0.0
    avg_fill_price: Optional[float] = None
    raw: dict = field(default_factory=dict)


@dataclass
class BrokerPosition:
    symbol: str
    qty: float            # signed: long > 0, short < 0
    avg_price: float = 0.0
    mark_price: Optional[float] = None


@dataclass
class AccountPolicy:
    """What the user has authorised for one account. Defaults are the most restrictive."""
    mode: Mode = Mode.INTELLIGENCE_ONLY
    autonomous_enabled: bool = False             # MODE 3 needs this AND mode == AUTONOMOUS
    autonomous_enabled_by: Optional[str] = None
    autonomous_enabled_at: Optional[str] = None
    allowed_symbols: list = field(default_factory=list)       # empty = nothing allowed
    allowed_strategies: list = field(default_factory=list)    # empty = any strategy label
    max_order_notional: float = 0.0              # per order, account currency
    max_total_notional: float = 0.0              # capital limit: total gross exposure
    max_daily_orders: int = 20
    max_quote_age_seconds: float = 5.0
    max_spread_bps: float = 25.0
    max_slippage_bps: float = 10.0
    min_depth_ratio: float = 1.5                 # visible book depth must be >= ratio * order qty
    allow_shorting: bool = False
    duplicate_window_seconds: int = 30
    order_ttl_seconds: int = 60                  # unfilled/partial remainder cancelled after this
    proposal_ttl_seconds: int = 300
    reconcile_tolerance_qty: float = 1e-8
    reconcile_tolerance_pct: float = 0.25        # absorbs exchange fees taken in the base asset
    emergency_use_market: bool = True

    def to_dict(self) -> dict:
        d = dict(self.__dict__)
        d["mode"] = self.mode.value
        return d

    @staticmethod
    def from_dict(d: dict) -> "AccountPolicy":
        known = {k: v for k, v in d.items() if k in AccountPolicy.__dataclass_fields__}
        if "mode" in known:
            known["mode"] = Mode(known["mode"])
        return AccountPolicy(**known)


@dataclass
class ExecutionResult:
    status: str
    message: str = ""
    mode: Optional[str] = None
    client_order_id: Optional[str] = None
    proposal_id: Optional[str] = None
    reasons: list = field(default_factory=list)
    order: Optional[dict] = None

    def to_dict(self) -> dict:
        return dict(self.__dict__)
