"""Pure pre-trade checks. No I/O: every function takes data in and returns reasons out."""
from __future__ import annotations

import math
from datetime import datetime
from typing import Optional

from .domain import AccountPolicy, InstrumentRules, OrderBook, OrderIntent, OrderType, Quote, Side

CLOCK_SKEW_TOLERANCE_S = 5.0


def quote_problems(quote: Optional[Quote], now: datetime, policy: AccountPolicy) -> list:
    """Live-price verification: reject missing, crossed, stale, future-dated or wide-spread quotes."""
    if quote is None:
        return ["No live quote available"]
    if not quote.valid:
        return ["Quote is invalid (non-positive or crossed bid/ask)"]
    out = []
    age = quote.age_seconds(now)
    if age < -CLOCK_SKEW_TOLERANCE_S:
        out.append(f"Quote timestamp is {-age:.1f}s in the future (clock skew or bad data)")
    elif age > policy.max_quote_age_seconds:
        out.append(f"Quote is stale ({age:.1f}s old > {policy.max_quote_age_seconds}s)")
    if quote.spread_bps > policy.max_spread_bps:
        out.append(f"Spread {quote.spread_bps:.1f} bps exceeds limit {policy.max_spread_bps} bps")
    return out


def walk_book(book: OrderBook, side: Side, qty: float) -> tuple:
    """Return (vwap, filled_qty) for consuming `qty` from the side of the book the order hits."""
    levels = book.asks if side == Side.BUY else book.bids
    remaining, cost, filled = qty, 0.0, 0.0
    for price, size in levels:
        take = min(remaining, size)
        cost += take * price
        filled += take
        remaining -= take
        if remaining <= 1e-15:
            break
    return (cost / filled if filled > 0 else 0.0), filled


def book_problems(book: Optional[OrderBook], quote: Quote, intent: OrderIntent,
                  policy: AccountPolicy, now: datetime) -> list:
    """Order-book analysis: enough visible depth and tolerable expected slippage."""
    if book is None:
        return []     # venue exposes no book; spread + protective limit still apply
    out = []
    age = (now - book.ts).total_seconds()
    if age > policy.max_quote_age_seconds + CLOCK_SKEW_TOLERANCE_S:
        out.append(f"Order book is stale ({age:.1f}s old)")
        return out
    vwap, filled = walk_book(book, intent.side, intent.qty)
    if filled + 1e-12 < intent.qty * policy.min_depth_ratio and filled + 1e-12 < intent.qty:
        out.append("Insufficient book depth to fill the full order")
    else:
        _, deep = walk_book(book, intent.side, intent.qty * policy.min_depth_ratio)
        if deep + 1e-12 < intent.qty * policy.min_depth_ratio:
            out.append(f"Visible depth below {policy.min_depth_ratio}x order size")
    if filled > 0:
        touch = quote.ask if intent.side == Side.BUY else quote.bid
        slip = abs(vwap - touch) / touch * 1e4
        if slip > policy.max_slippage_bps:
            out.append(f"Expected book slippage {slip:.1f} bps exceeds limit {policy.max_slippage_bps} bps")
    return out


def protective_limit(side: Side, quote: Quote, max_slippage_bps: float) -> float:
    """Worst acceptable price. Market intents are always sent as marketable limits at this price."""
    band = max_slippage_bps / 1e4
    return quote.ask * (1 + band) if side == Side.BUY else quote.bid * (1 - band)


def round_down(value: float, step: float) -> float:
    if step <= 0:
        return value
    return math.floor(value / step + 1e-9) * step


def round_price(price: float, tick: float, side: Side) -> float:
    """Round toward the conservative side: buys down, sells up, so slippage limits are never loosened."""
    if tick <= 0:
        return price
    units = price / tick
    return (math.floor(units + 1e-9) if side == Side.BUY else math.ceil(units - 1e-9)) * tick


def intent_problems(intent: OrderIntent, policy: AccountPolicy) -> list:
    out = []
    if not isinstance(intent.qty, (int, float)) or not math.isfinite(intent.qty) or intent.qty <= 0:
        out.append("Quantity must be a positive finite number")
    if intent.order_type == OrderType.LIMIT and not (
            isinstance(intent.limit_price, (int, float)) and math.isfinite(intent.limit_price) and intent.limit_price > 0):
        out.append("Limit orders need a positive finite limit_price")
    sym = (intent.symbol or "").upper()
    if not sym:
        out.append("Symbol is required")
    elif sym not in {s.upper() for s in policy.allowed_symbols}:
        out.append(f"Symbol {sym} is not in this account's approved instruments")
    if policy.allowed_strategies and intent.strategy not in policy.allowed_strategies:
        out.append(f"Strategy '{intent.strategy}' is not approved for this account")
    return out


def rules_problems(qty: float, price: float, rules: InstrumentRules) -> list:
    out = []
    if rules.min_qty and qty + 1e-15 < rules.min_qty:
        out.append(f"Quantity {qty} below venue minimum {rules.min_qty}")
    if rules.min_notional and qty * price + 1e-9 < rules.min_notional:
        out.append(f"Notional {qty * price:.2f} below venue minimum {rules.min_notional}")
    return out


def limit_vs_band_problem(intent: OrderIntent, quote: Quote, policy: AccountPolicy) -> Optional[str]:
    """A user-supplied limit more aggressive than the slippage band is refused, not silently clamped."""
    if intent.order_type != OrderType.LIMIT or intent.limit_price is None:
        return None
    worst = protective_limit(intent.side, quote, policy.max_slippage_bps)
    if intent.side == Side.BUY and intent.limit_price > worst * (1 + 1e-12):
        return f"Limit {intent.limit_price} exceeds slippage band ceiling {worst:.8g}"
    if intent.side == Side.SELL and intent.limit_price < worst * (1 - 1e-12):
        return f"Limit {intent.limit_price} below slippage band floor {worst:.8g}"
    return None
