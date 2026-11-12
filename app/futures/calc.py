"""Futures / perpetual position calculator.

Pure Decimal arithmetic. No network, no database, no order placement: it computes what a proposed position
would look like (sizing, margin, P&L, costs, liquidation estimate, risk) and which rules it breaks.

Distinctions kept explicit everywhere:
  capital   = funds the trader chooses to allocate
  margin    = collateral committed to the position (notional / leverage, after quantity rounding)
  notional  = total leveraged exposure
  quantity  = contracts (or base units) actually orderable after step / contract rounding

Liquidation prices here are ESTIMATES from a standard maintenance-margin model. They are never authoritative:
the exchange's own risk engine decides. Exchange limits (max leverage, tiers, tick/step) must be supplied by the
caller from the exchange; nothing is hard-coded except the platform ceiling of 150x.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP
from typing import Any, Optional, Sequence

D = Decimal
ZERO = D(0)
ONE = D(1)
BPS = D(10000)
HUNDRED = D(100)
MAX_ABS = D(10) ** 15

PLATFORM_MAX_LEVERAGE = 150
PRESET_LEVERAGE = (1, 2, 3, 5, 10, 15, 20, 25, 50, 75, 100, 125, 150)
MOVEMENT_PRESETS = tuple(D(x) for x in ("0.1", "0.25", "0.5", "0.75", "1", "1.5", "2", "3", "5", "10"))
DEFAULT_MMR = D("0.005")  # ASSUMED when the caller supplies neither tiers nor a rate
EXPOSURE_PRESETS_PCT = {"conservative": D(10), "moderate": D(25), "aggressive": D(50)}
MAX_LEGS = 20


class CalcError(ValueError):
    """Invalid input: the calculation cannot be performed."""


@dataclass
class MarginTier:
    mmr: Decimal                       # maintenance margin rate for this bracket (fraction, 0.005 = 0.5%)
    notional_cap: Optional[Decimal] = None  # bracket applies while notional <= cap; None = unbounded
    cum: Decimal = ZERO                # maintenance amount (exchange "cum" / offset), settle currency
    max_leverage: Optional[int] = None


@dataclass
class Limits:
    platform_max_leverage: int = PLATFORM_MAX_LEVERAGE
    exchange_max_leverage: Optional[int] = None   # from the instrument; None = not verified
    account_max_leverage: Optional[int] = None    # from the account / permissions
    policy_max_leverage: Optional[int] = None     # administrator policy
    min_risk_reward: Optional[Decimal] = None
    min_liquidation_distance_pct: Optional[Decimal] = None


@dataclass
class Inputs:
    direction: str                      # long | short
    capital: Decimal                    # settle currency (coin for inverse)
    leverage: int
    entry_price: Decimal
    contract_type: str = "linear"       # linear | inverse
    settle_currency: str = "USDT"
    margin_mode: str = "isolated"       # isolated | cross
    exit_price: Optional[Decimal] = None
    move_pct: Optional[Decimal] = None  # favourable expected movement, percent (negative = adverse)
    stop_price: Optional[Decimal] = None
    take_profit_prices: Sequence[Decimal] = ()
    entry_liquidity: str = "taker"
    exit_liquidity: str = "taker"
    taker_fee_rate: Decimal = D("0.0005")   # ASSUMPTION unless supplied from the account's fee tier
    maker_fee_rate: Decimal = D("0.0002")
    slippage_bps: Decimal = D("5")          # per taker side; ASSUMPTION unless measured from the order book
    funding_rate: Decimal = ZERO            # per interval, fraction; positive = longs pay shorts
    funding_intervals: Decimal = ZERO
    maintenance_margin_rate: Optional[Decimal] = None
    tiers: Sequence[MarginTier] = ()
    extra_margin: Decimal = ZERO            # isolated: margin added on top of initial margin
    cross_wallet_balance: Optional[Decimal] = None
    cross_other_maintenance: Decimal = ZERO
    mark_price: Optional[Decimal] = None
    available_balance: Optional[Decimal] = None
    contract_multiplier: Decimal = ONE      # linear: base units per contract
    contract_value: Decimal = ONE           # inverse: USD per contract
    tick_size: Optional[Decimal] = None
    qty_step: Optional[Decimal] = None
    min_qty: Optional[Decimal] = None
    min_notional: Optional[Decimal] = None
    correlation_group: Optional[str] = None
    limits: Limits = field(default_factory=Limits)
    movements: Sequence[Decimal] = MOVEMENT_PRESETS


# ----------------------------------------------------------------------------------------------- helpers

def _s(x: Optional[Decimal], dp: int = 8) -> Optional[str]:
    if x is None:
        return None
    return format(x.quantize(D(1).scaleb(-dp), rounding=ROUND_HALF_UP), "f")


def _round_down(x: Decimal, step: Optional[Decimal]) -> Decimal:
    if step is None:
        return x
    return (x / step).to_integral_value(rounding=ROUND_DOWN) * step


def _on_grid(x: Decimal, step: Optional[Decimal]) -> bool:
    if step is None:
        return True
    q = x / step
    return q == q.to_integral_value()


def _check(x: Optional[Decimal], name: str, *, positive: bool = False, nonneg: bool = False) -> None:
    if x is None:
        return
    if not isinstance(x, Decimal) or not x.is_finite():
        raise CalcError(f"{name} must be a finite number")
    if abs(x) >= MAX_ABS:
        raise CalcError(f"{name} is out of range")
    if positive and x <= 0:
        raise CalcError(f"{name} must be greater than zero")
    if nonneg and x < 0:
        raise CalcError(f"{name} must not be negative")


def _validate(i: Inputs) -> None:
    if i.direction not in ("long", "short"):
        raise CalcError("direction must be 'long' or 'short'")
    if i.contract_type not in ("linear", "inverse"):
        raise CalcError("contract_type must be 'linear' or 'inverse'")
    if i.margin_mode not in ("isolated", "cross"):
        raise CalcError("margin_mode must be 'isolated' or 'cross'")
    if i.entry_liquidity not in ("taker", "maker") or i.exit_liquidity not in ("taker", "maker"):
        raise CalcError("liquidity must be 'taker' or 'maker'")
    if isinstance(i.leverage, bool) or not isinstance(i.leverage, int) or not 1 <= i.leverage <= PLATFORM_MAX_LEVERAGE:
        raise CalcError(f"leverage must be an integer from 1 to {PLATFORM_MAX_LEVERAGE}")
    for name in ("capital", "entry_price", "contract_multiplier", "contract_value"):
        _check(getattr(i, name), name, positive=True)
    for name in ("exit_price", "stop_price", "mark_price", "tick_size", "qty_step", "min_qty", "min_notional"):
        _check(getattr(i, name), name, positive=True)
    for name in ("extra_margin", "cross_other_maintenance", "available_balance", "cross_wallet_balance", "funding_intervals"):
        _check(getattr(i, name), name, nonneg=True)
    for name in ("taker_fee_rate", "maker_fee_rate"):
        _check(getattr(i, name), name, nonneg=True)
        if getattr(i, name) >= D("0.1"):
            raise CalcError(f"{name} must be below 0.1 (10%)")
    _check(i.slippage_bps, "slippage_bps", nonneg=True)
    if i.slippage_bps > 1000:
        raise CalcError("slippage_bps must be at most 1000")
    _check(i.funding_rate, "funding_rate")
    if abs(i.funding_rate) >= D("0.1"):
        raise CalcError("funding_rate must be below 10% per interval")
    if i.funding_intervals > 10000:
        raise CalcError("funding_intervals is out of range")
    _check(i.move_pct, "move_pct")
    if i.move_pct is not None and not (D("-99.99") <= i.move_pct <= D(1000)):
        raise CalcError("move_pct must be between -99.99 and 1000")
    if i.maintenance_margin_rate is not None:
        _check(i.maintenance_margin_rate, "maintenance_margin_rate", nonneg=True)
        if i.maintenance_margin_rate >= 1:
            raise CalcError("maintenance_margin_rate must be below 1")
    for t in i.tiers:
        _check(t.mmr, "tier mmr", nonneg=True)
        if t.mmr >= 1:
            raise CalcError("tier mmr must be below 1")
        _check(t.cum, "tier cum", nonneg=True)
        _check(t.notional_cap, "tier notional_cap", positive=True)
    if len(i.take_profit_prices) > 5:
        raise CalcError("at most 5 take-profit prices")
    for tp in i.take_profit_prices:
        _check(tp, "take_profit_price", positive=True)
    for m in i.movements:
        _check(m, "movement", positive=True)
        if m > 100:
            raise CalcError("movement percentages must be at most 100")
    if len(i.movements) > 30:
        raise CalcError("at most 30 movement scenarios")


def _find_tier(tiers: Sequence[MarginTier], notional: Decimal) -> Optional[MarginTier]:
    ordered = sorted(tiers, key=lambda t: (t.notional_cap is None, t.notional_cap or ZERO))
    for t in ordered:
        if t.notional_cap is None or notional <= t.notional_cap:
            return t
    return None


_RANK = {"low": 0, "moderate": 1, "high": 2, "extreme": 3}
_NAME = {v: k for k, v in _RANK.items()}


# ----------------------------------------------------------------------------------------------- core

def calculate(inp: Inputs) -> dict[str, Any]:
    _validate(inp)
    long = inp.direction == "long"
    sign = ONE if long else -ONE
    inverse = inp.contract_type == "inverse"
    lev = D(inp.leverage)
    entry = inp.entry_price
    violations: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []

    def bad(code: str, message: str) -> None:
        violations.append({"code": code, "message": message})

    def warn(code: str, message: str) -> None:
        warnings.append({"code": code, "message": message})

    mdp = 8 if inverse else 2  # display precision of settle-currency amounts

    # ---- leverage limits: the lowest applicable limit wins
    lim = inp.limits
    caps = [("platform", min(lim.platform_max_leverage, PLATFORM_MAX_LEVERAGE))]
    for name, val in (("exchange", lim.exchange_max_leverage), ("account", lim.account_max_leverage), ("policy", lim.policy_max_leverage)):
        if val is not None:
            caps.append((name, val))
    cap_src, cap_val = min(caps, key=lambda t: t[1])
    if inp.leverage > cap_val:
        bad("leverage_exceeds_limit", f"{inp.leverage}x exceeds the {cap_src} maximum of {cap_val}x")
    if lim.exchange_max_leverage is None:
        warn("leverage_unverified", "Exchange/instrument maximum leverage was not supplied: this leverage is NOT verified against the exchange.")

    # ---- sizing
    if inverse:
        contracts = _round_down(inp.capital * lev * entry / inp.contract_value, D(1))
        qty = _round_down(contracts, inp.qty_step) if inp.qty_step else contracts
        notional = qty * inp.contract_value                  # USD
        margin = notional / (entry * lev)                    # coin
        base_qty = None
    else:
        raw = inp.capital * lev / (entry * inp.contract_multiplier)
        qty = _round_down(raw, inp.qty_step)
        base_qty = qty * inp.contract_multiplier
        notional = base_qty * entry
        margin = notional / lev
    if qty <= 0:
        raise CalcError("capital is too small for one order step at this leverage and price")
    if inp.min_qty is not None and qty < inp.min_qty:
        bad("below_min_quantity", f"quantity {_s(qty)} is below the minimum {_s(inp.min_qty)}")
    if inp.min_notional is not None and notional < inp.min_notional:
        bad("below_min_notional", f"notional {_s(notional, 2)} is below the minimum {_s(inp.min_notional, 2)}")

    # ---- maintenance margin parameters
    tier = _find_tier(inp.tiers, notional) if inp.tiers else None
    if inp.tiers and tier is None:
        bad("notional_exceeds_tiers", "Position notional is above the largest supplied margin tier.")
    if tier is not None:
        mmr, cum, mm_src = tier.mmr, tier.cum, "supplied_tier_table"
        if tier.max_leverage is not None and inp.leverage > tier.max_leverage:
            bad("leverage_exceeds_limit", f"{inp.leverage}x exceeds the risk-tier maximum of {tier.max_leverage}x for this notional")
    elif inp.maintenance_margin_rate is not None:
        mmr, cum, mm_src = inp.maintenance_margin_rate, ZERO, "supplied_flat_rate"
    else:
        mmr, cum, mm_src = DEFAULT_MMR, ZERO, "assumed_default"
        warn("mmr_assumed", "No maintenance-margin rate or tiers supplied: a 0.5% rate is ASSUMED. Real exchange tiers differ.")
    maintenance = max(notional / entry * mmr, ZERO) if inverse else max(notional * mmr - cum, ZERO)

    # ---- price grid
    for label, price in (("entry_price", entry), ("exit_price", inp.exit_price), ("stop_price", inp.stop_price)):
        if price is not None and not _on_grid(price, inp.tick_size):
            bad("price_not_on_tick", f"{label} {_s(price)} is not a multiple of the tick size {_s(inp.tick_size)} (it will not be rounded for you)")
    for tp in inp.take_profit_prices:
        if not _on_grid(tp, inp.tick_size):
            bad("price_not_on_tick", f"take_profit {_s(tp)} is not a multiple of the tick size {_s(inp.tick_size)}")

    # ---- per-price P&L model
    rate_e = inp.maker_fee_rate if inp.entry_liquidity == "maker" else inp.taker_fee_rate
    rate_x = inp.maker_fee_rate if inp.exit_liquidity == "maker" else inp.taker_fee_rate
    slip_e = inp.slippage_bps if inp.entry_liquidity == "taker" else ZERO
    slip_x = inp.slippage_bps if inp.exit_liquidity == "taker" else ZERO

    def pnl(px: Decimal) -> dict[str, Decimal]:
        if inverse:
            gross = sign * notional * (ONE / entry - ONE / px)
            ef, xf = notional / entry * rate_e, notional / px * rate_x
            es, xs = notional / entry * slip_e / BPS, notional / px * slip_x / BPS
            fund = notional / entry * inp.funding_rate * inp.funding_intervals * sign
        else:
            gross = sign * (px - entry) * base_qty
            ef, xf = base_qty * entry * rate_e, base_qty * px * rate_x
            es, xs = base_qty * entry * slip_e / BPS, base_qty * px * slip_x / BPS
            fund = notional * inp.funding_rate * inp.funding_intervals * sign
        net = gross - ef - xf - es - xs - fund
        return {"gross": gross, "entry_fee": ef, "exit_fee": xf, "slippage": es + xs, "funding": fund,
                "costs": ef + xf + es + xs + fund, "net": net, "rom": net / margin * HUNDRED}

    def pnl_out(px: Decimal) -> dict[str, Any]:
        p = pnl(px)
        return {"price": _s(px), "gross_pnl": _s(p["gross"], mdp), "entry_fee": _s(p["entry_fee"], mdp),
                "exit_fee": _s(p["exit_fee"], mdp), "slippage": _s(p["slippage"], mdp), "funding": _s(p["funding"], mdp),
                "total_costs": _s(p["costs"], mdp), "net_pnl": _s(p["net"], mdp),
                "return_on_margin_pct": _s(p["rom"], 2),
                "gross_return_on_margin_pct": _s(p["gross"] / margin * HUNDRED, 2)}

    # ---- liquidation estimate
    liq: Optional[Decimal] = None
    liq_status, liq_reason = "estimated", None
    if inp.margin_mode == "cross":
        if inp.cross_wallet_balance is None:
            liq_status, liq_reason = "unavailable", "Cross margin liquidation depends on the whole account; supply cross_wallet_balance."
            wb = None
        else:
            wb = inp.cross_wallet_balance - inp.cross_other_maintenance
            warn("cross_estimate", "Cross-margin estimate assumes other positions stay static; the exchange decides at account level.")
    else:
        wb = margin + inp.extra_margin
    if wb is not None:
        if inverse:
            if long:
                liq = notional * (ONE + mmr) / (wb + notional / entry)
            else:
                den = notional / entry - wb
                liq = notional * (ONE - mmr) / den if den > 0 else None
        else:
            if long:
                liq = (notional - wb - cum) / (base_qty * (ONE - mmr))
            else:
                liq = (notional + wb + cum) / (base_qty * (ONE + mmr))
        if liq is not None and liq <= 0:
            liq = None
        if liq is None:
            liq_status, liq_reason = "not_reachable", "Collateral covers the position at any positive price (estimate)."
    if liq is not None:
        if (long and liq >= entry) or (not long and liq <= entry):
            bad("liquidation_at_or_beyond_entry",
                f"Estimated liquidation ({_s(liq)}) is at or beyond the entry price: the position would be liquidated immediately at this leverage.")
    dist_entry = abs(entry - liq) / entry * HUNDRED if liq is not None else None
    dist_mark = abs(inp.mark_price - liq) / inp.mark_price * HUNDRED if (liq is not None and inp.mark_price) else None
    if lim.min_liquidation_distance_pct is not None and dist_entry is not None and dist_entry < lim.min_liquidation_distance_pct:
        bad("liquidation_too_close", f"Liquidation is {_s(dist_entry, 2)}% from entry; policy minimum is {_s(lim.min_liquidation_distance_pct, 2)}%")

    # ---- target / stop / take-profit
    target_price = inp.exit_price
    if target_price is None and inp.move_pct is not None:
        target_price = entry * (ONE + sign * inp.move_pct / HUNDRED)
    if target_price is not None and target_price <= 0:
        raise CalcError("target price must be greater than zero")
    target = None
    if target_price is not None:
        target = pnl_out(target_price)
        target["move_pct"] = _s((target_price - entry) / entry * HUNDRED * sign, 4)

    stop_out = None
    if inp.stop_price is not None:
        sp = inp.stop_price
        if (long and sp >= entry) or (not long and sp <= entry):
            bad("stop_wrong_side", "Stop-loss must be below entry for a long and above entry for a short.")
        if liq is not None and ((long and sp <= liq) or (not long and sp >= liq)):
            bad("stop_beyond_liquidation", f"Stop-loss {_s(sp)} would not trigger before the estimated liquidation price {_s(liq)}.")
        stop_out = pnl_out(sp)

    tps = []
    for tp in inp.take_profit_prices:
        if (long and tp <= entry) or (not long and tp >= entry):
            bad("take_profit_wrong_side", "Take-profit must be above entry for a long and below entry for a short.")
        tps.append(pnl_out(tp))

    rr = None
    ref_price = inp.take_profit_prices[0] if inp.take_profit_prices else target_price
    if inp.stop_price is not None and ref_price is not None:
        reward, risk = pnl(ref_price), pnl(inp.stop_price)
        if risk["gross"] < 0 and reward["gross"] > 0:
            g = reward["gross"] / -risk["gross"]
            n = reward["net"] / -risk["net"] if risk["net"] < 0 else None
            rr = {"gross": _s(g, 2), "net_of_costs": _s(n, 2) if n is not None else None}
            basis = n if n is not None else g
            if lim.min_risk_reward is not None and basis < lim.min_risk_reward:
                bad("risk_reward_too_low", f"Risk/reward {_s(basis, 2)} is below the policy minimum {_s(lim.min_risk_reward, 2)}")

    # ---- balance
    required = margin + pnl(entry)["entry_fee"]
    balance = None
    if inp.available_balance is not None:
        after = inp.available_balance - required
        balance = {"available": _s(inp.available_balance, mdp), "required_margin_plus_entry_fee": _s(required, mdp),
                   "available_after": _s(after, mdp)}
        if after < 0:
            bad("insufficient_balance", f"Required {_s(required, mdp)} exceeds available balance {_s(inp.available_balance, mdp)}")

    # ---- risk classification
    rank = 0
    if inp.leverage >= 100:
        rank = 3
    elif inp.leverage >= 50:
        rank = 2
    elif inp.leverage >= 10:
        rank = 1
    if dist_entry is not None:
        rank = max(rank, 3 if dist_entry < 1 else 2 if dist_entry < 3 else 1 if dist_entry < 10 else 0)
    if inp.leverage >= 100:
        approx = _s(dist_entry, 2) if dist_entry is not None else "a very small"
        warn("extreme_leverage", f"{inp.leverage}x is extreme leverage: liquidation is about {approx}% from entry (estimate). "
                                  "Fees, slippage, funding or a brief wick can wipe out the margin.")
    if inp.contract_type == "linear" and inp.slippage_bps >= 50:
        warn("high_slippage_assumption", "Slippage assumption is 50 bps or more per side.")

    # ---- scenarios: favourable / adverse price moves relative to the position
    scenarios = []
    for m in sorted(set(inp.movements)):
        for side_name, k in (("favourable", ONE), ("adverse", -ONE)):
            px = entry * (ONE + sign * k * m / HUNDRED)
            if px <= 0:
                continue
            p = pnl(px)
            liquidated = liq is not None and ((long and px <= liq) or (not long and px >= liq))
            net, rom = p["net"], p["rom"]
            if liquidated and inp.margin_mode == "isolated":
                net, rom = -(margin + inp.extra_margin), -HUNDRED * (margin + inp.extra_margin) / margin
            scenarios.append({"movement_pct": _s(m, 4), "side": side_name, "price": _s(px),
                              "gross_pnl": _s(p["gross"], mdp), "net_pnl": _s(net, mdp),
                              "return_on_margin_pct": _s(rom, 2), "liquidated": liquidated})

    return {
        "valid": not violations,
        "read_only": True,
        "instrument": {"contract_type": inp.contract_type, "settle_currency": inp.settle_currency,
                       "direction": inp.direction, "margin_mode": inp.margin_mode},
        "sizing": {"capital": _s(inp.capital, mdp), "leverage": inp.leverage,
                   "effective_max_leverage": cap_val, "effective_max_leverage_source": cap_src,
                   "notional": _s(notional, 2 if not inverse else 2), "notional_currency": "USD" if inverse else inp.settle_currency,
                   "quantity": _s(qty), "base_quantity": _s(base_qty) if base_qty is not None else None,
                   "initial_margin": _s(margin, mdp), "unused_capital": _s(inp.capital - margin, mdp),
                   "maintenance_margin": _s(maintenance, mdp), "maintenance_margin_source": mm_src,
                   "maintenance_margin_rate": _s(mmr, 6)},
        "entry": {"requested_price": _s(entry),
                  "estimated_fill_price": _s(entry * (ONE + sign * slip_e / BPS)),
                  "note": "Estimated fill is an assumption from slippage_bps, not a confirmed fill."},
        "target": target,
        "stop_loss": stop_out,
        "take_profits": tps,
        "risk_reward": rr,
        "liquidation": {"price": _s(liq), "status": liq_status, "reason": liq_reason,
                        "distance_pct_from_entry": _s(dist_entry, 4), "distance_pct_from_mark": _s(dist_mark, 4),
                        "authoritative": False,
                        "note": "Estimate from a standard maintenance-margin model; the exchange's own liquidation price governs."},
        "balance": balance,
        "risk": {"class": _NAME[rank], "warnings": warnings},
        "scenarios": scenarios,
        "violations": violations,
        "assumptions": {"constant_notional": True, "fee_rates_supplied_by_caller": True,
                        "funding_applied_at_entry_notional": True,
                        "loss_capped_at_isolated_margin_in_liquidated_rows": True},
    }


# ----------------------------------------------------------------------------------------------- allocation

def _cents(x: Decimal) -> Decimal:
    # quantize so the exponent is always -2 (a bare product/division can otherwise print as "2500" rather than "2500.00")
    return _round_down(x, D("0.01")).quantize(D("0.01"))


def allocate_capital(total: Decimal, method: str, count: int, weights: Optional[Sequence[Decimal]] = None,
                     risks: Optional[Sequence[Decimal]] = None) -> list[Decimal]:
    """Split capital across legs. The result never sums to more than `total`."""
    _check(total, "total", positive=True)
    if not 1 <= count <= MAX_LEGS:
        raise CalcError(f"count must be between 1 and {MAX_LEGS}")
    if method == "equal":
        return [_cents(total / count)] * count
    if method == "percentage":
        if weights is None or len(weights) != count:
            raise CalcError("percentage allocation needs one percentage per leg")
        for w in weights:
            _check(w, "percentage", nonneg=True)
        if sum(weights) > 100:
            raise CalcError("percentages sum to more than 100")
        return [_cents(total * w / HUNDRED) for w in weights]
    if method == "manual":
        if weights is None or len(weights) != count:
            raise CalcError("manual allocation needs one amount per leg")
        for w in weights:
            _check(w, "amount", nonneg=True)
        if sum(weights) > total:
            raise CalcError("manual amounts exceed the available capital")
        return [_cents(w) for w in weights]
    if method == "risk_weighted":
        if risks is None or len(risks) != count:
            raise CalcError("risk-weighted allocation needs one risk figure (e.g. stop distance %) per leg")
        for r in risks:
            _check(r, "risk", positive=True)
        inv = [ONE / r for r in risks]
        tot = sum(inv)
        return [_cents(total * x / tot) for x in inv]
    if method == "ai":
        raise CalcError("AI-recommended allocation is not available in this calculator")
    raise CalcError("method must be equal, percentage, manual or risk_weighted")


def exposure_capital(available: Decimal, preset: str, custom_pct: Optional[Decimal] = None,
                     max_pct: Decimal = HUNDRED) -> Decimal:
    """Capital to allocate for an exposure-intensity preset. Never changes leverage or the balance."""
    _check(available, "available", positive=True)
    _check(max_pct, "max_pct", positive=True)
    if max_pct > 100:
        raise CalcError("max_pct must be at most 100")
    if preset == "maximum":
        pct = max_pct
    elif preset == "custom":
        if custom_pct is None:
            raise CalcError("custom allocation needs custom_pct")
        _check(custom_pct, "custom_pct", positive=True)
        pct = custom_pct
    elif preset in EXPOSURE_PRESETS_PCT:
        pct = EXPOSURE_PRESETS_PCT[preset]
    else:
        raise CalcError("preset must be conservative, moderate, aggressive, maximum or custom")
    if pct > max_pct:
        raise CalcError(f"allocation {pct}% exceeds the permitted maximum {max_pct}%")
    return _cents(available * pct / HUNDRED)


# ----------------------------------------------------------------------------------------------- portfolio

def portfolio_preview(legs: Sequence[Inputs], available_balance: Optional[Decimal] = None) -> dict[str, Any]:
    if not 1 <= len(legs) <= MAX_LEGS:
        raise CalcError(f"a portfolio needs between 1 and {MAX_LEGS} legs")
    if len({l.settle_currency for l in legs}) > 1 or len({l.contract_type for l in legs}) > 1:
        raise CalcError("mixed settlement currencies or contract types: preview each group separately")
    _check(available_balance, "available_balance", nonneg=True)
    inverse = legs[0].contract_type == "inverse"
    mdp = 8 if inverse else 2
    results, tot_cap, tot_margin, tot_notional, tot_fee = [], ZERO, ZERO, ZERO, ZERO
    groups: dict[str, dict[str, Decimal]] = {}
    all_valid = True
    for idx, leg in enumerate(legs):
        try:
            r = calculate(leg)
        except CalcError as exc:
            results.append({"index": idx, "valid": False, "error": str(exc)})
            all_valid = False
            continue
        r["index"] = idx
        results.append(r)
        all_valid = all_valid and r["valid"]
        margin = D(r["sizing"]["initial_margin"])
        notional = D(r["sizing"]["notional"])
        fee = D(r["target"]["entry_fee"]) if r["target"] else ZERO
        if r["target"] is None:
            # entry fee is independent of the target price; recompute from the entry price
            rate = leg.maker_fee_rate if leg.entry_liquidity == "maker" else leg.taker_fee_rate
            fee = notional * rate if not inverse else notional / leg.entry_price * rate
        tot_cap += leg.capital
        tot_margin += margin
        tot_notional += notional
        tot_fee += fee
        g = groups.setdefault(leg.correlation_group or "ungrouped", {"long_notional": ZERO, "short_notional": ZERO})
        g["long_notional" if leg.direction == "long" else "short_notional"] += notional
    required = tot_margin + tot_fee
    violations = []
    balance = None
    if available_balance is not None:
        after = available_balance - required
        balance = {"available": _s(available_balance, mdp), "required_margin_plus_entry_fees": _s(required, mdp),
                   "available_after": _s(after, mdp)}
        if after < 0:
            violations.append({"code": "insufficient_balance",
                               "message": f"Combined margin and entry fees {_s(required, mdp)} exceed available balance {_s(available_balance, mdp)}"})
    return {
        "valid": all_valid and not violations,
        "read_only": True,
        "legs": results,
        "totals": {"capital": _s(tot_cap, mdp), "initial_margin": _s(tot_margin, mdp), "notional": _s(tot_notional, 2),
                   "estimated_entry_fees": _s(tot_fee, mdp)},
        "exposure_by_group": {k: {"long_notional": _s(v["long_notional"], 2), "short_notional": _s(v["short_notional"], 2),
                                  "net_notional": _s(v["long_notional"] - v["short_notional"], 2),
                                  "gross_notional": _s(v["long_notional"] + v["short_notional"], 2)} for k, v in groups.items()},
        "balance": balance,
        "violations": violations,
        "note": "Correlation is not estimated; legs are grouped only by the correlation_group label you supply. "
                "Cross-margin liquidation interactions between legs are not modelled.",
    }
