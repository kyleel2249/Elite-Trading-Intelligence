"""Profit allocation: exact integer split by basis points (largest-remainder), posted as one balanced entry."""
from __future__ import annotations

from app.accounting.domain import EntrySpec, Line, ValidationError
from app.accounting.coa import RETAINED
from app.accounting.ledger import Ledger, PostResult


def split(total_units: int, shares_bps: dict) -> dict:
    """Split `total_units` by basis points. Result always sums exactly to the total (no rounding leakage)."""
    if not isinstance(total_units, int) or isinstance(total_units, bool) or total_units <= 0:
        raise ValidationError("only positive profit can be allocated")
    if not shares_bps or any((not isinstance(v, int)) or isinstance(v, bool) or v < 0 for v in shares_bps.values()):
        raise ValidationError("shares must be non-negative integer basis points")
    if sum(shares_bps.values()) != 10_000:
        raise ValidationError("shares must sum to exactly 10000 bps")
    base = {k: total_units * v // 10_000 for k, v in shares_bps.items()}
    rem = total_units - sum(base.values())
    order = sorted(shares_bps, key=lambda k: ((total_units * shares_bps[k]) % 10_000, k), reverse=True)
    for k in order[:rem]:
        base[k] += 1
    return base


def post_allocation(ledger: Ledger, *, date: str, period_id: str, profit_units: int, shares_bps: dict,
                    accounts: dict, posted_by: str = "system") -> PostResult:
    """Debit retained earnings, credit each bucket's account. `period_id` makes the posting idempotent."""
    if set(accounts) != set(shares_bps):
        raise ValidationError("every bucket needs exactly one target account")
    parts = split(profit_units, shares_bps)
    lines = [Line(RETAINED, debit=profit_units, memo="Profit allocation")]
    lines += [Line(accounts[k], credit=v, memo=f"Allocation: {k}") for k, v in parts.items() if v > 0]
    return ledger.post(EntrySpec(date, "profit_allocation", period_id, lines, memo=f"Profit allocation {period_id}", posted_by=posted_by))
