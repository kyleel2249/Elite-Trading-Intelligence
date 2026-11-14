"""Candle fetchers for Bitget and Twelve Data, returning rows in the shape ETI's Binance kline normaliser consumes:
{open_time, open, high, low, close, volume, close_time} (milliseconds, oldest first).

Failures raise HistoryError with the HTTP status the API should answer with; nothing is guessed or padded. Response
shapes follow each provider's documented REST API and are covered by mocked tests, not by a live call from this repo.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional

import httpx

BITGET_BASE = "https://api.bitget.com"
TD_BASE = "https://api.twelvedata.com"
INTERVAL_MS = {"1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000, "4h": 14_400_000,
               "1d": 86_400_000, "1w": 604_800_000}
BITGET_GRAN = {"1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1h", "4h": "4h", "1d": "1day", "1w": "1week"}
TD_INTERVAL = {"1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "1h": "1h", "4h": "4h", "1d": "1day", "1w": "1week"}


class HistoryError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


def _step(interval: str, table: dict[str, str]) -> tuple[str, int]:
    if interval not in table:
        raise HistoryError(422, f"unsupported interval '{interval}' for this market; use one of {', '.join(table)}")
    return table[interval], INTERVAL_MS[interval]


async def fetch_bitget(symbol: str, interval: str, limit: int, transport: Optional[httpx.AsyncBaseTransport] = None) -> list[dict[str, Any]]:
    gran, step = _step(interval, BITGET_GRAN)
    try:
        async with httpx.AsyncClient(timeout=15.0, transport=transport) as c:
            r = await c.get(f"{BITGET_BASE}/api/v2/spot/market/candles",
                            params={"symbol": symbol.upper(), "granularity": gran, "limit": min(limit, 1000)})
    except httpx.HTTPError:
        raise HistoryError(502, "Bitget is unreachable from this server")
    if r.status_code in (400, 404):
        raise HistoryError(404, "unknown symbol or interval on Bitget")
    if r.status_code != 200:
        raise HistoryError(502, f"Bitget returned HTTP {r.status_code}")
    try:
        body = r.json()
        if str(body.get("code")) != "00000" or not isinstance(body.get("data"), list):
            raise ValueError("bad code")
        rows = [{"open_time": int(k[0]), "open": float(k[1]), "high": float(k[2]), "low": float(k[3]), "close": float(k[4]),
                 "volume": float(k[5]), "close_time": int(k[0]) + step - 1} for k in body["data"]]
    except (AttributeError, KeyError, IndexError, TypeError, ValueError):
        raise HistoryError(502, "Bitget returned an unreadable candle payload")
    if not rows:
        raise HistoryError(404, "Bitget returned no candles for this symbol")
    return sorted(rows, key=lambda x: x["open_time"])


def _td_time_ms(text: str) -> int:
    fmt = "%Y-%m-%d %H:%M:%S" if " " in text else "%Y-%m-%d"
    return int(datetime.strptime(text, fmt).replace(tzinfo=timezone.utc).timestamp() * 1000)


async def fetch_twelvedata(symbol: str, interval: str, limit: int, key: str,
                           transport: Optional[httpx.AsyncBaseTransport] = None) -> list[dict[str, Any]]:
    """`symbol` is `TICKER:MIC` (a stock on a named exchange), a bare ticker, or a forex pair like `EUR/USD`."""
    if not key:
        raise HistoryError(503, "TWELVEDATA_API_KEY is not set, so this market cannot be charted")
    iv, step = _step(interval, TD_INTERVAL)
    ticker, _, mic = symbol.upper().partition(":")
    params = {"symbol": ticker, "interval": iv, "outputsize": min(limit, 5000), "timezone": "UTC", "apikey": key}
    if mic:
        params["exchange"] = mic
    try:
        async with httpx.AsyncClient(timeout=20.0, transport=transport) as c:
            r = await c.get(f"{TD_BASE}/time_series", params=params)
    except httpx.HTTPError:
        raise HistoryError(502, "Twelve Data is unreachable from this server")
    if r.status_code != 200:
        raise HistoryError(502, f"Twelve Data returned HTTP {r.status_code}")
    try:
        body = r.json()
    except ValueError:
        raise HistoryError(502, "Twelve Data returned an unreadable payload")
    if not isinstance(body, dict):
        raise HistoryError(502, "Twelve Data returned an unreadable payload")
    if body.get("status") == "error" or "values" not in body:
        code, msg = body.get("code"), str(body.get("message", "error")).replace(key, "***")[:160]
        if code in (400, 404):
            raise HistoryError(404, f"Twelve Data: {msg}")
        raise HistoryError(502, f"Twelve Data refused the request: {msg}")
    try:
        rows = []
        for v in body["values"]:
            t = _td_time_ms(str(v["datetime"]))
            rows.append({"open_time": t, "open": float(v["open"]), "high": float(v["high"]), "low": float(v["low"]),
                         "close": float(v["close"]), "volume": float(v.get("volume") or 0), "close_time": t + step - 1})
    except (KeyError, TypeError, ValueError):
        raise HistoryError(502, "Twelve Data returned an unreadable candle payload")
    if not rows:
        raise HistoryError(404, "Twelve Data returned no candles for this symbol")
    return sorted(rows, key=lambda x: x["open_time"])
