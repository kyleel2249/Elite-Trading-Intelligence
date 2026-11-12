"""Post-trade learning pipeline.

Every closed position goes through ten steps, each persisted on the ``eti_trades`` row
(``learning.steps``):

 1. original analysis      - signal snapshot captured at entry, hash re-verified at close
 2. actual execution       - every entry/exit fill, order ids, environment
 3. expected vs actual     - entry vs the signal's reference price; exit vs its stop/target
 4. realized P/L           - recomputed from fills and reconciled with the portfolio's own figure
 5. slippage + costs       - entry slippage, exit deviation, estimated fees
 6. assumptions that held  - only objectively checkable assumptions; the rest are 'not_evaluable'
 7. assumptions that failed
 8. market regime          - point-in-time labels at entry and at exit (never looked up from the future)
 9. strategy evaluation    - edge-health statistics over ALL closed trades (not just this one)
10. research/monitoring priorities and lessons updated

What this pipeline deliberately does NOT do: change, activate or retire a strategy. At most it
creates one conservative *proposal* once enough trades exist (see StrategyVersionService).
"""
from __future__ import annotations

import logging
import math
import uuid
from datetime import timedelta
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.memory.assumptions import evaluate_assumptions, split_results
from app.memory.backtests import BacktestMemoryService
from app.memory.lessons import LessonService, PriorityService
from app.memory.models import MemorySignal, MemoryTrade
from app.memory.regimes import RegimeMemoryService
from app.memory.registry import get_or_create_registry
from app.memory.signals import signal_fingerprint
from app.memory.store import MemoryStore
from app.memory.util import append_unique, as_utc, iso, naive_utc, utcnow, wilson_interval
from app.memory.versions import StrategyVersionService

logger = logging.getLogger("eti.memory.learning")

FILL_KINDS = ("open", "add", "reduce", "close", "flip")


def resolve_strategy_id(thesis: Optional[str], council_action: Optional[str]) -> str:
    if thesis and thesis.startswith("StrategyRunner:"):
        parts = thesis.split(":")
        if len(parts) >= 2 and parts[1]:
            return parts[1][:64]
    if council_action:
        return "council"
    return "manual"


def leg_pnl(side: str, entry: float, exit_price: float, qty: float) -> float:
    return (exit_price - entry) * qty if side == "long" else (entry - exit_price) * qty


def _k(key: str) -> str:
    return key[:160]


