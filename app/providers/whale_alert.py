"""Whale Alert adapter (Enterprise REST API), per https://developer.whale-alert.io documentation (checked 2026-11-12).

Base URL https://leviathan.whale-alert.io, key as ``?api_key=``. Used endpoints: GET /status, GET /{chain}/status,
GET /{chain}/height_at_time/{ts}, GET /{chain}/transactions. The REST API is the Enterprise plan; the cheaper Alerts plan is
WebSocket only, so REST calls are expected to be refused (reported as ``plan_restricted``) on that plan.

Whale Alert reports TRANSFERS between attributed owners. A transfer is never a trade: nothing here emits a buy/sell signal.
Flow classification relies on ``owner_type`` containing "exchange"; the exact owner_type vocabulary is not documented, so
anything not recognised stays ``wallet_to_wallet`` and unattributed flows are kept out of exchange totals.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Optional
from urllib.parse import parse_qs, urlparse

from .base import ProviderClient, ProviderError, ProviderResult

_CHAIN = re.compile(r"^[a-z0-9_-]{2,24}$")
_SYMBOL = re.compile(r"^[A-Za-z0-9._-]{1,20}$")
SPECIAL_TYPES = {"mint", "burn", "lock", "unlock", "freeze", "unfreeze"}


def _f(v: Any) -> Optional[float]:
    try:
        return None if v is None or v == "" else float(v)
    except (TypeError, ValueError):
        return None


def _is_exchange(leg: Optional[dict[str, Any]]) -> bool:
    return bool(leg) and "exchange" in str(leg.get("owner_type") or "").lower()


def _lead(legs: Any) -> Optional[dict[str, Any]]:
    cand = [l for l in (legs or []) if isinstance(l, dict)]
    return max(cand, key=lambda l: _f(l.get("amount")) or 0.0, default=None)


def classify_flow(tx_type: str, src: Optional[dict[str, Any]], dst: Optional[dict[str, Any]]) -> str:
    t = (tx_type or "transfer").lower()
    if t in SPECIAL_TYPES:
        return t
    s_ex, d_ex = _is_exchange(src), _is_exchange(dst)
    if s_ex and d_ex:
        same = (src.get("owner") or "").lower() == (dst.get("owner") or "").lower() and bool(src.get("owner"))
        return "internal_exchange_transfer" if same else "exchange_to_exchange"
    if s_ex:
        return "exchange_outflow"
    if d_ex:
        return "exchange_inflow"
    return "wallet_to_wallet"


def normalize_transaction(tx: dict[str, Any], blockchain: str) -> list[dict[str, Any]]:
    """One flow per sub-transaction. USD value uses the provider's unit price; unpriced flows keep amount_usd=None."""
    flows = []
    ts = tx.get("timestamp")
    when = datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat() if isinstance(ts, (int, float)) else None
    for sub in tx.get("sub_transactions") or []:
        if not isinstance(sub, dict):
            continue
        src, dst = _lead(sub.get("inputs")), _lead(sub.get("outputs"))
        amount = sum((_f(l.get("amount")) or 0.0) for l in (sub.get("outputs") or []) if isinstance(l, dict)) or \
            sum((_f(l.get("amount")) or 0.0) for l in (sub.get("inputs") or []) if isinstance(l, dict))
        price = _f(sub.get("unit_price_usd"))
        owners = [(src or {}).get("owner"), (dst or {}).get("owner")]
        flows.append({"timestamp": when, "blockchain": blockchain, "hash": tx.get("hash"), "symbol": str(sub.get("symbol") or "").upper(),
                      "amount": amount, "amount_usd": round(amount * price, 2) if price is not None else None,
                      "kind": classify_flow(sub.get("transaction_type") or "transfer", src, dst),
                      "from_owner": (src or {}).get("owner"), "to_owner": (dst or {}).get("owner"),
                      "from_owner_type": (src or {}).get("owner_type"), "to_owner_type": (dst or {}).get("owner_type"),
                      "attribution": "attributed" if any(owners) else "unattributed"})
    return flows


