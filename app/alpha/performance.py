"""Discovery performance: did early flags precede real moves? Measured from append-only snapshots so no
future information leaks in: each flag is judged only by prices recorded AFTER it, over a fixed horizon, against a benchmark.

Definitions (parameters, stated up front, never tuned after seeing results):
  event      first snapshot of an "episode": the candidate's flagged/unflagged class changed (or its first snapshot)
  flagged    status in SIGNAL_STATUSES at the event
  outcome    first later snapshot between horizon and 2x horizon after the event (otherwise pending/unresolvable)
  success    forward return >= threshold for the asset class AND beats the benchmark (when a benchmark price exists)
  FP rate    1 - precision among flagged;  miss rate = share of UNflagged events that succeeded;  recall = flagged successes / all successes
Survivorship: candidates that stop appearing (delisted, dropped from scans) cannot be scored; they are counted as unresolvable and reported.
Small samples: below `min_samples` resolvable flagged events, metrics are returned but no performance claim is made."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from statistics import median
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.alpha.db_models import AlphaCandidateSnapshot

SIGNAL_STATUSES = ("EARLY_ACCUMULATION", "DEVELOPING_OPPORTUNITY", "CONFIRMED_OPPORTUNITY", "HIGH_CONVICTION_OPPORTUNITY")
SUCCESS_RETURN = {"crypto": 0.10, "token": 0.10, "equity": 0.05, "etf": 0.04}


def _events(snaps: list[AlphaCandidateSnapshot]) -> list[AlphaCandidateSnapshot]:
    out, prev = [], None
    for s in snaps:
        flagged = s.status in SIGNAL_STATUSES
        if prev is None or flagged != prev:
            out.append(s)
        prev = flagged
    return out


def evaluate_discovery(db: Session, horizon_days: int = 14, asset_class: Optional[str] = None, now: Optional[datetime] = None,
                       min_samples: int = 30) -> dict[str, Any]:
    now = (now or datetime.now(timezone.utc)).replace(tzinfo=None)
    q = db.query(AlphaCandidateSnapshot)
    if asset_class:
        q = q.filter(AlphaCandidateSnapshot.asset_class == asset_class)
    by: dict[str, list[AlphaCandidateSnapshot]] = {}
    for s in q.order_by(AlphaCandidateSnapshot.candidate_id, AlphaCandidateSnapshot.ts).all():
        by.setdefault(s.candidate_id, []).append(s)
    H = timedelta(days=horizon_days)
    rows: list[dict[str, Any]] = []
    pending = unresolvable = 0
    for cid, snaps in by.items():
        for ev in _events(snaps):
            if ev.ts + H > now:
                pending += 1
                continue
            later = [x for x in snaps if ev.ts + H <= x.ts <= ev.ts + 2 * H]
            if not later:
                unresolvable += 1
                continue
            out = later[0]
            r = out.price / ev.price - 1
            rb = (out.bench_price / ev.bench_price - 1) if ev.bench_price and out.bench_price else None
            thr = SUCCESS_RETURN.get(ev.asset_class, 0.10)
            success = r >= thr and (rb is None or r > rb)
            lead = None
            if success:
                hit = next((x for x in snaps if ev.ts < x.ts <= out.ts and x.price >= ev.price * (1 + thr)), None)
                lead = (hit.ts - ev.ts).total_seconds() / 86400 if hit else None
            rows.append({"candidate_id": cid, "status": ev.status, "flagged": ev.status in SIGNAL_STATUSES, "ret": r, "excess": (r - rb) if rb is not None else None,
                         "success": success, "lead_days": lead, "asset_class": ev.asset_class, "benchmarked": rb is not None})
    flagged = [r for r in rows if r["flagged"]]
    unflag = [r for r in rows if not r["flagged"]]

    def avg(xs: list[float]) -> Optional[float]:
        return round(sum(xs) / len(xs) * 100, 3) if xs else None
    fs, us = sum(1 for r in flagged if r["success"]), sum(1 for r in unflag if r["success"])
    precision = fs / len(flagged) if flagged else None
    base = us / len(unflag) if unflag else None
    leads = [r["lead_days"] for r in flagged if r["lead_days"] is not None]
    by_status = {}
    for st in SIGNAL_STATUSES:
        g = [r for r in flagged if r["status"] == st]
        if g:
            by_status[st] = {"events": len(g), "precision": round(sum(1 for r in g if r["success"]) / len(g), 3), "avg_return_pct": avg([r["ret"] for r in g])}
    enough = len(flagged) >= min_samples
    return {
        "horizon_days": horizon_days, "success_definition": {"min_forward_return": SUCCESS_RETURN, "beats_benchmark_when_available": True},
        "flagged_events": len(flagged), "unflagged_events": len(unflag), "pending": pending, "unresolvable": unresolvable,
        "precision": round(precision, 3) if precision is not None else None,
        "false_positive_rate": round(1 - precision, 3) if precision is not None else None,
        "miss_rate_among_unflagged": round(base, 3) if base is not None else None,
        "recall": round(fs / (fs + us), 3) if (fs + us) else None,
        "lift_vs_unflagged": round(precision / base, 2) if precision is not None and base else None,
        "avg_return_flagged_pct": avg([r["ret"] for r in flagged]), "avg_return_unflagged_pct": avg([r["ret"] for r in unflag]),
        "avg_excess_flagged_pct": avg([r["excess"] for r in flagged if r["excess"] is not None]),
        "median_lead_time_days": round(median(leads), 2) if leads else None, "by_status": by_status,
        "benchmarked_share": round(sum(1 for r in rows if r["benchmarked"]) / len(rows), 3) if rows else None,
        "small_sample_warning": not enough,
        "claim": ("Sample large enough to report, still historical and not a forecast." if enough else
                  f"Fewer than {min_samples} resolvable flagged events: ETI makes NO performance claim from this."),
        "limits": ["snapshots are scan-cadence (>= 6h apart), so lead time is coarse", "success is judged at the horizon end, not intra-period",
                   "assets that disappear from scans are unresolvable (survivorship), counted above", "pooled events are not independent in a common market move"],
    }
