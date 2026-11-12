"""Versioned strategy configurations with governed, human-approved promotion.

Governance rules (enforced here and covered by tests)
-----------------------------------------------------
1. Version rows are immutable apart from status/approval - a config is never edited in place.
2. Autonomous learning (actor_kind='system') can only create ``proposed`` versions whose changes
   are conservative (less risk / fewer regimes). It cannot validate, activate or retire anything.
3. ``validated`` needs a passing validation-partition backtest whose leakage audit passed.
4. ``active`` needs a validated version and a named human approver.
5. A proposal needs a minimum number of closed trades, a statistically flagged edge problem and
   respects a cooldown - one winning or losing trade can never trigger a rewrite.
"""
from __future__ import annotations

import json
from datetime import timedelta
from typing import Any, Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.memory.models import MemoryBacktest, StrategyVersion
from app.memory.partition import VALIDATION_PARTITIONS
from app.memory.registry import get_or_create_registry
from app.memory.util import as_utc, is_finite_number, iso, naive_utc, sha256_json, utcnow

# Mirrors StrategyPromotionAuthority.MIN_OOS_TRADES (kept local to avoid an import cycle).
MIN_OOS_TRADES = 5

DEFAULT_MODULE_CONFIG: dict[str, Any] = {
    "lookback": 20,
    "risk_per_trade_pct": 1.0,
    "fee_bps": 5.0,
    "avoid_regimes": [],
}

STATUSES = ("baseline", "proposed", "candidate", "validated", "active", "retired", "rejected")
ALLOWED: dict[str, set[str]] = {
    "proposed": {"candidate", "rejected"},
    "candidate": {"validated", "rejected"},
    "validated": {"active", "rejected"},
    "baseline": {"retired"},
    "active": {"retired"},
    "retired": set(),
    "rejected": set(),
}
SYSTEM_ALLOWED_TARGETS = {"rejected"}


def diff_config(old: Optional[dict[str, Any]], new: dict[str, Any]) -> dict[str, Any]:
    old = old or {}
    return {
        "added": {k: new[k] for k in new if k not in old},
        "removed": [k for k in old if k not in new],
        "changed": {k: {"from": old[k], "to": new[k]} for k in new if k in old and old[k] != new[k]},
    }


def _has_change(d: dict[str, Any]) -> bool:
    return bool(d["added"] or d["removed"] or d["changed"])


def validate_config(config: Any) -> None:
    if not isinstance(config, dict) or not config:
        raise ValueError("config must be a non-empty object")
    try:
        json.dumps(config)
    except (TypeError, ValueError) as exc:
        raise ValueError("config must be JSON-serialisable") from exc
    from app.adaptive_edge.optimization import ParameterOptimizer  # lazy: avoids import cycle

    for k, (lo, hi) in ParameterOptimizer.BOUNDS.items():
        if k in config:
            v = config[k]
            if not is_finite_number(v) or not (lo <= v <= hi):
                raise ValueError(f"{k} must be within [{lo}, {hi}]")
    if "risk_per_trade_pct" in config:
        v = config["risk_per_trade_pct"]
        if not is_finite_number(v) or not (0 < v <= 5):
            raise ValueError("risk_per_trade_pct must be in (0, 5]")
    if "fee_bps" in config:
        v = config["fee_bps"]
        if not is_finite_number(v) or v < 0:
            raise ValueError("fee_bps must be >= 0")