def normalize_alert(alert: dict[str, Any]) -> list[dict[str, Any]]:
    """Alerts API (WebSocket) message -> flows. Owner type is not provided there, so exchange direction cannot be derived."""
    ts = alert.get("timestamp")
    when = datetime.fromtimestamp(int(ts), tz=timezone.utc).isoformat() if isinstance(ts, (int, float)) else None
    tx_type = str(alert.get("transaction_type") or "transfer").lower()
    return [{"timestamp": when, "blockchain": alert.get("blockchain"), "hash": (alert.get("transaction") or {}).get("hash"),
             "symbol": str(a.get("symbol") or "").upper(), "amount": _f(a.get("amount")), "amount_usd": _f(a.get("value_usd")),
             "kind": tx_type if tx_type in SPECIAL_TYPES else "unclassified_transfer", "from_owner": alert.get("from"), "to_owner": alert.get("to"),
             "from_owner_type": None, "to_owner_type": None,
             "attribution": "attributed" if any(str(alert.get(k) or "").lower() not in ("", "unknown wallet") for k in ("from", "to")) else "unattributed"}
            for a in alert.get("amounts") or [] if isinstance(a, dict)]


def summarize_flows(flows: list[dict[str, Any]], top: int = 5) -> dict[str, Any]:
    by: dict[str, dict[str, Any]] = {}
    for f in flows:
        s = by.setdefault(f["symbol"], {"symbol": f["symbol"], "exchange_inflow_usd": 0.0, "exchange_outflow_usd": 0.0, "kinds": {}, "unpriced": 0})
        s["kinds"][f["kind"]] = s["kinds"].get(f["kind"], 0) + 1
        if f["amount_usd"] is None:
            s["unpriced"] += 1
            continue
        if f["attribution"] == "attributed" and f["kind"] == "exchange_inflow":
            s["exchange_inflow_usd"] += f["amount_usd"]
        elif f["attribution"] == "attributed" and f["kind"] == "exchange_outflow":
            s["exchange_outflow_usd"] += f["amount_usd"]
    out = []
    for s in by.values():
        s["net_exchange_flow_usd"] = round(s["exchange_inflow_usd"] - s["exchange_outflow_usd"], 2)
        s["exchange_inflow_usd"], s["exchange_outflow_usd"] = round(s["exchange_inflow_usd"], 2), round(s["exchange_outflow_usd"], 2)
        out.append(s)
    out.sort(key=lambda s: -(s["exchange_inflow_usd"] + s["exchange_outflow_usd"]))
    largest = sorted((f for f in flows if f["amount_usd"] is not None), key=lambda f: -f["amount_usd"])[:top]
    return {"flows": len(flows), "by_symbol": out, "largest": largest,
            "signal": None,
            "notes": ["Transfers, not trades: an exchange inflow is not proof of selling and an outflow is not proof of buying.",
                      "Internal exchange moves, mints/burns and unattributed transfers are excluded from net exchange flow.",
                      "ETI emits no directional signal from whale transfers; use as context only."]}


