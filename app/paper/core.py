"""Pure paper-trading core (stdlib only). No network, no database, no clock of its own.

All money maths lives here so it can be tested exhaustively. The service layer fetches a verified order book,
calls the engine, and persists the resulting state.

Accounting (average cost, fee-inclusive):
  BUY  q @ p, fee f : cash -= q*p + f ; cost basis per unit = (old_cost*old_qty + q*p + f) / new_qty
  SELL q @ p, fee f : cash += q*p - f ; realized += q*p - f - avg_cost*q
  unrealized = (mark - avg_cost) * qty        (mark = best bid: what a liquidation would roughly get)
  invariant: equity - starting_cash == realized_pnl + unrealized_pnl
"""
from __future__ import annotations

import math
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

EPS = 1e-12
SYMBOL_RE = re.compile(r"^[A-Z0-9./_-]{1,32}$")

MARKET, LIMIT, STOP_LOSS, TAKE_PROFIT = "market", "limit", "stop_loss", "take_profit"
ORDER_TYPES = (MARKET, LIMIT, STOP_LOSS, TAKE_PROFIT)
OPEN_STATUSES = ("new", "partially_filled")


class PaperError(Exception):
    """Order rejected. The message is safe to show to the user."""


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.isoformat() if dt else None


def _parse(s: Optional[str]) -> Optional[datetime]:
    return datetime.fromisoformat(s) if s else None


def _finite_pos(x) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) and x > 0


# --------------------------------------------------------------------------- market data
@dataclass(frozen=True)
class Book:
    symbol: str
    bids: tuple          # ((price, qty), ...) best first
    asks: tuple
    ts: datetime
    source: str = "unknown"

    @property
    def best_bid(self) -> float:
        return self.bids[0][0] if self.bids else 0.0

    @property
    def best_ask(self) -> float:
        return self.asks[0][0] if self.asks else 0.0

    @property
    def mid(self) -> float:
        return (self.best_bid + self.best_ask) / 2.0

    @property
    def spread_bps(self) -> float:
        return (self.best_ask - self.best_bid) / self.mid * 1e4 if self.valid else float("inf")

    @property
    def valid(self) -> bool:
        return bool(self.bids and self.asks and _finite_pos(self.best_bid) and _finite_pos(self.best_ask)
                    and self.best_ask >= self.best_bid)

    def to_dict(self) -> dict:
        return {"symbol": self.symbol, "best_bid": self.best_bid, "best_ask": self.best_ask,
                "spread_bps": round(self.spread_bps, 3), "ts": _iso(self.ts), "source": self.source}


@dataclass
class PaperConfig:
    starting_cash: float = 10_000.0
    taker_fee_bps: float = 10.0            # 0.10% - Binance spot standard tier
    maker_fee_bps: float = 10.0
    extra_slippage_bps: float = 1.0        # latency / queue slippage on top of walking the book
    participation: float = 0.5             # never consume more than this fraction of eligible visible depth
    max_spread_bps: float = 50.0
    max_book_age_seconds: float = 5.0
    min_order_notional: float = 1.0
    max_position_notional_pct: float = 25.0   # of equity, per symbol, after the trade
    max_order_notional_pct: float = 25.0      # of equity, per order
    max_open_positions: int = 10
    max_open_orders: int = 50
    duplicate_window_seconds: float = 3.0
    qty_step: float = 0.0                  # 0 = no lot-size rounding

    def to_dict(self) -> dict:
        return dict(self.__dict__)

    @staticmethod
    def from_dict(d: dict) -> "PaperConfig":
        return PaperConfig(**{k: v for k, v in d.items() if k in PaperConfig.__dataclass_fields__})


