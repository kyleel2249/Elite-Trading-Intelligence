"""ExecutionEngine: the only path from a trading signal to a broker order.

MODE 1 intelligence_only -> logs analysis, never creates an order.
MODE 2 assisted          -> stores a proposal; a human approval re-runs every guard on fresh data, then executes.
MODE 3 autonomous        -> executes inside the account's approved instruments, capital limits and risk rules,
                            but only if autonomous execution was explicitly enabled for that account.

Every path ends in `_execute`, which fails closed: missing data, stale data, unknown venue state or an
unconfigured limit means no order.
"""
from __future__ import annotations

import asyncio
import hashlib
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Optional

from . import guards
from .domain import (AccountPolicy, BrokerOrder, BrokerPosition, ExecutionResult, Mode, OrderIntent, OrderStatus,
                     OrderType, Side, utcnow)
from .errors import (OrderRejectedError, PermanentProviderError, PermissionPolicyError, ProviderUnavailableError,
                     TransientProviderError, UnknownOutcomeError)
from .health import CircuitBreaker, retry_async
from .store import AccountRecord, OrderRow, ProposalRow

# (intent, policy, quote, equity, positions, environment) -> (approved, reasons)
RiskGate = Callable[..., Awaitable[tuple]]

UNKNOWN_GRACE_SECONDS = 120
EMERGENCY_SLIPPAGE_BPS = 100.0
_EPS = 1e-12


