"""Live market snapshot routed to the provider that can actually serve the instrument.

* crypto            -> Binance public data
* US stocks / ETFs  -> Alpaca data API (requires ALPACA_API_KEY/SECRET)
* metals / indices / commodities / futures with an ETF stand-in -> that ETF via Alpaca,
  clearly labelled as a proxy (it is NOT the underlying's price)
* everything else   -> ``provider_not_integrated`` (no data is invented)
"""
from __future__ import annotations

from typing import Any, Optional

from app.markets.providers import not_integrated_reason, routes_for
from app.markets.registry import classify
from app.markets.sessions import session_status


async def route_snapshot(symbol: str, provider: Optional[str] = None, *, market_service: Any = None, settings: Any = None) -> dict:
    inst = classify(symbol, provider_hint=provider)
    base = {"requested_symbol": inst.symbol, "instrument": inst.to_dict()}
    routes = [r for r in routes_for(inst) if not provider or r["provider"] == provider.lower()]
    if not routes:
        return {**base, "data_status": "provider_not_integrated", "price": None,
                "reason": not_integrated_reason(inst) or "No data route for this instrument or provider"}

    route = routes[0]
    if market_service is None:
        from app.market.service import MarketService  # imported lazily: needs httpx / settings stack
        market_service = MarketService(settings)
    snap = await market_service.get_snapshot(route["provider"], route["symbol"])
    market = session_status(route["session_id"]).to_dict()
    out = {**base, **snap, "route": route, "execution_market": market}
    if route["kind"] == "etf_proxy":
        out["is_proxy"] = True
        out["proxy_notice"] = (f"Price shown is {route['symbol']}, an ETF stand-in for {inst.symbol}; "
                               "it is not the underlying's price.")
    if not market["is_open"] and out.get("data_status") == "fresh":
        out["data_status"] = "fresh_but_market_closed"
    return out
