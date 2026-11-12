"""Which provider can supply data for / execute which market - stated truthfully.

Adapters that exist in ``app/integrations``:
  * Binance - crypto spot (public data; testnet/paper/live orders through TradingService)
  * Alpaca  - US-listed stocks and ETFs, plus US equity options (data API; paper/live orders)
  * OANDA   - forex, spot metals, and index/commodity CFDs (practice = paper; live gated)

Route kinds:
  direct     - the instrument itself (spot FX, spot metals, crypto spot, US stock/option)
  cfd        - an OANDA CFD on an index/commodity: tracks the underlying with financing costs; not offered everywhere
  etf_proxy  - a US-listed ETF stand-in (tracks a different instrument; sized by notional)

Every route reports whether its provider is *configured* (credentials present). A route can exist in
code yet be unusable until you add credentials; ``executable`` means "an adapter exists", ``setup``
tells you whether it will work right now.

Still without any adapter: non-US equities (Europe/Asia/Africa) and futures. They stay analysis-only.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

from app.markets.oanda_map import oanda_instrument
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
        "alpaca", frozenset({AssetClass.STOCK, AssetClass.OPTION}), True, True, True, ("paper", "live"),
        "US-listed stocks/ETFs and US equity options only; day orders; extended-hours orders are not supported by the ETI client. "
        "Options need an Alpaca account with options trading approved."),
    "oanda": ProviderCapability(
        "oanda", frozenset({AssetClass.FOREX, AssetClass.METAL, AssetClass.INDEX, AssetClass.COMMODITY}), False, True, True,
        ("paper", "live"),
        "Spot FX and metals, plus index/commodity CFDs. Paper = OANDA practice account. Instruments offered depend on your "
        "OANDA entity and jurisdiction (CFDs are not available to US accounts); ETI checks your account's instrument list."),
}

# Classes with no direct adapter, and what would be needed.
NOT_INTEGRATED: dict[str, str] = {
    "forex": "OANDA adapter exists but is not configured (set OANDA_API_TOKEN and OANDA_ACCOUNT_ID), or this pair is not offered by OANDA.",
    "metal": "OANDA adapter exists but is not configured, or this metal is not offered; ETF proxies (GLD/SLV/PPLT/PALL) need Alpaca keys.",
    "index": "No route for this index (OANDA does not list it and no ETF stand-in exists).",
    "commodity": "No route for this commodity (OANDA does not list it and no ETF stand-in exists).",
    "future": "No futures adapter (and no ETF stand-in: contract sizing does not map to shares). Analysis, sizing and sessions work; execution is unavailable.",
    "option": "Options route via Alpaca for US equity options (OCC symbols); other options are unsupported.",
    "stock_non_us": "No non-US equity adapter (EU/Asia/Africa). Analysis, sessions and sizing work; execution is unavailable.",
}

_OANDA_SESSION = {AssetClass.FOREX: "fx_24x5", AssetClass.METAL: "metals_otc"}
_CFD_NOTE = ("OANDA CFD: tracks the underlying with financing costs and OANDA's own hours/spreads; it is not the cash index or the "
             "exchange future, and CFDs are not offered in every jurisdiction (e.g. US accounts).")


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
    if cap.name == "oanda" and oanda_instrument(inst) is None:
        return False          # asset class is supported, but OANDA does not list this specific market
    return True


def setup_status(provider: str, settings: Any = None) -> dict:
    """Whether a provider's credentials are present (never reveals values)."""
    if settings is None:
        from app.config import get_settings
        settings = get_settings()
    p = provider.lower()
    if p == "oanda":
        missing = [n for n, v in (("OANDA_API_TOKEN", settings.oanda_api_token), ("OANDA_ACCOUNT_ID", settings.oanda_account_id)) if not v]
        return {"configured": not missing, "missing": missing}
    if p == "alpaca":
        missing = [n for n, v in (("ALPACA_API_KEY", settings.alpaca_api_key), ("ALPACA_SECRET_KEY", settings.alpaca_secret_key)) if not v]
        return {"configured": not missing, "missing": missing}
    if p == "binance":     # public market data needs no keys; paper orders simulate without keys; real testnet/live orders need them
        has = bool(settings.binance_api_key and settings.binance_secret_key)
        return {"configured": True, "missing": [], "note": None if has else
                "public data and simulated paper fills work without keys; real testnet/live orders need BINANCE_API_KEY and BINANCE_SECRET_KEY"}
    return {"configured": False, "missing": []}


