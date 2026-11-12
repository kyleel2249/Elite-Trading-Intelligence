"""Internal paper-trading exchange. Pure Python (stdlib only); no exchange credentials, no network.

Realism model
* Fills use ONLY a caller-supplied, verified live quote (and book, when available). Without one the order is rejected -
  prices are never invented.
* Market orders walk the visible book, taking at most `participation` of each level, paying base slippage plus a
  size-impact term and the taker fee. Insufficient visible depth => PARTIAL fill.
* Limit orders fill at their limit (or better when marketable) and pay maker/taker fees accordingly.
* Stop and take-profit orders trigger on the quote and then execute as market orders (a gap fills at the gapped price).
* BUY orders reserve cash; SELL orders reserve holdings. No shorting, no negative cash.
Accounting: buy fees are capitalised into cost basis, sell fees reduce proceeds, so
equity - starting_cash == realized_pnl + unrealized_pnl at all times.
"""
from __future__ import annotations

import copy
import math
import re
import uuid
from dataclasses import asdict, dataclass, field, fields
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

EPS = 1e-12
SYMBOL_RE = re.compile(r"^[A-Z0-9._/-]{1,32}$")
ORDER_TYPES = ("market", "limit", "stop", "take_profit")
WORKING = ("new", "partially_filled")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def _fin(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


@dataclass
class PaperConfig:
    starting_cash: float = 100_000.0
    taker_fee_bps: float = 10.0
    maker_fee_bps: float = 10.0
    base_slippage_bps: float = 2.0
    impact_bps_full_level: float = 10.0       # extra slippage if an order consumed 100% of a level
    participation: float = 0.5                # max share of each visible level an order may take
    unknown_liquidity_penalty_bps: float = 5.0
    max_quote_age_s: float = 10.0
    max_spread_bps: float = 50.0
    min_notional: float = 10.0
    max_open_positions: int = 10
    max_position_pct: float = 25.0            # max notional per symbol, % of equity
    max_order_pct: float = 25.0               # max notional per order, % of equity
    duplicate_window_s: float = 5.0
    reserve_buffer_bps: float = 50.0          # extra cash held back for market buys (slippage + fee headroom)
    max_closed_orders_kept: int = 2000
    max_fills_kept: int = 5000


@dataclass
class Snapshot:
    """A verified live quote. `verified` must come from the data-quality layer (fresh, valid)."""
    symbol: str
    bid: float
    ask: float
    ts: datetime
    last: Optional[float] = None
    bids: Optional[list] = None      # [(price, qty), ...] best first
    asks: Optional[list] = None
    verified: bool = True

    @property
    def mid(self) -> float:
        return (self.bid + self.ask) / 2.0

    @property
    def spread_bps(self) -> float:
        return (self.ask - self.bid) / self.mid * 1e4

    def problem(self, now: datetime, cfg: PaperConfig) -> Optional[str]:
        if not (_fin(self.bid) and _fin(self.ask)) or self.bid <= 0 or self.ask <= 0 or self.ask < self.bid:
            return "invalid_quote"
        if not self.verified:
            return "quote_not_verified"
        if (now - self.ts).total_seconds() > cfg.max_quote_age_s:
            return "quote_stale"
        if self.spread_bps > cfg.max_spread_bps:
            return "spread_too_wide"
        return None


@dataclass
class PaperOrder:
    id: str
    client_order_id: str
    symbol: str
    side: str
    type: str
    qty: float
    limit_price: Optional[float] = None
    trigger_price: Optional[float] = None
    tif: str = "gtc"
    status: str = "new"
    filled_qty: float = 0.0
    avg_fill_price: Optional[float] = None
    fees: float = 0.0
    reserved_cash: float = 0.0
    reserve_per_unit: float = 0.0
    oco_group: Optional[str] = None
    triggered: bool = False
    created_at: str = ""
    updated_at: str = ""
    expire_at: Optional[str] = None
    reason: Optional[str] = None
    strategy: str = "manual"
    thesis: Optional[str] = None

    @property
    def remaining(self) -> float:
        return max(self.qty - self.filled_qty, 0.0)

    @property
    def working(self) -> bool:
        return self.status in WORKING

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_dict(d: dict) -> "PaperOrder":
        names = {f.name for f in fields(PaperOrder)}
        return PaperOrder(**{k: v for k, v in d.items() if k in names})


class PaperEngine:
    def __init__(self, account_id: str = "default", config: Optional[PaperConfig] = None,
                 clock: Callable[[], datetime] = utcnow, kill_switch: Callable[[], bool] = lambda: False):
        self.account_id = account_id
        self.cfg = config or PaperConfig()
        self.clock = clock
        self.kill_switch = kill_switch
        self.starting_cash = self.cfg.starting_cash
        self.cash = self.cfg.starting_cash
        self.realized_pnl = 0.0
        self.fees_paid = 0.0
        self.holdings: dict[str, dict] = {}     # symbol -> {qty, avg_cost, realized_pnl, last_mark}
        self.orders: dict[str, PaperOrder] = {}
        self.fills: list[dict] = []
        self.seq = 0
        self._audit: list[dict] = []            # drained by the store after each mutation
        self._audit_seq = 0

    # ------------------------------------------------------------------ audit / ids
    def _log(self, event: str, order_id: Optional[str] = None, **detail: Any) -> None:
        self._audit_seq += 1
        self._audit.append({"seq": self._audit_seq, "ts": _iso(self.clock()), "account_id": self.account_id,
                            "event": event, "order_id": order_id, "detail": detail})

    def drain_audit(self) -> list[dict]:
        out, self._audit = self._audit, []
        return out

    def _next_id(self) -> str:
        self.seq += 1
        return f"ord-{self.seq:07d}"

    # ------------------------------------------------------------------ persistence
    def to_state(self) -> dict:
        closed = [o for o in self.orders.values() if not o.working]
        keep_closed = {o.id for o in sorted(closed, key=lambda o: o.created_at)[-self.cfg.max_closed_orders_kept:]}
        orders = {k: o.to_dict() for k, o in self.orders.items() if o.working or k in keep_closed}
        return {"account_id": self.account_id, "starting_cash": self.starting_cash, "cash": self.cash, "realized_pnl": self.realized_pnl,
                "fees_paid": self.fees_paid, "holdings": copy.deepcopy(self.holdings), "orders": orders,
                "fills": self.fills[-self.cfg.max_fills_kept:], "seq": self.seq, "audit_seq": self._audit_seq}

    @classmethod
    def from_state(cls, state: dict, config: Optional[PaperConfig] = None, **kw: Any) -> "PaperEngine":
        e = cls(state.get("account_id", "default"), config, **kw)
        e.starting_cash = float(state["starting_cash"]); e.cash = float(state["cash"])
        e.realized_pnl = float(state.get("realized_pnl", 0.0)); e.fees_paid = float(state.get("fees_paid", 0.0))
        e.holdings = copy.deepcopy(state.get("holdings", {}))
        e.orders = {k: PaperOrder.from_dict(v) for k, v in state.get("orders", {}).items()}
        e.fills = list(state.get("fills", [])); e.seq = int(state.get("seq", 0)); e._audit_seq = int(state.get("audit_seq", 0))
        return e

    def clone(self) -> "PaperEngine":
        return PaperEngine.from_state(self.to_state(), self.cfg, clock=self.clock, kill_switch=self.kill_switch)

    # ------------------------------------------------------------------ derived balances
    def reserved_cash(self) -> float:
        return sum(o.reserved_cash for o in self.orders.values() if o.working and o.side == "buy")

    def available_cash(self) -> float:
        return self.cash - self.reserved_cash()

    def reserved_qty(self, symbol: str, exclude_group: Optional[str] = None) -> float:
        total, groups = 0.0, {}
        for o in self.orders.values():
            if not (o.working and o.side == "sell" and o.symbol == symbol):
                continue
            if o.oco_group:
                if o.oco_group == exclude_group:
                    continue
                groups[o.oco_group] = max(groups.get(o.oco_group, 0.0), o.remaining)
            else:
                total += o.remaining
        return total + sum(groups.values())

    def held_qty(self, symbol: str) -> float:
        return self.holdings.get(symbol, {}).get("qty", 0.0)

    def available_qty(self, symbol: str) -> float:
        return max(self.held_qty(symbol) - self.reserved_qty(symbol), 0.0)

    def _mark(self, symbol: str) -> float:
        h = self.holdings.get(symbol, {})
        return h.get("last_mark") or h.get("avg_cost") or 0.0

    def equity(self) -> float:
        return self.cash + sum(h["qty"] * (h.get("last_mark") or h.get("avg_cost") or 0.0) for h in self.holdings.values() if h["qty"] > EPS)

    def open_positions(self) -> int:
        return sum(1 for h in self.holdings.values() if h["qty"] > EPS)

    def note_mark(self, symbol: str, mid: float) -> None:
        h = self.holdings.get(symbol)
        if h is not None and _fin(mid) and mid > 0:
            h["last_mark"] = mid

    # ------------------------------------------------------------------ validation helpers
    def _reject(self, o: PaperOrder, reason: str) -> dict:
        o.status, o.reason, o.updated_at = "rejected", reason, _iso(self.clock())
        o.reserved_cash = 0.0
        self.orders[o.id] = o
        self._log("order_rejected", o.id, reason=reason, symbol=o.symbol, side=o.side, qty=o.qty, type=o.type)
        return {"accepted": False, "duplicate": False, "reasons": [reason], "order": o.to_dict(), "fills": []}

    def _basic_errors(self, symbol, side, otype, qty, limit_price, trigger_price, tif) -> Optional[str]:
        if not isinstance(symbol, str) or not SYMBOL_RE.match(symbol):
            return "invalid_symbol"
        if side not in ("buy", "sell"):
            return "invalid_side"
        if otype not in ORDER_TYPES:
            return "invalid_order_type"
        if tif not in ("gtc", "ioc"):
            return "invalid_time_in_force"
        if not _fin(qty) or qty <= 0:
            return "invalid_quantity"
        if otype == "limit" and not (_fin(limit_price) and limit_price > 0):
            return "limit_price_required"
        if otype in ("stop", "take_profit") and not (_fin(trigger_price) and trigger_price > 0):
            return "trigger_price_required"
        if otype == "market" and (limit_price is not None or trigger_price is not None):
            return "market_order_takes_no_price"
        return None

    def _trigger_hit(self, o: PaperOrder, snap: Snapshot) -> bool:
        t = o.trigger_price
        if o.type == "stop":
            return snap.bid <= t if o.side == "sell" else snap.ask >= t
        return snap.bid >= t if o.side == "sell" else snap.ask <= t       # take_profit

    # ------------------------------------------------------------------ submit
    def submit(self, *, symbol: str, side: str, qty: float, order_type: str = "market", limit_price: Optional[float] = None,
               trigger_price: Optional[float] = None, tif: Optional[str] = None, client_order_id: Optional[str] = None,
               strategy: str = "manual", thesis: Optional[str] = None, snap: Optional[Snapshot] = None,
               expire_seconds: Optional[float] = None, _oco_group: Optional[str] = None, _skip_dupe_check: bool = False) -> dict:
        now = self.clock()
        symbol = symbol.strip().upper() if isinstance(symbol, str) else symbol
        side = side.strip().lower() if isinstance(side, str) else side
        order_type = order_type.strip().lower() if isinstance(order_type, str) else order_type
        tif = (tif or ("ioc" if order_type == "market" else "gtc"))
        cid = client_order_id or f"cli-{uuid.uuid4().hex[:16]}"
        if client_order_id and cid in {o.client_order_id for o in self.orders.values()}:
            existing = next(o for o in self.orders.values() if o.client_order_id == cid)
            return {"accepted": existing.status != "rejected", "duplicate": True, "reasons": ["duplicate_client_order_id"],
                    "order": existing.to_dict(), "fills": []}
        o = PaperOrder(id=self._next_id(), client_order_id=cid, symbol=symbol if isinstance(symbol, str) else str(symbol), side=str(side),
                       type=str(order_type), qty=float(qty) if _fin(qty) else 0.0, limit_price=limit_price, trigger_price=trigger_price,
                       tif=str(tif), created_at=_iso(now), updated_at=_iso(now), strategy=strategy, thesis=thesis, oco_group=_oco_group)
        if expire_seconds and _fin(expire_seconds) and expire_seconds > 0:
            o.expire_at = _iso(now + timedelta(seconds=expire_seconds))
        err = self._basic_errors(symbol, side, order_type, qty, limit_price, trigger_price, tif)
        if err:
            return self._reject(o, err)
        if self.kill_switch():
            return self._reject(o, "kill_switch_active")
        if not _skip_dupe_check:
            window = timedelta(seconds=self.cfg.duplicate_window_s)
            for p in self.orders.values():
                if p.status == "rejected" or p.id == o.id:
                    continue
                if (p.symbol, p.side, p.type, p.qty, p.limit_price, p.trigger_price) == (o.symbol, o.side, o.type, o.qty, o.limit_price, o.trigger_price) \
                        and now - datetime.fromisoformat(p.created_at) <= window:
                    return self._reject(o, "duplicate_order_within_window")
        if snap is None:
            return self._reject(o, "no_verified_live_price")
        prob = snap.problem(now, self.cfg)
        if prob:
            return self._reject(o, prob)
        self.note_mark(symbol, snap.mid)

        equity = self.equity()
        if side == "buy":
            ref = {"market": snap.ask, "limit": limit_price, "stop": max(snap.ask, trigger_price or 0), "take_profit": snap.ask}[order_type]
            if order_type == "limit":
                ref = limit_price
            notional = qty * ref
            if notional < self.cfg.min_notional:
                return self._reject(o, "below_min_notional")
            if notional > equity * self.cfg.max_order_pct / 100.0:
                return self._reject(o, "order_exceeds_max_order_pct")
            held_value = self.held_qty(symbol) * snap.mid
            if held_value + notional > equity * self.cfg.max_position_pct / 100.0:
                return self._reject(o, "position_limit_exceeded")
            if self.held_qty(symbol) <= EPS and self.open_positions() >= self.cfg.max_open_positions:
                return self._reject(o, "max_open_positions_reached")
            fee_bps = self.cfg.taker_fee_bps + self.cfg.reserve_buffer_bps
            need = notional * (1 + fee_bps / 1e4)
            if need > self.available_cash() + EPS:
                return self._reject(o, "insufficient_balance")
            o.reserved_cash, o.reserve_per_unit = need, need / qty
        else:
            if qty * snap.bid < self.cfg.min_notional and qty < self.held_qty(symbol) - EPS:
                return self._reject(o, "below_min_notional")
            avail = self.available_qty(symbol) if not _oco_group else max(self.held_qty(symbol) - self.reserved_qty(symbol, _oco_group), 0.0)
            if qty > avail + EPS:
                return self._reject(o, "insufficient_holdings")
        if order_type in ("stop", "take_profit"):
            if self._trigger_hit(o, snap):
                return self._reject(o, "trigger_already_hit")
        self.orders[o.id] = o
        self._log("order_accepted", o.id, symbol=symbol, side=side, type=order_type, qty=qty, limit_price=limit_price, trigger_price=trigger_price)
        fills = self._work(o, snap, arriving=True)
        return {"accepted": True, "duplicate": False, "reasons": [], "order": o.to_dict(), "fills": fills}

    def submit_oco(self, *, symbol: str, qty: float, stop_price: float, take_profit_price: float, snap: Optional[Snapshot],
                   client_order_id: Optional[str] = None, strategy: str = "manual", thesis: Optional[str] = None) -> dict:
        """Protective exit pair on existing holdings: when one leg fills the other shrinks/cancels."""
        symbol = symbol.strip().upper()
        if not (_fin(stop_price) and _fin(take_profit_price) and 0 < stop_price < take_profit_price):
            o = PaperOrder(id=self._next_id(), client_order_id=client_order_id or f"cli-{uuid.uuid4().hex[:16]}", symbol=symbol, side="sell",
                           type="stop", qty=float(qty) if _fin(qty) else 0.0, created_at=_iso(self.clock()), updated_at=_iso(self.clock()))
            return {"accepted": False, "orders": [self._reject(o, "invalid_oco_prices")["order"]], "reasons": ["invalid_oco_prices"]}
        gid = f"oco-{uuid.uuid4().hex[:10]}"
        base = client_order_id or f"cli-{uuid.uuid4().hex[:12]}"
        r1 = self.submit(symbol=symbol, side="sell", qty=qty, order_type="stop", trigger_price=stop_price, client_order_id=base + "-sl",
                         strategy=strategy, thesis=thesis, snap=snap, _oco_group=gid, _skip_dupe_check=True)
        if not r1["accepted"]:
            return {"accepted": False, "orders": [r1["order"]], "reasons": r1["reasons"], "oco_group": gid}
        r2 = self.submit(symbol=symbol, side="sell", qty=qty, order_type="take_profit", trigger_price=take_profit_price, client_order_id=base + "-tp",
                         strategy=strategy, thesis=thesis, snap=snap, _oco_group=gid, _skip_dupe_check=True)
        if not r2["accepted"]:
            self.cancel(r1["order"]["id"], reason="oco_sibling_rejected")
            return {"accepted": False, "orders": [r1["order"], r2["order"]], "reasons": r2["reasons"], "oco_group": gid}
        return {"accepted": True, "orders": [r1["order"], r2["order"]], "reasons": [], "oco_group": gid}

    def preview(self, **kw: Any) -> dict:
        """Dry run on a copy of the account: exact validation + fill estimate, nothing persisted."""
        sim = self.clone()
        cash0 = sim.cash
        kw = {**kw, "client_order_id": None}
        res = sim.submit(**kw)
        sim.drain_audit()
        fills = res["fills"]
        qty = sum(f["qty"] for f in fills)
        out = {"would_accept": res["accepted"], "reasons": res["reasons"], "order_status": res["order"]["status"],
               "estimated_fill_qty": qty, "estimated_avg_price": (sum(f["qty"] * f["price"] for f in fills) / qty) if qty else None,
               "estimated_fees": sum(f["fee"] for f in fills), "estimated_slippage_bps": (sum(f["qty"] * f["slippage_bps"] for f in fills) / qty) if qty else None,
               "partial": 0 < qty < res["order"]["qty"] - EPS, "liquidity_known": all(f["liquidity_known"] for f in fills) if fills else None,
               "cash_before": cash0, "cash_after": sim.cash, "reserved_cash_after": sim.reserved_cash(),
               "available_cash_before": self.available_cash(), "available_qty_before": self.available_qty(str(kw.get("symbol", "")).upper()),
               "rests_on_book": res["order"]["status"] in WORKING}
        return out

    # ------------------------------------------------------------------ cancel / expire
    def _release(self, o: PaperOrder) -> None:
        o.reserved_cash = 0.0

    def cancel(self, order_id: str, reason: str = "user_cancel") -> dict:
        o = self.orders.get(order_id)
        if o is None:
            return {"ok": False, "reason": "unknown_order"}
        if not o.working:
            return {"ok": False, "reason": "already_closed", "order": o.to_dict()}
        o.status, o.reason, o.updated_at = "canceled", reason, _iso(self.clock())
        self._release(o)
        self._log("order_canceled", o.id, reason=reason, filled_qty=o.filled_qty)
        return {"ok": True, "order": o.to_dict()}

    def cancel_all(self, symbol: Optional[str] = None) -> int:
        n = 0
        for o in list(self.orders.values()):
            if o.working and (symbol is None or o.symbol == symbol.upper()):
                n += self.cancel(o.id, "cancel_all")["ok"]
        return n

    # ------------------------------------------------------------------ matching
    def process_market(self, snap: Snapshot) -> list[dict]:
        """Advance every working order on this symbol against a new verified quote."""
        now = self.clock()
        if snap.problem(now, self.cfg) or self.kill_switch():
            return []                      # never fill on unverified prices; kill switch freezes execution
        self.note_mark(snap.symbol, snap.mid)
        fills: list[dict] = []
        for o in [x for x in self.orders.values() if x.working and x.symbol == snap.symbol]:
            if o.expire_at and now >= datetime.fromisoformat(o.expire_at):
                o.status, o.reason, o.updated_at = "expired", "expired", _iso(now)
                self._release(o); self._log("order_expired", o.id)
                continue
            fills += self._work(o, snap, arriving=False)
        return fills

    def _work(self, o: PaperOrder, snap: Snapshot, arriving: bool) -> list[dict]:
        if not o.working:
            return []
        if o.type in ("stop", "take_profit") and not o.triggered:
            if not self._trigger_hit(o, snap):
                return []
            o.triggered = True
            self._log("order_triggered", o.id, bid=snap.bid, ask=snap.ask, trigger=o.trigger_price)
        if o.type == "limit":
            return self._fill_limit(o, snap, arriving)
        fills = self._fill_market(o, snap)
        if o.working and o.tif == "ioc":
            o.status, o.reason, o.updated_at = "canceled", "ioc_unfilled_remainder_canceled", _iso(self.clock())
            self._release(o); self._log("order_canceled", o.id, reason=o.reason, filled_qty=o.filled_qty)
        return fills

    def _levels(self, o: PaperOrder, snap: Snapshot) -> tuple[list, bool]:
        lv = snap.asks if o.side == "buy" else snap.bids
        if lv:
            return [(float(p), float(q)) for p, q in lv if _fin(p) and _fin(q) and q > 0], True
        return [((snap.ask if o.side == "buy" else snap.bid), None)], False

    def _fill_market(self, o: PaperOrder, snap: Snapshot) -> list[dict]:
        levels, known = self._levels(o, snap)
        rem = o.remaining
        tq = tn = tslip = 0.0
        for price, qty in levels:
            if rem <= EPS:
                break
            if known:
                take = min(rem, qty * self.cfg.participation)
                impact = self.cfg.impact_bps_full_level * (take / qty)
                slip = self.cfg.base_slippage_bps + impact
            else:
                take, slip = rem, self.cfg.base_slippage_bps + self.cfg.unknown_liquidity_penalty_bps
            if take <= EPS:
                continue
            px = price * (1 + slip / 1e4) if o.side == "buy" else price * (1 - slip / 1e4)
            tq += take; tn += take * px; tslip += take * slip; rem -= take
        if tq <= EPS:
            return []
        return [self._apply_fill(o, tq, tn / tq, "taker", tslip / tq, known)]

    def _fill_limit(self, o: PaperOrder, snap: Snapshot, arriving: bool) -> list[dict]:
        lim = o.limit_price
        marketable = (snap.ask <= lim) if o.side == "buy" else (snap.bid >= lim)
        if not marketable:
            return []
        levels, known = self._levels(o, snap)
        rem = o.remaining; tq = tn = 0.0
        for price, qty in levels:
            if rem <= EPS or (o.side == "buy" and price > lim) or (o.side == "sell" and price < lim):
                break
            take = min(rem, qty * self.cfg.participation) if known else rem
            if take <= EPS:
                continue
            # arriving marketable orders get the book price (taker, price improvement allowed); resting orders fill at their limit (maker)
            px = price if arriving else lim
            tq += take; tn += take * px; rem -= take
        if tq <= EPS:
            return []
        role = "taker" if arriving else "maker"
        return [self._apply_fill(o, tq, tn / tq, role, 0.0, known)]

    def _apply_fill(self, o: PaperOrder, qty: float, price: float, role: str, slip_bps: float, known: bool) -> dict:
        qty = min(qty, o.remaining)
        fee = qty * price * (self.cfg.taker_fee_bps if role == "taker" else self.cfg.maker_fee_bps) / 1e4
        h = self.holdings.setdefault(o.symbol, {"qty": 0.0, "avg_cost": 0.0, "realized_pnl": 0.0, "last_mark": price})
        realized = 0.0
        if o.side == "buy":
            self.cash -= qty * price + fee
            cost = h["qty"] * h["avg_cost"] + qty * price + fee
            h["qty"] += qty
            h["avg_cost"] = cost / h["qty"]
            o.reserved_cash = max(o.reserved_cash - o.reserve_per_unit * qty, 0.0)
        else:
            proceeds = qty * price - fee
            realized = proceeds - qty * h["avg_cost"]
            self.cash += proceeds
            h["qty"] = max(h["qty"] - qty, 0.0)
            h["realized_pnl"] += realized
            self.realized_pnl += realized
            if h["qty"] <= EPS:
                h["qty"], h["avg_cost"] = 0.0, 0.0
        h["last_mark"] = price if h.get("last_mark") is None else h["last_mark"]
        self.fees_paid += fee
        prev_val = (o.avg_fill_price or 0.0) * o.filled_qty
        o.filled_qty += qty
        o.avg_fill_price = (prev_val + qty * price) / o.filled_qty
        o.fees += fee
        now = _iso(self.clock()); o.updated_at = now
        if o.remaining <= EPS:
            o.status, o.filled_qty = "filled", o.qty
            self._release(o)
        else:
            o.status = "partially_filled"
        fill = {"fill_id": f"fil-{self.seq:07d}-{len(self.fills) + 1}", "order_id": o.id, "client_order_id": o.client_order_id, "ts": now,
                "symbol": o.symbol, "side": o.side, "qty": qty, "price": price, "fee": fee, "role": role, "realized_pnl": realized,
                "slippage_bps": slip_bps, "liquidity_known": known, "order_type": o.type}
        self.fills.append(fill)
        self._log("fill", o.id, qty=qty, price=price, fee=fee, role=role, realized_pnl=realized, status=o.status)
        if o.oco_group:
            for sib in self.orders.values():
                if sib.id != o.id and sib.oco_group == o.oco_group and sib.working:
                    sib.qty -= qty
                    if sib.remaining <= EPS:
                        sib.status, sib.reason, sib.updated_at = "canceled", "oco_filled", now
                        self._release(sib); self._log("order_canceled", sib.id, reason="oco_filled")
        return fill

    # ------------------------------------------------------------------ views / admin
    def account_view(self, marks: Optional[dict[str, float]] = None) -> dict:
        marks = marks or {}
        pos, unreal = [], 0.0
        for sym, h in sorted(self.holdings.items()):
            if h["qty"] <= EPS and abs(h["realized_pnl"]) < EPS:
                continue
            mark = marks.get(sym) or h.get("last_mark") or h["avg_cost"]
            if marks.get(sym):
                h["last_mark"] = marks[sym]
            u = h["qty"] * (mark - h["avg_cost"]) if h["qty"] > EPS else 0.0
            unreal += u
            pos.append({"symbol": sym, "qty": h["qty"], "avg_cost": h["avg_cost"], "mark_price": mark, "market_value": h["qty"] * mark,
                        "unrealized_pnl": u, "realized_pnl": h["realized_pnl"], "reserved_qty": self.reserved_qty(sym),
                        "available_qty": self.available_qty(sym), "open": h["qty"] > EPS})
        equity = self.cash + sum(p["market_value"] for p in pos)
        return {"account_id": self.account_id, "execution_mode": "INTERNAL_PAPER", "currency": "USD", "starting_cash": self.starting_cash,
                "cash": self.cash, "reserved_cash": self.reserved_cash(), "available_cash": self.available_cash(), "equity": equity,
                "realized_pnl": self.realized_pnl, "unrealized_pnl": unreal, "total_pnl": equity - self.starting_cash,
                "fees_paid": self.fees_paid, "open_positions": sum(1 for p in pos if p["open"]), "positions": pos,
                "open_orders": sum(1 for o in self.orders.values() if o.working), "fills": len(self.fills)}

    def list_orders(self, status: str = "all") -> list[dict]:
        rows = sorted(self.orders.values(), key=lambda o: o.created_at, reverse=True)
        if status == "open":
            rows = [o for o in rows if o.working]
        elif status == "closed":
            rows = [o for o in rows if not o.working]
        return [o.to_dict() for o in rows]

    def reset(self, starting_cash: Optional[float] = None) -> None:
        sc = float(starting_cash) if starting_cash and _fin(starting_cash) and starting_cash > 0 else self.cfg.starting_cash
        self._log("account_reset", None, previous_equity=self.equity(), new_starting_cash=sc)
        self.starting_cash = self.cash = sc
        self.realized_pnl = self.fees_paid = 0.0
        self.holdings, self.orders, self.fills = {}, {}, []