class WhaleAlertClient(ProviderClient):
    name = "whale_alert"
    capability = "whale_activity"
    base_url = "https://leviathan.whale-alert.io"
    rate_per_minute = 400       # Enterprise limit is 500 calls/min
    verify_ttl_seconds = 12 * 3600

    def _auth(self, params: dict, headers: dict) -> None:
        params["api_key"] = self._key

    def _classify(self, status: int, body: Any) -> Optional[ProviderError]:
        err = super()._classify(status, body)
        if err:
            return err
        if isinstance(body, dict) and body.get("error"):
            low = str(body["error"]).lower()
            kind = "auth" if "authenticated" in low else "plan_restricted" if "not allowed" in low else "rate_limited" if "limit" in low else "bad_request"
            return ProviderError(self.name, kind, "provider returned an error", status)
        if not isinstance(body, (dict, list)):
            return ProviderError(self.name, "bad_response", "expected JSON", status)
        return None

    @staticmethod
    def _chain(chain: str) -> str:
        c = (chain or "").strip().lower()
        if not _CHAIN.match(c):
            raise ProviderError("whale_alert", "bad_request", "invalid blockchain name")
        return c

    async def blockchains(self) -> ProviderResult:
        res = await self.request("/status", cache_ttl=3600)
        if not isinstance(res.data, list):
            raise ProviderError(self.name, "bad_response", "expected a list")
        data = [{"name": b.get("name"), "symbols": b.get("symbols")} for b in res.data if isinstance(b, dict)]
        return ProviderResult(data, res.provider, res.endpoint, res.fetched_at, res.latency_ms, res.from_cache)

    async def chain_status(self, chain: str) -> ProviderResult:
        c = self._chain(chain)
        res = await self.request(f"/{c}/status", cache_ttl=60)
        d = res.data if isinstance(res.data, dict) else {}
        if "end_height" not in d:
            raise ProviderError(self.name, "bad_response", "missing end_height")
        return ProviderResult({"start_height": d.get("start_height"), "end_height": d.get("end_height"), "min_plan_height": d.get("min_plan_height")},
                              res.provider, res.endpoint, res.fetched_at, res.latency_ms, res.from_cache, {"blockchain": c})

    async def height_at_time(self, chain: str, unix_ts: int) -> int:
        c = self._chain(chain)
        res = await self.request(f"/{c}/height_at_time/{int(unix_ts)}", cache_ttl=300)
        h = res.data.get("height") if isinstance(res.data, dict) else None
        if not isinstance(h, int):
            raise ProviderError(self.name, "bad_response", "missing height")
        return h

    async def recent_transactions(self, chain: str, symbol: str, lookback_minutes: int = 60, min_usd: float = 1_000_000.0,
                                  limit: int = 100, max_pages: int = 3) -> ProviderResult:
        c = self._chain(chain)
        if not _SYMBOL.match(symbol or "") or not (1 <= lookback_minutes <= 1440) or not (1 <= limit <= 500) or min_usd < 0:
            raise ProviderError(self.name, "bad_request", "invalid symbol, lookback, limit or min_usd")
        start = await self.height_at_time(c, int(datetime.now(timezone.utc).timestamp()) - lookback_minutes * 60)
        params: dict[str, Any] = {"start_height": start, "symbol": symbol.lower(), "limit": limit, "order": "asc"}
        flows: list[dict[str, Any]] = []
        res: Optional[ProviderResult] = None
        scanned = pages = 0
        while pages < max_pages:
            res = await self.request(f"/{c}/transactions", params, cache_ttl=30)
            body = res.data if isinstance(res.data, dict) else {}
            txs = [t for t in body.get("transactions") or [] if isinstance(t, dict)]
            scanned += len(txs)
            for t in txs:
                flows += [f for f in normalize_transaction(t, c) if f["symbol"] == symbol.upper() and (f["amount_usd"] or 0.0) >= min_usd]
            pages += 1
            nxt = body.get("next")
            if not nxt or not txs:
                break
            q = parse_qs(urlparse(str(nxt)).query)
            if "start_index" not in q and "start_height" not in q:
                break
            for k in ("start_height", "start_index"):
                if k in q:
                    params[k] = int(q[k][0])
        assert res is not None
        return ProviderResult(flows, res.provider, res.endpoint, res.fetched_at, res.latency_ms, res.from_cache,
                              {"blockchain": c, "symbol": symbol.upper(), "pages": pages, "transactions_scanned": scanned, "min_usd": min_usd,
                               "truncated": bool(pages >= max_pages and body.get("next"))})

    async def probe(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        end = None
        for name, call in (("status", self.blockchains), ("chain_status", lambda: self.chain_status("ethereum"))):
            try:
                r = await call()
                out[name] = {"status": "ok", "rows": len(r.data) if isinstance(r.data, list) else 1}
                if name == "chain_status":
                    end = r.data["end_height"]
            except ProviderError as e:
                out[name] = {"status": e.kind, "http": e.status}
        if end is not None:
            try:
                r = await self.request("/ethereum/transactions", {"start_height": max(int(end) - 20, 0), "limit": 1}, cache_ttl=0)
                out["transactions"] = {"status": "ok", "rows": len((r.data or {}).get("transactions") or []) if isinstance(r.data, dict) else 0}
            except ProviderError as e:
                out["transactions"] = {"status": e.kind, "http": e.status}
        return out
