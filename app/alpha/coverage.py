"""Market coverage registry: what ETI can really see, how fresh it is, and what it cannot."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from app.alpha.db_models import AlphaSourceStatus
from app.config import Settings

REQUESTED_EXCHANGES = ["NYSE", "NASDAQ", "NYSE American", "London Stock Exchange", "Tokyo Stock Exchange", "Hong Kong Stock Exchange",
                       "Shanghai Stock Exchange", "Shenzhen Stock Exchange", "Euronext", "Frankfurt Stock Exchange",
                       "Australian Securities Exchange", "Toronto Stock Exchange"]

PROVIDERS: list[dict[str, Any]] = [
    {"id": "binance_public", "name": "Binance public spot REST", "asset_classes": ["crypto"], "exchanges": ["BINANCE (spot USDT pairs)"],
     "fields": ["24h ticker", "daily/hourly OHLCV", "order book depth"], "needs": None, "max_age_s": 3600 * 6,
     "gaps": ["spot USDT pairs only", "no derivatives funding/open-interest in this adapter"]},
    {"id": "dexscreener", "name": "DexScreener public API", "asset_classes": ["token"], "exchanges": ["multi-chain DEX pairs"],
     "fields": ["pair price", "liquidity USD", "24h volume", "txn counts", "pair age", "FDV/market cap"], "needs": None, "max_age_s": 3600 * 6,
     "gaps": ["no holder distribution", "no contract verification", "only tokens with a published profile are discovered", "heuristic safety screen is not an audit"]},
    {"id": "alpaca_data", "name": "Alpaca market data v2", "asset_classes": ["equity", "etf"], "exchanges": ["US-listed (IEX feed on free plans)"],
     "fields": ["daily OHLCV", "most-actives screener", "movers screener"], "needs": "alpaca", "max_age_s": 3600 * 36,
     "gaps": ["US only", "IEX volume understates consolidated volume", "no fundamentals", "no options or short-interest data"]},
    {"id": "sec_tickers", "name": "SEC company tickers (exchange list)", "asset_classes": ["equity"], "exchanges": ["NYSE", "NASDAQ", "NYSE American (as listed by SEC)"],
     "fields": ["issuer name", "ticker", "CIK", "exchange"], "needs": None, "max_age_s": 86400 * 3, "gaps": ["identity list only, no prices"]},
    {"id": "sec_edgar", "name": "SEC EDGAR (13F, Form 4, 13D/G)", "asset_classes": ["equity"], "exchanges": ["US filers"],
     "fields": ["13F information tables (delayed)", "Form 4 transactions", "filing index"], "needs": None, "max_age_s": 86400 * 3,
     "gaps": ["13F is quarterly and up to 45 days delayed", "13F omits shorts, most derivatives and non-US holdings", "CUSIP-to-ticker mapping is not bundled"]},
    {"id": "sec_facts", "name": "SEC XBRL company facts", "asset_classes": ["equity"], "exchanges": ["US filers with 10-K filings"],
     "fields": ["revenue", "net income", "equity", "long-term debt", "operating cash flow", "capex", "diluted EPS (annual, audited)"], "needs": None,
     "max_age_s": 86400 * 3, "gaps": ["annual 10-K only; no quarterly/TTM", "foreign private issuers (20-F/40-F) not covered", "XBRL tag choices vary by company"]},
    {"id": "quiver_quant", "name": "Quiver Quant", "asset_classes": ["equity"], "exchanges": ["US"], "fields": ["congress trades", "government contracts", "lobbying", "insiders (plan dependent)"],
     "needs": "quiver", "max_age_s": 86400, "gaps": ["datasets depend on plan", "secondary source"]},
    {"id": "liquid", "name": "Liquid API", "asset_classes": ["crypto"], "exchanges": ["operator-verified base URL only"], "fields": ["not assumed"],
     "needs": "liquid", "max_age_s": 3600, "gaps": ["the existing ETI Liquid client implements a health check only; no market-data fields are consumed", "requires a verified LIQUID_API_BASE_URL"]},
    {"id": "explorer", "name": "Etherscan-compatible explorer", "asset_classes": ["token", "crypto"], "exchanges": ["operator-configured chain"], "fields": ["ERC-20 transfers"],
     "needs": "explorer", "max_age_s": 3600 * 6, "gaps": ["recent-transfer window only", "labels supplied by operator; none bundled"]},
    {"id": "fred", "name": "FRED", "asset_classes": ["macro"], "exchanges": [], "fields": ["macro series"], "needs": "fred", "max_age_s": 86400 * 2, "gaps": []},
]


def _configured(p: dict[str, Any], s: Settings) -> bool:
    need = p["needs"]
    if need is None:
        return True
    return {"alpaca": s.alpaca_configured, "quiver": s.quiver_configured, "liquid": s.liquid_configured,
            "fred": s.fred_configured, "explorer": bool(getattr(s, "alpha_explorer_api_key", None) and getattr(s, "alpha_explorer_base_url", None))}.get(need, False)


def build_registry(db: Session, settings: Settings) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    rows = {r.provider: r for r in db.query(AlphaSourceStatus).all()}
    out = []
    for p in PROVIDERS:
        r = rows.get(p["id"])
        configured = _configured(p, settings)
        age = None
        if r and r.last_success:
            age = int((now - r.last_success.replace(tzinfo=timezone.utc)).total_seconds())
        if not configured:
            status = "NOT_CONFIGURED"
        elif r is None or r.last_success is None:
            status = "UNVERIFIED" if r is None or r.failures == 0 else "FAILING"
        elif age is not None and age > p["max_age_s"]:
            status = "STALE"
        elif r.last_error_at and (r.last_error_at > r.last_success):
            status = "DEGRADED"
        else:
            status = "OK"
        out.append({"provider": p["id"], "name": p["name"], "asset_classes": p["asset_classes"], "exchanges": p["exchanges"],
                    "fields": p["fields"], "configured": configured, "status": status, "freshness_seconds": age,
                    "calls": r.calls if r else 0, "failures": r.failures if r else 0,
                    "last_error": r.last_error if r else None, "known_gaps": p["gaps"]})
    supported_exchanges = sorted({e for p in out if p["configured"] for e in p["exchanges"]})
    return {"generated_at": now.isoformat(), "providers": out,
            "requested_exchanges_without_integration": [e for e in REQUESTED_EXCHANGES if e not in ("NYSE", "NASDAQ", "NYSE American")],
            "supported_exchanges": supported_exchanges,
            "claim": "ETI does NOT cover global markets. Coverage is limited to the providers above; UNVERIFIED means never successfully called from this deployment.",
            "asset_classes_without_integration": ["forex", "commodities", "futures/derivatives", "international equities", "ETF-specific analytics"]}
