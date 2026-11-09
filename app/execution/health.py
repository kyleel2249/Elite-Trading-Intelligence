"""Venue health: circuit breaker (downtime detection) and retry with backoff (reconnection)."""
from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Optional, Type

from .errors import TransientProviderError


def _now() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class CircuitBreaker:
    """closed -> (N consecutive failures) -> open -> (cooldown) -> half_open -> one probe decides."""
    failure_threshold: int = 3
    cooldown_seconds: float = 30.0
    clock: Callable[[], datetime] = _now
    state: str = "closed"
    failures: int = 0
    opened_at: Optional[datetime] = None
    last_error: Optional[str] = None
    last_success: Optional[datetime] = None
    _probe_in_flight: bool = field(default=False, repr=False)

    def allow(self) -> bool:
        if self.state == "closed":
            return True
        if self.state == "open":
            if self.opened_at and (self.clock() - self.opened_at).total_seconds() >= self.cooldown_seconds:
                self.state = "half_open"
                self._probe_in_flight = False
            else:
                return False
        if self.state == "half_open":
            if self._probe_in_flight:
                return False
            self._probe_in_flight = True
            return True
        return True

    def record_success(self) -> None:
        self.state, self.failures, self.opened_at = "closed", 0, None
        self._probe_in_flight = False
        self.last_success = self.clock()

    def record_failure(self, error: str = "") -> None:
        self.failures += 1
        self.last_error = error[:300] or self.last_error
        self._probe_in_flight = False
        if self.state == "half_open" or self.failures >= self.failure_threshold:
            self.state = "open"
            self.opened_at = self.clock()

    @property
    def is_down(self) -> bool:
        return self.state != "closed"

    def snapshot(self) -> dict:
        return {
            "state": self.state, "consecutive_failures": self.failures, "last_error": self.last_error,
            "opened_at": self.opened_at.isoformat() if self.opened_at else None,
            "last_success": self.last_success.isoformat() if self.last_success else None,
        }


async def retry_async(fn: Callable[[], Awaitable], *, attempts: int = 3, base_delay: float = 0.25,
                      max_delay: float = 4.0, retry_on: Type[BaseException] = TransientProviderError,
                      sleep: Callable[[float], Awaitable] = asyncio.sleep,
                      rng: Callable[[], float] = random.random):
    """Exponential backoff with jitter. Only use for idempotent operations (reads, cancels, lookups)."""
    last: Optional[BaseException] = None
    for i in range(max(1, attempts)):
        try:
            return await fn()
        except retry_on as e:      # noqa: PERF203
            last = e
            if i == attempts - 1:
                break
            await sleep(min(max_delay, base_delay * (2 ** i)) * (0.5 + rng() / 2))
    assert last is not None
    raise last