# --------------------------------------------------------------------------- records
@dataclass
class Order:
    id: str
    client_order_id: str
    symbol: str
    side: str
    type: str
    qty: float
    limit_price: Optional[float] = None     # limit / take_profit price
    stop_price: Optional[float] = None      # stop_loss trigger
    status: str = "new"
    filled_qty: float = 0.0
    avg_fill_price: Optional[float] = None
    fees: float = 0.0
    oco_group: Optional[str] = None
    triggered: bool = False
    note: str = ""
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    @property
    def remaining(self) -> float:
        return max(0.0, self.qty - self.filled_qty)

    @property
    def is_open(self) -> bool:
        return self.status in OPEN_STATUSES

    def to_dict(self) -> dict:
        d = dict(self.__dict__)
        d["created_at"], d["updated_at"] = _iso(self.created_at), _iso(self.updated_at)
        d["remaining"] = self.remaining
        return d

    @staticmethod
    def from_dict(d: dict) -> "Order":
        d = {k: v for k, v in d.items() if k in Order.__dataclass_fields__}
        d["created_at"], d["updated_at"] = _parse(d.get("created_at")), _parse(d.get("updated_at"))
        return Order(**d)


@dataclass
class Fill:
    id: str
    order_id: str
    symbol: str
    side: str
    qty: float
    price: float
    fee: float
    liquidity: str                  # taker | maker
    realized_pnl: float
    ts: Optional[datetime] = None

    def to_dict(self) -> dict:
        d = dict(self.__dict__)
        d["ts"] = _iso(self.ts)
        return d

    @staticmethod
    def from_dict(d: dict) -> "Fill":
        d = dict(d)
        d["ts"] = _parse(d.get("ts"))
        return Fill(**d)


@dataclass
class Position:
    symbol: str
    qty: float = 0.0
    avg_cost: float = 0.0            # fee-inclusive
    realized_pnl: float = 0.0
    last_mark: float = 0.0           # best bid at last book seen

    def to_dict(self) -> dict:
        return dict(self.__dict__)


@dataclass
class Account:
    account_id: str
    config: PaperConfig = field(default_factory=PaperConfig)
    cash: float = 0.0
    realized_pnl: float = 0.0
    fees_paid: float = 0.0
    positions: dict = field(default_factory=dict)      # symbol -> Position
    orders: dict = field(default_factory=dict)         # id -> Order
    fills: list = field(default_factory=list)
    seq: int = 0
    version: int = 0
    created_at: Optional[datetime] = None

    def to_dict(self) -> dict:
        return {"account_id": self.account_id, "config": self.config.to_dict(), "cash": self.cash,
                "realized_pnl": self.realized_pnl, "fees_paid": self.fees_paid,
                "positions": {k: v.to_dict() for k, v in self.positions.items()},
                "orders": {k: v.to_dict() for k, v in self.orders.items()},
                "fills": [f.to_dict() for f in self.fills], "seq": self.seq, "version": self.version,
                "created_at": _iso(self.created_at)}

    @staticmethod
    def from_dict(d: dict) -> "Account":
        a = Account(d["account_id"], PaperConfig.from_dict(d.get("config", {})), d["cash"], d["realized_pnl"],
                    d["fees_paid"], {k: Position(**v) for k, v in d["positions"].items()},
                    {k: Order.from_dict(v) for k, v in d["orders"].items()}, [Fill.from_dict(f) for f in d["fills"]],
                    d["seq"], d.get("version", 0), _parse(d.get("created_at")))
        return a


@dataclass
class OrderRequest:
    symbol: str
    side: str
    type: str = MARKET
    qty: float = 0.0
    limit_price: Optional[float] = None
    stop_price: Optional[float] = None
    client_order_id: Optional[str] = None
    oco_group: Optional[str] = None


# --------------------------------------------------------------------------- fill simulation
def simulate_walk(book: Book, side: str, qty: float, cfg: PaperConfig, limit_price: Optional[float] = None,
                  slippage: bool = True) -> tuple:
    """Walk the book for `qty`. Returns (filled_qty, vwap, eligible_depth).

    Only levels at or better than `limit_price` are eligible; at most `participation` of eligible depth is taken.
    Extra slippage (bps) worsens each price unless the fill is a resting-limit fill at its own price.
    """
    levels = book.asks if side == "buy" else book.bids
    eligible = [(p, q) for p, q in levels if limit_price is None
                or (p <= limit_price + EPS if side == "buy" else p >= limit_price - EPS)]
    depth = sum(q for _, q in eligible)
    cap = depth * cfg.participation
    want = min(qty, cap)
    cost = filled = 0.0
    slip = cfg.extra_slippage_bps / 1e4 if slippage else 0.0
    for p, q in eligible:
        if want - filled <= EPS:
            break
        take = min(q, want - filled)
        px = p * (1 + slip) if side == "buy" else p * (1 - slip)
        if limit_price is not None:                      # never worse than the user's limit
            px = min(px, limit_price) if side == "buy" else max(px, limit_price)
        cost += take * px
        filled += take
    return filled, (cost / filled if filled > EPS else 0.0), depth