class TradeLearningService:
    def __init__(self, db: Session, settings: Optional[Settings] = None):
        self.db = db
        self.settings = settings or get_settings()

    # ------------------------------------------------------------------ fill ingestion
    def process_fill(self, event: dict[str, Any]) -> Optional[MemoryTrade]:
        """Entry point called by PortfolioService after a fill has been committed.

        event keys: kind(open|add|reduce|close|flip), provider, environment, symbol, qty, price,
        position_side (open), pnl (realized by this fill), client_order_id, thesis, council_action,
        and for flip: close_qty, remainder_qty, new_side.
        """
        kind = event.get("kind")
        if kind not in FILL_KINDS:
            return None
        provider = str(event.get("provider") or "").lower()
        env = str(event.get("environment") or "").lower()
        symbol = str(event.get("symbol") or "").upper()
        try:
            price = float(event["price"])
            qty = float(event["close_qty"] if kind == "flip" else event["qty"])
        except (KeyError, TypeError, ValueError):
            return None
        if not (math.isfinite(price) and math.isfinite(qty)) or price <= 0 or qty <= 0:
            return None
        ts = as_utc(event.get("ts")) or utcnow()

        trade = self._open_trade(provider, env, symbol)
        if kind == "open":
            if trade is None:
                return self._open(event, provider, env, symbol, price, qty, ts)
            kind = "add"  # defensive: an 'open' while a trade is open behaves like an add
        if trade is None:
            logger.info("no open memory trade for %s %s %s on %s fill; skipped", provider, env, symbol, kind)
            return None

        fill_key = f"{event.get('client_order_id') or 'na'}:{kind}:{qty}:{price}"
        seen = [f.get("fill_key") for f in (trade.entry_fills or [])] + [f.get("fill_key") for f in (trade.exit_fills or [])]
        if fill_key in seen:
            return trade

        if kind == "add":
            return self._add(trade, event, price, qty, ts, fill_key)
        if kind in ("reduce", "close"):
            return self._exit(trade, event, price, qty, ts, closing=(kind == "close"), fill_key=fill_key)
        # flip: close the existing trade, then open the remainder on the other side
        closed = self._exit(trade, event, price, qty, ts, closing=True, fill_key=fill_key)
        remainder = float(event.get("remainder_qty") or 0.0)
        if remainder > 0:
            self._open({**event, "position_side": event.get("new_side")}, provider, env, symbol, price, remainder, ts)
        return closed

    def _open_trade(self, provider: str, env: str, symbol: str) -> Optional[MemoryTrade]:
        return (
            self.db.query(MemoryTrade)
            .filter(
                MemoryTrade.provider == provider, MemoryTrade.environment == env,
                MemoryTrade.symbol == symbol, MemoryTrade.status == "open",
            )
            .order_by(MemoryTrade.opened_at.desc())
            .first()
        )

    @staticmethod
    def _fill(ts: Any, qty: float, price: float, event: dict[str, Any], fill_key: str, **extra: Any) -> dict[str, Any]:
        return {"ts": iso(ts), "qty": qty, "price": price, "client_order_id": event.get("client_order_id"),
                "fill_key": fill_key, **extra}

    def _link_signal(self, symbol: str, provider: str, position_side: str, strategy_id: str, ts: Any) -> Optional[MemorySignal]:
        if strategy_id == "manual":
            return None  # no analysis was claimed for a manual order
        window = int(self.settings.memory_signal_link_window_minutes)
        q = self.db.query(MemorySignal).filter(
            MemorySignal.symbol == symbol, MemorySignal.provider == provider,
            MemorySignal.status == "open", MemorySignal.direction == position_side,
            MemorySignal.as_of >= naive_utc(ts - timedelta(minutes=window)),
            MemorySignal.as_of <= naive_utc(ts),  # the signal must predate the fill
        )
        if strategy_id == "council":
            q = q.filter(MemorySignal.source == "council")
        else:
            q = q.filter(MemorySignal.strategy_id == strategy_id)
        return q.order_by(MemorySignal.as_of.desc()).first()

    def _open(self, event: dict[str, Any], provider: str, env: str, symbol: str, price: float, qty: float, ts: Any) -> MemoryTrade:
        thesis = event.get("thesis")
        council_action = event.get("council_action")
        strategy_id = resolve_strategy_id(thesis, council_action)
        side = event.get("position_side") or ("long" if event.get("side") == "buy" else "short")
        if side not in ("long", "short"):
            side = "long"
        version = StrategyVersionService(self.db, self.settings).ensure_baseline(strategy_id)
        sig = self._link_signal(symbol, provider, side, strategy_id, ts)
        if sig is not None:
            snapshot: dict[str, Any] = {
                "signal_id": sig.signal_id, "source": sig.source, "direction": sig.direction,
                "confidence": sig.confidence, "reference_price": sig.reference_price, "stop_price": sig.stop_price,
                "target_price": sig.target_price, "horizon_seconds": sig.horizon_seconds, "regime": sig.regime,
                "assumptions": sig.assumptions, "analysis": sig.analysis, "as_of": iso(sig.as_of),
                "link_method": "latest_matching_open_signal_before_fill",
            }
            sha: Optional[str] = sig.analysis_sha256
        else:
            snapshot = {"note": "no_prior_signal_record", "thesis": thesis, "council_action": council_action}
            sha = None
        regime_obs = RegimeMemoryService(self.db, self.settings).latest_as_of(symbol, provider, ts)
        regime_entry = regime_obs.primary_regime if regime_obs else (sig.regime if sig else None)
        fill_key = f"{event.get('client_order_id') or 'na'}:open:{qty}:{price}"
        trade = MemoryTrade(
            trade_id=f"trd-{uuid.uuid4().hex[:20]}", signal_id=sig.signal_id if sig else None,
            strategy_id=strategy_id, strategy_version=version.version if version else None,
            provider=provider, environment=env, symbol=symbol, side=side, status="open", data_partition="live",
            entry_qty=qty, open_qty=qty, entry_avg_price=price, entry_notional=price * qty,
            expected_entry_price=sig.reference_price if sig else None,
            entry_fills=[self._fill(ts, qty, price, event, fill_key)], exit_fills=[],
            mfe_price=price, mae_price=price, regime_entry=regime_entry,
            analysis_snapshot=snapshot, analysis_sha256=sha, thesis=thesis, council_action=council_action,
            client_order_ids=append_unique([], event.get("client_order_id")),
            fee_bps_assumed=float(self.settings.memory_fee_bps), fees_estimated=True, opened_at=ts,
        )
        self.db.add(trade)
        if sig is not None:
            sig.status = "executed"
            sig.trade_id = trade.trade_id
        self.db.commit()
        self.db.refresh(trade)
        return trade

    def _add(self, trade: MemoryTrade, event: dict[str, Any], price: float, qty: float, ts: Any, fill_key: str) -> MemoryTrade:
        new_open = trade.open_qty + qty
        trade.entry_avg_price = (trade.entry_avg_price * trade.open_qty + price * qty) / new_open
        trade.open_qty = new_open
        trade.entry_qty = trade.entry_qty + qty
        trade.entry_notional = trade.entry_notional + price * qty
        trade.entry_fills = [*(trade.entry_fills or []), self._fill(ts, qty, price, event, fill_key)]
        trade.client_order_ids = append_unique(trade.client_order_ids, event.get("client_order_id"))
        self._touch_excursion(trade, price)
        self.db.commit()
        self.db.refresh(trade)
        return trade

    @staticmethod
    def _touch_excursion(trade: MemoryTrade, price: float) -> None:
        if trade.mfe_price is None or trade.mae_price is None:
            trade.mfe_price = price
            trade.mae_price = price
            return
        if trade.side == "long":
            trade.mfe_price = max(trade.mfe_price, price)
            trade.mae_price = min(trade.mae_price, price)
        else:
            trade.mfe_price = min(trade.mfe_price, price)
            trade.mae_price = max(trade.mae_price, price)

    def update_excursions(self, marks: dict[tuple[str, str, str], float]) -> int:
        """Track best/worst marked price of open trades (used for stop/target assumption checks)."""
        n = 0
        for t in self.db.query(MemoryTrade).filter(MemoryTrade.status == "open").all():
            px = marks.get((t.provider, t.environment, t.symbol))
            if px is None or not math.isfinite(px) or px <= 0:
                continue
            self._touch_excursion(t, float(px))
            n += 1
        if n:
            self.db.commit()
        return n

    def _exit(self, trade: MemoryTrade, event: dict[str, Any], price: float, qty: float, ts: Any, *, closing: bool, fill_key: str) -> MemoryTrade:
        qty = min(qty, trade.open_qty) if trade.open_qty > 0 else qty
        pnl = leg_pnl(trade.side, trade.entry_avg_price, price, qty)
        trade.exit_fills = [
            *(trade.exit_fills or []),
            self._fill(ts, qty, price, event, fill_key, pnl=pnl, entry_avg=trade.entry_avg_price, reported_pnl=event.get("pnl")),
        ]
        trade.open_qty = max(0.0, trade.open_qty - qty)
        trade.exit_qty_total = trade.exit_qty_total + qty
        trade.exit_notional = trade.exit_notional + price * qty
        trade.gross_pnl = (trade.gross_pnl or 0.0) + pnl
        if event.get("pnl") is not None:
            trade.reported_pnl = (trade.reported_pnl or 0.0) + float(event["pnl"])
        trade.client_order_ids = append_unique(trade.client_order_ids, event.get("client_order_id"))
        self._touch_excursion(trade, price)
        if closing or trade.open_qty <= 1e-12:
            self._finalize(trade, ts)
        self.db.commit()
        self.db.refresh(trade)
        if trade.status == "closed":
            self._post_close(trade)
        return trade

    # ------------------------------------------------------------------ steps 1-8
    def _finalize(self, trade: MemoryTrade, ts: Any) -> None:
        closed = as_utc(ts)
        opened = as_utc(trade.opened_at)
        trade.status = "closed"
        trade.closed_at = closed
        trade.holding_seconds = max(0.0, (closed - opened).total_seconds())  # type: ignore[operator]

        entry_vwap = trade.entry_notional / trade.entry_qty if trade.entry_qty else trade.entry_avg_price
        exit_avg = trade.exit_notional / trade.exit_qty_total if trade.exit_qty_total else None
        trade.exit_avg_price = exit_avg

        gross = float(trade.gross_pnl or 0.0)
        fees = (trade.entry_notional + trade.exit_notional) * trade.fee_bps_assumed / 1e4
        trade.gross_pnl = gross
        trade.fees = fees
        trade.net_pnl = gross - fees
        trade.return_pct = (trade.net_pnl / trade.entry_notional * 100.0) if trade.entry_notional else None
        trade.fees_estimated = True
        if trade.reported_pnl is not None:
            trade.pnl_reconciliation_diff = gross - trade.reported_pnl

        snap = trade.analysis_snapshot or {}
        sign = 1.0 if trade.side == "long" else -1.0
        entry_slip_cost: Optional[float] = None
        if trade.expected_entry_price:
            diff = (entry_vwap - trade.expected_entry_price) * sign  # adverse positive
            trade.entry_slippage_bps = diff / trade.expected_entry_price * 1e4
            entry_slip_cost = diff * trade.entry_qty

        exit_slip_cost: Optional[float] = None
        target, stop = snap.get("target_price"), snap.get("stop_price")
        if exit_avg is not None:
            expected_exit, kind = None, None
            if gross > 0 and target:
                expected_exit, kind = float(target), "vs_target"
            elif gross <= 0 and stop:
                expected_exit, kind = float(stop), "vs_stop"
            if expected_exit:
                diff = (expected_exit - exit_avg) * sign  # adverse positive
                trade.expected_exit_price = expected_exit
                trade.exit_deviation_bps = diff / expected_exit * 1e4
                trade.exit_deviation_kind = kind
                if kind == "vs_stop":
                    exit_slip_cost = diff * trade.exit_qty_total
        if entry_slip_cost is not None or exit_slip_cost is not None:
            trade.slippage_cost = (entry_slip_cost or 0.0) + (exit_slip_cost or 0.0)

        regime_exit_obs = RegimeMemoryService(self.db, self.settings).latest_as_of(trade.symbol, trade.provider, closed)
        trade.regime_exit = regime_exit_obs.primary_regime if regime_exit_obs else None

        if trade.signal_id and trade.analysis_sha256:
            sig = self.db.query(MemorySignal).filter(MemorySignal.signal_id == trade.signal_id).one_or_none()
            trade.analysis_integrity = (
                "verified" if sig is not None and signal_fingerprint(sig) == trade.analysis_sha256 else "mismatch"
            )

        ctx = {
            "side": trade.side, "exit_price": exit_avg, "gross_pnl": gross, "holding_seconds": trade.holding_seconds,
            "stop_price": stop, "target_price": target, "horizon_seconds": snap.get("horizon_seconds"),
            "mfe_price": trade.mfe_price, "mae_price": trade.mae_price,
            "regime_entry": trade.regime_entry, "regime_exit": trade.regime_exit,
            "entry_slippage_bps": trade.entry_slippage_bps,
            "exit_slippage_bps": trade.exit_deviation_bps if trade.exit_deviation_kind == "vs_stop" else None,
            "slippage_alert_bps": self.settings.memory_slippage_alert_bps,
        }
        evaluated = evaluate_assumptions(snap.get("assumptions"), ctx)
        grouped = split_results(evaluated)

        net = trade.net_pnl
        trade.classification = "win" if net > 1e-9 else ("loss" if net < -1e-9 else "breakeven")
        alert = float(self.settings.memory_slippage_alert_bps)
        trade.learning = {
            "version": 1,
            "steps": {
                "original_analysis": {
                    "signal_id": trade.signal_id, "sha256": trade.analysis_sha256, "integrity": trade.analysis_integrity,
                    "had_prior_analysis": trade.signal_id is not None,
                },
                "actual_execution": {
                    "environment": trade.environment, "provider": trade.provider,
                    "entry_fills": len(trade.entry_fills or []), "exit_fills": len(trade.exit_fills or []),
                    "order_ids": list(trade.client_order_ids or []),
                },
                "price_comparison": {
                    "expected_entry": trade.expected_entry_price, "entry_vwap": entry_vwap,
                    "entry_slippage_bps": trade.entry_slippage_bps, "expected_exit": trade.expected_exit_price,
                    "exit_avg": exit_avg, "exit_deviation_bps": trade.exit_deviation_bps,
                    "exit_deviation_kind": trade.exit_deviation_kind,
                },
                "pnl": {
                    "gross": gross, "fees": fees, "net": net, "return_pct": trade.return_pct,
                    "portfolio_reported_gross": trade.reported_pnl, "reconciliation_diff": trade.pnl_reconciliation_diff,
                },
                "costs": {
                    "fee_bps_assumed_per_side": trade.fee_bps_assumed, "fees_estimated": True,
                    "entry_slippage_cost": entry_slip_cost, "exit_stop_slippage_cost": exit_slip_cost,
                    "slippage_alert": bool(trade.entry_slippage_bps is not None and trade.entry_slippage_bps > alert),
                    "note": "slippage is already embedded in fill prices; it is reported, not deducted again",
                },
                "assumptions": grouped,
                "regime": {
                    "entry": trade.regime_entry, "exit": trade.regime_exit,
                    "changed": bool(trade.regime_entry and trade.regime_exit and trade.regime_entry != trade.regime_exit),
                },
            },
            "limitations": [
                "Fees are estimated from MEMORY_FEE_BPS; paper fills carry no real fees.",
                "Stop/target checks use marked prices seen by the MTM job, not tick data.",
                "Regime labels come from the latest point-in-time observation; 'unknown' when none was fresh.",
            ],
        }

    # ------------------------------------------------------------------ steps 9-10
    def strategy_samples(self, strategy_ids: Optional[set[str]] = None, as_of: Any = None) -> dict[str, list[Any]]:
        """Closed live/paper trades as EdgeHealth samples, oldest first. Includes every strategy
        regardless of its current status (no survivorship filter)."""
        from app.adaptive_edge.edge_health import TradeSample

        q = self.db.query(MemoryTrade).filter(MemoryTrade.status == "closed", MemoryTrade.data_partition == "live")
        if strategy_ids:
            q = q.filter(MemoryTrade.strategy_id.in_(list(strategy_ids)))
        if as_of is not None:
            q = q.filter(MemoryTrade.closed_at <= naive_utc(as_of))
        out: dict[str, list[Any]] = {}
        for t in q.order_by(MemoryTrade.closed_at.asc()).all():
            out.setdefault(t.strategy_id, []).append(TradeSample(
                pnl=float(t.gross_pnl or 0.0), win=(t.net_pnl or 0.0) > 0,
                holding_bars=int((t.holding_seconds or 0) // 3600), costs=float(t.fees or 0.0), regime=t.regime_entry,
            ))
        return out

    def _closed_trades(self, strategy_id: str) -> list[MemoryTrade]:
        return (
            self.db.query(MemoryTrade)
            .filter(MemoryTrade.strategy_id == strategy_id, MemoryTrade.status == "closed", MemoryTrade.data_partition == "live")
            .order_by(MemoryTrade.closed_at.asc())
            .all()
        )

    def evaluate_strategy(self, strategy_id: str) -> dict[str, Any]:
        from app.adaptive_edge.edge_health import EdgeHealthMonitor, TradeSample

        trades = self._closed_trades(strategy_id)
        samples = [
            TradeSample(pnl=float(t.gross_pnl or 0.0), win=(t.net_pnl or 0.0) > 0,
                        holding_bars=int((t.holding_seconds or 0) // 3600), costs=float(t.fees or 0.0), regime=t.regime_entry)
            for t in trades
        ]
        reg = get_or_create_registry(self.db, strategy_id) if StrategyVersionService(self.db, self.settings).effective_version(strategy_id) else None
        report = EdgeHealthMonitor().assess(strategy_id, samples, previous_status=reg.health_status if reg else None)

        regime_stats: dict[str, dict[str, Any]] = {}
        for t in trades:
            r = regime_stats.setdefault(t.regime_entry or "unknown", {"n": 0, "wins": 0, "net": 0.0})
            r["n"] += 1
            r["wins"] += 1 if (t.net_pnl or 0.0) > 0 else 0
            r["net"] += float(t.net_pnl or 0.0)
        for r in regime_stats.values():
            r["win_rate"] = round(r["wins"] / r["n"], 4)
            r["ev_net"] = round(r["net"] / r["n"], 6)
            r["evidence"] = "adequate" if r["n"] >= 20 else ("weak" if r["n"] >= 10 else "insufficient")

        divergence = None
        bt = BacktestMemoryService(self.db).latest_validation(strategy_id)
        n = len(trades)
        if bt is not None and bt.win_rate is not None and bt.trades >= 5 and n >= int(self.settings.memory_min_trades_for_change):
            p0 = min(0.95, max(0.05, bt.win_rate))
            p = sum(1 for t in trades if (t.net_pnl or 0.0) > 0) / n
            z = (p - p0) / math.sqrt(p0 * (1 - p0) / n)
            divergence = {"backtest_run": bt.run_id, "backtest_win_rate": bt.win_rate, "live_win_rate": round(p, 4),
                          "z": round(z, 3), "significant": abs(z) > 2.0}
        return {"report": report.to_dict(), "regime_stats": regime_stats, "n_closed": n, "backtest_divergence": divergence}

    def _update_lessons(self, trade: MemoryTrade) -> list[str]:
        svc = LessonService(self.db)
        steps = (trade.learning or {}).get("steps", {})
        grouped = steps.get("assumptions", {})
        regime = trade.regime_entry or "unknown"
        sid = trade.strategy_id
        keys: list[str] = []
        for a in grouped.get("held", []):
            k = _k(f"assumption:{sid}:{a['type']}:{regime}")
            svc.observe(lesson_key=k, category="assumption", strategy_id=sid, subject=a["type"], supports=True,
                        trade_id=trade.trade_id, context={"regime": regime})
            keys.append(k)
        for a in grouped.get("failed", []):
            k = _k(f"assumption:{sid}:{a['type']}:{regime}")
            svc.observe(lesson_key=k, category="assumption", strategy_id=sid, subject=a["type"], supports=False,
                        trade_id=trade.trade_id, context={"regime": regime})
            keys.append(k)
        if regime != "unknown":
            k = _k(f"regime:{sid}:{regime}")
            svc.observe(lesson_key=k, category="regime", strategy_id=sid, subject=regime,
                        supports=(trade.net_pnl or 0.0) > 0, trade_id=trade.trade_id, context={"regime": regime})
            keys.append(k)
        if trade.entry_slippage_bps is not None:
            alert = float(self.settings.memory_slippage_alert_bps)
            k = _k(f"execution:{trade.symbol}:slippage")
            svc.observe(lesson_key=k, category="execution", strategy_id=None, subject=trade.symbol,
                        supports=trade.entry_slippage_bps <= alert, trade_id=trade.trade_id, context={"alert_bps": alert})
            keys.append(k)
        return keys

    def _update_priorities(self, trade: MemoryTrade, ev: dict[str, Any]) -> list[str]:
        pr = PriorityService(self.db)
        sid, regime, tid = trade.strategy_id, trade.regime_entry or "unknown", trade.trade_id
        steps = (trade.learning or {}).get("steps", {})
        grouped = steps.get("assumptions", {})
        touched: list[str] = []

        def bump(key: str, kind: str, title: str, delta: float, **kw: Any) -> None:
            row = pr.bump(_k(key), kind, title, delta=delta, strategy_id=kw.get("strategy_id", sid), trade_id=tid,
                          rationale=kw.get("rationale"), create=delta > 0)
            if row is not None:
                touched.append(row.topic_key)

        for a in grouped.get("failed", []):
            bump(f"research:assumption:{sid}:{a['type']}", "research", f"Why the '{a['type']}' assumption fails for {sid}", 1.0,
                 rationale={"last_detail": a.get("detail")})
        for a in grouped.get("held", []):
            bump(f"research:assumption:{sid}:{a['type']}", "research", "", -0.4)
        if regime != "unknown":
            if (trade.net_pnl or 0.0) < 0:
                bump(f"research:regime:{sid}:{regime}", "research", f"Losses of {sid} in regime '{regime}'", 0.8)
            else:
                bump(f"research:regime:{sid}:{regime}", "research", "", -0.3)
        if steps.get("costs", {}).get("slippage_alert"):
            bump(f"monitoring:execution:{trade.symbol}", "monitoring", f"Execution quality on {trade.symbol}", 1.0, strategy_id=None)
        if steps.get("regime", {}).get("changed"):
            bump(f"monitoring:regime:{trade.symbol}", "monitoring", f"Regime transitions while trading {trade.symbol}", 0.5, strategy_id=None)
        if trade.analysis_integrity == "mismatch":
            bump("monitoring:analysis_integrity", "monitoring", "Original analysis changed after entry", 3.0, strategy_id=None)
        if trade.signal_id is None:
            bump("monitoring:process:unplanned_trades", "monitoring", "Trades opened without a recorded prior analysis", 0.5, strategy_id=None)
        status = (ev.get("report") or {}).get("status")
        if status in ("WEAKENING", "DEGRADED", "BROKEN"):
            bump(f"research:edge:{sid}", "research", f"Edge health of {sid} is {status}", 2.5 if status != "WEAKENING" else 1.5,
                 rationale={"status": status, "n_closed": ev.get("n_closed")})
        return touched

    def _record_failure(self, trade: MemoryTrade) -> Optional[str]:
        if trade.classification != "loss":
            return None
        failed = (((trade.learning or {}).get("steps") or {}).get("assumptions") or {}).get("failed", [])
        row = MemoryStore(self.db).add_event(
            "strategy_failure",
            {
                "trade_id": trade.trade_id, "strategy_id": trade.strategy_id, "strategy_version": trade.strategy_version,
                "symbol": trade.symbol, "net_pnl": trade.net_pnl, "return_pct": trade.return_pct,
                "regime_entry": trade.regime_entry, "regime_exit": trade.regime_exit,
                "failed_assumptions": [f.get("id") for f in failed],
                "interpretation": "evidence of one losing trade - not a verdict on the strategy",
            },
            key=f"failure:{trade.trade_id}", title=f"Losing trade of {trade.strategy_id} on {trade.symbol}",
            tags=[trade.strategy_id, trade.regime_entry or "unknown"], source="learning", commit=False,
        )
        return row.key

    def _post_close(self, trade: MemoryTrade) -> None:
        """Steps 9-10. Failures here never undo the already-committed trade record."""
        try:
            steps = dict((trade.learning or {}).get("steps") or {})
            ev = self.evaluate_strategy(trade.strategy_id)
            lessons = self._update_lessons(trade)
            topics = self._update_priorities(trade, ev)
            failure_key = self._record_failure(trade)

            versions = StrategyVersionService(self.db, self.settings)
            proposal = None
            reg = None
            if versions.effective_version(trade.strategy_id) is not None:
                reg = get_or_create_registry(self.db, trade.strategy_id)
                reg.health_status = ev["report"]["status"]
            self.db.commit()
            if reg is not None:
                proposal = versions.propose_from_learning(
                    trade.strategy_id, health=ev["report"], regime_stats=ev["regime_stats"], n_closed=ev["n_closed"],
                )
            steps["strategy_evaluation"] = {
                "health_status": ev["report"]["status"], "sample_size": ev["n_closed"], "reasons": ev["report"]["reasons"],
                "profit_factor": ev["report"]["profit_factor"], "expected_value": ev["report"]["expected_value"],
                "regime_stats": ev["regime_stats"], "backtest_divergence": ev["backtest_divergence"],
                "policy": "one trade never changes a strategy; changes are proposals gated by sample size and human approval",
            }
            steps["lessons_updated"] = lessons
            steps["priorities_updated"] = topics
            steps["strategy_failure_recorded"] = failure_key
            steps["version_proposal"] = proposal.version if proposal is not None else None
            trade.learning = {**(trade.learning or {}), "steps": steps}
            self.db.commit()
        except Exception:
            self.db.rollback()
            logger.warning("post-close learning failed for %s", trade.trade_id, exc_info=True)

    # ------------------------------------------------------------------ reporting
    def performance(self, strategy_id: Optional[str] = None, environment: Optional[str] = None) -> dict[str, Any]:
        q = self.db.query(MemoryTrade)
        if strategy_id:
            q = q.filter(MemoryTrade.strategy_id == strategy_id)
        if environment:
            q = q.filter(MemoryTrade.environment == environment)
        rows = q.limit(20000).all()
        closed = [t for t in rows if t.status == "closed"]
        wins = [t for t in closed if t.classification == "win"]
        losses = [t for t in closed if t.classification == "loss"]
        gross_win = sum(t.net_pnl or 0.0 for t in wins)
        gross_loss = abs(sum(t.net_pnl or 0.0 for t in losses))
        n = len(closed)
        ci = wilson_interval(len(wins), n)
        slips = [t.entry_slippage_bps for t in closed if t.entry_slippage_bps is not None]

        def grp(attr: str) -> dict[str, Any]:
            g: dict[str, list[MemoryTrade]] = {}
            for t in closed:
                g.setdefault(getattr(t, attr) or "unknown", []).append(t)
            return {k: {"n": len(v), "win_rate": round(sum(1 for t in v if t.classification == "win") / len(v), 4),
                        "net_pnl": round(sum(t.net_pnl or 0.0 for t in v), 6)} for k, v in g.items()}

        return {
            "open_trades": sum(1 for t in rows if t.status == "open"),
            "closed_trades": n, "wins": len(wins), "losses": len(losses),
            "breakeven": n - len(wins) - len(losses),
            "win_rate": round(len(wins) / n, 4) if n else None,
            "win_rate_wilson95": [round(ci[0], 4), round(ci[1], 4)] if ci else None,
            "gross_pnl": round(sum(t.gross_pnl or 0.0 for t in closed), 6),
            "fees_estimated": round(sum(t.fees or 0.0 for t in closed), 6),
            "net_pnl": round(sum(t.net_pnl or 0.0 for t in closed), 6),
            "profit_factor": round(gross_win / gross_loss, 4) if gross_loss > 0 else None,
            "avg_entry_slippage_bps": round(sum(slips) / len(slips), 4) if slips else None,
            "by_strategy": grp("strategy_id"), "by_regime": grp("regime_entry"),
            "notes": [
                "Includes every strategy that ever traded, including later suspended/retired ones (no survivorship filter).",
                "Win rate with fewer than 30 closed trades is not statistically meaningful." if n < 30 else "Sample size adequate for a rough estimate.",
            ],
        }