def routes_for(inst: Instrument, settings: Any = None) -> list[dict]:
    """Executable routes for an instrument, best first. Empty list = analysis only."""
    routes: list[dict] = []
    ac = inst.asset_class

    if ac == AssetClass.CRYPTO:
        routes.append({"provider": "binance", "symbol": inst.symbol, "kind": "direct", "session_id": "crypto_24x7",
                       "environments": list(CAPABILITIES["binance"].environments),
                       "note": "Spot order via TradingService; the pair must exist on Binance spot."})

    elif ac == AssetClass.STOCK and inst.region == "US":
        routes.append({"provider": "alpaca", "symbol": inst.symbol, "kind": "direct", "session_id": "us_equity",
                       "environments": list(CAPABILITIES["alpaca"].environments),
                       "note": "Whole-share day orders via TradingService."})

    elif ac == AssetClass.OPTION:
        routes.append({"provider": "alpaca", "symbol": inst.symbol, "kind": "direct", "session_id": "us_equity",
                       "environments": list(CAPABILITIES["alpaca"].environments),
                       "note": "US equity option via Alpaca (whole contracts, day orders). Requires an options-approved account; "
                               "prefer limit orders - option spreads are wide."})

    elif ac in (AssetClass.FOREX, AssetClass.METAL, AssetClass.INDEX, AssetClass.COMMODITY):
        venue = oanda_instrument(inst)
        if venue:
            cfd = ac in (AssetClass.INDEX, AssetClass.COMMODITY)
            routes.append({"provider": "oanda", "symbol": inst.symbol, "venue_symbol": venue, "kind": "cfd" if cfd else "direct",
                           "session_id": _OANDA_SESSION.get(ac, "cme_globex" if ac == AssetClass.INDEX else inst.session_id),
                           "environments": list(CAPABILITIES["oanda"].environments),
                           "note": (_CFD_NOTE if cfd else f"Spot {inst.name or inst.symbol} via OANDA ({venue}); units are base-currency/ounces.")
                                   + (" Session hours are approximate; the live quote's tradeable flag is authoritative." if cfd else "")})
        if ac in (AssetClass.METAL, AssetClass.INDEX, AssetClass.COMMODITY):
            # Futures are never routed to ETFs: their sizing is in contracts, an ETF route would be in shares.
            proxy = execution_proxy(inst)
            if proxy:
                etf, quality = proxy
                caveat = {"close": "Tracks the underlying closely but carries fund fees and trades only in US equity hours.",
                          "approximate": "Tracks a different/approximate benchmark; basis risk vs the named index.",
                          "futures_based": "Futures-based fund: roll yield (contango/backwardation) diverges from spot."}.get(quality, "")
                routes.append({"provider": "alpaca", "symbol": etf, "kind": "etf_proxy", "proxy_quality": quality, "session_id": "us_equity",
                               "environments": list(CAPABILITIES["alpaca"].environments),
                               "note": f"Not the instrument itself: {inst.symbol} exposure via {etf}. {caveat}".strip()})

    for r in routes:
        r["setup"] = setup_status(r["provider"], settings)
    return routes


def data_coverage(inst: Instrument, settings: Any = None) -> dict:
    routes = routes_for(inst, settings)
    if routes:
        r = routes[0]
        return {"status": "available" if r["setup"]["configured"] else "needs_setup", "provider": r["provider"], "symbol": r["symbol"],
                "via": r["kind"], "missing": r["setup"]["missing"]}
    return {"status": "provider_not_integrated", "provider": None, "symbol": None, "via": None, "missing": []}


def not_integrated_reason(inst: Instrument) -> Optional[str]:
    if routes_for(inst):
        return None
    if inst.asset_class == AssetClass.STOCK:
        return NOT_INTEGRATED["stock_non_us"]
    return NOT_INTEGRATED.get(inst.asset_class.value)


def overview(settings: Any = None) -> dict:
    """Capability matrix for every asset class (what works, what needs credentials, what has no adapter)."""
    matrix = {}
    for ac in AssetClass:
        if ac == AssetClass.UNKNOWN:
            continue
        caps = [c for c in CAPABILITIES.values() if ac in c.asset_classes]
        cfd = ac in (AssetClass.INDEX, AssetClass.COMMODITY)
        direct = [c.name for c in caps if not (cfd and c.name == "oanda")]
        cfd_via = [c.name for c in caps if cfd and c.name == "oanda"]
        proxy_via = ["alpaca"] if ac in (AssetClass.METAL, AssetClass.INDEX, AssetClass.COMMODITY) else []
        providers = sorted({*direct, *cfd_via, *proxy_via})
        matrix[ac.value] = {
            "direct_providers": direct, "cfd_providers": cfd_via, "etf_proxy_via": proxy_via,
            "analysis": True, "execution": bool(providers),
            "setup": {p: setup_status(p, settings) for p in providers},
            "gap": None if providers else NOT_INTEGRATED.get(ac.value),
        }
    matrix["stock"]["gap"] = NOT_INTEGRATED["stock_non_us"]
    matrix["stock"]["execution_scope"] = "US-listed only"
    matrix["option"]["execution_scope"] = "US equity options only"
    return {"providers": {k: v.to_dict() for k, v in CAPABILITIES.items()}, "asset_classes": matrix}