class PaperEngine:
    """Operates on one Account. Not thread-safe: callers serialise access per account."""

    def __init__(self, account: Account):
        self.acct = account
        self.audit: list = []

    # ------------------------------------------------------------------ factory
    @staticmethod
    def new_account(account_id: str, cfg: Optional[PaperConfig] = None, now: Optional[datetime] = None) -> Account:
        cfg = cfg or PaperConfig()
        if not _finite_pos(cfg.starting_cash):
            raise PaperError("starting_cash must be positive")
        return Account(account_id, cfg, cash=cfg.starting_cash, created_at=now or utcnow())

    # ------------------------------------------------------------------ helpers
    def _log(self, event: str, now, order: Optional[Order] = None, **details):
        self.audit.append({"ts": _iso(now), "event": event, "order_id": order.id if order else None,
                           "account_id": self.acct.account_id, "details": details})

    def _next_id(self, prefix: str) -> str:
        self.acct.seq += 1
        return f"{prefix}-{self.acct.seq:06d}"

    def open_orders(self, symbol: Optional[str] = None) -> list:
        return [o for o in self.acct.orders.values() if o.is_open and (symbol is None or o.symbol == symbol)]

    def reserved_cash(self) -> float:
        cfg = self.acct.config
        return sum(o.remaining * o.limit_price * (1 + cfg.taker_fee_bps / 1e4)
                   for o in self.open_orders() if o.side == "buy" and o.limit_price)

    def available_cash(self) -> float:
        return self.acct.cash - self.reserved_cash()

    def reserved_qty(self, symbol: str, exclude_group: Optional[str] = None) -> float:
        """Open sell orders reserve holdings. Orders in one OCO group reserve once (the largest)."""
        groups: dict = {}
        total = 0.0
        for o in self.open_orders(symbol):
            if o.side != "sell" or (exclude_group and o.oco_group == exclude_group):
                continue
            if o.oco_group:
                groups[o.oco_group] = max(groups.get(o.oco_group, 0.0), o.remaining)
            else:
                total += o.remaining
        return total + sum(groups.values())

    def available_qty(self, symbol: str, exclude_group: Optional[str] = None) -> float:
        pos = self.acct.positions.get(symbol)
        return max(0.0, (pos.qty if pos else 0.0) - self.reserved_qty(symbol, exclude_group))

    def equity(self, marks: Optional[dict] = None) -> float:
        marks = marks or {}
        total = self.acct.cash
        for s, p in self.acct.positions.items():
            total += p.qty * (marks.get(s) or p.last_mark or p.avg_cost)
        return total

    def _validate_book(self, book: Book, now: datetime):
        cfg = self.acct.config
        if not book.valid:
            raise PaperError("No verified live price: order book is empty or crossed")
        age = (now - book.ts).total_seconds()
        if age > cfg.max_book_age_seconds:
            raise PaperError(f"Market data is stale ({age:.1f}s old); refusing to simulate a fill")
        if age < -5.0:
            raise PaperError("Market data timestamp is in the future; refusing to simulate a fill")
        if book.spread_bps > cfg.max_spread_bps:
            raise PaperError(f"Spread {book.spread_bps:.1f} bps exceeds the {cfg.max_spread_bps} bps limit")

    def _mark(self, book: Book):
        pos = self.acct.positions.get(book.symbol)
        if pos and book.valid:
            pos.last_mark = book.best_bid

    # ------------------------------------------------------------------ validation + placement
    def _validate_request(self, req: OrderRequest, now: datetime) -> OrderRequest:
        cfg = self.acct.config
        req.symbol = (req.symbol or "").strip().upper()
        req.side = (req.side or "").strip().lower()
        req.type = (req.type or "").strip().lower()
        if not SYMBOL_RE.match(req.symbol):
            raise PaperError("Invalid symbol")
        if req.side not in ("buy", "sell"):
            raise PaperError("side must be buy or sell")
        if req.type not in ORDER_TYPES:
            raise PaperError(f"type must be one of {', '.join(ORDER_TYPES)}")
        if not _finite_pos(req.qty):
            raise PaperError("Quantity must be a positive finite number")
        if cfg.qty_step > 0:
            req.qty = math.floor(req.qty / cfg.qty_step + 1e-9) * cfg.qty_step
            if req.qty <= 0:
                raise PaperError("Quantity rounds to zero at the lot size")
        if req.type in (LIMIT, TAKE_PROFIT) and not _finite_pos(req.limit_price):
            raise PaperError(f"{req.type} orders need a positive limit_price")
        if req.type == STOP_LOSS and not _finite_pos(req.stop_price):
            raise PaperError("stop_loss orders need a positive stop_price")
        if req.type in (STOP_LOSS, TAKE_PROFIT) and req.side != "sell":
            raise PaperError("stop_loss and take_profit orders are exit orders and must be sells (no shorting)")
        if req.type == MARKET:
            req.limit_price = req.stop_price = None
        return req

    def _duplicate(self, req: OrderRequest, now: datetime) -> Optional[Order]:
        cfg = self.acct.config
        if req.client_order_id:
            for o in self.acct.orders.values():
                if o.client_order_id == req.client_order_id:
                    return o
            return None
        for o in self.acct.orders.values():
            if (o.symbol, o.side, o.type, o.qty, o.limit_price, o.stop_price) == (
                    req.symbol, req.side, req.type, req.qty, req.limit_price, req.stop_price) \
                    and o.status != "rejected" and o.created_at \
                    and (now - o.created_at).total_seconds() < cfg.duplicate_window_seconds:
                raise PaperError("Duplicate order: an identical order was just placed")
        return None

    def preview(self, req: OrderRequest, book: Book, now: datetime) -> dict:
        """What would happen, without changing anything. Raises PaperError exactly where place_order would."""
        req = self._validate_request(OrderRequest(**req.__dict__), now)
        self._validate_book(book, now)
        cfg = self.acct.config
        out = {"symbol": req.symbol, "side": req.side, "type": req.type, "qty": req.qty, "book": book.to_dict()}
        limit = req.limit_price if req.type == LIMIT else None
        self._check_funds_and_limits(req, book)
        if req.type == MARKET or (req.type == LIMIT and self._marketable(req, book)):
            q, px, depth = simulate_walk(book, req.side, req.qty, cfg, limit)
            fee = q * px * cfg.taker_fee_bps / 1e4
            touch = book.best_ask if req.side == "buy" else book.best_bid
            slip = abs(px - touch) / touch * 1e4 if q > 0 else 0.0
            out.update(expected_fill_qty=q, expected_avg_price=px, expected_fee=fee, expected_slippage_bps=round(slip, 3),
                       visible_depth=depth, expected_unfilled_qty=max(0.0, req.qty - q),
                       notional=q * px, note="Executes immediately as taker" +
                       ("; remainder rests" if req.type == LIMIT and q < req.qty else
                        ("; remainder cancelled (insufficient visible liquidity)" if q < req.qty else "")))
        else:
            out.update(expected_fill_qty=0.0, note="Rests in the book until the market reaches the price")
        return out

    def _marketable(self, req: OrderRequest, book: Book) -> bool:
        return (req.side == "buy" and req.limit_price >= book.best_ask - EPS) or \
               (req.side == "sell" and req.limit_price <= book.best_bid + EPS)

    def _check_funds_and_limits(self, req: OrderRequest, book: Book):
        cfg = self.acct.config
        eq = self.equity({book.symbol: book.best_bid})
        pos = self.acct.positions.get(req.symbol)
        if req.side == "sell":
            avail = self.available_qty(req.symbol, req.oco_group)
            if req.qty > avail + EPS:
                held = pos.qty if pos else 0.0
                raise PaperError(f"Insufficient holdings: selling {req.qty:g} but only {avail:g} of {req.symbol} is "
                                 f"available ({held:g} held, {held - avail:g} reserved by open orders)")
            if req.type == STOP_LOSS and req.stop_price >= book.best_bid:
                raise PaperError("Stop price must be below the current bid (it would trigger immediately)")
            if req.type == TAKE_PROFIT and req.limit_price <= book.best_bid:
                raise PaperError("Take-profit price must be above the current bid")
            if req.type != STOP_LOSS and req.qty * (req.limit_price or book.best_bid) < cfg.min_order_notional:
                raise PaperError(f"Order notional below the {cfg.min_order_notional} minimum")
            return
        # buy
        ref = req.limit_price if req.type == LIMIT else book.best_ask
        worst = ref * (1 + cfg.extra_slippage_bps / 1e4) if req.type == MARKET else ref
        est_cost = req.qty * worst * (1 + cfg.taker_fee_bps / 1e4)
        notional = req.qty * worst
        if notional < cfg.min_order_notional:
            raise PaperError(f"Order notional {notional:.2f} is below the {cfg.min_order_notional} minimum")
        if est_cost > self.available_cash() + EPS:
            raise PaperError(f"Insufficient balance: need {est_cost:,.2f} but only {self.available_cash():,.2f} is available")
        if eq > 0 and notional > eq * cfg.max_order_notional_pct / 100.0 + EPS:
            raise PaperError(f"Order notional {notional:,.2f} exceeds {cfg.max_order_notional_pct}% of equity")
        held_notional = (pos.qty if pos else 0.0) * book.best_bid
        if eq > 0 and held_notional + notional > eq * cfg.max_position_notional_pct / 100.0 + EPS:
            raise PaperError(f"Position in {req.symbol} would exceed {cfg.max_position_notional_pct}% of equity")
        if not pos or pos.qty <= EPS:
            if len([p for p in self.acct.positions.values() if p.qty > EPS]) >= cfg.max_open_positions:
                raise PaperError(f"Maximum open positions ({cfg.max_open_positions}) reached")

    def place_order(self, req: OrderRequest, book: Book, now: datetime, halted: bool = False) -> Order:
        """Validate, then execute or rest. Raises PaperError (and audits it) when rejected."""
        try:
            if halted:
                raise PaperError("Trading is halted (kill switch active)")
            req = self._validate_request(req, now)
            dup = self._duplicate(req, now)
            if dup is not None:
                self._log("duplicate_returned", now, dup)
                return dup
            if len(self.open_orders()) >= self.acct.config.max_open_orders:
                raise PaperError("Too many open orders")
            self._validate_book(book, now)
            self._check_funds_and_limits(req, book)
        except PaperError as e:
            self._log("order_rejected", now, reason=str(e), request=req.__dict__)
            raise
        cfg = self.acct.config
        o = Order(self._next_id("ord"), req.client_order_id or f"pp-{uuid.uuid4().hex[:16]}", req.symbol, req.side,
                  req.type, req.qty, req.limit_price, req.stop_price, oco_group=req.oco_group,
                  created_at=now, updated_at=now)
        self.acct.orders[o.id] = o
        self._log("order_accepted", now, o, type=o.type, side=o.side, qty=o.qty, limit=o.limit_price, stop=o.stop_price)
        self._mark(book)
        if o.type == MARKET:
            self._execute_taker(o, book, now, limit=None)
            self._finish_ioc(o, now)
        elif o.type == LIMIT and self._marketable(req, book):
            self._execute_taker(o, book, now, limit=o.limit_price)
        self._after_fill_housekeeping(o, now)
        return o

    # ------------------------------------------------------------------ execution
    def _execute_taker(self, o: Order, book: Book, now: datetime, limit: Optional[float]):
        cfg = self.acct.config
        q, px, _ = simulate_walk(book, o.side, o.remaining, cfg, limit)
        if q <= EPS:
            return
        self._apply_fill(o, q, px, cfg.taker_fee_bps, "taker", now)

    def _execute_maker(self, o: Order, book: Book, now: datetime):
        cfg = self.acct.config
        q, _, _ = simulate_walk(book, o.side, o.remaining, cfg, o.limit_price, slippage=False)
        if q <= EPS:
            return
        self._apply_fill(o, q, o.limit_price, cfg.maker_fee_bps, "maker", now)

    def _finish_ioc(self, o: Order, now: datetime):
        if o.is_open:
            if o.filled_qty <= EPS:
                o.status, o.note = "rejected", "No visible liquidity available to fill this market order"
                self._log("order_rejected", now, o, reason=o.note)
            else:
                o.status = "canceled"
                o.note = "Partially filled; remainder cancelled (insufficient visible liquidity)"
                self._log("order_remainder_canceled", now, o, filled_qty=o.filled_qty, requested=o.qty)
            o.updated_at = now

    def _apply_fill(self, o: Order, qty: float, price: float, fee_bps: float, liquidity: str, now: datetime):
        a = self.acct
        notional = qty * price
        fee = notional * fee_bps / 1e4
        pos = a.positions.setdefault(o.symbol, Position(o.symbol))
        realized = 0.0
        if o.side == "buy":
            a.cash -= notional + fee
            new_qty = pos.qty + qty
            pos.avg_cost = (pos.avg_cost * pos.qty + notional + fee) / new_qty
            pos.qty = new_qty
        else:
            a.cash += notional - fee
            realized = notional - fee - pos.avg_cost * qty
            pos.realized_pnl += realized
            a.realized_pnl += realized
            pos.qty -= qty
            if pos.qty <= EPS:
                pos.qty, pos.avg_cost = 0.0, 0.0
        a.fees_paid += fee
        o.avg_fill_price = ((o.avg_fill_price or 0.0) * o.filled_qty + notional) / (o.filled_qty + qty)
        o.filled_qty += qty
        o.fees += fee
        o.updated_at = now
        o.status = "filled" if o.remaining <= EPS else "partially_filled"
        if o.status == "filled":
            o.filled_qty = o.qty
        a.fills.append(Fill(self._next_id("fill"), o.id, o.symbol, o.side, qty, price, fee, liquidity, realized, now))
        self._log("fill", now, o, qty=qty, price=price, fee=fee, liquidity=liquidity, realized_pnl=realized,
                  status=o.status)

    def _after_fill_housekeeping(self, o: Order, now: datetime):
        if o.filled_qty > EPS and o.oco_group:
            for sib in self.open_orders():
                if sib.oco_group == o.oco_group and sib.id != o.id:
                    sib.status, sib.note, sib.updated_at = "canceled", f"OCO sibling {o.id} executed", now
                    self._log("order_canceled", now, sib, reason="oco")
        # a sell that consumed holdings may leave other sells over-reserved: shrink them
        if o.side == "sell" and o.filled_qty > EPS:
            pos = self.acct.positions.get(o.symbol)
            held = pos.qty if pos else 0.0
            for s in self.open_orders(o.symbol):
                if s.side == "sell" and s.remaining > held + EPS:
                    if held <= EPS:
                        s.status, s.note, s.updated_at = "canceled", "No holdings left to sell", now
                        self._log("order_canceled", now, s, reason="no_holdings")
                    else:
                        s.qty = s.filled_qty + held
                        s.updated_at = now

    # ------------------------------------------------------------------ resting orders
    def on_tick(self, book: Book, now: datetime) -> list:
        """Advance resting orders for book.symbol. Returns orders that changed."""
        changed = []
        if not book.valid:
            return changed
        if (now - book.ts).total_seconds() > self.acct.config.max_book_age_seconds:
            return changed                                    # never trigger on stale data
        self._mark(book)
        for o in sorted(self.open_orders(book.symbol), key=lambda x: x.created_at or now):
            if not o.is_open:                                  # cancelled by an OCO sibling earlier in this loop
                continue
            before = (o.status, o.filled_qty)
            if o.type == LIMIT:
                if o.side == "buy" and book.best_ask <= o.limit_price + EPS:
                    self._execute_maker(o, book, now)
                elif o.side == "sell" and book.best_bid >= o.limit_price - EPS:
                    self._execute_maker(o, book, now)
            elif o.type == STOP_LOSS:
                if not o.triggered and book.best_bid <= o.stop_price + EPS:
                    o.triggered = True
                    self._log("stop_triggered", now, o, bid=book.best_bid, stop=o.stop_price)
                if o.triggered:
                    self._execute_taker(o, book, now, limit=None)   # stop becomes a market sell
            elif o.type == TAKE_PROFIT:
                if not o.triggered and book.best_bid >= o.limit_price - EPS:
                    o.triggered = True
                    self._log("take_profit_triggered", now, o, bid=book.best_bid, price=o.limit_price)
                if o.triggered:
                    self._execute_taker(o, book, now, limit=o.limit_price)
            if (o.status, o.filled_qty) != before:
                changed.append(o)
                self._after_fill_housekeeping(o, now)
        return changed

    def cancel_order(self, order_id: str, now: datetime) -> Order:
        o = self.acct.orders.get(order_id)
        if o is None:
            raise PaperError("Unknown order")
        if not o.is_open:
            raise PaperError(f"Order is already {o.status}")
        o.status = "canceled"
        o.note = "Canceled by user" + (f" after partial fill of {o.filled_qty:g}" if o.filled_qty > EPS else "")
        o.updated_at = now
        self._log("order_canceled", now, o, reason="user", filled_qty=o.filled_qty)
        return o

    def cancel_all(self, now: datetime, symbol: Optional[str] = None) -> list:
        return [self.cancel_order(o.id, now) for o in self.open_orders(symbol)]

    def flatten(self, books: dict, now: datetime) -> dict:
        """Emergency: cancel everything and market-sell every holding that has a usable book."""
        canceled = [o.id for o in self.cancel_all(now)]
        sold, failed = [], []
        for sym, pos in list(self.acct.positions.items()):
            if pos.qty <= EPS:
                continue
            book = books.get(sym)
            try:
                if book is None:
                    raise PaperError("no live book")
                o = self.place_order(OrderRequest(sym, "sell", MARKET, pos.qty, client_order_id=f"flatten-{sym}-{self.acct.seq}"),
                                       book, now)
                sold.append({"symbol": sym, "order_id": o.id, "status": o.status, "filled_qty": o.filled_qty})
            except PaperError as e:
                failed.append({"symbol": sym, "reason": str(e)})
        self._log("flatten", now, canceled=canceled, sold=sold, failed=failed)
        return {"canceled": canceled, "sold": sold, "failed": failed}

    # ------------------------------------------------------------------ reporting
    def summary(self, marks: Optional[dict] = None) -> dict:
        marks = marks or {}
        a = self.acct
        positions, unreal, mkt_value = [], 0.0, 0.0
        for s, p in sorted(a.positions.items()):
            if p.qty <= EPS:
                continue
            mark = marks.get(s) or p.last_mark or p.avg_cost
            u = (mark - p.avg_cost) * p.qty
            unreal += u
            mkt_value += p.qty * mark
            positions.append({"symbol": s, "qty": p.qty, "avg_cost": p.avg_cost, "mark": mark, "market_value": p.qty * mark,
                              "unrealized_pnl": u, "realized_pnl": p.realized_pnl,
                              "available_qty": self.available_qty(s)})
        equity = a.cash + mkt_value
        return {"account_id": a.account_id, "starting_cash": a.config.starting_cash, "cash": a.cash,
                "reserved_cash": self.reserved_cash(), "available_cash": self.available_cash(),
                "market_value": mkt_value, "equity": equity, "realized_pnl": a.realized_pnl, "unrealized_pnl": unreal,
                "total_pnl": equity - a.config.starting_cash, "fees_paid": a.fees_paid,
                "return_pct": (equity - a.config.starting_cash) / a.config.starting_cash * 100.0,
                "positions": positions, "open_orders": len(self.open_orders()), "fills": len(a.fills)}