class ExecutionEngine:
    def __init__(self, store, adapter_factory: Callable[[AccountRecord], object], *,
                 risk_gate: Optional[RiskGate] = None, clock: Callable[[], datetime] = utcnow,
                 sleep: Callable[[float], Awaitable] = asyncio.sleep,
                 kill_switch: Callable[[], bool] = lambda: False,
                 breaker_threshold: int = 3, breaker_cooldown: float = 30.0):
        self.store, self._factory, self.risk_gate = store, adapter_factory, risk_gate
        self.clock, self._sleep, self._kill = clock, sleep, kill_switch
        self._adapters: dict = {}
        self._breakers: dict = {}
        self._locks: dict = {}
        self._perm_checked: set = set()
        self._breaker_args = (breaker_threshold, breaker_cooldown)

    # ------------------------------------------------------------------ plumbing
    def _lock(self, account_id):
        return self._locks.setdefault(account_id, asyncio.Lock())

    def _adapter(self, acct: AccountRecord):
        a = self._adapters.get(acct.account_id)
        if a is None:
            a = self._factory(acct)
            if getattr(a, "environment", None) != acct.environment:
                raise ProviderUnavailableError(
                    f"Adapter environment '{getattr(a, 'environment', '?')}' does not match account "
                    f"environment '{acct.environment}'; refusing to trade")
            self._adapters[acct.account_id] = a
        return a

    def drop_adapter(self, account_id):
        """Forget the cached adapter (after credential rotation or to force a fresh connection)."""
        self._adapters.pop(account_id, None)
        self._perm_checked.discard(account_id)

    def _breaker(self, acct) -> CircuitBreaker:
        key = f"{acct.provider}:{acct.environment}"
        if key not in self._breakers:
            self._breakers[key] = CircuitBreaker(*self._breaker_args, clock=self.clock)
        return self._breakers[key]

    async def _read(self, acct, fn):
        br = self._breaker(acct)
        if not br.allow():
            raise ProviderUnavailableError(f"{acct.provider} appears down (circuit {br.state}); not sending requests")
        try:
            r = await retry_async(fn, attempts=3, sleep=self._sleep)
        except TransientProviderError as e:
            br.record_failure(str(e))
            raise
        br.record_success()
        return r

    async def _write(self, acct, fn):
        br = self._breaker(acct)
        if not br.allow():
            raise ProviderUnavailableError(f"{acct.provider} appears down (circuit {br.state}); not sending orders")
        try:
            r = await fn()
        except TransientProviderError as e:
            br.record_failure(str(e))
            raise
        br.record_success()
        return r

    def _log(self, account_id, event, client_order_id=None, **details):
        self.store.append_log(account_id, event, client_order_id, details)

    def _fail(self, acct_id, reasons, status="rejected", mode=None, event="order_rejected", **kw):
        reasons = list(reasons)
        self._log(acct_id, event, reasons=reasons, **kw)
        return ExecutionResult(status, "; ".join(reasons), mode=mode, reasons=reasons, **{
            k: v for k, v in kw.items() if k in ("client_order_id", "proposal_id")})

    def status(self) -> dict:
        return {"circuit_breakers": {k: b.snapshot() for k, b in self._breakers.items()},
                "global_kill_switch": bool(self._kill()), "adapters_loaded": sorted(self._adapters)}

    # ------------------------------------------------------------------ entry points
    async def submit_signal(self, intent: OrderIntent) -> ExecutionResult:
        acct = self.store.get_account(intent.account_id)
        if acct is None:
            return ExecutionResult("rejected", "Unknown account", reasons=["Unknown account"])
        intent.symbol = intent.symbol.upper()
        mode = acct.policy.mode
        self._log(acct.account_id, "signal_received", mode=mode.value, intent=intent.to_dict())
        if mode == Mode.INTELLIGENCE_ONLY:
            self._log(acct.account_id, "analysis_only", intent=intent.to_dict())
            return ExecutionResult("analysis_only", "Intelligence-only mode: analysis recorded, no order created.",
                                   mode=mode.value)
        if mode == Mode.ASSISTED:
            return await self._propose(acct, intent)
        if not acct.policy.autonomous_enabled:
            return self._fail(acct.account_id, ["Autonomous execution has not been explicitly enabled for this account"],
                              mode=mode.value)
        return await self._execute(acct, intent, origin="autonomous")

    async def _propose(self, acct: AccountRecord, intent: OrderIntent) -> ExecutionResult:
        problems = guards.intent_problems(intent, acct.policy)
        if problems:
            return self._fail(acct.account_id, problems, mode=Mode.ASSISTED.value)
        snap = None
        try:
            q = await self._read(acct, lambda: self._adapter(acct).get_quote(intent.symbol))
            snap = {"bid": q.bid, "ask": q.ask, "ts": q.ts.isoformat()}
        except Exception as e:     # a proposal can still be made; approval re-verifies live data
            snap = {"error": type(e).__name__}
        now = self.clock()
        p = ProposalRow(f"prop-{uuid.uuid4().hex[:16]}", acct.account_id, intent.to_dict(), "pending_approval", now,
                        now + timedelta(seconds=acct.policy.proposal_ttl_seconds), snap)
        self.store.save_proposal(p)
        self._log(acct.account_id, "order_proposed", proposal_id=p.proposal_id, intent=intent.to_dict(),
                  expires_at=p.expires_at.isoformat())
        return ExecutionResult("pending_approval", "Waiting for user approval.", mode=Mode.ASSISTED.value,
                               proposal_id=p.proposal_id)

    async def approve(self, proposal_id: str, approver: str) -> ExecutionResult:
        p = self.store.get_proposal(proposal_id)
        if p is None:
            return ExecutionResult("rejected", "Unknown proposal", reasons=["Unknown proposal"])
        if p.status == "pending_approval" and self.clock() > p.expires_at:
            self.store.claim_proposal(proposal_id, "system", "expired")
            return self._fail(p.account_id, ["Proposal expired; re-propose against current prices"],
                              proposal_id=proposal_id, event="proposal_expired")
        claimed = self.store.claim_proposal(proposal_id, approver, "executing")
        if claimed is None:
            return ExecutionResult("rejected", f"Proposal is {p.status}, not pending", reasons=[f"Proposal is {p.status}"],
                                   proposal_id=proposal_id)
        acct = self.store.get_account(p.account_id)
        intent = OrderIntent.from_dict(p.intent)
        intent.idempotency_key = f"proposal:{proposal_id}"
        if acct is None or acct.policy.mode == Mode.INTELLIGENCE_ONLY:
            self.store.update_proposal(proposal_id, status="failed")
            return self._fail(p.account_id, ["Account no longer permits execution"], proposal_id=proposal_id)
        self._log(acct.account_id, "proposal_approved", proposal_id=proposal_id, approver=approver)
        res = await self._execute(acct, intent, origin="approved", approver=approver)
        res.proposal_id = proposal_id
        ok = res.status in ("submitted", "partially_filled", "filled")
        self.store.update_proposal(proposal_id, status="executed" if ok else "failed", result=res.to_dict())
        return res

    def reject_proposal(self, proposal_id: str, by: str) -> bool:
        p = self.store.claim_proposal(proposal_id, by, "rejected")
        if p:
            self._log(p.account_id, "proposal_rejected", proposal_id=proposal_id, by=by)
        return p is not None

    # ------------------------------------------------------------------ guarded execution
    @staticmethod
    def _idem_key(intent: OrderIntent, policy: AccountPolicy, now: datetime) -> str:
        if intent.idempotency_key:
            return f"{intent.account_id}|{intent.idempotency_key}"
        if intent.signal_id:
            return f"{intent.account_id}|signal|{intent.signal_id}"
        bucket = int(now.timestamp() // max(1, policy.duplicate_window_seconds))
        raw = (f"{intent.account_id}|{intent.symbol}|{intent.side.value}|{intent.qty:.10g}|{intent.order_type.value}|"
               f"{intent.limit_price}|{intent.strategy}|{bucket}")
        return hashlib.sha256(raw.encode()).hexdigest()

    async def _execute(self, acct: AccountRecord, intent: OrderIntent, origin: str,
                       approver: Optional[str] = None) -> ExecutionResult:
        mode = acct.policy.mode.value
        async with self._lock(acct.account_id):
            acct = self.store.get_account(acct.account_id) or acct     # re-read: halt flag may have changed
            policy = acct.policy
            fail = lambda reasons, **kw: self._fail(acct.account_id, reasons, mode=mode, symbol=intent.symbol, **kw)

            if self._kill():
                return fail(["Global KILL_SWITCH is active"])
            if acct.halted:
                return fail([f"Account is halted: {acct.halted_reason}"], event="order_blocked_halted")
            problems = guards.intent_problems(intent, policy)
            if problems:
                return fail(problems)

            now = self.clock()
            key = self._idem_key(intent, policy, now)
            explicit = bool(intent.idempotency_key or intent.signal_id)
            if not explicit:
                since = now - timedelta(seconds=policy.duplicate_window_seconds)
                recent = [r for r in self.store.list_orders(acct.account_id, since=since, symbol=intent.symbol,
                                                            side=intent.side.value)
                          if r.status not in (OrderStatus.REJECTED.value,)]
                if recent:
                    self._log(acct.account_id, "duplicate_blocked", client_order_id=recent[0].client_order_id,
                              symbol=intent.symbol)
                    return ExecutionResult("duplicate", "An equivalent order was already placed within the duplicate "
                                           "window", mode=mode, client_order_id=recent[0].client_order_id,
                                           reasons=["duplicate within window"])
            try:
                adapter = self._adapter(acct)
                if acct.environment == "live" and acct.account_id not in self._perm_checked:
                    await self._read(acct, adapter.verify_permissions)
                    self._perm_checked.add(acct.account_id)
                if not await self._read(acct, lambda: adapter.market_open(intent.symbol)):
                    return fail(["Market is closed or instrument not tradeable"])
                quote = await self._read(acct, lambda: adapter.get_quote(intent.symbol))
                book = (await self._read(acct, lambda: adapter.get_order_book(intent.symbol, 20))
                        if adapter.supports_order_book else None)
                equity = await self._read(acct, adapter.get_equity)
                positions = await self._read(acct, adapter.get_positions)
                rules = await self._read(acct, lambda: adapter.get_rules(intent.symbol))
            except PermissionPolicyError as e:
                self.store.save_account(self._with_halt(acct, f"Credential permission refused: {e}"))
                return fail([f"Credential permission refused: {e}"], event="credentials_refused")
            except (ProviderUnavailableError, TransientProviderError, PermanentProviderError) as e:
                return fail([f"Venue unavailable or refused data request: {e}"], event="order_blocked_venue")

            # --- verification of live data ---
            now = self.clock()
            reasons = guards.quote_problems(quote, now, policy)
            if not reasons:
                reasons += guards.book_problems(book, quote, intent, policy, now)
                band = guards.limit_vs_band_problem(intent, quote, policy)
                if band:
                    reasons.append(band)
            if reasons:
                return fail(reasons)

            # --- position logic ---
            pos = next((p.qty for p in positions if p.symbol.upper() == intent.symbol), 0.0)
            working = self.store.list_orders(acct.account_id, statuses=[s.value for s in OrderStatus if s.working],
                                             symbol=intent.symbol)
            pending_sell = sum(r.qty - r.filled_qty for r in working if r.side == "sell")
            reduces = ((pos > 0 and intent.side == Side.SELL and intent.qty <= pos + _EPS) or
                       (pos < 0 and intent.side == Side.BUY and intent.qty <= -pos + _EPS))
            can_short = policy.allow_shorting and getattr(adapter, "supports_short", True)
            if intent.reduce_only and not reduces:
                return fail(["reduce_only order would not reduce an existing position"])
            if intent.side == Side.SELL and not can_short and intent.qty > max(0.0, pos - pending_sell) + _EPS:
                return fail(["Sell exceeds available long position (shorting not permitted for this account/venue)"])

            # --- price/qty construction: market intents become protective limits ---
            qty = guards.round_down(intent.qty, rules.step_size)
            if qty <= 0:
                return fail(["Quantity rounds to zero at the venue's lot size"])
            if intent.order_type == OrderType.LIMIT:
                price = guards.round_price(intent.limit_price, rules.tick_size, intent.side)
            else:
                price = guards.round_price(guards.protective_limit(intent.side, quote, policy.max_slippage_bps),
                                           rules.tick_size, intent.side)
            reasons = guards.rules_problems(qty, price, rules)

            # --- user-approved capital limits ---
            notional = qty * price
            if policy.max_order_notional <= 0:
                reasons.append("No per-order notional limit configured for this account")
            elif notional > policy.max_order_notional + 1e-9:
                reasons.append(f"Order notional {notional:.2f} exceeds per-order limit {policy.max_order_notional:.2f}")
            if not reduces:
                gross = sum(abs(p.qty) * (p.mark_price or p.avg_price or 0.0) for p in positions)
                gross += sum((r.qty - r.filled_qty) * (r.limit_price or quote.ask) for r in working if r.side == "buy")
                if policy.max_total_notional <= 0:
                    reasons.append("No total capital limit configured for this account")
                elif gross + notional > policy.max_total_notional + 1e-9:
                    reasons.append(f"Exposure {gross + notional:.2f} would exceed capital limit "
                                   f"{policy.max_total_notional:.2f}")
            day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
            today = [r for r in self.store.list_orders(acct.account_id, since=day_start, limit=10_000)
                     if r.status != OrderStatus.REJECTED.value and r.origin != "emergency"]
            if len(today) >= policy.max_daily_orders:
                reasons.append(f"Daily order limit reached ({len(today)}/{policy.max_daily_orders})")

            # --- independent risk officer (fail closed on live) ---
            if self.risk_gate is None:
                if acct.environment == "live":
                    reasons.append("No risk gate configured; live execution refused")
            else:
                try:
                    ok, rg = await self.risk_gate(intent, policy, quote, equity, positions, acct.environment)
                except Exception as e:     # a broken risk officer is a veto
                    ok, rg = False, [f"Risk gate failed: {type(e).__name__}"]
                if not ok:
                    reasons += list(rg)
            if reasons:
                return fail(reasons)

            # --- reserve (duplicate prevention), persist BEFORE sending ---
            cid = "eti-" + hashlib.sha256(key.encode()).hexdigest()[:24]
            row, created = self.store.reserve_order(OrderRow(
                cid, key, acct.account_id, acct.provider, acct.environment, intent.symbol, intent.side.value, qty,
                OrderType.LIMIT.value, price, mode=mode, origin=origin, strategy=intent.strategy, thesis=intent.thesis,
                created_at=self.clock(), updated_at=self.clock()))
            if not created:
                self._log(acct.account_id, "duplicate_blocked", client_order_id=row.client_order_id)
                return ExecutionResult("duplicate", "Order with this idempotency key already exists", mode=mode,
                                       client_order_id=row.client_order_id, order=row.to_dict(),
                                       reasons=["duplicate idempotency key"])
            self._log(acct.account_id, "order_submitting", client_order_id=cid, symbol=intent.symbol,
                      side=intent.side.value, qty=qty, limit_price=price, spread_bps=round(quote.spread_bps, 3),
                      quote_age_s=round(quote.age_seconds(now), 3), origin=origin, approver=approver)
            row = await self._submit_row(acct, adapter, row, OrderType.LIMIT, price, reduce_only=intent.reduce_only)
        return self._result_from_row(row, mode)

    @staticmethod
    def _with_halt(acct, reason):
        acct.halted, acct.halted_reason = True, reason
        return acct

    @staticmethod
    def _result_from_row(row: OrderRow, mode: str) -> ExecutionResult:
        status = {"filled": "filled", "partially_filled": "partially_filled", "submitted": "submitted",
                  "rejected": "rejected", "canceled": "canceled", "expired": "canceled",
                  "unknown": "unknown", "pending_submit": "unknown"}.get(row.status, row.status)
        msg = row.error or {"unknown": "Outcome unconfirmed; reconciliation will resolve it. Do not resend."}.get(status, "")
        return ExecutionResult(status, msg, mode=mode, client_order_id=row.client_order_id,
                               reasons=[row.error] if row.error and status == "rejected" else [], order=row.to_dict())

    # ------------------------------------------------------------------ submit with failure recovery
    async def _submit_row(self, acct, adapter, row: OrderRow, order_type, price, reduce_only=False) -> OrderRow:
        side = Side(row.side)

        async def send():
            return await self._write(acct, lambda: adapter.submit_order(
                client_order_id=row.client_order_id, symbol=row.symbol, side=side, qty=row.qty, order_type=order_type,
                limit_price=price, reduce_only=reduce_only))
        try:
            bo = await send()
        except OrderRejectedError as e:
            self._log(acct.account_id, "order_rejected_by_venue", row.client_order_id, error=str(e))
            return self.store.update_order(row.client_order_id, status=OrderStatus.REJECTED.value, error=str(e)[:400])
        except PermanentProviderError as e:
            self._log(acct.account_id, "order_failed_permanent", row.client_order_id, error=str(e))
            return self.store.update_order(row.client_order_id, status=OrderStatus.REJECTED.value, error=str(e)[:400])
        except ProviderUnavailableError as e:
            return self.store.update_order(row.client_order_id, status=OrderStatus.REJECTED.value, error=str(e)[:400])
        except TransientProviderError as e:
            # Network error or timeout: the venue may or may not have the order. Look before doing anything else.
            self._log(acct.account_id, "order_outcome_uncertain", row.client_order_id, error=str(e))
            bo = await self._resolve_uncertain(acct, adapter, row, send)
            if bo is None:
                return self.store.update_order(row.client_order_id, status=OrderStatus.UNKNOWN.value,
                                               error="Submission outcome unconfirmed")
        return self._apply_broker_order(acct, row, bo)

    async def _resolve_uncertain(self, acct, adapter, row, resend) -> Optional[BrokerOrder]:
        try:
            found = await retry_async(lambda: adapter.get_order_by_client_id(row.symbol, row.client_order_id),
                                      attempts=3, sleep=self._sleep)
        except TransientProviderError:
            return None                      # cannot tell: never resend blind
        if found is not None:
            self._log(acct.account_id, "order_adopted_after_uncertainty", row.client_order_id)
            return found
        # Venue confirms the order is absent; resubmitting with the SAME client id is duplicate-safe.
        try:
            self._log(acct.account_id, "order_resubmit_after_confirmed_absent", row.client_order_id)
            return await resend()
        except OrderRejectedError as e:
            self.store.update_order(row.client_order_id, status=OrderStatus.REJECTED.value, error=str(e)[:400])
            raise
        except TransientProviderError:
            return None

    def _apply_broker_order(self, acct, row: OrderRow, bo: BrokerOrder) -> OrderRow:
        before = row.filled_qty
        new = self.store.update_order(
            row.client_order_id, status=bo.status.value, filled_qty=bo.filled_qty,
            avg_fill_price=bo.avg_fill_price if bo.avg_fill_price is not None else row.avg_fill_price,
            provider_order_id=bo.provider_order_id or row.provider_order_id, error=None)
        if bo.filled_qty > before + _EPS:
            self._log(acct.account_id, "fill", row.client_order_id, symbol=row.symbol, side=row.side,
                      delta_qty=bo.filled_qty - before, filled_qty=bo.filled_qty, avg_price=bo.avg_fill_price,
                      status=bo.status.value)
        return new

    # ------------------------------------------------------------------ open-order & partial-fill management
    async def manage_open_orders(self, account_id: str) -> dict:
        async with self._lock(account_id):
            return await self._manage_locked(account_id)

    async def _manage_locked(self, account_id: str) -> dict:
        acct = self.store.get_account(account_id)
        out = {"checked": 0, "updated": 0, "canceled_remainders": 0, "unresolved": 0}
        if acct is None:
            return out
        adapter = self._adapter(acct)
        now = self.clock()
        for row in self.store.list_orders(account_id, statuses=[s.value for s in OrderStatus if s.working]):
            out["checked"] += 1
            age = (now - row.created_at).total_seconds()
            try:
                bo = await self._read(acct, lambda: adapter.get_order_by_client_id(row.symbol, row.client_order_id))
            except (TransientProviderError, ProviderUnavailableError):
                out["unresolved"] += 1
                continue
            if bo is None:
                if age > UNKNOWN_GRACE_SECONDS:
                    self.store.update_order(row.client_order_id, status=OrderStatus.REJECTED.value,
                                            error="Order never reached the venue")
                    self._log(account_id, "order_never_reached_venue", row.client_order_id)
                    out["updated"] += 1
                else:
                    out["unresolved"] += 1
                continue
            row2 = self._apply_broker_order(acct, row, bo)
            if row2.status != row.status or row2.filled_qty != row.filled_qty:
                out["updated"] += 1
            if bo.status in (OrderStatus.SUBMITTED, OrderStatus.PARTIALLY_FILLED) and age > acct.policy.order_ttl_seconds:
                try:
                    await retry_async(lambda: adapter.cancel_order(row.symbol, row.client_order_id, bo.provider_order_id),
                                      attempts=3, sleep=self._sleep)
                    final = await retry_async(lambda: adapter.get_order_by_client_id(row.symbol, row.client_order_id),
                                              attempts=3, sleep=self._sleep)
                except TransientProviderError:
                    out["unresolved"] += 1
                    continue
                if final is not None:
                    self._apply_broker_order(acct, row2, final)
                    if final.status == OrderStatus.CANCELED and final.filled_qty > 0:
                        self.store.update_order(row.client_order_id, error="Remainder cancelled after partial fill")
                        self._log(account_id, "partial_fill_remainder_canceled", row.client_order_id,
                                  filled_qty=final.filled_qty, requested_qty=row.qty)
                    else:
                        self._log(account_id, "order_ttl_canceled", row.client_order_id, filled_qty=final.filled_qty)
                    out["canceled_remainders"] += 1
        return out

    # ------------------------------------------------------------------ position reconciliation
    def _ledger(self, account_id) -> dict:
        net: dict = {}
        for r in self.store.list_orders(account_id, limit=100_000):
            if r.filled_qty > 0:
                net[r.symbol] = net.get(r.symbol, 0.0) + (r.filled_qty if r.side == "buy" else -r.filled_qty)
        return net

    async def reconcile_positions(self, account_id: str) -> dict:
        async with self._lock(account_id):
            acct = self.store.get_account(account_id)
            if acct is None:
                return {"status": "unknown_account"}
            adapter = self._adapter(acct)
            await self._manage_locked(account_id)
            if self.store.list_orders(account_id, statuses=[OrderStatus.UNKNOWN.value, OrderStatus.PENDING_SUBMIT.value]):
                return {"status": "deferred", "reason": "unresolved orders in flight"}
            try:
                positions = await self._read(acct, adapter.get_positions)
            except (TransientProviderError, ProviderUnavailableError) as e:
                return {"status": "venue_unavailable", "error": str(e)}
            broker = {p.symbol.upper(): p.qty for p in positions}
            ledger = self._ledger(account_id)
            if acct.baseline is None:
                acct.baseline = {s: broker.get(s, 0.0) - ledger.get(s, 0.0) for s in set(broker) | set(ledger)}
                self.store.save_account(acct)
                self._log(account_id, "baseline_recorded", baseline=acct.baseline)
                return {"status": "baseline_recorded", "baseline": acct.baseline}
            tol = acct.policy.reconcile_tolerance_qty
            diffs = {}
            for s in set(broker) | set(ledger) | set(acct.baseline):
                expected = acct.baseline.get(s, 0.0) + ledger.get(s, 0.0)
                d = broker.get(s, 0.0) - expected
                allowed = tol + acct.policy.reconcile_tolerance_pct / 100.0 * max(abs(expected), abs(broker.get(s, 0.0)))
                if abs(d) > allowed:
                    diffs[s] = {"broker": broker.get(s, 0.0), "expected": expected, "difference": d}
            if diffs:
                self._log(account_id, "position_mismatch", differences=diffs)
                if not acct.halted:
                    self.store.save_account(self._with_halt(acct, "Position mismatch between ETI ledger and broker"))
                return {"status": "mismatch", "differences": diffs, "halted": True}
            return {"status": "in_sync"}

    async def accept_broker_positions(self, account_id: str, by: str) -> dict:
        """Human decision: treat the broker's current positions as the truth and re-baseline."""
        async with self._lock(account_id):
            acct = self.store.get_account(account_id)
            adapter = self._adapter(acct)
            positions = await self._read(acct, adapter.get_positions)
            ledger = self._ledger(account_id)
            broker = {p.symbol.upper(): p.qty for p in positions}
            acct.baseline = {s: broker.get(s, 0.0) - ledger.get(s, 0.0) for s in set(broker) | set(ledger)}
            self.store.save_account(acct)
            self._log(account_id, "baseline_reset_by_user", by=by, baseline=acct.baseline)
            return {"status": "baseline_recorded", "baseline": acct.baseline}

    # ------------------------------------------------------------------ emergency management
    async def halt(self, account_id: str, reason: str, by: str = "system") -> bool:
        acct = self.store.get_account(account_id)
        if acct is None:
            return False
        self.store.save_account(self._with_halt(acct, reason))
        self._log(account_id, "account_halted", reason=reason, by=by)
        return True

    async def clear_halt(self, account_id: str, by: str) -> bool:
        acct = self.store.get_account(account_id)
        if acct is None:
            return False
        acct.halted, acct.halted_reason = False, None
        self.store.save_account(acct)
        self._log(account_id, "halt_cleared", by=by)
        return True

    async def emergency_flatten(self, account_id: str, reason: str, by: str = "system",
                                scope: str = "eti_managed") -> dict:
        """Halt the account, cancel working orders, and close positions. Only ever reduces exposure.

        scope="eti_managed" closes only what ETI opened (ledger); scope="all" closes every broker position.
        """
        async with self._lock(account_id):
            acct = self.store.get_account(account_id)
            if acct is None:
                return {"status": "unknown_account"}
            if reason == "retry" and (acct.halted_reason or "").startswith("EMERGENCY"):
                m = re.match(r"EMERGENCY(?:_PENDING)?\[(\w+)\]: (.*?)(?: \(close orders sent.*)?$", acct.halted_reason)
                if m:
                    scope, reason = m.group(1), m.group(2)
            self.store.save_account(self._with_halt(acct, f"EMERGENCY_PENDING[{scope}]: {reason}"))
            self._log(account_id, "emergency_started", reason=reason, by=by, scope=scope)
            adapter = self._adapter(acct)
            summary = {"canceled": [], "closing": [], "failed": [], "scope": scope}
            try:
                open_orders = await self._read(acct, adapter.list_open_orders)
                for bo in open_orders:
                    mine = self.store.get_order(bo.client_order_id)
                    if mine is not None or scope == "all":
                        try:
                            await retry_async(lambda: adapter.cancel_order("", bo.client_order_id, bo.provider_order_id),
                                              attempts=3, sleep=self._sleep)
                            summary["canceled"].append(bo.client_order_id)
                        except Exception as e:
                            summary["failed"].append({"cancel": bo.client_order_id, "error": type(e).__name__})
                positions = await self._read(acct, adapter.get_positions)
            except (TransientProviderError, ProviderUnavailableError) as e:
                self._log(account_id, "emergency_venue_unavailable", error=str(e))
                summary["failed"].append({"stage": "read", "error": str(e)})
                summary["status"] = "incomplete_retry_pending"
                return summary
            ledger = self._ledger(account_id)
            now = self.clock()
            for p in positions:
                sym = p.symbol.upper()
                led = ledger.get(sym, 0.0)
                if scope == "all":
                    target = p.qty
                elif led * p.qty > 0:
                    target = (1 if p.qty > 0 else -1) * min(abs(led), abs(p.qty))
                else:
                    target = 0.0
                qty = abs(target)
                if qty <= _EPS:
                    continue
                side = Side.SELL if p.qty > 0 else Side.BUY
                working = [r for r in self.store.list_orders(account_id, statuses=[s.value for s in OrderStatus if s.working],
                                                             symbol=sym) if r.origin == "emergency"]
                if working:
                    summary["closing"].append({"symbol": sym, "client_order_id": working[0].client_order_id, "note": "already working"})
                    continue
                try:
                    rules = await self._read(acct, lambda: adapter.get_rules(sym))
                    qty = guards.round_down(qty, rules.step_size) or qty
                    use_market = acct.policy.emergency_use_market
                    otype, price = OrderType.MARKET, None
                    if not use_market:
                        q = await self._read(acct, lambda: adapter.get_quote(sym))
                        otype = OrderType.LIMIT
                        price = guards.round_price(guards.protective_limit(side, q, EMERGENCY_SLIPPAGE_BPS),
                                                   rules.tick_size, side)
                    key = f"emergency|{account_id}|{sym}|{int(now.timestamp() // 60)}"
                    cid = "eti-" + hashlib.sha256(key.encode()).hexdigest()[:24]
                    row, created = self.store.reserve_order(OrderRow(
                        cid, key, account_id, acct.provider, acct.environment, sym, side.value, qty, otype.value,
                        price, mode=acct.policy.mode.value, origin="emergency", strategy="emergency", thesis=reason,
                        created_at=now, updated_at=now))
                    if not created:
                        summary["closing"].append({"symbol": sym, "client_order_id": cid, "note": "already sent this minute"})
                        continue
                    row = await self._submit_row(acct, adapter, row, otype, price, reduce_only=True)
                    summary["closing"].append({"symbol": sym, "client_order_id": cid, "status": row.status,
                                               "qty": qty, "side": side.value})
                    if row.status in ("rejected", "unknown"):
                        summary["failed"].append({"symbol": sym, "error": row.error})
                except Exception as e:
                    summary["failed"].append({"symbol": sym, "error": f"{type(e).__name__}: {e}"[:200]})
            summary["status"] = "incomplete_retry_pending" if summary["failed"] else "closing_orders_sent"
            if not summary["failed"]:
                fresh = self.store.get_account(account_id)
                self.store.save_account(self._with_halt(
                    fresh, f"EMERGENCY[{scope}]: {reason} (close orders sent; verify positions, then clear the halt)"))
            self._log(account_id, "emergency_finished", **summary)
            return summary

    # ------------------------------------------------------------------ supervisor tick
    async def supervise_once(self) -> dict:
        report = {}
        for acct in self.store.list_accounts():
            if acct.policy.mode == Mode.INTELLIGENCE_ONLY and not acct.halted:
                continue
            r: dict = {}
            try:
                adapter = self._adapter(acct)
                br = self._breaker(acct)
                was_down = br.is_down
                try:
                    await self._read(acct, adapter.ping)
                    if was_down:
                        self._log(acct.account_id, "venue_recovered")
                except (TransientProviderError, ProviderUnavailableError) as e:
                    if not was_down or br.state == "open" and br.failures == br.failure_threshold:
                        self._log(acct.account_id, "venue_down", error=str(e), breaker=br.snapshot())
                    r["venue"] = "down"
                    report[acct.account_id] = r
                    continue
                r["orders"] = await self.manage_open_orders(acct.account_id)
                fresh = self.store.get_account(acct.account_id)
                if fresh.halted and (fresh.halted_reason or "").startswith("EMERGENCY_PENDING"):
                    r["emergency"] = await self.emergency_flatten(acct.account_id, "retry", by="supervisor")
                elif not fresh.halted:
                    r["reconcile"] = await self.reconcile_positions(acct.account_id)
            except Exception as e:      # one bad account must not stop the loop
                r["error"] = f"{type(e).__name__}: {e}"[:200]
                self._log(acct.account_id, "supervisor_error", error=r["error"])
            report[acct.account_id] = r
        return report
