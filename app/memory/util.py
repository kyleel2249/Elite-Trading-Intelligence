"""Small shared helpers for the memory package (time handling, hashing, statistics)."""
from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timezone
from typing import Any, Optional


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def as_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """Return a timezone-aware UTC datetime. Naive values (e.g. read back from SQLite) are
    interpreted as UTC, matching how every ETI model writes them."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def naive_utc(dt: Optional[datetime]) -> Optional[datetime]:
    """Naive-UTC form used when binding datetimes into SQL filters."""
    d = as_utc(dt)
    return d.replace(tzinfo=None) if d is not None else None


def iso(dt: Optional[datetime]) -> Optional[str]:
    d = as_utc(dt)
    return d.isoformat() if d is not None else None


def sha256_json(obj: Any) -> str:
    raw = json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def is_finite_number(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(float(x))


def clamp(x: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, x))


def wilson_interval(successes: int, n: int, z: float = 1.96) -> Optional[tuple[float, float]]:
    """Wilson score interval for a proportion. None when n == 0."""
    if n <= 0:
        return None
    p = successes / n
    denom = 1.0 + z * z / n
    centre = (p + z * z / (2.0 * n)) / denom
    half = z * math.sqrt((p * (1.0 - p) + z * z / (4.0 * n)) / n) / denom
    return (max(0.0, centre - half), min(1.0, centre + half))


def append_unique(items: Optional[list], value: Any, keep_last: Optional[int] = None) -> list:
    out = list(items or [])
    if value is not None and value not in out:
        out.append(value)
    if keep_last is not None and len(out) > keep_last:
        out = out[-keep_last:]
    return out
