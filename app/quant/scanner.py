"""Global market scanner: 1,000-2,000 instruments per cycle.

Design:
* Providers expose ``fetch_batch(symbols)`` (bulk endpoints preferred) so a
  full scan is a handful of requests, not thousands.
* Per-provider token-bucket rate limit, bounded concurrency, exponential
  backoff with jitter, and failover to the next provider in the chain.
* Every instrument has a coverage record. An instrument is only ``ACTIVE``
  while its newest *valid* data is within ``max_age_seconds``; otherwise it is
  ``STALE`` or ``UNAVAILABLE`` and is never reported as monitored.
* Identical snapshots (same provider/symbol/timestamp/price) are counted as duplicates.
Throughput claims must come from load tests with real providers; the
``ScanMetrics`` returned by ``scan_once`` is what you measure.
"""
from __future__ import annotations

import asyncio
import random
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional, Protocol


class QuoteProvider(Protocol):
    name: str
    max_batch: int
    rate_per_sec: float

    async def fetch_batch(self, symbols: list[str]) -> dict[str, dict[str, Any]]:
        """Return {symbol: {price, bid?, ask?, volume?, ts_utc(datetime)}} for symbols it could serve."""


@dataclass
class UniverseEntry:
    symbol: str
    asset_class: str
    exchange: str
    providers: list[str]            # ordered: primary first, then failovers
    priority: int = 0               # higher = scanned/refreshed first


@dataclass
class Coverage:
    symbol: str
    asset_class: str
    exchange: str
    provider: Optional[str] = None
    failover_provider: Optional[str] = None
    status: str = "NEVER_SCANNED"   # ACTIVE | STALE | UNAVAILABLE | NEVER_SCANNED
    last_success_ts: Optional[str] = None
    last_valid_data_ts: Optional[str] = None
    price: Optional[float] = None
    data_age_seconds: Optional[float] = None
    quality_score: float = 0.0
    fields: list[str] = field(default_factory=list)
    last_error: Optional[str] = None
    consecutive_failures: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ScanMetrics:
    started_at: str = ""
    duration_seconds: float = 0.0
    universe_size: int = 0
    scanned_ok: int = 0
    stale: int = 0
    unavailable: int = 0
    skipped_duplicate: int = 0
    requests: int = 0
    retries: int = 0
    failovers: int = 0
    per_provider: dict[str, dict[str, int]] = field(default_factory=dict)
    completion_pct: float = 0.0
    within_interval: bool = True

    def to_dict(self) -> dict:
        return asdict(self)


class TokenBucket:
    def __init__(self, rate_per_sec: float, burst: Optional[float] = None, clock=time.monotonic, sleep=asyncio.sleep):
        self.rate, self.capacity = max(rate_per_sec, 1e-6), burst or max(1.0, rate_per_sec)
        self.tokens, self.clock, self.sleep = self.capacity, clock, sleep
        self.t = clock()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            while True:
                now = self.clock()
                self.tokens = min(self.capacity, self.tokens + (now - self.t) * self.rate)
                self.t = now
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                await self.sleep((1 - self.tokens) / self.rate)


def _chunks(xs: list[str], n: int):
    for i in range(0, len(xs), max(1, n)):
        yield xs[i:i + n]


