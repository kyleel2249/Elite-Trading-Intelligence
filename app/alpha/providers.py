"""Market-data providers used by discovery. Every call records success/failure
in alpha_source_status so the coverage registry reports measured freshness,
never assumed freshness. All providers accept an injected httpx.AsyncClient
(tests use httpx.MockTransport)."""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any, Optional

import httpx

from app.alpha.db_models import AlphaSourceStatus

logger = logging.getLogger("eti.alpha")
BINANCE_PUBLIC = "https://api.binance.com"
DEXSCREENER = "https://api.dexscreener.com"
ALPACA_DATA = "https://data.alpaca.markets"
SEC_FILES = "https://www.sec.gov/files"
SEC_UA = "EliteTradingIntelligence/1.0 (research; set SEC_USER_AGENT)"


def record_status(db, provider: str, ok: bool, error: Optional[str] = None) -> None:
    if db is None:
        return
    row = db.query(AlphaSourceStatus).filter_by(provider=provider).one_or_none()
    if row is None:
        row = AlphaSourceStatus(provider=provider, calls=0, failures=0)
        db.add(row)
    row.calls = (row.calls or 0) + 1
    now = datetime.now(timezone.utc)
    if ok:
        row.last_success = now
    else:
        row.failures = (row.failures or 0) + 1
        row.last_error_at = now
        row.last_error = (error or "error")[:300]
    db.commit()


class _Base:
    provider = "base"

    def __init__(self, client: Optional[httpx.AsyncClient] = None, db=None, timeout: float = 15.0):
        self._client = client
        self.db = db
        self.timeout = timeout

    async def _get(self, url: str, params: Optional[dict] = None, headers: Optional[dict] = None) -> Any:
        """GET with bounded retry on 429/503 (honours Retry-After, capped at 5s). Every outcome is recorded."""
        last: Optional[Exception] = None
        for attempt in range(3):
            try:
                if self._client is not None:
                    r = await self._client.get(url, params=params, headers=headers)
                else:
                    async with httpx.AsyncClient(timeout=self.timeout) as c:
                        r = await c.get(url, params=params, headers=headers)
                if r.status_code in (429, 503) and attempt < 2:
                    try:
                        wait = min(5.0, float(r.headers.get("Retry-After", 0.5 * (attempt + 1))))
                    except ValueError:
                        wait = 1.0
                    await asyncio.sleep(wait)
                    continue
                r.raise_for_status()
                data = r.json()
                record_status(self.db, self.provider, True)
                return data
            except Exception as exc:  # noqa: BLE001 - recorded then re-raised
                last = exc
                break
        record_status(self.db, self.provider, False, f"{type(last).__name__}: {last}"[:300])
        raise last  # type: ignore[misc]


class BinanceUniverse(_Base):
    """Public, keyless Binance spot REST: 24h tickers and daily klines."""
    provider = "binance_public"

    async def tickers_24h(self) -> list[dict[str, Any]]:
        rows = await self._get(f"{BINANCE_PUBLIC}/api/v3/ticker/24hr")
        out = []
        for r in rows:
            sym = r.get("symbol", "")
            if not sym.endswith("USDT") or any(sym.endswith(x) for x in ("UPUSDT", "DOWNUSDT", "BULLUSDT", "BEARUSDT")):
                continue
            try:
                out.append({"symbol": sym, "price": float(r["lastPrice"]), "quote_volume": float(r["quoteVolume"]),
                            "change_pct": float(r["priceChangePercent"]), "trades": int(r.get("count") or 0)})
            except (KeyError, ValueError, TypeError):
                continue
        return out

    async def klines(self, symbol: str, interval: str = "1d", limit: int = 200) -> list[dict[str, Any]]:
        rows = await self._get(f"{BINANCE_PUBLIC}/api/v3/klines",
                               {"symbol": symbol.upper(), "interval": interval, "limit": limit})
        return [{"open_time": k[0], "open": float(k[1]), "high": float(k[2]), "low": float(k[3]),
                 "close": float(k[4]), "volume": float(k[5]), "close_time": k[6]} for k in rows]


class DexScreener(_Base):
    """Keyless DexScreener public API: new token profiles and pair data."""
    provider = "dexscreener"

    async def latest_profiles(self) -> list[dict[str, Any]]:
        data = await self._get(f"{DEXSCREENER}/token-profiles/latest/v1")
        return [d for d in (data if isinstance(data, list) else []) if d.get("tokenAddress") and d.get("chainId")]

    async def pairs_for_tokens(self, chain: str, addresses: list[str]) -> list[dict[str, Any]]:
        if not addresses:
            return []
        data = await self._get(f"{DEXSCREENER}/tokens/v1/{chain}/{','.join(addresses[:30])}")
        return data if isinstance(data, list) else []

    async def search(self, q: str) -> list[dict[str, Any]]:
        data = await self._get(f"{DEXSCREENER}/latest/dex/search", {"q": q})
        return (data or {}).get("pairs") or []


class AlpacaMarketData(_Base):
    """Alpaca market-data v2 (key required). Free plans are IEX-feed only."""
    provider = "alpaca_data"

    def __init__(self, key: Optional[str], secret: Optional[str], **kw: Any):
        super().__init__(**kw)
        self.key, self.secret = key, secret

    @property
    def configured(self) -> bool:
        return bool(self.key and self.secret)

    def _h(self) -> dict[str, str]:
        return {"APCA-API-KEY-ID": self.key or "", "APCA-API-SECRET-KEY": self.secret or ""}

    async def daily_bars(self, symbol: str, limit: int = 250) -> list[dict[str, Any]]:
        data = await self._get(f"{ALPACA_DATA}/v2/stocks/{symbol.upper()}/bars",
                               {"timeframe": "1Day", "limit": limit, "adjustment": "split", "feed": "iex"}, self._h())
        return [{"open_time": b["t"], "open": b["o"], "high": b["h"], "low": b["l"], "close": b["c"], "volume": b["v"]}
                for b in (data or {}).get("bars") or []]

    async def most_actives(self, top: int = 25) -> list[dict[str, Any]]:
        data = await self._get(f"{ALPACA_DATA}/v1beta1/screener/stocks/most-actives", {"by": "volume", "top": top}, self._h())
        return (data or {}).get("most_actives") or []

    async def movers(self, top: int = 25) -> dict[str, list[dict[str, Any]]]:
        data = await self._get(f"{ALPACA_DATA}/v1beta1/screener/stocks/movers", {"top": top}, self._h())
        return {"gainers": (data or {}).get("gainers") or [], "losers": (data or {}).get("losers") or []}


class SecTickerUniverse(_Base):
    """SEC company_tickers_exchange.json: US-listed issuers with exchange field."""
    provider = "sec_tickers"

    def __init__(self, user_agent: Optional[str] = None, **kw: Any):
        super().__init__(**kw)
        self.ua = user_agent or SEC_UA

    async def listed(self) -> list[dict[str, Any]]:
        data = await self._get(f"{SEC_FILES}/company_tickers_exchange.json", headers={"User-Agent": self.ua})
        fields = (data or {}).get("fields") or []
        out = []
        for row in (data or {}).get("data") or []:
            d = dict(zip(fields, row))
            if d.get("ticker"):
                out.append({"cik": d.get("cik"), "name": d.get("name"), "ticker": d["ticker"], "exchange": d.get("exchange")})
        return out
