"""Market-aware assessment: session + liquidity + costs + sizing + routing in one verdict.

Two entry points:
  * ``assess``             - full planning report for a symbol (API / dashboard).
  * ``market_risk_review`` - small deterministic check the RiskEngine runs on every order.

Neither submits orders. ``assess`` is a planning calculator: its equity input comes from
the caller and is NEVER used to approve an order (the RiskEngine derives equity
server-side, as before).
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Optional

from app.markets.profiles import MarketProfile, profile_for
from app.markets.providers import data_coverage, not_integrated_reason, provider_supports, routes_for
from app.markets.registry import classify
from app.markets.sessions import SESSIONS, liquidity_factor, session_status, spread_multiplier
from app.markets.types import AssetClass, Instrument, MarketReview

_USD_LIKE = {"USD", "USDT", "USDC", "FDUSD", "BUSD", "TUSD"}
COST_TO_RISK_WARN = 0.25


# ---------------------------------------------------------------------------
# RiskEngine hook
# ---------------------------------------------------------------------------
def market_risk_review(symbol: str, provider: Optional[str], environment: str, *,
                       now: Optional[datetime] = None) -> MarketReview:
    """Deterministic, side-effect-free market checks for one proposed order."""
    inst = classify(symbol, provider_hint=provider)
    prof = profile_for(inst)
    review = MarketReview(asset_class=inst.asset_class.value, tier=inst.tier,
                          notional_cap_multiplier=prof.notional_cap_multiplier, risk_multiplier=prof.risk_multiplier)
    if inst.asset_class == AssetClass.UNKNOWN:
        review.warnings.append(f"{symbol!r} could not be classified; market-specific limits were not applied")
        return review

    supports = provider_supports(provider, inst)
    if supports is False:
        msg = f"{provider} cannot trade {inst.asset_class.value} instrument {inst.symbol} (no adapter for this market, or not offered by this provider)"
        (review.warnings if inst.confidence == "heuristic" else review.blocking_reasons).append(msg)

    if (provider or "").lower() == "oanda" and (environment or "").lower() == "testnet":
        review.blocking_reasons.append("OANDA has no testnet environment; use environment=paper (OANDA practice account) or live")

    if inst.session_id in SESSIONS:
        status = session_status(inst.session_id, now)
        review.session_state = status.state
        review.tradeable_now = status.state == "open"
        if not review.tradeable_now:
            when = f"; next open {status.next_open_utc}" if status.next_open_utc else ""
            msg = f"{inst.symbol} market is {status.state} ({status.reason or status.regime}){when}"
            (review.blocking_reasons if (environment or "").lower() == "live" else review.warnings).append(msg)
    if inst.tier in ("emerging", "frontier") or "meme" in inst.tags:
        review.warnings.append(f"{inst.symbol} is a {inst.tier} / high-risk instrument: position and risk limits are tightened")
    return review


# ---------------------------------------------------------------------------
# Sizing helpers
# ---------------------------------------------------------------------------
def _quote_to_usd(inst: Instrument, price: float, supplied: Optional[float]) -> tuple[Optional[float], Optional[str]]:
    if supplied is not None:
        return supplied, None
    q = inst.quote
    if inst.asset_class in (AssetClass.FOREX, AssetClass.METAL) and inst.base == "USD" and price > 0:
        return 1.0 / price, None           # USDJPY, USDCAD, USDCHF: quote -> USD is 1/price
    if q is None or q in _USD_LIKE:
        return 1.0, ("quote currency treated as 1:1 with USD" if q and q != "USD" else None)
    return None, f"quote currency {q} needs a USD conversion rate: pass quote_to_usd"


def _floor_to_step(qty: float, step: float) -> float:
    if step <= 0:
        return qty
    n = math.floor(qty / step + 1e-9)
    decimals = max(0, -int(math.floor(math.log10(step)))) if step < 1 else 0
    return round(n * step, decimals + 2)


def _size(inst: Instrument, prof: MarketProfile, *, price: float, equity: float, risk_pct: float, side: str,
          stop_price: Optional[float], atr: Optional[float], factor: float, quote_to_usd: Optional[float],
          max_notional_pct: float, adv_usd: Optional[float], max_adv_pct: float) -> dict:
    out: dict = {"status": "ok"}
    if price <= 0 or equity <= 0 or risk_pct <= 0:
        return {"status": "invalid_input", "reason": "price, account_equity and risk_pct must be positive"}
    q2u, note = _quote_to_usd(inst, price, quote_to_usd)
    if q2u is None:
        return {"status": "needs_quote_usd_rate", "reason": note}
    if note:
        out["note"] = note
    mult = inst.contract_multiplier or 1.0
    usd_per_unit = price * mult * q2u

    if stop_price is not None:
        wrong_side = (side == "buy" and stop_price >= price) or (side == "sell" and stop_price <= price)
        if stop_price <= 0 or wrong_side:
            return {"status": "invalid_input", "reason": f"stop_price must be {'below' if side == 'buy' else 'above'} price for a {side}"}
        dist, source = abs(price - stop_price), "provided_stop"
    elif atr is not None and atr > 0:
        dist, source = atr * 1.5, "atr_x1.5"
    elif inst.asset_class == AssetClass.OPTION:
        dist, source = price, "full_premium_at_risk"
    else:
        dist, source = price * prof.daily_vol_pct / 100.0 * prof.stop_vol_mult, "profile_volatility_default"
    if dist <= 0:
        return {"status": "invalid_input", "reason": "stop distance must be positive"}

    haircut = 0.5 if 0 < factor < 0.5 else 1.0
    budget = equity * (risk_pct / 100.0) * prof.risk_multiplier * haircut
    qty_risk = budget / (dist * mult * q2u)
    cap_usd = equity * (max_notional_pct / 100.0) * prof.notional_cap_multiplier
    qty_cap = cap_usd / usd_per_unit
    limits = {"risk_budget": qty_risk, "notional_cap": qty_cap}
    if adv_usd is not None and adv_usd > 0:
        limits["liquidity_participation"] = (adv_usd * max_adv_pct / 100.0) / usd_per_unit
    binding = min(limits, key=limits.get)
    qty = _floor_to_step(limits[binding], inst.qty_step)
    if qty < inst.min_qty - 1e-12:
        min_notional = inst.min_qty * usd_per_unit
        min_risk = inst.min_qty * dist * mult * q2u
        eff_cap_pct = max_notional_pct * prof.notional_cap_multiplier
        out.update(status="below_minimum_size", quantity=0.0, binding_constraint=binding,
                   reason=f"Allowed size ({limits[binding]:.6g}) is below the minimum order size ({inst.min_qty:g}) "
                          f"under the {binding.replace('_', ' ')} limit. The smallest order is ~${min_notional:,.0f} notional "
                          f"(~${min_risk:,.0f} at risk): that needs account equity of about ${min_notional / (eff_cap_pct / 100.0):,.0f} "
                          f"for the {eff_cap_pct:g}% notional cap and ${min_risk / ((risk_pct / 100.0) * prof.risk_multiplier * haircut):,.0f} "
                          f"for the risk budget.",
                   minimum_order={"notional_usd": round(min_notional, 2), "risk_usd": round(min_risk, 2),
                                  "equity_for_notional_cap_usd": round(min_notional / (eff_cap_pct / 100.0), 2),
                                  "equity_for_risk_budget_usd": round(min_risk / ((risk_pct / 100.0) * prof.risk_multiplier * haircut), 2)})
        qty = 0.0
    else:
        out["quantity"] = qty
        out["binding_constraint"] = binding
    notional = qty * usd_per_unit
    risk_actual = qty * dist * mult * q2u
    out.update(
        notional_usd=round(notional, 2), risk_amount_usd=round(risk_actual, 2),
        risk_pct_of_equity=round(risk_actual / equity * 100.0, 4),
        risk_budget_usd=round(budget, 2), stop_distance=round(dist, 8), stop_source=source,
        stop_price=round(price - dist if side == "buy" else price + dist, 8),
        target_1r=round(price + dist if side == "buy" else price - dist, 8),
        target_2r=round(price + 2 * dist if side == "buy" else price - 2 * dist, 8),
        limits={k: round(v, 8) for k, v in limits.items()},
        max_notional_pct_applied=round(max_notional_pct * prof.notional_cap_multiplier, 4),
        liquidity_haircut_applied=haircut < 1.0,
    )
    return out


# ---------------------------------------------------------------------------
# Full assessment
# ---------------------------------------------------------------------------
def assess(symbol: str, *, now: Optional[datetime] = None, price: Optional[float] = None, account_equity: float = 10000.0,
           risk_pct: float = 1.0, side: str = "buy", stop_price: Optional[float] = None, atr: Optional[float] = None,
           measured_spread_bps: Optional[float] = None, avg_daily_volume_usd: Optional[float] = None,
           listing_age_days: Optional[float] = None, quote_to_usd: Optional[float] = None,
           max_notional_pct: float = 6.0, max_adv_participation_pct: float = 1.0,
           provider: Optional[str] = None, environment: str = "paper", settings=None) -> dict:
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    side = (side or "buy").lower()
    inst = classify(symbol, provider_hint=provider)
    base = {"as_of_utc": now.isoformat(), "planning_only": True,
            "disclaimer": "Planning aid built on static baselines unless live inputs are supplied; not investment advice."}

    if inst.asset_class == AssetClass.UNKNOWN:
        return {**base, "instrument": inst.to_dict(), "verdict": "blocked",
                "reasons": [f"{symbol!r} could not be classified as a supported market"], "warnings": []}

    status = session_status(inst.session_id, now)
    prof = profile_for(inst, listing_age_days=listing_age_days, avg_daily_volume_usd=avg_daily_volume_usd)
    factor, liq_ctx = liquidity_factor(inst.asset_class.value, status, now)
    smult = spread_multiplier(factor)
    all_routes = routes_for(inst, settings)
    routes = [r for r in all_routes if not provider or r["provider"] == provider.lower()]

    if measured_spread_bps is not None:
        spread, spread_src = float(measured_spread_bps), "measured"
    else:
        spread, spread_src = prof.spread_bps * (smult or 1.0), "baseline_scaled_for_session_liquidity"
    slip = prof.slippage_bps_per_side * (smult or 1.0)
    round_trip = spread + 2 * (prof.commission_bps_per_side + slip)
    costs = {"spread_bps": round(spread, 3), "spread_source": spread_src, "commission_bps_per_side": prof.commission_bps_per_side,
             "slippage_bps_per_side": round(slip, 3), "round_trip_bps": round(round_trip, 3), "source": prof.source}

    reasons: list[str] = []
    warnings: list[str] = []
    verdict = "ready"

    sizing = None
    if price is not None:
        sizing = _size(inst, prof, price=price, equity=account_equity, risk_pct=risk_pct, side=side, stop_price=stop_price,
                       atr=atr, factor=factor, quote_to_usd=quote_to_usd, max_notional_pct=max_notional_pct,
                       adv_usd=avg_daily_volume_usd, max_adv_pct=max_adv_participation_pct)
        if sizing.get("notional_usd"):
            costs["round_trip_usd"] = round(sizing["notional_usd"] * round_trip / 1e4, 2)
            if sizing.get("risk_amount_usd"):
                ratio = costs["round_trip_usd"] / sizing["risk_amount_usd"]
                costs["cost_to_risk_ratio"] = round(ratio, 3)
                if ratio > COST_TO_RISK_WARN:
                    warnings.append(f"Round-trip costs consume {ratio:.0%} of the risk budget; a tight edge here is eaten by friction")
        # Only when the ETF is the *primary* route: an OANDA CFD or spot route takes the quantity in underlying units as-is.
        proxy_route = routes[0] if routes and routes[0]["kind"] == "etf_proxy" else None
        if proxy_route and sizing.get("notional_usd"):
            # The quantity above is in underlying units; the executable instrument is the ETF. Size it by notional.
            sizing["proxy_sizing"] = {
                "symbol": proxy_route["symbol"], "size_by_notional_usd": sizing["notional_usd"],
                "instruction": (f"Do not submit the quantity above to {proxy_route['symbol']}: it is in {inst.symbol} units. "
                                f"Divide notional_usd by {proxy_route['symbol']}'s current price and round down to whole shares; "
                                "re-derive the stop in the ETF's own price terms."),
            }
        if sizing["status"] in ("invalid_input", "needs_quote_usd_rate", "below_minimum_size"):
            reasons.append(sizing.get("reason", sizing["status"]))
            verdict = "blocked"

    route_status = {r["session_id"]: session_status(r["session_id"], now) for r in routes}
    if verdict != "blocked":
        if not routes:
            verdict = "analysis_only"
            reasons.append(not_integrated_reason(inst) or "No execution route for this instrument")
            if status.state != "open":
                warnings.append(f"Market is {status.state} ({status.reason or status.regime})"
                                + (f"; next open {status.next_open_utc}" if status.next_open_utc else ""))
        elif not any(s.state == "open" for s in route_status.values()):
            verdict = "wait_for_session"
            first = next(iter(route_status.values()))
            via = "" if first.session_id == inst.session_id else f" (execution route trades in {first.name} hours)"
            reasons.append(f"Execution market is {first.state} ({first.reason or first.regime}){via}"
                           + (f"; next open {first.next_open_utc}" if first.next_open_utc else ""))
        elif not any(r["setup"]["configured"] for r in routes):
            verdict = "needs_setup"
            r0 = routes[0]
            reasons.append(f"{r0['provider']} route exists but is not configured: set {', '.join(r0['setup']['missing'])}")
        elif warnings or prof.liquidity in ("low", "very_low") or status.state != "open":
            verdict = "caution"
            if status.state != "open":
                warnings.append(f"The underlying market itself is {status.state}; the execution route may not reflect current prices")

    # Warnings that apply regardless of verdict
    if status.regime in ("opening_volatility", "closing_flow"):
        warnings.append(f"Session regime: {status.regime.replace('_', ' ')}")
    if liq_ctx.get("note"):
        warnings.append(liq_ctx["note"])
    if prof.liquidity in ("low", "very_low"):
        warnings.append(f"{prof.label}: {prof.liquidity.replace('_', ' ')} liquidity - exit at size may be slow or costly")
    if prof.gap_risk in ("weekend", "overnight", "limit_moves"):
        warnings.append({"weekend": "Weekend gap risk: stops do not protect across the weekly close.",
                         "overnight": "Overnight gap risk: stops do not protect across the close.",
                         "limit_moves": "Daily price limits can lock the market and prevent exit."}[prof.gap_risk])
    if inst.confidence == "heuristic":
        warnings.append("Classification is a heuristic guess; verify the instrument and its venue.")
    if prof.key == "crypto.new_listing":
        warnings.append(f"Listed < 30 days ago: treated as a new listing (extreme volatility, wide spreads).")
    if inst.asset_class == AssetClass.CRYPTO and inst.tier == "emerging" and listing_age_days is None:
        warnings.append("Listing age unknown: pass listing_age_days to detect newly listed tokens.")
    if status.schedule_confidence == "approximate":
        warnings.append("Session hours are approximate reference hours; verify with the exchange.")
    if status.holiday_calendar == "not_applied":
        warnings.append("No holiday calendar applied for this market; it may be closed on a public holiday.")
    for r in routes:
        if r["kind"] in ("etf_proxy", "cfd"):
            warnings.append(r["note"])
        if r["setup"].get("note"):
            warnings.append(f"{r['provider']}: {r['setup']['note']}")
    if inst.asset_class in (AssetClass.FUTURE, AssetClass.OPTION):
        warnings.extend(inst.notes)
    if provider and not routes and all_routes:
        reasons.append(f"{provider} has no route for {inst.symbol}; available: "
                       + ", ".join(sorted({r['provider'] for r in all_routes})))

    return {
        **base,
        "instrument": inst.to_dict(),
        "session": {**status.to_dict(), "liquidity_factor": factor, "spread_multiplier": smult, **liq_ctx},
        "profile": prof.to_dict(),
        "costs": costs,
        "sizing": sizing,
        "execution": {"executable": bool(routes), "routes": routes, "environment_requested": environment,
                      "data": data_coverage(inst, settings), "live_trading": "disabled unless explicitly enabled and risk-gated"},
        "verdict": verdict,
        "reasons": reasons,
        "warnings": list(dict.fromkeys(warnings)),
    }
