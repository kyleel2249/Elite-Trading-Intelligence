"""In-process paper broker. Environment is always "paper"; the engine refuses to treat it as live.

Fills marketable limits against the quote/book it is fed, supports partial fills and injected faults,
so the full order lifecycle (partials, timeouts, outages) can be exercised without a venue.
"""
from __future__ import annotations

from typing import Callable, Optional

from ..domain import (BrokerOrder, BrokerPosition, InstrumentRules, OrderBook, OrderStatus, OrderType, Quote, Side,
                      utcnow)
from ..errors import OrderRejectedError, TransientProviderError, UnknownOutcomeError
from .base import BrokerAdapter


class PaperAdapter(BrokerAdapter):
    name = "paper"
    environment = "paper"
    supports_order_book = True

    def __init__(self, starting_cash: float = 100_000.0, clock: Callable = utcnow):
        self.clock = clock
        self.cash = starting_cash
        self.quotes: dict = {}
        self.books: dict = {}
        self.rules: dict = {}
        self.positions: dict = {}        # symbol -> [qty, avg]
        self.orders: dict = {}           # client_order_id -> BrokerOrder
        self.fill_fraction = 1.0         # 1.0 full, 0<x<1 partial, 0 rest unfilled
        self.down = False                # simulate venue outage
        self.fail_submit_with: Optional[Exception] = None   # raised once, then cleared
        self.submit_lost = False         # order reaches venue but the response is lost (UnknownOutcome)
        self.submit_calls = 0

    # -- test/feed helpers --
    def set_quote(self, symbol: str, bid: float, ask: float, ts=None) -> None:
        self.quotes[symbol.upper()] = Quote("paper", symbol.upper(), bid, ask, ts or self.clock())

    def set_book(self, symbol: str, bids, asks, ts=None) -> None:
        self.books[symbol.upper()] = OrderBook(symbol.upper(), tuple(bids), tuple(asks), ts or self.clock())

    def _check_up(self):
        if self.down:
            raise TransientProviderError("paper venue down")

    async def market_open(self, symbol):
        self._check_up()
        return True

    # -- market data --
    async def get_quote(self, symbol):
        self._check_up()
        q = self.quotes.get(symbol.upper())
        if q is None:
            raise TransientProviderError(f"no quote for {symbol}")
        return q

    async def get_order_book(self, symbol, depth=20):
        self._check_up()
        return self.books.get(symbol.upper())

    async def get_rules(self, symbol):
        return self.rules.get(symbol.upper(), InstrumentRules())

    # -- account --
    async def get_equity(self):
        self._check_up()
        total = self.cash
        for sym, (qty, _avg) in self.positions.items():
            q = self.quotes.get(sym)
            if q:
                total += qty * q.mid
        return total

    async def get_positions(self):
        self._check_up()
        return [BrokerPosition(s, qty, avg, self.quotes[s].mid if s in self.quotes else None)
                for s, (qty, avg) in self.positions.items() if abs(qty) > 1e-12]

    # -- orders --
    def _apply_fill(self, symbol, side, qty, price):
        sign = 1 if side == Side.BUY else -1
        pos = self.positions.setdefault(symbol, [0.0, 0.0])
        new_qty = pos[0] + sign * qty
        if pos[0] == 0 or (pos[0] > 0) == (sign > 0):
            total = abs(pos[0]) + qty
            pos[1] = (pos[1] * abs(pos[0]) + price * qty) / total if total else price
        elif abs(new_qty) > 1e-12 and (new_qty > 0) != (pos[0] > 0):
            pos[1] = price
        pos[0] = new_qty
        self.cash -= sign * qty * price

    async def submit_order(self, *, client_order_id, symbol, side, qty, order_type, limit_price, reduce_only=False):
        self._check_up()
        self.submit_calls += 1
        if self.fail_submit_with is not None:
            err, self.fail_submit_with = self.fail_submit_with, None
            raise err
        if client_order_id in self.orders:
            raise OrderRejectedError("duplicate client_order_id")
        symbol = symbol.upper()
        q = self.quotes.get(symbol)
        if q is None:
            raise OrderRejectedError("unknown symbol")
        marketable = order_type == OrderType.MARKET or (
            limit_price is not None and (limit_price >= q.ask if side == Side.BUY else limit_price <= q.bid))
        filled, price = 0.0, None
        if marketable:
            px = q.ask if side == Side.BUY else q.bid
            filled = qty * self.fill_fraction
            if filled > 0:
                price = px
                self._apply_fill(symbol, side, filled, price)
        status = (OrderStatus.FILLED if filled >= qty - 1e-12 else
                  OrderStatus.PARTIALLY_FILLED if filled > 0 else OrderStatus.SUBMITTED)
        order = BrokerOrder(client_order_id, f"p-{len(self.orders) + 1}", status, qty, filled, price)
        self.orders[client_order_id] = order
        if self.submit_lost:
            self.submit_lost = False
            raise UnknownOutcomeError("response lost after venue accepted the order")
        return order

    async def get_order_by_client_id(self, symbol, client_order_id):
        self._check_up()
        return self.orders.get(client_order_id)

    async def cancel_order(self, symbol, client_order_id, provider_order_id):
        self._check_up()
        o = self.orders.get(client_order_id)
        if o and not o.status.terminal:
            o.status = OrderStatus.CANCELED

    async def list_open_orders(self):
        self._check_up()
        return [o for o in self.orders.values() if not o.status.terminal]
