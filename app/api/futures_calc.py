"""Read-only futures calculator API. It computes and validates; it never places, signs or submits orders."""
from __future__ import annotations

from decimal import Decimal
from typing import Literal, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.futures import calc
from app.futures.calc import CalcError, Inputs, Limits, MarginTier

router = APIRouter(prefix="/api/futures-calc", tags=["futures-calculator"])

Dec = Decimal


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TierIn(_Strict):
    mmr_pct: Dec = Field(..., ge=0, lt=100, description="Maintenance margin rate, percent")
    notional_cap: Optional[Dec] = Field(None, gt=0)
    cum: Dec = Field(Dec(0), ge=0)
    max_leverage: Optional[int] = Field(None, ge=1, le=1000)


class LimitsIn(_Strict):
    platform_max_leverage: int = Field(calc.PLATFORM_MAX_LEVERAGE, ge=1, le=calc.PLATFORM_MAX_LEVERAGE)
    exchange_max_leverage: Optional[int] = Field(None, ge=1, le=1000)
    account_max_leverage: Optional[int] = Field(None, ge=1, le=1000)
    policy_max_leverage: Optional[int] = Field(None, ge=1, le=1000)
    min_risk_reward: Optional[Dec] = Field(None, gt=0)
    min_liquidation_distance_pct: Optional[Dec] = Field(None, gt=0, lt=100)


class LegIn(_Strict):
    contract_type: Literal["linear", "inverse"] = "linear"
    settle_currency: str = Field("USDT", min_length=2, max_length=10, pattern=r"^[A-Za-z0-9]+$")
    direction: Literal["long", "short"]
    capital: Dec = Field(..., gt=0)
    leverage: int = Field(..., ge=1, le=calc.PLATFORM_MAX_LEVERAGE)
    entry_price: Dec = Field(..., gt=0)
    margin_mode: Literal["isolated", "cross"] = "isolated"
    exit_price: Optional[Dec] = Field(None, gt=0)
    move_pct: Optional[Dec] = Field(None, description="Favourable expected movement in percent (negative = adverse)")
    stop_price: Optional[Dec] = Field(None, gt=0)
    take_profit_prices: list[Dec] = Field(default_factory=list, max_length=5)
    entry_liquidity: Literal["taker", "maker"] = "taker"
    exit_liquidity: Literal["taker", "maker"] = "taker"
    taker_fee_bps: Dec = Field(Dec(5), ge=0, lt=1000)
    maker_fee_bps: Dec = Field(Dec(2), ge=0, lt=1000)
    slippage_bps: Dec = Field(Dec(5), ge=0, le=1000)
    funding_rate_pct: Dec = Field(Dec(0), description="Percent per funding interval; positive = longs pay")
    funding_intervals: Dec = Field(Dec(0), ge=0, le=10000)
    maintenance_margin_pct: Optional[Dec] = Field(None, ge=0, lt=100)
    tiers: list[TierIn] = Field(default_factory=list, max_length=30)
    extra_margin: Dec = Field(Dec(0), ge=0)
    cross_wallet_balance: Optional[Dec] = Field(None, ge=0)
    cross_other_maintenance: Dec = Field(Dec(0), ge=0)
    mark_price: Optional[Dec] = Field(None, gt=0)
    available_balance: Optional[Dec] = Field(None, ge=0)
    contract_multiplier: Dec = Field(Dec(1), gt=0)
    contract_value: Dec = Field(Dec(1), gt=0)
    tick_size: Optional[Dec] = Field(None, gt=0)
    qty_step: Optional[Dec] = Field(None, gt=0)
    min_qty: Optional[Dec] = Field(None, gt=0)
    min_notional: Optional[Dec] = Field(None, gt=0)
    correlation_group: Optional[str] = Field(None, max_length=32)
    limits: LimitsIn = Field(default_factory=LimitsIn)
    movements_pct: list[Dec] = Field(default_factory=lambda: list(calc.MOVEMENT_PRESETS), max_length=30)


class PortfolioIn(_Strict):
    legs: list[LegIn] = Field(..., min_length=1, max_length=calc.MAX_LEGS)
    available_balance: Optional[Dec] = Field(None, ge=0)


class AllocateIn(_Strict):
    total: Dec = Field(..., gt=0)
    method: Literal["equal", "percentage", "manual", "risk_weighted", "ai"]
    count: int = Field(..., ge=1, le=calc.MAX_LEGS)
    weights: Optional[list[Dec]] = None
    risks: Optional[list[Dec]] = None


