"""Kelly Criterion position sizing with hard, server-side caps.

Definitions (kept explicit because they are different things):

* ``risk_fraction``  - share of bankroll lost if the stop is hit (capital at risk).
* ``allocation``     - position notional as a share of bankroll.
  allocation = risk_fraction / stop_distance_pct, so a tight stop does not
  silently produce a huge position: the 6% allocation cap binds independently.

Kelly: f* = (b*p - q) / b, with b = net reward per unit of risk after costs.
f* is interpreted as the fraction of bankroll to put AT RISK (a full loss at
the stop loses the whole risked amount), then scaled by fractional Kelly.

Final notional = MIN(kelly-derived notional, 6% of bankroll,
                     remaining portfolio capacity, sector/correlation room,
                     liquidity capacity)
No leverage is ever added: notional never exceeds what these caps allow.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field, asdict
from typing import Optional

HARD_MAX_POSITION_PCT = 6.0  # absolute ceiling; configuration can only lower it


@dataclass(frozen=True)
class KellyLimits:
    max_position_pct: float = HARD_MAX_POSITION_PCT
    max_risk_per_trade_pct: float = 1.0
    kelly_fraction: float = 0.25          # conservative default
    max_total_exposure_pct: float = 60.0
    max_sector_exposure_pct: float = 25.0
    max_correlated_exposure_pct: float = 25.0
    min_samples: int = 30                 # below half of this -> reject
    wilson_z: float = 1.28                # ~90% one-sided lower bound on p
    target_daily_vol_pct: float = 3.0     # volatility scaling reference

    def effective_max_position_pct(self) -> float:
        # The 6% ceiling cannot be raised by configuration.
        return max(0.0, min(self.max_position_pct, HARD_MAX_POSITION_PCT))

    def effective_kelly_fraction(self) -> float:
        # Fractional Kelly configurable within [0.25, 0.50].
        return min(0.50, max(0.25, self.kelly_fraction))


@dataclass
class KellyInput:
    bankroll: float
    entry_price: float
    stop_price: float
    target_price: float
    win_probability: float                # estimated from validated outcomes
    sample_size: int = 0
    side: str = "buy"
    fee_bps: float = 10.0                 # per side
    slippage_bps: float = 5.0             # per side
    funding_cost_pct: float = 0.0         # holding cost over horizon, % of price
    current_exposure_pct: float = 0.0
    sector_exposure_pct: float = 0.0
    correlated_exposure_pct: float = 0.0
    liquidity_capacity_notional: Optional[float] = None
    realized_daily_vol_pct: Optional[float] = None
    probability_calibrated: bool = True


@dataclass
class KellyResult:
    approved: bool
    reasons: list[str]
    bankroll: float
    win_probability_input: float = 0.0
    win_probability_used: float = 0.0
    payoff_ratio_b: float = 0.0
    full_kelly_pct: float = 0.0
    fractional_kelly_pct: float = 0.0
    kelly_fraction_used: float = 0.0
    risk_fraction_pct: float = 0.0
    final_allocation_pct: float = 0.0
    position_notional: float = 0.0
    quantity: float = 0.0
    entry_price: float = 0.0
    stop_price: float = 0.0
    max_loss_at_stop: float = 0.0
    max_loss_at_stop_pct: float = 0.0
    portfolio_exposure_after_pct: float = 0.0
    binding_constraint: str = "none"
    constraint_notional: dict[str, float] = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


def kelly_fraction(p: float, b: float) -> float:
    """Full Kelly f* = (b*p - q)/b. Returns 0 for non-positive edge."""
    if b <= 0 or not (0.0 <= p <= 1.0):
        return 0.0
    q = 1.0 - p
    f = (b * p - q) / b
    return max(0.0, f)


def wilson_lower_bound(p: float, n: int, z: float) -> float:
    """Lower confidence bound for a binomial proportion."""
    if n <= 0:
        return 0.0
    phat = min(1.0, max(0.0, p))
    denom = 1 + z * z / n
    centre = phat + z * z / (2 * n)
    margin = z * math.sqrt((phat * (1 - phat) + z * z / (4 * n)) / n)
    return max(0.0, (centre - margin) / denom)


def _reject(inp: KellyInput, reasons: list[str], **kw) -> KellyResult:
    return KellyResult(
        approved=False, reasons=reasons, bankroll=inp.bankroll,
        win_probability_input=inp.win_probability, entry_price=inp.entry_price,
        stop_price=inp.stop_price,
        portfolio_exposure_after_pct=inp.current_exposure_pct, **kw,
    )


def size_position(inp: KellyInput, limits: Optional[KellyLimits] = None) -> KellyResult:
    limits = limits or KellyLimits()
    reasons: list[str] = []

    # ---- input validation (fail closed) ----
    nums = (inp.bankroll, inp.entry_price, inp.stop_price, inp.target_price, inp.win_probability)
    if any((not isinstance(x, (int, float))) or math.isnan(x) or math.isinf(x) for x in nums):
        return _reject(inp, ["Non-numeric or non-finite input"])
    if inp.bankroll <= 0 or inp.entry_price <= 0:
        return _reject(inp, ["Bankroll and entry price must be positive"])
    side = inp.side.lower()
    if side not in ("buy", "sell"):
        return _reject(inp, ["Side must be buy or sell"])
    if side == "buy" and not (inp.stop_price < inp.entry_price < inp.target_price):
        return _reject(inp, ["Long requires stop < entry < target"])
    if side == "sell" and not (inp.target_price < inp.entry_price < inp.stop_price):
        return _reject(inp, ["Short requires target < entry < stop"])
    if not (0.0 <= inp.win_probability <= 1.0):
        return _reject(inp, ["Win probability must be within [0, 1]"])

    # ---- calibration / evidence ----
    if not inp.probability_calibrated:
        return _reject(inp, ["Probability estimate is not calibrated"])
    if inp.sample_size < limits.min_samples // 2:
        return _reject(inp, [f"Insufficient sample size ({inp.sample_size} < {limits.min_samples // 2})"])
    p_used = min(inp.win_probability, wilson_lower_bound(inp.win_probability, inp.sample_size, limits.wilson_z))

    # ---- payoff after costs ----
    cost_per_unit = inp.entry_price * (2 * (inp.fee_bps + inp.slippage_bps) / 10_000.0
                                       + inp.funding_cost_pct / 100.0)
    gross_reward = abs(inp.target_price - inp.entry_price)
    gross_risk = abs(inp.entry_price - inp.stop_price)
    net_reward = gross_reward - cost_per_unit
    net_risk = gross_risk + cost_per_unit
    if net_reward <= 0:
        return _reject(inp, ["Costs consume the entire expected reward"], win_probability_used=p_used)
    b = net_reward / net_risk

    f_full = kelly_fraction(p_used, b)
    if f_full <= 0:
        return _reject(
            inp, ["No positive edge (Kelly <= 0): allocation is zero"],
            win_probability_used=p_used, payoff_ratio_b=b,
        )

    frac = limits.effective_kelly_fraction()
    # Sample-size haircut between min_samples/2 and min_samples
    sample_scale = min(1.0, inp.sample_size / float(limits.min_samples)) if limits.min_samples > 0 else 1.0
    vol_scale = 1.0
    if inp.realized_daily_vol_pct and inp.realized_daily_vol_pct > 0:
        vol_scale = min(1.0, limits.target_daily_vol_pct / inp.realized_daily_vol_pct)
    f_frac = f_full * frac * sample_scale * vol_scale

    # Capital at risk is separately capped (distinct from allocation cap)
    risk_fraction = min(f_frac, limits.max_risk_per_trade_pct / 100.0)
    risk_amount = risk_fraction * inp.bankroll
    stop_pct = net_risk / inp.entry_price  # includes costs
    kelly_notional = risk_amount / stop_pct if stop_pct > 0 else 0.0

    # ---- notional caps ----
    caps: dict[str, float] = {
        "kelly": kelly_notional,
        "position_cap_6pct": inp.bankroll * limits.effective_max_position_pct() / 100.0,
        "portfolio_capacity": max(0.0, inp.bankroll * (limits.max_total_exposure_pct - inp.current_exposure_pct) / 100.0),
        "sector_capacity": max(0.0, inp.bankroll * (limits.max_sector_exposure_pct - inp.sector_exposure_pct) / 100.0),
        "correlated_capacity": max(0.0, inp.bankroll * (limits.max_correlated_exposure_pct - inp.correlated_exposure_pct) / 100.0),
    }
    if inp.liquidity_capacity_notional is not None:
        caps["liquidity_capacity"] = max(0.0, inp.liquidity_capacity_notional)

    binding = min(caps, key=lambda k: caps[k])
    notional = caps[binding]
    if notional <= 0:
        return _reject(
            inp, [f"No capacity remaining ({binding})"],
            win_probability_used=p_used, payoff_ratio_b=b, full_kelly_pct=f_full * 100,
            fractional_kelly_pct=f_frac * 100, kelly_fraction_used=frac,
            binding_constraint=binding, constraint_notional=caps,
        )

    qty = notional / inp.entry_price
    max_loss = qty * net_risk
    alloc_pct = notional / inp.bankroll * 100.0
    # Defensive invariant: never exceed the hard ceiling.
    assert alloc_pct <= HARD_MAX_POSITION_PCT + 1e-9, "6% position cap violated"
    if binding != "kelly":
        reasons.append(f"Size limited by {binding}")
    if risk_fraction < f_frac:
        reasons.append("Capital-at-risk cap reduced the Kelly risk fraction")

    return KellyResult(
        approved=True, reasons=reasons or ["Sized by fractional Kelly"],
        bankroll=inp.bankroll, win_probability_input=inp.win_probability,
        win_probability_used=p_used, payoff_ratio_b=b,
        full_kelly_pct=f_full * 100, fractional_kelly_pct=f_frac * 100,
        kelly_fraction_used=frac, risk_fraction_pct=max_loss / inp.bankroll * 100,
        final_allocation_pct=alloc_pct, position_notional=notional, quantity=qty,
        entry_price=inp.entry_price, stop_price=inp.stop_price,
        max_loss_at_stop=max_loss, max_loss_at_stop_pct=max_loss / inp.bankroll * 100,
        portfolio_exposure_after_pct=inp.current_exposure_pct + alloc_pct,
        binding_constraint=binding, constraint_notional=caps,
    )
