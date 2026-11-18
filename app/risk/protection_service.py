"""ETI CAPITAL PROTECTION SYSTEM — persistence and orchestration.

Builds the account snapshot from the database (never from request data), loads
the strategy gate and news calendar, runs the pure decision core, latches halts,
and manages the strategy quarantine lifecycle with a hash-chained audit trail.

Independence: this module imports no language-model, council, signal-engine or
adaptive-edge code. Releasing a halt or a quarantine requires a
``HumanAuthorization`` that only ``authorize_admin`` can create from the
separate ``CPS_ADMIN_KEY`` secret.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional

from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.models import (
    JournalEntry, Position, ProtectionAuditRecord, ProtectionNewsEvent, ProtectionStateRecord,
    StrategyQuarantineRecord, StrategyTradeLog,
)
from app.risk.protection import (
    AccountSnapshot, NewsContext, NewsEvent, OpenPosition, OrderIntent, ProtectionVerdict, Rule,
    StrategyGate, assess_emergency, default_stop_for, evaluate_order_safe, find_stop_breaches,
    find_unprotected, liquidation_intents, _refuse,
)
from app.risk.protection_policy import ProtectionPolicy, policy_from_settings
from app.risk.quarantine import (
    HumanAuthorization, QuarantineConfig, QuarantineReason, StrategyExpectations, StrategyLiveStats,
    StrategyStatus, check_revalidation, evaluate_strategy,
)

logger = logging.getLogger("eti.capital_protection")

NEWS_FRESH_HOURS = 48
OBS_KEEP = 20
FLAG_LOOKBACK_HOURS = 24


def base_equity(settings: Settings, environment: str) -> float:
    """Starting equity baseline (mirrors app.trading.risk_context.base_equity; duplicated to avoid an import cycle)."""
    if (environment or "").lower() == "live":
        return float(settings.live_account_equity or 0.0)
    return float(settings.paper_starting_equity)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _naive(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc).replace(tzinfo=None) if dt.tzinfo else dt


def _aware(dt: Optional[datetime]) -> Optional[datetime]:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def authorize_admin(settings: Settings, provided_key: Optional[str]) -> Optional[HumanAuthorization]:
    """Create a human authorisation from the dedicated admin secret, or None.

    Fails closed: no admin key configured, a key equal to the general API key (the key an agent holds),
    a key shorter than 16 characters, or a wrong key all yield None.
    """
    expected = (getattr(settings, "cps_admin_key", None) or "").strip()
    api_key = (getattr(settings, "api_key", None) or "").strip()
    if len(expected) < 16 or expected == api_key or not provided_key:
        return None
    if not hmac.compare_digest(provided_key.encode("utf-8"), expected.encode("utf-8")):
        return None
    return HumanAuthorization(reviewer="admin", actor_type="human", issued_at=_utcnow().isoformat())


@dataclass
class SweepReport:
    environment: str
    emergency: bool = False
    emergency_reasons: list[str] = field(default_factory=list)
    halted: bool = False
    stop_breaches: list[str] = field(default_factory=list)
    default_stops_attached: list[str] = field(default_factory=list)
    quarantined: list[str] = field(default_factory=list)
    liquidations: list[OrderIntent] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "environment": self.environment, "emergency": self.emergency,
            "emergency_reasons": self.emergency_reasons, "halted": self.halted,
            "stop_breaches": self.stop_breaches, "default_stops_attached": self.default_stops_attached,
            "quarantined": self.quarantined,
            "liquidations": [f"{i.side} {i.qty} {i.symbol}" for i in self.liquidations],
        }


class CapitalProtectionService:
    def __init__(self, db: Optional[Session], settings: Optional[Settings] = None):
        self.db = db
        self.settings = settings or get_settings()
        self.policy: ProtectionPolicy = policy_from_settings(self.settings)

    # ------------------------------------------------------------------ audit (hash chained)
    def audit(self, event_type: str, detail: Optional[dict[str, Any]] = None, actor: str = "system") -> None:
        if self.db is None:
            return
        try:
            last = self.db.query(ProtectionAuditRecord).order_by(ProtectionAuditRecord.id.desc()).first()
            prev = last.hash if last else ""
            at = _naive(_utcnow())
            body = json.dumps({"t": event_type, "a": actor, "d": detail or {}, "p": prev, "at": at.isoformat()},
                              sort_keys=True, default=str, separators=(",", ":"))
            self.db.add(ProtectionAuditRecord(
                event_type=event_type, actor=actor, detail=detail or {}, prev_hash=prev,
                hash=hashlib.sha256(body.encode("utf-8")).hexdigest(), created_at=at,
            ))
            self.db.commit()
        except Exception:  # audit failure must never block protection itself
            self.db.rollback()
            logger.warning("capital protection audit write failed", exc_info=True)

    def verify_audit_chain(self) -> dict[str, Any]:
        if self.db is None:
            return {"ok": True, "records": 0}
        prev = ""
        count = 0
        for row in self.db.query(ProtectionAuditRecord).order_by(ProtectionAuditRecord.id.asc()).all():
            body = json.dumps({"t": row.event_type, "a": row.actor, "d": row.detail or {}, "p": prev,
                               "at": row.created_at.isoformat()}, sort_keys=True, default=str, separators=(",", ":"))
            if row.prev_hash != prev or row.hash != hashlib.sha256(body.encode("utf-8")).hexdigest():
                return {"ok": False, "broken_at_id": row.id, "records": count}
            prev = row.hash
            count += 1
        return {"ok": True, "records": count}

    # ------------------------------------------------------------------ key/value state
    def _get(self, key: str) -> Optional[dict[str, Any]]:
        if self.db is None:
            return None
        row = self.db.query(ProtectionStateRecord).filter(ProtectionStateRecord.key == key).one_or_none()
        return dict(row.value or {}) if row else None

    def _set(self, key: str, value: dict[str, Any]) -> None:
        if self.db is None:
            return
        row = self.db.query(ProtectionStateRecord).filter(ProtectionStateRecord.key == key).one_or_none()
        if row is None:
            self.db.add(ProtectionStateRecord(key=key, value=value))
        else:
            row.value = value
            row.updated_at = _naive(_utcnow())
        self.db.commit()

    # ------------------------------------------------------------------ halt latch
    def halt_state(self, environment: str) -> dict[str, Any]:
        state = self._get(f"halt:{environment}") or {}
        return {"halted": bool(state.get("halted")), "reason": state.get("reason", ""), "at": state.get("at")}

    def halt(self, environment: str, reason: str, actor: str = "system") -> None:
        """Latch a halt. Tightening is always allowed and needs no authorisation."""
        current = self.halt_state(environment)
        if current["halted"]:
            return
        self._set(f"halt:{environment}", {"halted": True, "reason": reason, "at": _utcnow().isoformat()})
        self.audit("HALT", {"environment": environment, "reason": reason}, actor)
        logger.error("CAPITAL PROTECTION HALT [%s]: %s", environment, reason)

    def reset_halt(self, environment: str, auth: HumanAuthorization, note: str) -> dict[str, Any]:
        auth.require()
        if len((note or "").strip()) < 10:
            raise ValueError("A written note (>= 10 characters) explaining the review is required")
        # Resetting re-bases the high-water mark so drawdown restarts from the post-incident equity.
        snap = self.build_account_snapshot(environment, persist_peak=False)
        self._set(f"peak:{environment}", {"equity": snap.equity})
        self._set(f"halt:{environment}", {"halted": False, "reason": "", "at": None, "released_by": auth.reviewer})
        self.audit("HALT_RELEASED", {"environment": environment, "note": note}, auth.reviewer)
        return self.halt_state(environment)

    # ------------------------------------------------------------------ account snapshot
    def build_account_snapshot(self, environment: str, *, persist_peak: bool = True) -> AccountSnapshot:
        env = (environment or "paper").lower()
        if self.db is None:
            return AccountSnapshot(equity=0.0, peak_equity=0.0, source="unavailable")
        start = base_equity(self.settings, env)
        positions_rows = self.db.query(Position).filter(Position.environment == env).all()
        realized_total = sum(p.realized_pnl for p in positions_rows)
        open_rows = [p for p in positions_rows if p.status == "open" and p.qty > 0]
        unrealized = sum(p.unrealized_pnl for p in open_rows)
        equity = start + realized_total + unrealized if start > 0 else 0.0

        stored_peak = float((self._get(f"peak:{env}") or {}).get("equity") or 0.0)
        peak = max(stored_peak, equity, start)
        if persist_peak and peak > stored_peak + 1e-9:
            self._set(f"peak:{env}", {"equity": peak})
        drawdown = max(0.0, (peak - equity) / peak * 100.0) if peak > 0 else 0.0

        now = _utcnow()
        day_start = _naive(now.replace(hour=0, minute=0, second=0, microsecond=0))
        week_start = _naive((now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0))
        closed = (
            self.db.query(JournalEntry)
            .filter(JournalEntry.environment == env, JournalEntry.event == "closed", JournalEntry.created_at >= week_start)
            .all()
        )
        daily_realized = sum((j.pnl or 0.0) for j in closed if j.created_at >= day_start)
        weekly_realized = sum((j.pnl or 0.0) for j in closed)
        open_loss = min(0.0, unrealized)  # open losses count in full; open gains earn no credit
        daily_pct = (daily_realized + open_loss) / equity * 100.0 if equity > 0 else 0.0
        weekly_pct = (weekly_realized + open_loss) / equity * 100.0 if equity > 0 else 0.0

        streak, last_loss_at = self._loss_streak(env)
        halt = self.halt_state(env)
        positions = tuple(
            OpenPosition(
                provider=p.provider, symbol=p.symbol, side=p.side, qty=p.qty,
                price=float(p.mark_price or p.avg_entry or 0.0), avg_entry=float(p.avg_entry or 0.0),
                stop_loss=_as_float((p.meta or {}).get("stop_loss")),
                strategy_id=(p.meta or {}).get("strategy_id"),
            )
            for p in open_rows
        )
        return AccountSnapshot(
            equity=equity, peak_equity=peak, daily_pnl_pct=daily_pct, weekly_pnl_pct=weekly_pct,
            drawdown_pct=drawdown, positions=positions, consecutive_losses=streak, last_loss_at=last_loss_at,
            halted=halt["halted"], halt_reason=halt["reason"], source="database",
        )

    def external_snapshot(self, key: str, *, equity: float, start_equity: float, positions: tuple,
                          source: str = "database", halt_environment: Optional[str] = None) -> AccountSnapshot:
        """Account snapshot for an account tracked outside the ETI portfolio tables (e.g. the internal paper engine).

        Equity and positions come from that account itself; the high-water mark, drawdown, halt latch are kept here.
        Daily/weekly P&L and the loss streak are not available from such accounts and are reported as zero.
        """
        if self.db is None or equity <= 0 or start_equity <= 0:
            return AccountSnapshot(equity=max(0.0, equity), peak_equity=max(0.0, equity), source="unavailable")
        stored_peak = float((self._get(f"peak:{key}") or {}).get("equity") or 0.0)
        peak = max(stored_peak, equity, start_equity)
        if peak > stored_peak + 1e-9:
            self._set(f"peak:{key}", {"equity": peak})
        halt = self.halt_state(halt_environment or key)
        return AccountSnapshot(
            equity=equity, peak_equity=peak, drawdown_pct=max(0.0, (peak - equity) / peak * 100.0),
            positions=positions, halted=halt["halted"], halt_reason=halt["reason"], source=source,
        )

    def _loss_streak(self, env: str) -> tuple[int, Optional[datetime]]:
        rows = (
            self.db.query(JournalEntry)
            .filter(JournalEntry.environment == env, JournalEntry.event == "closed", JournalEntry.pnl.isnot(None))
            .order_by(JournalEntry.created_at.desc(), JournalEntry.id.desc())
            .limit(50)
            .all()
        )
        streak, last_loss = 0, None
        for r in rows:
            if r.pnl < 0:
                streak += 1
                last_loss = last_loss or _aware(r.created_at)
            else:
                break
        return streak, last_loss

    # ------------------------------------------------------------------ news / strategies
    def news_context(self, now: Optional[datetime] = None) -> NewsContext:
        if self.db is None:
            return NewsContext(status="unavailable")
        now = now or _utcnow()
        beat = self._get("news_calendar")
        if not beat or not beat.get("refreshed_at"):
            status = "not_configured"
        else:
            refreshed = datetime.fromisoformat(beat["refreshed_at"])
            status = "ok" if (now - _aware(refreshed)) <= timedelta(hours=NEWS_FRESH_HOURS) else "stale"
        lo = _naive(now - timedelta(days=1))
        hi = _naive(now + timedelta(days=2))
        rows = (
            self.db.query(ProtectionNewsEvent)
            .filter(ProtectionNewsEvent.event_at >= lo, ProtectionNewsEvent.event_at <= hi)
            .all()
        )
        events = tuple(
            NewsEvent(title=r.title, at=_aware(r.event_at), impact=r.impact or "high", scope=tuple(r.scope or ["*"]))
            for r in rows
        )
        return NewsContext(status=status, events=events)

    def replace_news_calendar(self, events: Iterable[dict[str, Any]], auth: HumanAuthorization) -> int:
        """Refresh the upcoming-event calendar (also the freshness heartbeat). Admin only."""
        auth.require()
        now = _utcnow()
        self.db.query(ProtectionNewsEvent).filter(ProtectionNewsEvent.event_at >= _naive(now - timedelta(days=1))).delete()
        count = 0
        for ev in events:
            at = _aware(datetime.fromisoformat(str(ev["at"]).replace("Z", "+00:00")))
            self.db.add(ProtectionNewsEvent(
                title=str(ev["title"])[:256], impact=str(ev.get("impact", "high")).lower(),
                scope=[str(s).upper() for s in (ev.get("scope") or ["*"])], event_at=_naive(at),
                created_by=auth.reviewer,
            ))
            count += 1
        self.db.commit()
        self._set("news_calendar", {"refreshed_at": now.isoformat(), "count": count})
        self.audit("NEWS_CALENDAR_REPLACED", {"count": count}, auth.reviewer)
        return count

    def strategy_gate(self) -> StrategyGate:
        if self.db is None:
            return StrategyGate({})
        rows = self.db.query(StrategyQuarantineRecord).all()
        return StrategyGate({r.strategy_id: r.status for r in rows})

    # ------------------------------------------------------------------ the order gate
    def check_order(self, intent: OrderIntent, *, fallback: Optional[AccountSnapshot] = None,
                    now: Optional[datetime] = None) -> ProtectionVerdict:
        """Evaluate an order against the ETI portfolio in the database. Never raises; every failure is a refusal."""
        now = now or _utcnow()
        try:
            env = intent.environment.lower()
            if self.db is not None:
                account = self.build_account_snapshot(env)
            elif fallback is not None and env != "live":
                account = fallback  # unit tests / no-database contexts; never allowed for live
            else:
                return _refuse(self.policy, now, Rule.ACCOUNT_STATE_UNAVAILABLE,
                               "Account state unavailable (no database); order refused")
        except Exception as exc:  # noqa: BLE001
            logger.error("capital protection account snapshot failed", exc_info=True)
            return self._finish(intent, _refuse(self.policy, now, Rule.INTERNAL_ERROR,
                                                f"Capital protection error ({type(exc).__name__}); order refused"))
        return self.check_with_account(intent, account, now=now)

    def check_with_account(self, intent: OrderIntent, account: AccountSnapshot,
                           now: Optional[datetime] = None) -> ProtectionVerdict:
        """Evaluate an order against a caller-built account snapshot (e.g. live broker equity and positions)."""
        now = now or _utcnow()
        try:
            verdict = evaluate_order_safe(
                intent, account, self.policy, now=now, news=self.news_context(now), strategies=self.strategy_gate(),
            )
        except Exception as exc:  # noqa: BLE001
            logger.error("capital protection check failed", exc_info=True)
            verdict = _refuse(self.policy, now, Rule.INTERNAL_ERROR,
                              f"Capital protection error ({type(exc).__name__}); order refused")
        return self._finish(intent, verdict)

    def _finish(self, intent: OrderIntent, verdict: ProtectionVerdict) -> ProtectionVerdict:
        if not verdict.approved:
            self.audit("ORDER_REFUSED", {
                "symbol": intent.symbol, "side": intent.side, "qty": intent.qty, "environment": intent.environment,
                "strategy_id": intent.strategy_id, "violations": verdict.violations, "policy": verdict.policy_fingerprint,
            })
        return verdict

    # ------------------------------------------------------------------ continuous sweep
    def sweep(self, environment: str) -> SweepReport:
        """Emergency rules + stop-loss enforcement for one environment. Returns exits to execute."""
        env = environment.lower()
        report = SweepReport(environment=env)
        if self.db is None:
            return report
        account = self.build_account_snapshot(env)

        # attach default protective stops to legacy positions that have none (stop-loss enforcement)
        unprotected = find_unprotected(account.positions)
        if unprotected:
            for p in unprotected:
                row = (self.db.query(Position).filter(
                    Position.provider == p.provider, Position.environment == env,
                    Position.symbol == p.symbol, Position.status == "open").one_or_none())
                if row is not None:
                    meta = dict(row.meta or {})
                    meta["stop_loss"] = default_stop_for(p, self.policy)
                    meta["stop_source"] = "capital_protection_default"
                    row.meta = meta
                    report.default_stops_attached.append(p.symbol)
            self.db.commit()
            self.audit("DEFAULT_STOPS_ATTACHED", {"environment": env, "symbols": report.default_stops_attached})
            account = self.build_account_snapshot(env)

        # Without a configured equity baseline (e.g. LIVE_ACCOUNT_EQUITY unset) loss and drawdown cannot be
        # measured; entries are already refused (EQUITY_UNKNOWN), so no spurious emergency latch is raised.
        measurable = base_equity(self.settings, env) > 0
        em = assess_emergency(account, self.policy) if measurable else assess_emergency(
            AccountSnapshot(equity=1.0, peak_equity=1.0), self.policy)
        if em.triggered:
            report.emergency, report.emergency_reasons = True, em.reasons
            self.halt(env, "; ".join(em.reasons))
            report.halted = True
            if self.policy.auto_liquidate_on_emergency:
                report.liquidations = liquidation_intents(account.positions, env, source="emergency_liquidation")
                self.audit("EMERGENCY_LIQUIDATION", {"environment": env, "reasons": em.reasons,
                                                     "positions": [p.symbol for p in account.positions]})
                return report

        breaches = find_stop_breaches(account.positions)
        if breaches and self.policy.auto_liquidate_on_stop_breach:
            report.stop_breaches = [p.symbol for p in breaches]
            report.liquidations = liquidation_intents(breaches, env, source="stop_loss_enforcement")
            self.audit("STOP_LOSS_BREACH", {"environment": env, "symbols": report.stop_breaches})

        report.halted = report.halted or account.halted
        report.quarantined = self.evaluate_all_strategies()
        return report

    # ------------------------------------------------------------------ strategies
    def _record(self, strategy_id: str) -> Optional[StrategyQuarantineRecord]:
        return self.db.query(StrategyQuarantineRecord).filter(StrategyQuarantineRecord.strategy_id == strategy_id).one_or_none()

    def _transition(self, rec: StrategyQuarantineRecord, to: StrategyStatus, actor: str, detail: dict[str, Any]) -> None:
        history = list(rec.history or [])
        history.append({"at": _utcnow().isoformat(), "from": rec.status, "to": to.value, "actor": actor, "detail": detail})
        rec.history = history[-200:]
        rec.status = to.value
        self.db.commit()
        self.audit("STRATEGY_" + to.value, {"strategy_id": rec.strategy_id, **detail}, actor)

    def register_strategy(self, strategy_id: str, expectations: StrategyExpectations, auth: HumanAuthorization) -> dict[str, Any]:
        """Enable a strategy to trade. Human-authorised: a strategy cannot register (or re-enable) itself."""
        auth.require()
        problems = expectations.validate()
        if problems:
            raise ValueError("; ".join(problems))
        rec = self._record(strategy_id)
        if rec is not None and rec.status != StrategyStatus.ACTIVE.value:
            raise ValueError(f"Strategy is {rec.status}; use the review / revalidation workflow instead of re-registering")
        if rec is None:
            rec = StrategyQuarantineRecord(strategy_id=strategy_id, status=StrategyStatus.ACTIVE.value,
                                           expectations=expectations.to_dict(), history=[])
            self.db.add(rec)
        else:
            rec.expectations = expectations.to_dict()
        self.db.commit()
        self.audit("STRATEGY_REGISTERED", {"strategy_id": strategy_id, "expectations": expectations.to_dict()}, auth.reviewer)
        return self.strategy_view(strategy_id)

    def quarantine(self, strategy_id: str, reasons: list[dict[str, Any]], actor: str = "system") -> bool:
        """Quarantine (tighten). Needs no authorisation; idempotent."""
        rec = self._record(strategy_id)
        if rec is None or rec.status == StrategyStatus.QUARANTINED.value:
            return False
        rec.reasons = reasons
        rec.quarantined_at = _naive(_utcnow())
        rec.review = None
        self._transition(rec, StrategyStatus.QUARANTINED, actor, {"reasons": reasons})
        return True

    def observe(self, strategy_id: str, *, regime: Optional[str] = None, atr_pct: Optional[float] = None,
                integrity_flags: Iterable[str] = (), assumption_flags: Iterable[str] = ()) -> None:
        """Record market-assumption and data-integrity observations for a strategy (called by signal paths)."""
        if self.db is None or self._record(strategy_id) is None:
            return
        key = f"obs:{strategy_id}"
        obs = self._get(key) or {"regimes": [], "atr": [], "flags": []}
        if regime:
            obs["regimes"] = (obs["regimes"] + [regime])[-OBS_KEEP:]
        if atr_pct is not None:
            obs["atr"] = (obs["atr"] + [float(atr_pct)])[-OBS_KEEP:]
        now = _utcnow().isoformat()
        for f in integrity_flags:
            obs["flags"].append({"kind": "integrity", "flag": f, "at": now})
        for f in assumption_flags:
            obs["flags"].append({"kind": "assumption", "flag": f, "at": now})
        obs["flags"] = obs["flags"][-100:]
        self._set(key, obs)

    def live_stats(self, strategy_id: str, environment: str, *, since: Optional[datetime] = None) -> StrategyLiveStats:
        env = environment.lower()
        q = self.db.query(JournalEntry).filter(JournalEntry.environment == env, JournalEntry.event == "closed",
                                               JournalEntry.pnl.isnot(None))
        if since is not None:
            q = q.filter(JournalEntry.created_at >= _naive(since))
        closed = q.order_by(JournalEntry.created_at.asc(), JournalEntry.id.asc()).limit(2000).all()
        pnls = tuple(float(j.pnl) for j in closed if (j.payload or {}).get("strategy_id") == strategy_id)

        t = self.db.query(StrategyTradeLog).filter(StrategyTradeLog.strategy_id == strategy_id, StrategyTradeLog.environment == env)
        if since is not None:
            t = t.filter(StrategyTradeLog.created_at >= _naive(since))
        logs = t.order_by(StrategyTradeLog.created_at.asc(), StrategyTradeLog.id.asc()).limit(2000).all()
        slippage = tuple(float(x.slippage_bps) for x in logs if x.slippage_bps is not None)
        outcomes = tuple(
            "provider_error" if x.outcome == "provider_error" else "filled"
            for x in logs if x.outcome in ("filled", "submitted", "provider_error")
        )

        obs = self._get(f"obs:{strategy_id}") or {}
        cutoff = _utcnow() - timedelta(hours=FLAG_LOOKBACK_HOURS)
        recent = [f for f in obs.get("flags", []) if _aware(datetime.fromisoformat(f["at"])) >= cutoff]
        return StrategyLiveStats(
            trades_pnl=pnls, base_equity=base_equity(self.settings, env), slippage_bps=slippage,
            exec_outcomes=outcomes, regimes=tuple(obs.get("regimes", [])), atr_pct_obs=tuple(obs.get("atr", [])),
            integrity_flags=tuple(f["flag"] for f in recent if f["kind"] == "integrity"),
            assumption_flags=tuple(f["flag"] for f in recent if f["kind"] == "assumption"),
        )

    def evaluate_strategy(self, strategy_id: str, *, config: QuarantineConfig = QuarantineConfig()) -> dict[str, Any]:
        rec = self._record(strategy_id)
        if rec is None:
            raise KeyError(strategy_id)
        exp = StrategyExpectations.from_dict(rec.expectations or {})
        results: dict[str, Any] = {}
        findings: list[dict[str, Any]] = []
        if rec.status in (StrategyStatus.ACTIVE.value, StrategyStatus.REVALIDATING.value):
            since = (_aware(rec.quarantined_at) if rec.status == StrategyStatus.REVALIDATING.value
                     else _aware(rec.baseline_at))
            envs = ("paper", "testnet") if rec.status == StrategyStatus.REVALIDATING.value else ("live", "paper", "testnet")
            for env in envs:
                decision = evaluate_strategy(exp, self.live_stats(strategy_id, env, since=since), config=config)
                results[env] = decision.to_dict()
                for f in decision.findings:
                    findings.append({"environment": env, "reason": f.reason, "detail": f.detail})
            if findings:
                self.quarantine(strategy_id, findings)
        return {"strategy_id": strategy_id, "quarantined_now": bool(findings), "findings": findings,
                "status": self._record(strategy_id).status, "evaluations": results}

    def evaluate_all_strategies(self) -> list[str]:
        tripped: list[str] = []
        for rec in self.db.query(StrategyQuarantineRecord).all():
            if rec.status in (StrategyStatus.ACTIVE.value, StrategyStatus.REVALIDATING.value):
                try:
                    if self.evaluate_strategy(rec.strategy_id)["quarantined_now"]:
                        tripped.append(rec.strategy_id)
                except Exception:
                    logger.warning("strategy evaluation failed for %s", rec.strategy_id, exc_info=True)
                    # an unevaluable strategy is not trusted
                    self.quarantine(rec.strategy_id, [{"reason": QuarantineReason.DATA_INTEGRITY.value,
                                                       "detail": "Strategy evaluation failed; quarantined fail-closed"}])
                    tripped.append(rec.strategy_id)
        return tripped

    def begin_review(self, strategy_id: str, auth: HumanAuthorization) -> dict[str, Any]:
        auth.require()
        rec = self._record(strategy_id)
        if rec is None or rec.status != StrategyStatus.QUARANTINED.value:
            raise ValueError("Only a QUARANTINED strategy can enter review")
        rec.review = {"reviewer": auth.reviewer, "started_at": _utcnow().isoformat()}
        self._transition(rec, StrategyStatus.UNDER_REVIEW, auth.reviewer, {})
        return self.strategy_view(strategy_id)

    def approve_revalidation(self, strategy_id: str, auth: HumanAuthorization, root_cause: str, notes: str) -> dict[str, Any]:
        auth.require()
        rec = self._record(strategy_id)
        if rec is None or rec.status != StrategyStatus.UNDER_REVIEW.value:
            raise ValueError("Strategy must be UNDER_REVIEW to approve revalidation")
        if len(root_cause.strip()) < 20 or len(notes.strip()) < 20:
            raise ValueError("root_cause and notes must each be at least 20 characters")
        review = dict(rec.review or {})
        review.update(root_cause=root_cause.strip(), notes=notes.strip(), approved_for_revalidation_at=_utcnow().isoformat())
        rec.review = review
        self._transition(rec, StrategyStatus.REVALIDATING, auth.reviewer, {"root_cause": root_cause.strip()})
        return self.strategy_view(strategy_id)

    def complete_revalidation(self, strategy_id: str, auth: HumanAuthorization,
                              config: QuarantineConfig = QuarantineConfig()) -> dict[str, Any]:
        """Release to ACTIVE only if fresh post-quarantine evidence passes every test AND a human signs off."""
        auth.require()
        rec = self._record(strategy_id)
        if rec is None or rec.status != StrategyStatus.REVALIDATING.value:
            raise ValueError("Strategy must be REVALIDATING to complete revalidation")
        exp = StrategyExpectations.from_dict(rec.expectations or {})
        since = _aware(rec.quarantined_at)
        # Evidence must come from paper/testnet trades recorded after the quarantine; pool them chronologically.
        pnls: list[float] = []
        slippage: list[float] = []
        outcomes: list[str] = []
        base = base_equity(self.settings, "paper")
        for env in ("paper", "testnet"):
            s = self.live_stats(strategy_id, env, since=since)
            pnls += list(s.trades_pnl)
            slippage += list(s.slippage_bps)
            outcomes += list(s.exec_outcomes)
        obs_stats = self.live_stats(strategy_id, "paper", since=since)
        stats = StrategyLiveStats(
            trades_pnl=tuple(pnls), base_equity=base, slippage_bps=tuple(slippage), exec_outcomes=tuple(outcomes),
            regimes=obs_stats.regimes, atr_pct_obs=obs_stats.atr_pct_obs,
            integrity_flags=obs_stats.integrity_flags, assumption_flags=obs_stats.assumption_flags,
        )
        result = check_revalidation(exp, stats, quarantined_at=since, config=config)
        if not result.passed:
            self.audit("REVALIDATION_FAILED", {"strategy_id": strategy_id, "failures": result.failures}, auth.reviewer)
            return {"released": False, "failures": result.failures, "metrics": result.metrics, "status": rec.status}
        rec.reasons = None
        rec.quarantined_at = None
        rec.baseline_at = _naive(_utcnow())  # monitoring restarts from fresh evidence
        self._transition(rec, StrategyStatus.ACTIVE, auth.reviewer, {"revalidation": result.metrics})
        return {"released": True, "failures": [], "metrics": result.metrics, "status": StrategyStatus.ACTIVE.value}

    def strategy_view(self, strategy_id: str) -> dict[str, Any]:
        rec = self._record(strategy_id)
        if rec is None:
            raise KeyError(strategy_id)
        return {
            "strategy_id": rec.strategy_id, "status": rec.status, "reasons": rec.reasons or [],
            "quarantined_at": rec.quarantined_at.isoformat() if rec.quarantined_at else None,
            "baseline_at": rec.baseline_at.isoformat() if rec.baseline_at else None,
            "expectations": rec.expectations, "review": rec.review, "history": (rec.history or [])[-20:],
        }

    # ------------------------------------------------------------------ strategy trade log
    def log_attempt(self, *, strategy_id: Optional[str], environment: str, provider: str, symbol: str, side: str,
                    qty: float, reference_price: Optional[float], fill_price: Optional[float], outcome: str,
                    client_order_id: Optional[str]) -> None:
        if self.db is None or not strategy_id:
            return
        slip = None
        if reference_price and fill_price and reference_price > 0:
            direction = 1.0 if side == "buy" else -1.0
            slip = (fill_price - reference_price) / reference_price * 10_000.0 * direction  # positive = worse
        try:
            self.db.add(StrategyTradeLog(
                strategy_id=strategy_id, environment=environment, provider=provider, symbol=symbol.upper(), side=side,
                qty=qty, reference_price=reference_price, fill_price=fill_price, slippage_bps=slip, outcome=outcome,
                client_order_id=client_order_id,
            ))
            self.db.commit()
        except Exception:
            self.db.rollback()
            logger.warning("strategy trade log write failed", exc_info=True)

    # ------------------------------------------------------------------ status
    def status(self, environment: str = "paper") -> dict[str, Any]:
        acct = self.build_account_snapshot(environment, persist_peak=False)
        return {
            "system": "ETI CAPITAL PROTECTION SYSTEM",
            "policy": self.policy.to_dict(), "policy_fingerprint": self.policy.fingerprint,
            "environment": environment, "halt": self.halt_state(environment),
            "account": {
                "equity": acct.equity, "peak_equity": acct.peak_equity, "drawdown_pct": round(acct.drawdown_pct, 4),
                "daily_pnl_pct": round(acct.daily_pnl_pct, 4), "weekly_pnl_pct": round(acct.weekly_pnl_pct, 4),
                "open_positions": len(acct.positions), "consecutive_losses": acct.consecutive_losses,
                "unprotected_positions": [p.symbol for p in find_unprotected(acct.positions)],
            },
            "news": {"status": self.news_context().status},
            "strategies": {sid: st for sid, st in self.strategy_gate().statuses.items()},
            "admin_release_configured": _admin_configured(self.settings),
            "audit_chain": self.verify_audit_chain(),
        }


def _admin_configured(settings: Settings) -> bool:
    key = (getattr(settings, "cps_admin_key", None) or "").strip()
    return len(key) >= 16 and key != (getattr(settings, "api_key", None) or "").strip()


def _as_float(x: Any) -> Optional[float]:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if v == v and v not in (float("inf"), float("-inf")) else None
