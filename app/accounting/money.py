"""Exact money: integers in 1e-8 units (no floats are ever stored)."""
from __future__ import annotations

from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation

SCALE = 10 ** 8


class MoneyError(ValueError):
    pass


def to_units(value) -> int:
    """Decimal/str/int/float -> integer units. Floats are converted via their shortest repr, then rounded to 8 dp."""
    if isinstance(value, bool):
        raise MoneyError("amount must be a number")
    if isinstance(value, int):
        d = Decimal(value)
    else:
        try:
            d = Decimal(str(value).strip())
        except (InvalidOperation, ValueError):
            raise MoneyError(f"invalid amount: {value!r}")
    if not d.is_finite():
        raise MoneyError("amount must be finite")
    return int((d * SCALE).quantize(Decimal(1), rounding=ROUND_HALF_EVEN))


def fmt(units: int, dp: int = 8) -> str:
    """Integer units -> fixed-point string (default 8 dp; reports use 2 for display only via fmt(u, 2))."""
    sign = "-" if units < 0 else ""
    d = (Decimal(abs(units)) / SCALE).quantize(Decimal(1).scaleb(-dp), rounding=ROUND_HALF_EVEN)
    return sign + format(d, "f")
