"""Global trading controls: kill switch + automatic suspension.

State is process-local by design (fail-safe: restart does NOT re-enable
trading automatically; ``suspended`` starts False but live trading is also
gated by LIVE_TRADING_ENABLED, which defaults to false).
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class TradingControls:
    kill_switch: bool = False
    suspended_reasons: list[str] = field(default_factory=list)
    audit: list[dict] = field(default_factory=list)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    # abnormal-execution monitor
    recent_outcomes: list[str] = field(default_factory=list)

    def _log(self, event: str, detail: str, actor: str = "system") -> None:
        self.audit.append({"ts": time.time(), "event": event, "detail": detail, "actor": actor})
        del self.audit[:-500]

    def engage_kill_switch(self, actor: str = "operator", reason: str = "manual") -> None:
        with self._lock:
            self.kill_switch = True
            self._log("kill_switch_on", reason, actor)

    def release_kill_switch(self, actor: str = "operator") -> None:
        with self._lock:
            self.kill_switch = False
            self._log("kill_switch_off", "released", actor)

    def suspend(self, reason: str) -> None:
        with self._lock:
            if reason not in self.suspended_reasons:
                self.suspended_reasons.append(reason)
                self._log("auto_suspend", reason)

    def resume(self, reason: str, actor: str = "operator") -> None:
        with self._lock:
            if reason in self.suspended_reasons:
                self.suspended_reasons.remove(reason)
                self._log("resume", reason, actor)

    def record_execution_outcome(self, outcome: str, window: int = 20, max_reject_ratio: float = 0.5) -> None:
        """Suspend if the recent rejection/failure ratio is abnormal."""
        with self._lock:
            self.recent_outcomes.append(outcome)
            del self.recent_outcomes[:-window]
        n = len(self.recent_outcomes)
        if n >= 10:
            bad = sum(1 for o in self.recent_outcomes if o in ("REJECTED", "FAILED"))
            if bad / n > max_reject_ratio:
                self.suspend("abnormal_execution_behavior")

    def check_data_health(self, fresh_ratio: float, min_fresh_ratio: float = 0.5) -> None:
        """Auto-suspend on critical/stale data; auto-resume when healthy."""
        if fresh_ratio < min_fresh_ratio:
            self.suspend("critical_data_staleness")
        else:
            self.resume("critical_data_staleness", actor="system")

    def trading_blocked(self) -> Optional[str]:
        if self.kill_switch:
            return "global kill switch engaged"
        if self.suspended_reasons:
            return "trading suspended: " + ", ".join(self.suspended_reasons)
        return None

    def status(self) -> dict:
        return {"kill_switch": self.kill_switch, "suspended_reasons": list(self.suspended_reasons),
                "blocked": self.trading_blocked(), "recent_audit": self.audit[-20:]}


controls = TradingControls()