class ExposureIn(_Strict):
    available: Dec = Field(..., gt=0)
    preset: Literal["conservative", "moderate", "aggressive", "maximum", "custom"]
    custom_pct: Optional[Dec] = Field(None, gt=0, le=100)
    max_pct: Dec = Field(Dec(100), gt=0, le=100)


def to_inputs(m: LegIn) -> Inputs:
    bps, pct = Dec(10000), Dec(100)
    return Inputs(
        direction=m.direction, capital=m.capital, leverage=m.leverage, entry_price=m.entry_price,
        contract_type=m.contract_type, settle_currency=m.settle_currency.upper(), margin_mode=m.margin_mode,
        exit_price=m.exit_price, move_pct=m.move_pct, stop_price=m.stop_price,
        take_profit_prices=tuple(m.take_profit_prices),
        entry_liquidity=m.entry_liquidity, exit_liquidity=m.exit_liquidity,
        taker_fee_rate=m.taker_fee_bps / bps, maker_fee_rate=m.maker_fee_bps / bps, slippage_bps=m.slippage_bps,
        funding_rate=m.funding_rate_pct / pct, funding_intervals=m.funding_intervals,
        maintenance_margin_rate=None if m.maintenance_margin_pct is None else m.maintenance_margin_pct / pct,
        tiers=tuple(MarginTier(mmr=t.mmr_pct / pct, notional_cap=t.notional_cap, cum=t.cum, max_leverage=t.max_leverage)
                    for t in m.tiers),
        extra_margin=m.extra_margin, cross_wallet_balance=m.cross_wallet_balance,
        cross_other_maintenance=m.cross_other_maintenance, mark_price=m.mark_price,
        available_balance=m.available_balance, contract_multiplier=m.contract_multiplier, contract_value=m.contract_value,
        tick_size=m.tick_size, qty_step=m.qty_step, min_qty=m.min_qty, min_notional=m.min_notional,
        correlation_group=m.correlation_group,
        limits=Limits(platform_max_leverage=m.limits.platform_max_leverage,
                      exchange_max_leverage=m.limits.exchange_max_leverage,
                      account_max_leverage=m.limits.account_max_leverage,
                      policy_max_leverage=m.limits.policy_max_leverage,
                      min_risk_reward=m.limits.min_risk_reward,
                      min_liquidation_distance_pct=m.limits.min_liquidation_distance_pct),
        movements=tuple(m.movements_pct),
    )


def _run(fn, *args):
    try:
        return fn(*args)
    except CalcError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except ArithmeticError:  # decimal.InvalidOperation / DivisionByZero on extreme but schema-valid values
        raise HTTPException(status_code=422, detail="values are outside the range the calculator can represent")


@router.get("/presets")
async def presets():
    return {
        "leverage_presets": list(calc.PRESET_LEVERAGE),
        "platform_max_leverage": calc.PLATFORM_MAX_LEVERAGE,
        "movement_presets_pct": [str(x) for x in calc.MOVEMENT_PRESETS],
        "exposure_presets_pct": {k: str(v) for k, v in calc.EXPOSURE_PRESETS_PCT.items()},
        "note": "150x is the platform ceiling, not a guarantee that any exchange or instrument supports it. "
                "Supply the instrument's real limits in `limits`. This API is a calculator: it places no orders.",
    }


@router.post("/preview")
async def preview(body: LegIn):
    return _run(lambda: calc.calculate(to_inputs(body)))


@router.post("/portfolio")
async def portfolio(body: PortfolioIn):
    return _run(lambda: calc.portfolio_preview([to_inputs(l) for l in body.legs], body.available_balance))


@router.post("/allocate")
async def allocate(body: AllocateIn):
    amounts = _run(lambda: calc.allocate_capital(body.total, body.method, body.count, body.weights, body.risks))
    return {"method": body.method, "amounts": [str(a) for a in amounts], "allocated": str(sum(amounts)),
            "remaining": str(body.total - sum(amounts))}


@router.post("/exposure")
async def exposure(body: ExposureIn):
    amt = _run(lambda: calc.exposure_capital(body.available, body.preset, body.custom_pct, body.max_pct))
    return {"preset": body.preset, "capital": str(amt),
            "note": "Sets how much capital to allocate. It does not change leverage or any balance."}
