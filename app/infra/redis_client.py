"""Minimal Redis client speaking RESP2 over a plain socket (no third-party package).

One connection per client guarded by a lock; a dropped connection is re-opened once and the command retried only for idempotent
read commands (writes are never silently re-sent, so a lost reply cannot double-apply an INCR or LPUSH).
"""
from __future__ import annotations

import socket
import threading
from typing import Any
from urllib.parse import unquote, urlparse

IDEMPOTENT = {"GET", "MGET", "EXISTS", "TTL", "PTTL", "LRANGE", "LLEN", "ZRANGE", "ZRANGEBYSCORE", "ZCARD", "HGET", "HGETALL", "HLEN", "PING", "KEYS", "SCAN", "TYPE", "ZSCORE"}


class RedisError(Exception):
    """An error reply from the server (for example WRONGTYPE)."""


class RedisConnectionError(Exception):
    """The server could not be reached or the connection broke mid-command."""


def _enc(v: Any) -> bytes:
    if isinstance(v, bytes):
        return v
    if isinstance(v, bool):
        return b"1" if v else b"0"
    if isinstance(v, float):
        return repr(v).encode()
    return str(v).encode()


class Redis:
    def __init__(self, host: str = "127.0.0.1", port: int = 6379, db: int = 0, password: str | None = None, username: str | None = None, timeout: float = 5.0, decode: bool = True) -> None:
        self.host, self.port, self.db, self.password, self.username, self.timeout, self.decode = host, port, db, password, username, timeout, decode
        self._sock: socket.socket | None = None
        self._buf = b""
        self._lock = threading.RLock()

    @classmethod
    def from_url(cls, url: str, **kw: Any) -> "Redis":
        u = urlparse(url)
        if u.scheme not in ("redis",):
            raise ValueError("only redis:// URLs are supported (TLS endpoints need a rediss:// capable client)")
        db = int(u.path.lstrip("/") or 0)
        return cls(u.hostname or "127.0.0.1", u.port or 6379, db, unquote(u.password) if u.password else None, unquote(u.username) if u.username else None, **kw)

    # ---- connection ----
    def _connect(self) -> None:
        self.close()
        try:
            s = socket.create_connection((self.host, self.port), timeout=self.timeout)
        except OSError as e:
            raise RedisConnectionError(f"cannot connect to redis at {self.host}:{self.port}: {e}") from e
        s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self._sock, self._buf = s, b""
        try:
            if self.password:
                self._roundtrip(["AUTH", *([self.username] if self.username else []), self.password])
            if self.db:
                self._roundtrip(["SELECT", self.db])
        except RedisError:
            self.close()
            raise

    def close(self) -> None:
        with self._lock:
            if self._sock is not None:
                try:
                    self._sock.close()
                except OSError:
                    pass
            self._sock, self._buf = None, b""

    def _readline(self) -> bytes:
        assert self._sock is not None
        while b"\r\n" not in self._buf:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise RedisConnectionError("connection closed by server")
            self._buf += chunk
        line, self._buf = self._buf.split(b"\r\n", 1)
        return line

    def _readn(self, n: int) -> bytes:
        assert self._sock is not None
        while len(self._buf) < n + 2:
            chunk = self._sock.recv(65536)
            if not chunk:
                raise RedisConnectionError("connection closed by server")
            self._buf += chunk
        data, self._buf = self._buf[:n], self._buf[n + 2:]
        return data

    def _parse(self) -> Any:
        line = self._readline()
        t, rest = line[:1], line[1:]
        if t == b"+":
            return rest.decode()
        if t == b"-":
            return RedisError(rest.decode())
        if t == b":":
            return int(rest)
        if t == b"$":
            n = int(rest)
            if n < 0:
                return None
            d = self._readn(n)
            return d.decode() if self.decode else d
        if t == b"*":
            n = int(rest)
            return None if n < 0 else [self._parse() for _ in range(n)]
        raise RedisConnectionError(f"protocol error: {line!r}")

    def _roundtrip(self, args: list[Any]) -> Any:
        assert self._sock is not None
        out = [b"*%d\r\n" % len(args)]
        for a in args:
            b = _enc(a)
            out.append(b"$%d\r\n%s\r\n" % (len(b), b))
        self._sock.sendall(b"".join(out))
        r = self._parse()
        if isinstance(r, RedisError):
            raise r
        return r

    def execute(self, *args: Any, timeout: float | None = None) -> Any:
        name = str(args[0]).upper()
        with self._lock:
            for attempt in (0, 1):
                try:
                    if self._sock is None:
                        self._connect()
                    assert self._sock is not None
                    self._sock.settimeout(timeout if timeout is not None else self.timeout)
                    return self._roundtrip([args[0], *args[1:]])
                except (OSError, RedisConnectionError) as e:
                    self.close()
                    if isinstance(e, socket.timeout) and name not in IDEMPOTENT:
                        raise RedisConnectionError(f"timed out waiting for {name}; the command may or may not have been applied") from e
                    if attempt == 1 or name not in IDEMPOTENT:
                        raise e if isinstance(e, RedisConnectionError) else RedisConnectionError(str(e)) from e
        raise RedisConnectionError("unreachable")

    # ---- commands used by the cache and queue (thin, explicit wrappers) ----
    def ping(self) -> bool: return self.execute("PING") == "PONG"
    def get(self, k: str) -> str | None: return self.execute("GET", k)
    def set(self, k: str, v: Any, ex: int | None = None, px: int | None = None, nx: bool = False) -> bool:
        a: list[Any] = ["SET", k, v]
        if ex is not None: a += ["EX", int(ex)]
        if px is not None: a += ["PX", int(px)]
        if nx: a.append("NX")
        return self.execute(*a) == "OK"
    def delete(self, *k: str) -> int: return self.execute("DEL", *k)
    def exists(self, k: str) -> bool: return bool(self.execute("EXISTS", k))
    def incr(self, k: str) -> int: return self.execute("INCR", k)
    def expire(self, k: str, s: int) -> bool: return bool(self.execute("EXPIRE", k, int(s)))
    def pexpire(self, k: str, ms: int) -> bool: return bool(self.execute("PEXPIRE", k, int(ms)))
    def ttl(self, k: str) -> int: return self.execute("TTL", k)
    def lpush(self, k: str, *v: Any) -> int: return self.execute("LPUSH", k, *v)
    def rpush(self, k: str, *v: Any) -> int: return self.execute("RPUSH", k, *v)
    def llen(self, k: str) -> int: return self.execute("LLEN", k)
    def lrange(self, k: str, a: int, b: int) -> list[str]: return self.execute("LRANGE", k, a, b)
    def lrem(self, k: str, n: int, v: Any) -> int: return self.execute("LREM", k, n, v)
    def lmove(self, src: str, dst: str, a: str = "RIGHT", b: str = "LEFT") -> str | None: return self.execute("LMOVE", src, dst, a, b)
    def blmove(self, src: str, dst: str, timeout: float, a: str = "RIGHT", b: str = "LEFT") -> str | None:
        return self.execute("BLMOVE", src, dst, a, b, timeout, timeout=timeout + 5)
    def zadd(self, k: str, score: float, member: Any) -> int: return self.execute("ZADD", k, score, member)
    def zrem(self, k: str, *m: Any) -> int: return self.execute("ZREM", k, *m)
    def zcard(self, k: str) -> int: return self.execute("ZCARD", k)
    def zrangebyscore(self, k: str, lo: Any, hi: Any, limit: int | None = None) -> list[str]:
        a: list[Any] = ["ZRANGEBYSCORE", k, lo, hi]
        if limit: a += ["LIMIT", 0, limit]
        return self.execute(*a)
    def hset(self, k: str, f: str, v: Any) -> int: return self.execute("HSET", k, f, v)
    def hget(self, k: str, f: str) -> str | None: return self.execute("HGET", k, f)
    def hdel(self, k: str, *f: str) -> int: return self.execute("HDEL", k, *f)
    def hgetall(self, k: str) -> dict[str, str]:
        r = self.execute("HGETALL", k) or []
        return {r[i]: r[i + 1] for i in range(0, len(r), 2)}
    def eval(self, script: str, keys: list[str], args: list[Any]) -> Any: return self.execute("EVAL", script, len(keys), *keys, *args)
    def flushdb(self) -> bool: return self.execute("FLUSHDB") == "OK"
