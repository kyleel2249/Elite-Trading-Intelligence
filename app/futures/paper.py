"""Futures / perpetuals PAPER simulation (isolated margin, one-way mode). Nothing here touches an exchange account.

What is real and what is simulated
  * Prices come from Binance USD-M futures `premiumIndex` (mark price + last funding rate), fetched by the server.
    The client can never supply a price. If the feed is unreachable the operation is refused; there is no silent fallback.
  * Fills are simulated at mark price +/- slippage with a taker fee. They are not order-book fills.
  * Positions are checked only when mark_account() runs (API call or scheduler), so a stop that triggers between
    checks fills at the next observed price, which can be worse than the stop. Gaps are not hidden.
  * Liquidation uses the calculator's maintenance-margin model (default 0.5% rate unless tiers are supplied): an
    ESTIMATE. On liquidation the isolated margin is lost; the loss never exceeds it and the wallet cannot go negative.
  * Funding is charged for each 8h boundary (00/08/16 UTC) crossed since the last charge, using the feed's last
    funding rate at the time of the check (an approximation of the rates that actually applied).

Account invariant (tested): wallet = starting + realized_pnl - fees_paid - funding_paid.
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Awaitable, Callable, Optional

import httpx
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.futures import calc
from app.futures.calc import CalcError, Inputs, Limits
from app.futures.models import FuturesAccount, FuturesEvent, FuturesPosition

logger = logging.getLogger("eti.futures_paper")

D = Decimal
ZERO = D(0)
ONE = D(1)
BPS = D(10000)
TAKER_FEE = D("0.0005")          # 5 bps per side, an assumption (typical VIP-0 USD-M taker rate)
SLIPPAGE_BPS = D("5")            # per side, an assumption
QTY_STEP = D("0.000001")         # paper precision; real instruments have their own step
STOP_REQUIRED_ABOVE = 20         # capital-protection rule: leverage above this needs a stop-loss
FUNDING_INTERVAL_SECONDS = 8 * 3600
MAX_BALANCE = D(10_000_000)
SYMBOL_RE = re.compile(r"^[A-Z0-9]{3,20}$")
ACCOUNT_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
FAPI = "https://fapi.binance.com"


class PaperError(Exception):
    def __init__(self, status: int, message: str, violations: Optional[list] = None):
        super().__init__(message)
        self.status, self.message, self.violations = status, message, violations


class FeedError(Exception):
    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.message, self.status = message, status


@dataclass
class Quote:
    price: Decimal
    source: str
    funding_rate: Optional[Decimal]
    observed_at: datetime


Feed = Callable[[str], Awaitable[Quote]]


def _now() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _ts(dt: datetime) -> float:
    return dt.replace(tzinfo=timezone.utc).timestamp()


def _fmt(x: Decimal) -> str:
    return format(x.quantize(D("1e-12"), rounding=ROUND_HALF_UP), "f")


def _d(s: Optional[str]) -> Decimal:
    return D(s) if s is not None else ZERO


def _sign(direction: str) -> Decimal:
    return ONE if direction == "long" else -ONE


def funding_intervals_crossed(last: datetime, now: datetime) -> int:
    """Number of 8-hour funding boundaries (00:00, 08:00, 16:00 UTC) in (last, now]."""
    return max(int(_ts(now) // FUNDING_INTERVAL_SECONDS) - int(_ts(last) // FUNDING_INTERVAL_SECONDS), 0)


# ------------------------------------------------------------------------------------------------ price feed

async def binance_perp_feed(symbol: str, transport: Optional[httpx.AsyncBaseTransport] = None) -> Quote:
    try:
        async with httpx.AsyncClient(timeout=10.0, transport=transport) as c:
            r = await c.get(f"{FAPI}/fapi/v1/premiumIndex", params={"symbol": symbol})
    except httpx.HTTPError:
        raise FeedError("Binance futures price feed is unreachable from this server")
    if r.status_code in (451, 403):
        raise FeedError("Binance is refusing requests from this server's location. Run ETI in a region Binance serves.")
    if r.status_code in (400, 404):
        raise FeedError("Unknown perpetual symbol on Binance USD-M futures", 404)
    if r.status_code != 200:
        raise FeedError(f"Binance futures price feed returned HTTP {r.status_code}")
    try:
        j = r.json()
        price = D(str(j["markPrice"]))
        raw_rate = j.get("lastFundingRate")
        rate = D(str(raw_rate)) if raw_rate not in (None, "") else None
    except (KeyError, TypeError, ValueError, ArithmeticError):
        raise FeedError("Binance futures price feed returned an unreadable payload")
    if not price.is_finite() or price <= 0 or (rate is not None and not rate.is_finite()):
        raise FeedError("Binance futures price feed returned an invalid price")
    return Quote(price, "binance_usdm_mark_price", rate, _now())


_feed: Feed = binance_perp_feed


def get_feed() -> Feed:
    return _feed


def set_feed(feed: Optional[Feed]) -> None:
    global _feed
    _feed = feed or binance_perp_feed


# ------------------------------------------------------------------------------------------------ persistence helpers

def _log(db: Session, account_id: str, event: str, position_id: Optional[int] = None, detail: Optional[dict] = None) -> None:
    db.add(FuturesEvent(account_id=account_id, ts=_now(), event=event, position_id=position_id, detail=detail))


def _get_account(db: Session, account_id: str) -> FuturesAccount:
    acct = db.get(FuturesAccount, account_id)
    if acct is None:
        raise PaperError(404, "Unknown futures paper account")
    return acct


def _bump(db: Session, acct: FuturesAccount, *, wallet: Decimal, realized: Decimal, fees: Decimal, funding: Decimal) -> None:
    """Write new account totals only if nobody else changed the account since we read it."""
    v = acct.version
    res = db.execute(update(FuturesAccount).where(FuturesAccount.account_id == acct.account_id, FuturesAccount.version == v)
                     .values(wallet_balance=_fmt(wallet), realized_pnl=_fmt(realized), fees_paid=_fmt(fees),
                             funding_paid=_fmt(funding), version=v + 1, updated_at=_now()))
    if res.rowcount != 1:
        db.rollback()
        raise PaperError(409, "Account was changed concurrently; retry")
    db.refresh(acct)


def _open_positions(db: Session, account_id: str) -> list[FuturesPosition]:
    return list(db.scalars(select(FuturesPosition).where(FuturesPosition.account_id == account_id,
                                                         FuturesPosition.status == "open").order_by(FuturesPosition.id)))


def position_dict(p: FuturesPosition) -> dict[str, Any]:
    return {"id": p.id, "account_id": p.account_id, "symbol": p.symbol, "direction": p.direction, "leverage": p.leverage,
            "margin_mode": p.margin_mode, "status": p.status, "qty": p.qty, "entry_price": p.entry_price,
            "reference_price": p.reference_price, "notional": p.notional, "margin": p.margin, "maintenance_margin_rate": p.mmr,
            "liquidation_price_estimate": p.liq_price, "stop_price": p.stop_price, "take_profit_price": p.take_profit_price,
            "entry_fee": p.entry_fee, "exit_price": p.exit_price, "exit_fee": p.exit_fee, "funding": p.funding,
            "gross_pnl": p.gross_pnl, "realized_pnl_net": p.realized_pnl, "price_source": p.price_source,
            "opened_at": p.opened_at.isoformat(), "closed_at": p.closed_at.isoformat() if p.closed_at else None,
            "close_reason": p.close_reason, "simulated": True}


def account_summary(db: Session, acct: FuturesAccount, prices: Optional[dict[str, Optional[Decimal]]] = None) -> dict[str, Any]:
    prices = prices or {}
    open_ = _open_positions(db, acct.account_id)
    wallet = _d(acct.wallet_balance)
    margin_used = sum((_d(p.margin) for p in open_), ZERO)
    unreal, missing = ZERO, []
    for p in open_:
        px = prices.get(p.symbol)
        if px is None:
            missing.append(p.symbol)
        else:
            unreal += _sign(p.direction) * (px - _d(p.entry_price)) * _d(p.qty)
    complete = not missing
    return {"account_id": acct.account_id, "currency": acct.currency, "simulated": True,
            "starting_balance": acct.starting_balance, "wallet_balance": acct.wallet_balance,
            "margin_in_use": _fmt(margin_used), "available_balance": _fmt(wallet - margin_used),
            "unrealized_pnl": _fmt(unreal) if complete else None,
            "equity": _fmt(wallet + unreal) if complete else None,
            "price_unavailable_for": missing,
            "realized_pnl_gross": acct.realized_pnl, "fees_paid": acct.fees_paid, "funding_paid": acct.funding_paid,
            "open_positions": [position_dict(p) for p in open_], "version": acct.version}


# ------------------------------------------------------------------------------------------------ operations

def create_account(db: Session, account_id: str, starting_balance: Decimal, currency: str = "USDT") -> FuturesAccount:
    if not ACCOUNT_RE.match(account_id or ""):
        raise PaperError(422, "account_id must be 1-64 characters: letters, digits, _ . -")
    if not isinstance(starting_balance, Decimal) or not starting_balance.is_finite() or not ZERO < starting_balance <= MAX_BALANCE:
        raise PaperError(422, f"starting_balance must be greater than 0 and at most {MAX_BALANCE}")
    if db.get(FuturesAccount, account_id) is not None:
        raise PaperError(409, "Account already exists")
    acct = FuturesAccount(account_id=account_id, currency=currency, starting_balance=_fmt(starting_balance),
                          wallet_balance=_fmt(starting_balance), realized_pnl="0", fees_paid="0", funding_paid="0",
                          version=1, created_at=_now(), updated_at=_now())
    db.add(acct)
    _log(db, account_id, "account_created", detail={"starting_balance": _fmt(starting_balance), "currency": currency})
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise PaperError(409, "Account already exists")
    return acct


async def open_position(db: Session, account_id: str, symbol: str, direction: str, capital: Decimal, leverage: int,
                        stop_price: Optional[Decimal] = None, take_profit_price: Optional[Decimal] = None, *,
                        feed: Optional[Feed] = None, kill_switch: bool = False) -> dict[str, Any]:
    symbol = (symbol or "").upper()
    if not SYMBOL_RE.match(symbol):
        raise PaperError(422, "invalid symbol")
    if direction not in ("long", "short"):
        raise PaperError(422, "direction must be 'long' or 'short'")
    if isinstance(leverage, bool) or not isinstance(leverage, int) or not 1 <= leverage <= calc.PLATFORM_MAX_LEVERAGE:
        raise PaperError(422, f"leverage must be an integer from 1 to {calc.PLATFORM_MAX_LEVERAGE}")
    for name, val in (("capital", capital), ("stop_price", stop_price), ("take_profit_price", take_profit_price)):
        if val is not None and (not isinstance(val, Decimal) or not val.is_finite() or val <= 0 or val >= D(10) ** 12):
            raise PaperError(422, f"{name} must be a positive number")
    if kill_switch:
        raise PaperError(409, "Kill switch is active: no new simulated positions")
    acct = _get_account(db, account_id)
    if db.scalar(select(FuturesPosition.id).where(FuturesPosition.account_id == account_id, FuturesPosition.symbol == symbol,
                                                  FuturesPosition.status == "open")) is not None:
        raise PaperError(409, f"{symbol} already has an open position in this account (one-way mode): close it first")
    if leverage > STOP_REQUIRED_ABOVE and stop_price is None:
        raise PaperError(422, f"A stop_price is required above {STOP_REQUIRED_ABOVE}x leverage")

    quote = await (feed or get_feed())(symbol)
    sign = _sign(direction)
    fill = quote.price * (ONE + sign * SLIPPAGE_BPS / BPS)
    wallet = _d(acct.wallet_balance)
    available = wallet - sum((_d(p.margin) for p in _open_positions(db, account_id)), ZERO)

    inp = Inputs(direction=direction, capital=capital, leverage=leverage, entry_price=fill, stop_price=stop_price,
                 take_profit_prices=(take_profit_price,) if take_profit_price is not None else (),
                 taker_fee_rate=TAKER_FEE, slippage_bps=ZERO,   # slippage is already in the fill price
                 available_balance=available, qty_step=QTY_STEP, movements=(ONE,), limits=Limits())
    try:
        res = calc.calculate(inp)
    except CalcError as exc:
        raise PaperError(422, str(exc))
    except ArithmeticError:
        raise PaperError(422, "values are outside the range that can be simulated")
    if not res["valid"]:
        raise PaperError(422, "Order rejected by risk checks", res["violations"])

    qty = D(res["sizing"]["base_quantity"])
    notional = qty * fill
    margin = notional / D(leverage)
    entry_fee = notional * TAKER_FEE
    if margin + entry_fee > available:
        raise PaperError(422, "Insufficient available balance for margin plus entry fee")
    liq_raw = res["liquidation"]["price"]

    pos = FuturesPosition(account_id=account_id, symbol=symbol, direction=direction, leverage=leverage, margin_mode="isolated",
                          status="open", qty=_fmt(qty), entry_price=_fmt(fill), reference_price=_fmt(quote.price),
                          notional=_fmt(notional), margin=_fmt(margin), mmr=res["sizing"]["maintenance_margin_rate"],
                          liq_price=liq_raw, stop_price=_fmt(stop_price) if stop_price is not None else None,
                          take_profit_price=_fmt(take_profit_price) if take_profit_price is not None else None,
                          entry_fee=_fmt(entry_fee), price_source=quote.source, opened_at=_now(), last_funding_at=_now())
    db.add(pos)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise PaperError(409, f"{symbol} already has an open position in this account")
    _bump(db, acct, wallet=wallet - entry_fee, realized=_d(acct.realized_pnl), fees=_d(acct.fees_paid) + entry_fee,
          funding=_d(acct.funding_paid))
    _log(db, account_id, "position_opened", pos.id, {"symbol": symbol, "direction": direction, "leverage": leverage,
                                                      "fill": _fmt(fill), "mark": _fmt(quote.price), "source": quote.source})
    db.commit()
    return {"position": position_dict(pos), "simulated": True,
            "liquidation": res["liquidation"], "risk": res["risk"],
            "assumptions": ["Fill = mark price +/- 5 bps slippage; taker fee 5 bps per side (assumptions).",
                            f"Maintenance margin rate {res['sizing']['maintenance_margin_rate']} ({res['sizing']['maintenance_margin_source']}); liquidation price is an estimate.",
                            "Isolated margin, one-way mode. Cross margin is not simulated."]}


def _decide(pos: FuturesPosition, price: Decimal) -> Optional[str]:
    long = pos.direction == "long"
    if pos.liq_price is not None:
        liq = _d(pos.liq_price)
        if (long and price <= liq) or (not long and price >= liq):
            return "liquidated"
    if pos.stop_price is not None:
        sp = _d(pos.stop_price)
        if (long and price <= sp) or (not long and price >= sp):
            return "stop_loss"
    if pos.take_profit_price is not None:
        tp = _d(pos.take_profit_price)
        if (long and price >= tp) or (not long and price <= tp):
            return "take_profit"
    return None


def _close(db: Session, acct: FuturesAccount, pos: FuturesPosition, price: Decimal, reason: str) -> dict[str, Any]:
    sign = _sign(pos.direction)
    qty, entry, margin = _d(pos.qty), _d(pos.entry_price), _d(pos.margin)
    if reason == "liquidated":
        gross, exit_fee, exit_px, status = -margin, ZERO, price, "liquidated"   # isolated: the margin is lost, never more
    else:
        exit_px = price * (ONE - sign * SLIPPAGE_BPS / BPS)
        gross = sign * (exit_px - entry) * qty
        exit_fee = qty * exit_px * TAKER_FEE
        status = "closed"
    net = gross - _d(pos.entry_fee) - exit_fee - _d(pos.funding)
    pos.status, pos.exit_price, pos.exit_fee = status, _fmt(exit_px), _fmt(exit_fee)
    pos.gross_pnl, pos.realized_pnl = _fmt(gross), _fmt(net)
    pos.closed_at, pos.close_reason = _now(), reason
    _bump(db, acct, wallet=_d(acct.wallet_balance) + gross - exit_fee, realized=_d(acct.realized_pnl) + gross,
          fees=_d(acct.fees_paid) + exit_fee, funding=_d(acct.funding_paid))
    _log(db, acct.account_id, "position_" + status, pos.id, {"reason": reason, "observed_mark": _fmt(price), "exit": _fmt(exit_px),
                                                              "gross_pnl": _fmt(gross), "net_pnl": _fmt(net)})
    return {"symbol": pos.symbol, "action": reason, "status": status, "observed_mark": _fmt(price), "exit_price": _fmt(exit_px),
            "gross_pnl": _fmt(gross), "net_pnl": _fmt(net)}


async def close_position(db: Session, account_id: str, symbol: str, *, feed: Optional[Feed] = None) -> dict[str, Any]:
    symbol = (symbol or "").upper()
    acct = _get_account(db, account_id)
    pos = db.scalar(select(FuturesPosition).where(FuturesPosition.account_id == account_id, FuturesPosition.symbol == symbol,
                                                  FuturesPosition.status == "open"))
    if pos is None:
        raise PaperError(404, f"No open {symbol} position in this account")
    quote = await (feed or get_feed())(symbol)
    reason = "liquidated" if _decide(pos, quote.price) == "liquidated" else "manual"
    out = _close(db, acct, pos, quote.price, reason)
    db.commit()
    return out


async def mark_account(db: Session, account_id: str, *, feed: Optional[Feed] = None) -> dict[str, Any]:
    """Re-price every open position; charge funding; trigger stop / take-profit / liquidation. A position whose price
    cannot be fetched is left untouched and reported, never guessed."""
    acct = _get_account(db, account_id)
    feed = feed or get_feed()
    out: dict[str, Any] = {"account_id": account_id, "checked": 0, "actions": [], "errors": []}
    for pos in _open_positions(db, account_id):
        try:
            q = await feed(pos.symbol)
        except FeedError as exc:
            out["errors"].append({"symbol": pos.symbol, "error": exc.message})
            continue
        out["checked"] += 1
        n = funding_intervals_crossed(pos.last_funding_at, q.observed_at)
        if n > 0:
            if q.funding_rate is None:
                out["errors"].append({"symbol": pos.symbol, "error": "funding rate unavailable; funding not charged yet"})
            else:
                charge = _d(pos.qty) * q.price * q.funding_rate * D(n) * _sign(pos.direction)   # positive = this side pays
                _bump(db, acct, wallet=_d(acct.wallet_balance) - charge, realized=_d(acct.realized_pnl),
                      fees=_d(acct.fees_paid), funding=_d(acct.funding_paid) + charge)
                pos.funding = _fmt(_d(pos.funding) + charge)
                pos.last_funding_at = q.observed_at
                _log(db, account_id, "funding_charged", pos.id, {"intervals": n, "rate": str(q.funding_rate), "charge": _fmt(charge)})
                out["actions"].append({"symbol": pos.symbol, "action": "funding", "intervals": n, "charge": _fmt(charge)})
        action = _decide(pos, q.price)
        if action:
            out["actions"].append(_close(db, acct, pos, q.price, action))
        db.commit()
    return out


async def current_prices(symbols: list[str], feed: Optional[Feed] = None) -> dict[str, Optional[Decimal]]:
    feed = feed or get_feed()
    prices: dict[str, Optional[Decimal]] = {}
    for s in symbols:
        try:
            prices[s] = (await feed(s)).price
        except FeedError:
            prices[s] = None
    return prices