class StrategyVersionService:
    def __init__(self, db: Session, settings: Optional[Settings] = None):
        self.db = db
        self.settings = settings or get_settings()

    # -- reads --------------------------------------------------------------------------------
    def history(self, strategy_id: str) -> list[StrategyVersion]:
        return (
            self.db.query(StrategyVersion)
            .filter(StrategyVersion.strategy_id == strategy_id)
            .order_by(StrategyVersion.version.asc())
            .all()
        )

    def get(self, strategy_id: str, version: int) -> Optional[StrategyVersion]:
        return (
            self.db.query(StrategyVersion)
            .filter(StrategyVersion.strategy_id == strategy_id, StrategyVersion.version == version)
            .one_or_none()
        )

    def effective_version(self, strategy_id: str) -> Optional[StrategyVersion]:
        """The version currently in force: the active one, else the baseline."""
        for status in ("active", "baseline"):
            row = (
                self.db.query(StrategyVersion)
                .filter(StrategyVersion.strategy_id == strategy_id, StrategyVersion.status == status)
                .order_by(StrategyVersion.version.desc())
                .first()
            )
            if row is not None:
                return row
        return None

    def list_strategies(self) -> list[dict[str, Any]]:
        ids = [r[0] for r in self.db.query(StrategyVersion.strategy_id).distinct().all()]
        out = []
        for sid in sorted(ids):
            eff = self.effective_version(sid)
            hist = self.history(sid)
            out.append({
                "strategy_id": sid,
                "effective_version": eff.version if eff else None,
                "effective_status": eff.status if eff else None,
                "versions": len(hist),
                "open_proposals": sum(1 for v in hist if v.status in ("proposed", "candidate")),
            })
        return out

    # -- baseline -----------------------------------------------------------------------------
    def ensure_baseline(self, strategy_id: str) -> Optional[StrategyVersion]:
        """Create v1 'baseline' for documented strategy modules on first use."""
        eff = self.effective_version(strategy_id)
        if eff is not None:
            return eff
        if self.history(strategy_id):
            return None  # versions exist but none is in force (all retired/rejected)
        from app.knowledge.strategies import STRATEGY_MODULES

        if strategy_id not in STRATEGY_MODULES:
            return None
        cfg = json.loads(json.dumps(DEFAULT_MODULE_CONFIG))
        row = StrategyVersion(
            strategy_id=strategy_id, version=1, status="baseline", config=cfg, config_sha256=sha256_json(cfg),
            parent_version=None, change_reason="baseline from documented strategy module defaults",
            change_diff={}, evidence={"transitions": []}, created_by="system:baseline",
            activated_at=utcnow(),
        )
        self.db.add(row)
        try:
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            return self.effective_version(strategy_id)
        reg = get_or_create_registry(self.db, strategy_id)
        reg.params = cfg
        reg.version = 1
        self.db.commit()
        self.db.refresh(row)
        return row

    # -- create -------------------------------------------------------------------------------
    def create_version(
        self,
        strategy_id: str,
        config: dict[str, Any],
        *,
        reason: str,
        created_by: str,
        actor_kind: str = "user",
        parent_version: Optional[int] = None,
        evidence: Optional[dict[str, Any]] = None,
    ) -> StrategyVersion:
        if actor_kind not in ("user", "system"):
            raise ValueError("actor_kind must be 'user' or 'system'")
        if not (reason or "").strip() or not (created_by or "").strip():
            raise ValueError("reason and created_by are required")
        validate_config(config)
        if parent_version is None:
            base = self.ensure_baseline(strategy_id) or self.effective_version(strategy_id)
        else:
            base = self.get(strategy_id, parent_version)
            if base is None:
                raise LookupError("parent version not found")
        diff = diff_config(base.config if base else {}, config)
        if base is not None and not _has_change(diff):
            raise ValueError("configuration is identical to its parent; nothing to version")
        hist = self.history(strategy_id)
        row = StrategyVersion(
            strategy_id=strategy_id,
            version=(hist[-1].version + 1) if hist else 1,
            status="proposed" if actor_kind == "system" else "candidate",
            config=config, config_sha256=sha256_json(config),
            parent_version=base.version if base else None,
            change_reason=reason.strip()[:2000], change_diff=diff,
            evidence={**(evidence or {}), "transitions": []},
            created_by=created_by.strip()[:64],
        )
        self.db.add(row)
        try:
            self.db.commit()
        except IntegrityError as exc:
            self.db.rollback()
            raise ValueError("concurrent version creation; retry") from exc
        self.db.refresh(row)
        return row

    # -- governance ---------------------------------------------------------------------------
    def validation_evidence(self, strategy_id: str, version: int) -> dict[str, Any]:
        rows = (
            self.db.query(MemoryBacktest)
            .filter(
                MemoryBacktest.strategy_id == strategy_id,
                MemoryBacktest.strategy_version == version,
                MemoryBacktest.validation_eligible.is_(True),
            )
            .all()
        )
        ok = [
            r for r in rows
            if r.partition in VALIDATION_PARTITIONS and r.trades >= MIN_OOS_TRADES
            and r.total_return_pct > 0 and (r.leakage_audit or {}).get("passed")
        ]
        return {
            "eligible_runs": len(rows), "passing_runs": len(ok), "run_ids": [r.run_id for r in ok],
            "min_oos_trades": MIN_OOS_TRADES,
        }

    def transition(
        self,
        strategy_id: str,
        version: int,
        to_status: str,
        *,
        actor: str,
        actor_kind: str = "user",
        note: Optional[str] = None,
    ) -> StrategyVersion:
        row = self.get(strategy_id, version)
        if row is None:
            raise LookupError("strategy version not found")
        if not (actor or "").strip():
            raise ValueError("actor is required")
        if actor_kind == "system" and to_status not in SYSTEM_ALLOWED_TARGETS:
            raise PermissionError("autonomous learning may not validate, activate or retire strategy versions")
        if to_status not in ALLOWED.get(row.status, set()):
            raise ValueError(f"illegal transition {row.status} -> {to_status}")

        evidence = dict(row.evidence or {})
        now = utcnow()
        if to_status == "validated":
            ev = self.validation_evidence(strategy_id, version)
            if ev["passing_runs"] < 1:
                raise ValueError(
                    "no passing validation-partition backtest with a passed leakage audit "
                    f"(need >= {MIN_OOS_TRADES} trades and positive return)"
                )
            evidence["validation"] = ev
            evidence["validated_at"] = iso(now)
            evidence["validated_by"] = actor.strip()
        if to_status == "active":
            for prev in self.history(strategy_id):
                if prev.version != version and prev.status in ("active", "baseline"):
                    prev.status = "retired"
                    prev.status_changed_at = now
            row.approved_by = actor.strip()[:64]
            row.activated_at = now
            reg = get_or_create_registry(self.db, strategy_id)
            reg.params = dict(row.config or {})
            reg.version = row.version
        evidence["transitions"] = [
            *list(evidence.get("transitions") or []),
            {"from": row.status, "to": to_status, "by": actor.strip(), "kind": actor_kind, "at": iso(now), "note": note},
        ]
        row.evidence = evidence
        row.status = to_status
        row.status_changed_at = now
        self.db.commit()
        self.db.refresh(row)
        return row

    def rollback(self, strategy_id: str, to_version: int, *, approved_by: str, note: Optional[str] = None) -> StrategyVersion:
        """Re-instate the configuration of a previously validated (or baseline) version as a new
        version. Needs a named human approver; it is never an autonomous action."""
        target = self.get(strategy_id, to_version)
        if target is None:
            raise LookupError("target version not found")
        was_validated = bool((target.evidence or {}).get("validated_at")) or target.created_by == "system:baseline"
        if not was_validated:
            raise ValueError("only a previously validated or baseline version can be rolled back to")
        if not (approved_by or "").strip():
            raise ValueError("approved_by is required")
        hist = self.history(strategy_id)
        row = StrategyVersion(
            strategy_id=strategy_id, version=hist[-1].version + 1, status="validated",
            config=dict(target.config or {}), config_sha256=target.config_sha256,
            parent_version=target.version,
            change_reason=f"rollback to version {to_version}: {note or 'no note'}"[:2000],
            change_diff=diff_config((self.effective_version(strategy_id) or target).config, dict(target.config or {})),
            evidence={
                "rollback_of": to_version, "validated_at": (target.evidence or {}).get("validated_at") or iso(utcnow()),
                "validation": (target.evidence or {}).get("validation"), "transitions": [],
            },
            created_by=approved_by.strip()[:64],
        )
        self.db.add(row)
        self.db.commit()
        return self.transition(strategy_id, row.version, "active", actor=approved_by, actor_kind="user", note="rollback")

    # -- controlled learning proposals --------------------------------------------------------
    def propose_from_learning(
        self,
        strategy_id: str,
        *,
        health: dict[str, Any],
        regime_stats: dict[str, dict[str, Any]],
        n_closed: int,
    ) -> Optional[StrategyVersion]:
        """Create at most one conservative *proposal*; returns None when evidence is not enough."""
        if n_closed < int(self.settings.memory_min_trades_for_change):
            return None
        if health.get("status") not in ("WEAKENING", "DEGRADED", "BROKEN"):
            return None
        base = self.ensure_baseline(strategy_id) or self.effective_version(strategy_id)
        if base is None:
            return None
        hist = self.history(strategy_id)
        if any(v.status in ("proposed", "candidate") for v in hist):
            return None
        cutoff = utcnow() - timedelta(hours=int(self.settings.memory_proposal_cooldown_hours))
        if any(v.created_by == "system:learning" and as_utc(v.created_at) >= cutoff for v in hist):  # type: ignore[operator]
            return None

        cfg = json.loads(json.dumps(base.config or {}))
        factor = 0.5 if health.get("status") in ("DEGRADED", "BROKEN") else 0.75
        cur = float(cfg.get("risk_per_trade_pct", 1.0))
        new_risk = round(max(0.1, cur * factor), 4)
        if new_risk < cur:
            cfg["risk_per_trade_pct"] = new_risk
        avoid = list(cfg.get("avoid_regimes") or [])
        flagged = []
        for regime, s in (regime_stats or {}).items():
            if regime != "unknown" and s.get("n", 0) >= 10 and s.get("ev_net", 0.0) < 0 and regime not in avoid:
                avoid.append(regime)
                flagged.append(regime)
        if flagged:
            cfg["avoid_regimes"] = avoid
        if cfg == (base.config or {}):
            return None
        return self.create_version(
            strategy_id, cfg,
            reason=(
                f"Edge health {health.get('status')} over {n_closed} closed trades: reduce risk per trade and "
                f"avoid regimes with negative net expectancy ({', '.join(flagged) or 'none flagged'}). "
                "Proposal only - requires validation and human approval."
            ),
            created_by="system:learning", actor_kind="system", parent_version=base.version,
            evidence={
                "health": health, "n_closed": n_closed, "regime_stats": regime_stats,
                "basis": "closed live/paper trades up to proposal time",
                "conservative_only": True,
            },
        )