class GlobalScanner:
    def __init__(self, providers: dict[str, QuoteProvider], max_age_seconds: float = 300.0,
                 interval_seconds: float = 600.0, max_retries: int = 3, base_backoff: float = 0.5,
                 concurrency: int = 8, clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
                 sleep: Callable[[float], Awaitable[None]] = asyncio.sleep, jitter: bool = True):
        self.providers = providers
        self.max_age, self.interval = max_age_seconds, interval_seconds
        self.max_retries, self.base_backoff = max_retries, base_backoff
        self.sem = asyncio.Semaphore(concurrency)
        self.clock, self.sleep, self.jitter = clock, sleep, jitter
        self.buckets = {n: TokenBucket(p.rate_per_sec, sleep=sleep) for n, p in providers.items()}
        self.universe: dict[str, UniverseEntry] = {}
        self.coverage: dict[str, Coverage] = {}
        self._last_seen: dict[str, tuple] = {}
        self.last_metrics: Optional[ScanMetrics] = None
        self.last_full_scan: Optional[str] = None
        self.provider_health: dict[str, dict] = {n: {"ok": 0, "errors": 0, "last_error": None, "last_ok": None}
                                                 for n in providers}
        self._stop = asyncio.Event()

    # ---------- universe ----------
    def set_universe(self, entries: list[UniverseEntry]) -> None:
        self.universe = {e.symbol: e for e in entries}
        for e in entries:
            self.coverage.setdefault(e.symbol, Coverage(
                e.symbol, e.asset_class, e.exchange, provider=e.providers[0] if e.providers else None,
                failover_provider=e.providers[1] if len(e.providers) > 1 else None))
        for s in list(self.coverage):
            if s not in self.universe:
                del self.coverage[s]

    # ---------- fetching ----------
    async def _fetch_with_retry(self, pname: str, batch: list[str], m: ScanMetrics):
        prov, bucket = self.providers[pname], self.buckets[pname]
        pm = m.per_provider.setdefault(pname, {"requests": 0, "errors": 0})
        for attempt in range(self.max_retries + 1):
            async with self.sem:
                await bucket.acquire()
                pm["requests"] += 1
                m.requests += 1
                try:
                    out = await prov.fetch_batch(batch)
                    h = self.provider_health[pname]
                    h["ok"] += 1
                    h["last_ok"] = self.clock().isoformat()
                    return out
                except Exception as e:  # noqa: BLE001 - provider errors are data
                    pm["errors"] += 1
                    h = self.provider_health[pname]
                    h["errors"] += 1
                    h["last_error"] = f"{type(e).__name__}: {e}"[:200]
                    err = h["last_error"]
            if attempt < self.max_retries:
                m.retries += 1
                delay = self.base_backoff * (2 ** attempt)
                if self.jitter:
                    delay *= 0.5 + random.random()
                await self.sleep(delay)
        raise RuntimeError(err)

    def _apply(self, sym: str, pname: str, q: dict, m: ScanMetrics) -> str:
        """Returns 'fresh' | 'stale' | 'invalid'."""
        cov, now = self.coverage[sym], self.clock()
        ts, price = q.get("ts_utc"), q.get("price")
        valid = isinstance(price, (int, float)) and price > 0 and isinstance(ts, datetime)
        if not valid:
            return "invalid"
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        key = (pname, ts, price)
        if self._last_seen.get(sym) == key:
            m.skipped_duplicate += 1
        self._last_seen[sym] = key
        age = max(0.0, (now - ts).total_seconds())
        cov.provider, cov.price, cov.data_age_seconds = pname, float(price), age
        cov.last_success_ts, cov.last_valid_data_ts = now.isoformat(), ts.isoformat()
        cov.fields = [k for k in ("price", "bid", "ask", "volume") if q.get(k) is not None]
        cov.consecutive_failures, cov.last_error = 0, None
        fresh = age <= self.max_age
        cov.status = "ACTIVE" if fresh else "STALE"
        cov.quality_score = round((len(cov.fields) / 4) * (1.0 if fresh else 0.3), 2)
        return "fresh" if fresh else "stale"

    async def _scan_symbols(self, symbols: list[str], m: ScanMetrics) -> None:
        by_primary: dict[str, list[str]] = {}
        for s in symbols:
            by_primary.setdefault(self.universe[s].providers[0], []).append(s)

        async def run_provider_chain(sym_list: list[str], chain_idx: int, pname: str):
            max_batch = self.providers[pname].max_batch if pname in self.providers else 1
            await asyncio.gather(*[self._process_batch(pname, batch, chain_idx, m)
                                   for batch in _chunks(sym_list, max_batch)])

        await asyncio.gather(*[run_provider_chain(v, 0, p) for p, v in by_primary.items()])

    async def _process_batch(self, pname: str, batch: list[str], idx: int, m: ScanMetrics) -> None:
        results: dict[str, dict] = {}
        err: Optional[str] = None
        if pname in self.providers:
            try:
                results = await self._fetch_with_retry(pname, batch, m)
            except Exception as e:  # noqa: BLE001
                err = str(e)
        else:
            err = f"provider '{pname}' not registered"
        failed: list[str] = []
        for s in batch:
            q = results.get(s)
            outcome = self._apply(s, pname, q, m) if q is not None else "invalid"
            if outcome != "fresh":      # missing/invalid/stale -> try the next provider
                failed.append(s)
        # failover for symbols the provider could not serve
        by_next: dict[str, list[str]] = {}
        for s in failed:
            chain = self.universe[s].providers
            nxt = chain[idx + 1] if idx + 1 < len(chain) else None
            if nxt:
                by_next.setdefault(nxt, []).append(s)
            else:
                cov = self.coverage[s]
                cov.consecutive_failures += 1
                cov.last_error = err or "symbol not fresh/valid from any provider"
                if cov.last_valid_data_ts is None:
                    cov.status = "UNAVAILABLE"
                # otherwise keep prior record; the freshness pass sets STALE when it ages out
        for nxt, syms in by_next.items():
            m.failovers += len(syms)
            for b in _chunks(syms, self.providers[nxt].max_batch if nxt in self.providers else 1):
                await self._process_batch(nxt, b, idx + 1, m)

    # ---------- public API ----------
    async def scan_once(self, only: Optional[list[str]] = None) -> ScanMetrics:
        t0 = time.monotonic()
        m = ScanMetrics(started_at=self.clock().isoformat(), universe_size=len(self.universe))
        symbols = sorted(only or self.universe, key=lambda s: -self.universe[s].priority)
        await self._scan_symbols(symbols, m)
        # re-evaluate freshness for everything (data can age between scans)
        now = self.clock()
        for c in self.coverage.values():
            if c.last_valid_data_ts and c.status == "ACTIVE":
                age = (now - datetime.fromisoformat(c.last_valid_data_ts)).total_seconds()
                c.data_age_seconds = age
                if age > self.max_age:
                    c.status = "STALE"
        cov = self.coverage.values()
        m.scanned_ok = sum(1 for c in cov if c.status == "ACTIVE")
        m.stale = sum(1 for c in cov if c.status == "STALE")
        m.unavailable = sum(1 for c in cov if c.status in ("UNAVAILABLE", "NEVER_SCANNED"))
        m.duration_seconds = round(time.monotonic() - t0, 3)
        m.completion_pct = round(100 * (m.scanned_ok + m.stale) / max(1, m.universe_size), 2)
        m.within_interval = m.duration_seconds <= self.interval
        if only is None:
            self.last_full_scan = m.started_at
        self.last_metrics = m
        return m

    def priority_symbols(self, move_pct: float = 1.5, limit: int = 100) -> list[str]:
        """Instruments whose latest price jumped vs the previous scan (abnormal move)."""
        out = []
        for s, c in self.coverage.items():
            prev = getattr(self, "_prev_price", {}).get(s)
            if prev and c.price and abs(c.price / prev - 1) * 100 >= move_pct:
                out.append(s)
        self._prev_price = {s: c.price for s, c in self.coverage.items() if c.price}
        return out[:limit]

    def fresh_ratio(self) -> float:
        n = len(self.coverage)
        return (sum(1 for c in self.coverage.values() if c.status == "ACTIVE") / n) if n else 0.0

    def status(self) -> dict:
        n = len(self.coverage)
        by = {}
        for c in self.coverage.values():
            by[c.status] = by.get(c.status, 0) + 1
        return {"monitored_universe": n, "status_counts": by, "fresh_ratio": round(self.fresh_ratio(), 4),
                "last_full_scan": self.last_full_scan, "interval_seconds": self.interval,
                "last_metrics": self.last_metrics.to_dict() if self.last_metrics else None,
                "provider_health": self.provider_health}

    async def run_forever(self, on_cycle: Optional[Callable[[ScanMetrics], Awaitable[None]]] = None) -> None:
        while not self._stop.is_set():
            started = time.monotonic()
            try:
                m = await self.scan_once()
                if on_cycle:
                    await on_cycle(m)
            except Exception:  # noqa: BLE001 - never let the loop die
                pass
            wait = max(1.0, self.interval - (time.monotonic() - started))
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=wait)
            except asyncio.TimeoutError:
                pass

    def stop(self) -> None:
        self._stop.set()
