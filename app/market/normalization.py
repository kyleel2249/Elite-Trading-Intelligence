"""Normalize provider-specific payloads into ETI canonical records."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

from app.integrations.base import NormalizedQuote


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def normalize_binance_book_ticker(data: dict[str, Any], symbol: str) -> NormalizedQuote:
    bid = float(data["bidPrice"])
    ask = float(data["askPrice"])
    mid = (bid + ask) / 2.0
    now = utc_now()
    return NormalizedQuote(
        provider="binance",
        symbol=symbol.upper(),
        normalized_symbol=symbol.upper(),
        asset_class="crypto",
        price=mid,
        bid=bid,
        ask=ask,
        volume=None,
        ts_provider=now,
        ts_utc=now,
        retrieved_at=now,
        data_status="fresh",
        exchange="BINANCE",
        quote_currency="USDT" if symbol.upper().endswith("USDT") else None,
        meta={"source": "bookTicker", "bid_qty": data.get("bidQty"), "ask_qty": data.get("askQty")},
    )


def normalize_binance_kline(row: dict[str, Any], symbol: str, interval: str) -> dict[str, Any]:
    return {
        "provider": "binance",
        "symbol": symbol.upper(),
        "interval": interval,
        "open_time": row["open_time"],
        "open": row["open"],
        "high": row["high"],
        "low": row["low"],
        "close": row["close"],
        "volume": row["volume"],
        "close_time": row["close_time"],
        "ts_utc": datetime.fromtimestamp(row["close_time"] / 1000, tz=timezone.utc).isoformat(),
    }


def normalize_order_book(
    provider: str,
    symbol: str,
    bids: list[list[float]],
    asks: list[list[float]],
    depth: int = 20,
) -> dict[str, Any]:
    """Canonical order-book snapshot with liquidity metrics."""
    bids = sorted([[float(p), float(q)] for p, q in bids], key=lambda x: -x[0])[:depth]
    asks = sorted([[float(p), float(q)] for p, q in asks], key=lambda x: x[0])[:depth]

    best_bid = bids[0][0] if bids else None
    best_ask = asks[0][0] if asks else None
    spread = (best_ask - best_bid) if (best_bid is not None and best_ask is not None) else None
    spread_bps = (spread / best_bid * 10000) if spread and best_bid else None

    bid_vol = sum(q for _, q in bids)
    ask_vol = sum(q for _, q in asks)
    total = bid_vol + ask_vol
    imbalance = ((bid_vol - ask_vol) / total) if total > 0 else 0.0

    # Simple large-order detection (top-of-book size vs median)
    bid_sizes = [q for _, q in bids] or [0]
    ask_sizes = [q for _, q in asks] or [0]
    med_bid = sorted(bid_sizes)[len(bid_sizes) // 2]
    med_ask = sorted(ask_sizes)[len(ask_sizes) // 2]
    large_bids = [[p, q] for p, q in bids if q >= max(med_bid * 3, 1e-12)]
    large_asks = [[p, q] for p, q in asks if q >= max(med_ask * 3, 1e-12)]

    now = utc_now()
    return {
        "provider": provider,
        "symbol": symbol.upper(),
        "best_bid": best_bid,
        "best_ask": best_ask,
        "spread": spread,
        "spread_bps": spread_bps,
        "bid_volume": bid_vol,
        "ask_volume": ask_vol,
        "imbalance": imbalance,  # +1 bid-heavy, -1 ask-heavy
        "bids": bids,
        "asks": asks,
        "large_bids": large_bids[:5],
        "large_asks": large_asks[:5],
        "depth": depth,
        "ts_utc": now.isoformat(),
        "retrieved_at": now.isoformat(),
        "note": "Observed order-book data; imbalance and large-order flags are analytical interpretations",
    }
