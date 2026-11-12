"""Map ETI instruments to OANDA v20 instrument names.

OANDA lists forex, spot metals and index/commodity CFDs. Which of them an account can
actually trade depends on its jurisdiction and OANDA entity (for example, CFDs are not
offered to US accounts), so this is a *static candidate* mapping: the OANDA client checks
it against the account's real instrument list (GET /v3/accounts/{id}/instruments) before
quoting or ordering, and refuses anything the account does not list.

Index and commodity names are OANDA CFDs, not the cash index or the exchange future.
"""
from __future__ import annotations

from typing import Optional

from app.markets.registry import classify
from app.markets.types import AssetClass, Instrument

OANDA_INDICES = {
    "SPX": "SPX500_USD", "NDX": "NAS100_USD", "DJI": "US30_USD", "RUT": "US2000_USD",
    "FTSE100": "UK100_GBP", "DAX": "DE30_EUR", "CAC40": "FR40_EUR", "STOXX50": "EU50_EUR",
    "N225": "JP225_USD", "HSI": "HK33_HKD", "ASX200": "AU200_AUD", "NIFTY50": "IN50_USD",
}
OANDA_COMMODITIES = {
    "WTI": "WTICO_USD", "BRENT": "BCO_USD", "NATGAS": "NATGAS_USD", "CORN": "CORN_USD",
    "WHEAT": "WHEAT_USD", "SOYBEANS": "SOYBN_USD", "SUGAR": "SUGAR_USD",
}
# ETI commodities with no OANDA CFD: COFFEE, COCOA, COTTON (and every future/option).


def oanda_instrument(inst: Instrument, available: Optional[set[str]] = None) -> Optional[str]:
    """OANDA name for an ETI instrument, or None if OANDA does not list this market.

    ``available`` is the account's real instrument-name set; when given, a candidate that is not in it is rejected.
    """
    name: Optional[str] = None
    ac = inst.asset_class
    if ac in (AssetClass.FOREX, AssetClass.METAL) and inst.base and inst.quote:
        # A stablecoin-quoted exchange contract (XAUUSDT) is the same metal as OANDA's USD spot instrument.
        quote = "USD" if "stablecoin_quoted" in inst.tags else inst.quote
        name = f"{inst.base}_{quote}"
    elif ac == AssetClass.INDEX:
        name = OANDA_INDICES.get(inst.symbol)
    elif ac == AssetClass.COMMODITY:
        name = OANDA_COMMODITIES.get(inst.symbol)
    if name is None:
        return None
    if available is not None and name not in available:
        return None
    return name


def resolve_oanda_name(symbol: str, available: Optional[set[str]] = None) -> Optional[str]:
    """Accept an ETI symbol (EURUSD, XAUUSD, SPX ...) or an OANDA name already (EUR_USD, SPX500_USD)."""
    s = (symbol or "").strip().upper()
    if "_" in s and s.replace("_", "").isalnum():
        return s if (available is None or s in available) else None
    return oanda_instrument(classify(s, provider_hint="oanda"), available)
