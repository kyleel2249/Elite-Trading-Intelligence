"""Cache, distributed lock and fixed-window rate limiter on top of Redis. Every failure degrades to 'no cache / no limit hit' for the
cache helpers (a cache outage must not take the app down) but NOT for locks (a lock that cannot be taken is reported as not acquired)."""
from __future__ import annotations

import json
import secrets
import time
from contextlib import contextmanager
from typing import Any, Callable, Iterator

from .redis_client import Redis, RedisConnectionError

_RELEASE = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end"
_EXTEND = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end"


class RedisCache:
    def __init__(self, r: Redis, prefix: str = "eti:cache:") -> None:
        self.r, self.prefix = r, prefix

    def get(self, key: str) -> Any | None:
        try:
            v = self.r.get(self.prefix + key)
        except RedisConnectionError:
            return None
        if v is None:
            return None
        try:
            return json.loads(v)
        except ValueError:
            return None

    def set(self, key: str, value: Any, ttl: int = 300) -> bool:
        try:
            return self.r.set(self.prefix + key, json.dumps(value, separators=(",", ":"), default=str), ex=max(1, int(ttl)))
        except RedisConnectionError:
            return False

    def delete(self, key: str) -> None:
        try:
            self.r.delete(self.prefix + key)
        except RedisConnectionError:
            pass

    def get_or_set(self, key: str, factory: Callable[[], Any], ttl: int = 300) -> Any:
        hit = self.get(key)
        if hit is not None:
            return hit
        v = factory()
        if v is not None:
            self.set(key, v, ttl)
        return v


class Lock:
    """SET NX PX lock with a random token; only the holder can release or extend it."""
    def __init__(self, r: Redis, name: str, ttl_ms: int = 30_000) -> None:
        self.r, self.key, self.ttl_ms, self.token = r, "eti:lock:" + name, ttl_ms, secrets.token_hex(16)

    def acquire(self) -> bool:
        try:
            return self.r.set(self.key, self.token, px=self.ttl_ms, nx=True)
        except RedisConnectionError:
            return False

    def release(self) -> bool:
        try:
            return bool(self.r.eval(_RELEASE, [self.key], [self.token]))
        except RedisConnectionError:
            return False

    def extend(self, ttl_ms: int | None = None) -> bool:
        try:
            return bool(self.r.eval(_EXTEND, [self.key], [self.token, ttl_ms or self.ttl_ms]))
        except RedisConnectionError:
            return False


@contextmanager
def locked(r: Redis, name: str, ttl_ms: int = 30_000) -> Iterator[bool]:
    lk = Lock(r, name, ttl_ms)
    got = lk.acquire()
    try:
        yield got
    finally:
        if got:
            lk.release()


def rate_limit(r: Redis, key: str, limit: int, window_s: int, now: float | None = None) -> tuple[bool, int]:
    """Fixed-window counter. Returns (allowed, remaining). If Redis is down the request is ALLOWED (fail-open) and remaining is -1."""
    bucket = int((now if now is not None else time.time()) // window_s)
    k = f"eti:rl:{key}:{bucket}"
    try:
        n = r.incr(k)
        if n == 1:
            r.expire(k, window_s + 1)
    except RedisConnectionError:
        return True, -1
    return n <= limit, max(0, limit - n)
