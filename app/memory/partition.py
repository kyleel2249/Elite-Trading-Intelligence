"""Train / validation / live-evaluation separation and leakage guards.

Partitions
----------
train         data a strategy's parameters may be fitted on
validation    later data used once to judge a fitted candidate
holdout       final reserved data, touched at most once before activation
live          forward data produced after a strategy version was frozen (paper or live fills)
unclassified  anything whose split was never declared (never usable as validation evidence)

Guards
------
* look-ahead bias   -> point_in_time()/assert_not_future(): nothing newer than ``as_of`` is visible
* data leakage      -> audit_split(): overlap, missing embargo, tuning on the evaluation window
* survivorship bias -> universe_source flag + population reports (see signals/stats modules)
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import Enum
from typing import Any, Callable, Iterable, Optional

from app.memory.util import as_utc, utcnow


class Partition(str, Enum):
    TRAIN = "train"
    VALIDATION = "validation"
    HOLDOUT = "holdout"
    LIVE = "live"
    UNCLASSIFIED = "unclassified"


VALIDATION_PARTITIONS = frozenset({Partition.VALIDATION.value, Partition.HOLDOUT.value})


class LeakageError(ValueError):
    """Raised when an operation would let future information influence a past decision."""


@dataclass
class SplitPlan:
    n_bars: int
    embargo_bars: int
    train: tuple[int, int]
    validation: tuple[int, int]
    holdout: tuple[int, int]

    def to_dict(self) -> dict[str, Any]:
        return {
            "n_bars": self.n_bars,
            "embargo_bars": self.embargo_bars,
            "train": list(self.train),
            "validation": list(self.validation),
            "holdout": list(self.holdout),
            "convention": "half-open [start, end) bar indexes, strictly chronological, never shuffled",
        }


def chronological_split(
    n_bars: int,
    train_frac: float = 0.6,
    validation_frac: float = 0.2,
    embargo_bars: int = 0,
) -> SplitPlan:
    """Strictly chronological train / validation / holdout split with an embargo gap between
    consecutive windows (purges bars whose labels would overlap the previous window)."""
    if n_bars < 10:
        raise ValueError("need at least 10 bars to split")
    if not (0 < train_frac < 1) or not (0 < validation_frac < 1) or train_frac + validation_frac >= 1:
        raise ValueError("train_frac and validation_frac must be in (0,1) and sum to < 1")
    if embargo_bars < 0:
        raise ValueError("embargo_bars must be >= 0")
    train_end = int(n_bars * train_frac)
    val_start = train_end + embargo_bars
    val_end = val_start + int(n_bars * validation_frac)
    hold_start = val_end + embargo_bars
    if train_end < 1 or val_end <= val_start or hold_start >= n_bars:
        raise ValueError("series too short for the requested fractions/embargo")
    return SplitPlan(
        n_bars=n_bars,
        embargo_bars=embargo_bars,
        train=(0, train_end),
        validation=(val_start, val_end),
        holdout=(hold_start, n_bars),
    )


def _lt(a: Any, b: Any) -> bool:
    if isinstance(a, datetime) and isinstance(b, datetime):
        return as_utc(a) < as_utc(b)  # type: ignore[operator]
    return a < b


def _gap(a: Any, b: Any) -> Optional[float]:
    """Numeric distance b - a when both are plain numbers (bar indexes); otherwise None."""
    nums = (int, float)
    if isinstance(a, nums) and isinstance(b, nums) and not isinstance(a, bool) and not isinstance(b, bool):
        return float(b) - float(a)
    return None


def audit_split(
    training_range: Optional[tuple[Any, Any]] = None,
    evaluation_range: Optional[tuple[Any, Any]] = None,
    *,
    embargo_bars: int = 0,
    horizon: int = 0,
    parameters_fitted: bool = True,
    tuned_on_evaluation: bool = False,
    universe_source: str = "unknown",
) -> dict[str, Any]:
    """Audit an evaluation window for leakage. ``passed`` is only True when no failure exists.

    parameters_fitted=False means fixed rule parameters were used (nothing was learned from the
    training window), so overlap/embargo cannot leak and only tuning-on-evaluation is checked.
    """
    failures: list[str] = []
    warnings: list[str] = []
    notes: list[str] = []

    if tuned_on_evaluation:
        failures.append("parameters_tuned_on_evaluation_data")

    if parameters_fitted:
        if training_range is None or evaluation_range is None:
            failures.append("train_and_evaluation_ranges_not_declared")
        else:
            t_end = training_range[1]
            e_start = evaluation_range[0]
            if _lt(e_start, t_end):
                failures.append("evaluation_overlaps_training")
            else:
                gap = _gap(t_end, e_start)
                required = max(int(embargo_bars or 0), int(horizon or 0))
                if gap is not None and gap < required:
                    failures.append(f"embargo_gap_{int(gap)}_lt_required_{required}")
    else:
        notes.append("no_parameter_fitting_performed")

    if universe_source != "point_in_time":
        warnings.append("universe_not_point_in_time_survivorship_risk")

    return {
        "passed": not failures,
        "failures": failures,
        "warnings": warnings,
        "notes": notes,
        "universe_source": universe_source,
        "checked_at": utcnow().isoformat(),
    }


def point_in_time(records: Iterable[Any], as_of: datetime, key: Callable[[Any], datetime]) -> list[Any]:
    """Keep only records that were already available at ``as_of`` (look-ahead guard)."""
    cutoff = as_utc(as_of)
    return [r for r in records if as_utc(key(r)) <= cutoff]  # type: ignore[operator]


def assert_not_future(ts: datetime, as_of: Optional[datetime] = None, *, label: str = "timestamp", skew_seconds: int = 60) -> None:
    limit = as_utc(as_of) if as_of is not None else utcnow()
    if as_utc(ts) > limit + timedelta(seconds=skew_seconds):  # type: ignore[operator]
        raise LeakageError(f"{label} {as_utc(ts).isoformat()} is in the future relative to {limit.isoformat()}")


def is_forward_evidence(trade_opened_at: datetime, version_frozen_at: Optional[datetime]) -> bool:
    """A trade only counts as live evidence for a strategy version if it opened at/after the
    moment the version was frozen (activated). Earlier trades could have shaped the version."""
    if version_frozen_at is None:
        return False
    return as_utc(trade_opened_at) >= as_utc(version_frozen_at)  # type: ignore[operator]
