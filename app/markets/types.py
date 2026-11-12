"""Canonical types for ETI multi-market intelligence.

Stdlib only on purpose: the market layer must be importable (and testable) without
the web/database stack, and it is called from inside the RiskEngine.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class AssetClass(str, Enum):
    FOREX = "forex"
    METAL = "metal"
    CRYPTO = "crypto"
    STOCK = "stock"
    INDEX = "index"
    COMMODITY = "commodity"
    FUTURE = "future"
    OPTION = "option"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class Instrument:
    """A classified tradable (or analysable) instrument.

    ``confidence`` says how the classification was reached:
      catalog   - symbol is in ETI's curated catalog
      pattern   - matched a strict structural pattern (FX pair, OCC option, futures code)
      heuristic - best guess (e.g. an unlisted ticker). Never used to hard-block orders.
    """

    symbol: str                       # canonical ETI symbol
    asset_class: AssetClass
    tier: str                         # e.g. major / minor / exotic / meme / frontier
    profile_key: str                  # key into profiles.PROFILES
    region: str                       # US, EU, UK, JP, ZA, NG, global ...
    session_id: str                   # key into sessions.SESSIONS
    name: str = ""
    base: Optional[str] = None
    quote: Optional[str] = None       # quote / pricing currency where meaningful
    tags: tuple[str, ...] = ()
    confidence: str = "catalog"
    qty_step: float = 1.0             # smallest order increment we size to
    min_qty: float = 1.0
    contract_multiplier: float = 1.0  # units of underlying per 1.0 quantity
    underlying: Optional[str] = None  # futures / options underlying root
    notes: tuple[str, ...] = ()

    def to_dict(self) -> dict:
        return {
            "symbol": self.symbol,
            "asset_class": self.asset_class.value,
            "tier": self.tier,
            "profile_key": self.profile_key,
            "region": self.region,
            "session_id": self.session_id,
            "name": self.name,
            "base": self.base,
            "quote": self.quote,
            "tags": list(self.tags),
            "classification_confidence": self.confidence,
            "qty_step": self.qty_step,
            "min_qty": self.min_qty,
            "contract_multiplier": self.contract_multiplier,
            "underlying": self.underlying,
            "notes": list(self.notes),
        }


@dataclass
class MarketReview:
    """Result of the lightweight, deterministic check the RiskEngine runs per order."""

    asset_class: str = "unknown"
    tier: str = "unknown"
    blocking_reasons: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    notional_cap_multiplier: float = 1.0
    risk_multiplier: float = 1.0
    session_state: str = "unknown"
    tradeable_now: bool = True

    def to_dict(self) -> dict:
        return {
            "asset_class": self.asset_class,
            "tier": self.tier,
            "blocking_reasons": list(self.blocking_reasons),
            "warnings": list(self.warnings),
            "notional_cap_multiplier": self.notional_cap_multiplier,
            "risk_multiplier": self.risk_multiplier,
            "session_state": self.session_state,
            "tradeable_now": self.tradeable_now,
        }
