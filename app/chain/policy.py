"""Pure spending-policy checks for the ETI wallet. Returns human-readable violations; empty list means allowed."""
from __future__ import annotations

from decimal import Decimal, localcontext
from typing import Optional

from app.chain.networks import Limits, Network


def fmt_units(wei: int, decimals: int = 18) -> str:
    with localcontext() as ctx:
        ctx.prec = 80
        s = format(Decimal(wei) / Decimal(10) ** decimals, "f")
    return s.rstrip("0").rstrip(".") if "." in s else s


def to_units(amount: str | Decimal, decimals: int = 18) -> int:
    with localcontext() as ctx:
        ctx.prec = 80
        d = Decimal(str(amount))
        if d <= 0:
            raise ValueError("amount must be positive")
        q = d * Decimal(10) ** decimals
        if q != q.to_integral_value():
            raise ValueError(f"too many decimal places (max {decimals})")
        return int(q)


def violations(*, network: Network, limits: Limits, kill_switch: bool, kind: str, notional_wei: int, sent_today_wei: int,
               to: Optional[str] = None, wallet: Optional[str] = None, destination_allowed: bool = True,
               token_allowed: bool = True, slippage_bps: Optional[int] = None, router_configured: bool = True) -> list[str]:
    v: list[str] = []
    if kill_switch:
        v.append("the global kill switch is active")
    if network.mainnet and not limits.mainnet_send_enabled:
        v.append(f"sending on {network.label} is disabled (operator must set CHAIN_MAINNET_SEND_ENABLED)")
    if kind == "transfer":
        if notional_wei <= 0:
            v.append("amount must be positive")
        if to and wallet and to.lower() == wallet.lower():
            v.append("destination is the wallet itself")
        if to and int(to, 16) == 0:
            v.append("destination is the zero address")
        if limits.require_allowlist and not destination_allowed:
            v.append("destination is not on the allowlist")
    if kind in ("swap", "approve"):
        if not router_configured:
            v.append("no DEX router is configured for this network")
        if not token_allowed:
            v.append("token is not on the token allowlist")
    if kind == "swap" and (slippage_bps is None or not 1 <= slippage_bps <= limits.max_slippage_bps):
        v.append(f"slippage must be between 1 and {limits.max_slippage_bps} bps")
    if notional_wei > limits.max_tx_wei:
        v.append(f"amount {fmt_units(notional_wei)} {network.native} exceeds the per-transaction cap of {fmt_units(limits.max_tx_wei)}")
    if sent_today_wei + notional_wei > limits.max_daily_wei:
        v.append(f"would exceed the 24h cap of {fmt_units(limits.max_daily_wei)} {network.native} (already used {fmt_units(sent_today_wei)})")
    return v
