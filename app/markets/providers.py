"""Which provider can supply data for / execute which market - stated truthfully.

This table mirrors the adapters that actually exist in ``app/integrations``:
  * Binance  - crypto spot (public data; testnet/live orders through TradingService)
  * Alpaca   - US-listed stocks and ETFs (data API; paper/live orders)

Everything else (spot FX, spot metals, cash indices, futures, options, non-US equities)
has *no execution adapter and no market-data adapter* in this repository today. For
metals, indices and commodities that have a US-listed ETF stand-in, the route is the ETF
through Alpaca and is labelled ``etf_proxy`` with its tracking caveats. New adapters plug
in by adding a ``ProviderCapability`` here and a client under ``app/integrations``.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from app.markets.registry import execution_proxy
from app.markets.types import AssetClass, Instrument


@dataclass(frozen=True)
class ProviderCapability:
    name: str
    asset_classes: frozenset
    us_stocks_only: bool
    data: bool
    execution: bool
    environments: tuple
    notes: str

    def to_dict(self) -> dict:
        return {
            "name": self.name, "asset_classes": sorted(c.value for c in self.asset_classes),
            "us_stocks_only": self.us_stocks_only, "market_data": self.data, "execution": self.execution,
            "environments": list(self.environments), "notes": self.notes,
        }


CAPABILITIES: dict[str, ProviderCapability] = {
    "binance": ProviderCapability(
        "binance", frozenset({AssetClass.CRYPTO}), False, True, True, ("paper", "testnet", "live"),
        "Spot only (no margin, futures or options). The symbol must be listed on Binance spot."),
    "alpaca": ProviderCapability(
        "alpaca", frozenset({AssetClass.STOCK}), True, True, True, ("paper", "live"),
        "US-listed stocks and ETFs only; day orders; extended-hours orders are not supported by the ETI client."),
}

# Classes with no direct adapter, and what would be needed.
NOT_INTEGRATED: dict[str, str] = {
    "forex": "No FX broker/data adapter. Add one (e.g. an FX broker REST API) under app/integrations and register it here.",
    "metal": "No spot-metals adapter; use the ETF proxy route (GLD/SLV/PPLT/PALL via Alpaca) or add an adapter.",
    "index": "Cash indices are not tradable; use the ETF proxy route or add a futures/CFD adapter.",
    "commodity": "No commodity adapter; ETF proxies exist for crude, gas and some agriculturals. Futures need a futures broker adapter.",
    "future": "No futures adapter (and no ETF stand-in: contract sizing does not map to shares). Analysis, sizing and sessions work; execution is unavailable.",
    "option": "No options adapter in the ETI trading service; analysis and sizing only.",
    "stock_non_us": "No non-US equity adapter (EU/Asia/Africa). Analysis, sessions and sizing work; execution is unavailable.",
}


def provider_supports(provider: Optional[str], inst: Instrument) -> Optional[bool]:
    """True/False if ``provider`` is known, None if it is not a provider this table knows."""
    cap = CAPABILITIES.get((provider or "").lower())
    if cap is None:
        return None
    if inst.asset_class == AssetClass.UNKNOWN:
        return None
    if inst.asset_class not in cap.asset_classes:
        return False
    if cap.us_stocks_only and inst.asset_class == AssetClass.STOCK and inst.region != "US":
        return False
    return True


def routes_for(inst: Instrument) -> list[dict]:
    """Executable routes for an instrument (possibly via an ETF proxy). Empty list = analysis only."""
    routes: list[dict] = []
    if inst.asset_class == AssetClass.CRYPTO:
        routes.append({"provider": "binance", "symbol": inst.symbol, "kind": "direct", "session_id": "crypto_24x7",
                       "environments": list(CAPABILITIES["binance"].environments),
                       "note": "Spot order via TradingService; the pair must exist on Binance spot."})
    elif inst.asset_class == AssetClass.STOCK and inst.region == "US":
        routes.append({"provider": "alpaca", "symbol": inst.symbol, "kind": "direct", "session_id": "us_equity",
                       "environments": list(CAPABILITIES["alpaca"].environments),
                       "note": "Whole-share day orders via TradingService."})
    elif inst.asset_class in (AssetClass.METAL, AssetClass.INDEX, AssetClass.COMMODITY):
        # Futures are deliberately excluded: their sizing is in contracts, an ETF route would be in shares.
        proxy = execution_proxy(inst)
        if proxy:
            etf, quality = proxy
            caveat = {"close": "Tracks the underlying closely but carries fund fees and trades only in US equity hours.",
                      "approximate": "Tracks a different/approximate benchmark; basis risk vs the named index.",
                      "futures_based": "Futures-based fund: roll yield (contango/backwardation) diverges from spot."}.get(quality, "")
            routes.append({"provider": "alpaca", "symbol": etf, "kind": "etf_proxy", "proxy_quality": quality, "session_id": "us_equity",
                           "environments": list(CAPABILITIES["alpaca"].environments),
                           "note": f"Not the instrument itself: {inst.symbol} exposure via {etf}. {caveat}".strip()})
    return routes


def data_coverage(inst: Instrument) -> dict:
    routes = routes_for(inst)
    if routes:
        r = routes[0]
        return {"status": "available", "provider": r["provider"], "symbol": r["symbol"],
                "via": "direct" if r["kind"] == "direct" else "etf_proxy"}
    return {"status": "provider_not_integrated", "provider": None, "symbol": None, "via": None}


def not_integrated_reason(inst: Instrument) -> Optional[str]:
    if routes_for(inst):
        return None
    if inst.asset_class == AssetClass.STOCK:
        return NOT_INTEGRATED["stock_non_us"]
    return NOT_INTEGRATED.get(inst.asset_class.value)


def overview() -> dict:
    """Capability matrix for every asset class (what works, what does not)."""
    matrix = {}
    for ac in AssetClass:
        if ac == AssetClass.UNKNOWN:
            continue
        direct = [c.name for c in CAPABILITIES.values() if ac in c.asset_classes]
        matrix[ac.value] = {
            "direct_providers": direct,
            "etf_proxy_via": ["alpaca"] if ac in (AssetClass.METAL, AssetClass.INDEX, AssetClass.COMMODITY) else [],
            "analysis": True,
            "execution": bool(direct) or ac in (AssetClass.METAL, AssetClass.INDEX, AssetClass.COMMODITY),
            "gap": NOT_INTEGRATED.get(ac.value) if not direct else None,
        }
    matrix["stock"]["gap"] = NOT_INTEGRATED["stock_non_us"]
    matrix["stock"]["execution_scope"] = "US-listed only"
    return {"providers": {k: v.to_dict() for k, v in CAPABILITIES.items()}, "asset_classes": matrix}
