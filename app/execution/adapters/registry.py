"""Adapter registry: what exists, what is honest about not existing, and how to build one from credentials."""
from __future__ import annotations

from typing import Optional

from ..errors import ProviderUnavailableError
from .alpaca import AlpacaAdapter
from .base import AdapterInfo, BrokerAdapter, UnavailableAdapter
from .binance import BinanceAdapter
from .oanda import OandaAdapter
from .paper import PaperAdapter

INFO = {
    "paper": AdapterInfo("paper", ("any",), True, True, "implemented", "Built-in simulator; never touches real money."),
    "alpaca": AdapterInfo("alpaca", ("us_equity",), False, True, "implemented", "REST; paper and live."),
    "binance": AdapterInfo("binance", ("crypto_spot",), True, False, "implemented", "REST; testnet and live; spot only."),
    "oanda": AdapterInfo("oanda", ("forex", "cfd"), False, True, "implemented", "v20 REST; practice and live."),
    "kraken": AdapterInfo("kraken", ("crypto_spot",), False, False, "not_implemented",
                          "Adapter not written yet."),
    "coinbase": AdapterInfo("coinbase", ("crypto_spot",), False, False, "not_implemented",
                            "Advanced Trade API needs JWT (ES256) auth; adapter not written yet."),
    "mt5": AdapterInfo("mt5", ("forex", "cfd"), False, True, "not_implemented",
                       "MetaTrader 5 only exposes a local Windows terminal API; needs a separate bridge service."),
    "ibkr": AdapterInfo("ibkr", ("multi",), True, True, "not_implemented",
                        "Needs a running Client Portal Gateway or TWS session; needs a separate bridge service."),
}


def build_adapter(provider: str, credentials: dict, environment: str, symbols=()) -> BrokerAdapter:
    p = provider.lower()
    live = environment == "live"
    if p == "paper":
        return PaperAdapter()
    if p == "alpaca":
        return AlpacaAdapter(credentials["api_key"], credentials["secret_key"], paper=not live)
    if p == "binance":
        return BinanceAdapter(credentials["api_key"], credentials["secret_key"], testnet=not live, symbols=symbols)
    if p == "oanda":
        return OandaAdapter(credentials["token"], credentials["account_id"], practice=not live)
    info = INFO.get(p)
    reason = info.notes if info else "unknown provider"
    raise ProviderUnavailableError(f"{p}: {reason}")
