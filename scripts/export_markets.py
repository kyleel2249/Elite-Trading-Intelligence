"""Export the market layer's data tables and golden test vectors for the Cloudflare Worker port.

  worker/markets.generated.json  - catalog tables, sessions, profiles, holiday calendars, provider capabilities
  worker/markets.golden.json     - Python-computed results the TypeScript port must reproduce exactly

The Python implementation is the source of truth. ``tests/test_markets_worker_sync.py`` fails if these files
are stale, and ``worker/markets.test.ts`` fails if the TypeScript port disagrees with the golden vectors.
Run:  python scripts/export_markets.py
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.config import Settings  # noqa: E402
from app.markets import PROFILES, SESSIONS, CAPABILITIES, assess, classify, market_risk_review, session_status  # noqa: E402
from app.markets import registry as R  # noqa: E402
from app.markets.oanda_map import OANDA_COMMODITIES, OANDA_INDICES  # noqa: E402
from app.markets.sessions import _DATA_FILE  # noqa: E402

OUT_DATA = ROOT / "worker" / "markets.generated.json"
OUT_GOLD = ROOT / "worker" / "markets.golden.json"

NONE = Settings(oanda_api_token=None, oanda_account_id=None, alpaca_api_key=None, alpaca_secret_key=None,
                binance_api_key=None, binance_secret_key=None)
BOTH = Settings(oanda_api_token="x", oanda_account_id="y", alpaca_api_key="a", alpaca_secret_key="b",
                binance_api_key=None, binance_secret_key=None)
CREDS = {"none": NONE, "both": BOTH}


def _jsonable(o):
    if isinstance(o, (set, frozenset)):
        return sorted(o)
    if isinstance(o, tuple):
        return [_jsonable(x) for x in o]
    raise TypeError(type(o))


def build_data() -> dict:
    return {
        "sessions": {sid: {"id": s.id, "name": s.name, "tz": s.tz, "windows": [list(w) for w in s.windows],
                           "extended": [list(w) for w in s.extended], "always_open": s.always_open, "kind": s.kind,
                           "holiday_key": s.holiday_key, "schedule_confidence": s.schedule_confidence, "note": s.note}
                     for sid, s in SESSIONS.items()},
        "holidays_file": json.loads(Path(_DATA_FILE).read_text(encoding="utf-8")),
        "profiles": {k: p.to_dict() for k, p in PROFILES.items()},
        "capabilities": {k: v.to_dict() for k, v in CAPABILITIES.items()},
        "registry": {
            "fx_major_ccy": sorted(R.FX_MAJOR_CCY), "fx_all_ccy": sorted(R.FX_ALL_CCY), "fx_major_pairs": sorted(R._FX_MAJOR_PAIRS),
            "fx_pip": R._FX_PIP, "metals": {k: list(v) for k, v in R.METALS.items()}, "metal_proxies": R.METAL_PROXIES, "metal_units": R.METAL_UNITS, "metal_code_aliases": R.METAL_CODE_ALIASES,
            "metal_proxy_quality": R.METAL_PROXY_QUALITY, "industrial_metals": sorted(R.INDUSTRIAL_METALS), "gold_tokens": R.GOLD_TOKENS,
            "crypto_quotes": list(R.CRYPTO_QUOTES), "stable_quotes": sorted(R._STABLE_QUOTES), "stablecoins": sorted(R.STABLECOINS),
            "crypto_major": R.CRYPTO_MAJOR, "crypto_large": R.CRYPTO_LARGE, "crypto_defi": R.CRYPTO_DEFI, "crypto_meme": R.CRYPTO_MEME,
            "crypto_base_skip": sorted(R.CRYPTO_BASE_SKIP), "us_mega": sorted(R.US_MEGA), "liquid_etfs": sorted(R._LIQUID_ETFS),
            "us_etfs": sorted(R._US_ETFS), "exchanges": {k: list(v) for k, v in R.EXCHANGES.items()},
            "exchange_aliases": R._EXCHANGE_ALIASES, "suffix_to_exchange": R._SUFFIX_TO_EXCHANGE,
            "index_rows": [[*r[:5], list(r[5]), r[6], r[7]] for r in R._INDEX_ROWS],
            "commodity_rows": [[*r[:5], list(r[5]), r[6]] for r in R._COMMODITY_ROWS],
            "fut_roots": {k: list(v) for k, v in R._FUT_ROOTS.items()}, "name_aliases": R._NAME_ALIASES,
            "bare_crypto": sorted(R._BARE_CRYPTO),
        },
        "oanda": {"indices": OANDA_INDICES, "commodities": OANDA_COMMODITIES},
    }


CLASSIFY_CASES = [
    ("EURUSD", None), ("eur/usd", None), ("GBP_USD", None), ("USDJPY", None), ("AUDUSD", None), ("USDCAD", None), ("USDCHF", None),
    ("NZDUSD", None), ("EURGBP", None), ("USDZAR", None), ("USDNGN", None), ("USDTRY", None), ("XAUUSD", None), ("XAGUSD", None), ("XAUUSDT", None), ("XAUUSDT", "oanda"), ("COPPERUSDT", None), ("XCUUSD", None), ("XPTUSD", None), ("PAXGUSDT", None), ("XAUTUSDT", "binance"),
    ("XPTUSD", None), ("gold", None), ("BTCUSDT", None), ("BTC", None), ("ETHUSDT", None), ("SOLUSDT", None), ("XRPUSDT", None),
    ("BNBUSDT", None), ("DOGEUSDT", None), ("1000SATSUSDT", None), ("1000SATS", None), ("PEPEUSDT", None), ("UNIUSDT", None),
    ("NEWCOINUSDT", None), ("NEWCOINUSDT", "binance"), ("SOMEBTC", "binance"), ("USDCUSDT", None), ("AAPL", None), ("BRK.B", None),
    ("ZZZZ", None), ("SPY", None), ("SPX", None), ("SPX", "alpaca"), ("NDX", None), ("DJI", None), ("FTSE100", None), ("DAX", None),
    ("N225", None), ("^GSPC", None), ("US30", None), ("NG", None), ("NG", "alpaca"), ("WTI", None), ("CL", None), ("BRENT", None),
    ("CORN", None), ("COFFEE", None), ("VOD.L", None), ("SAP.DE", None), ("7203.T", None), ("NPN.JO", None), ("0700.HK", None),
    ("NGX:DANGCEM", None), ("GSE:GCB", None), ("EGX:COMI", None), ("NSE_KE:SCOM", None), ("JSE:NPN", None), ("xetra:sap", None),
    ("ESZ6", None), ("MESZ6", None), ("CLZ6", None), ("GCZ6", None), ("ZCH7", None), ("AAPL261218C00200000", None),
    ("SPY261218P00500000", None), ("???", None), ("", None), ("EURXYZ", None), ("USDUSD", None),
]
NOWS = ["2026-11-09T14:35:00Z", "2026-11-14T12:00:00Z", "2026-11-13T21:59:00Z", "2026-11-15T22:30:00Z", "2026-11-26T15:00:00Z",
        "2026-11-27T18:30:00Z", "2026-03-09T13:35:00Z", "2026-03-30T08:00:00Z", "2026-03-08T06:30:00Z", "2026-12-24T12:00:00Z",
        "2026-12-25T15:00:00Z", "2027-01-01T15:00:00Z", "2026-04-03T10:00:00Z", "2027-03-26T10:00:00Z", "2026-11-10T02:45:00Z",
        "2026-11-10T02:00:00Z", "2026-11-15T09:00:00Z", "2026-11-10T08:00:00Z", "2028-06-01T12:00:00Z", "2026-11-01T05:30:00Z",
        "2026-11-09T21:50:00Z", "2026-11-09T09:05:00Z"]
ASSESS_NOWS = ["2026-11-09T14:35:00Z", "2026-11-14T12:00:00Z", "2026-11-10T08:00:00Z"]
ASSESS_CASES = [
    dict(symbol="EURUSD", price=1.085), dict(symbol="USDJPY", price=150.2, stop_price=149.5), dict(symbol="USDZAR", price=18.2),
    dict(symbol="XAUUSD", price=2650.0, atr=30.0), dict(symbol="XAGUSD", price=31.0), dict(symbol="XCUUSD", price=4.5), dict(symbol="PAXGUSDT", price=2650.0), dict(symbol="XAUUSDT", price=2650.0), dict(symbol="BTCUSDT", price=70000.0, avg_daily_volume_usd=2e9),
    dict(symbol="1000SATSUSDT", price=0.45, listing_age_days=10), dict(symbol="DOGEUSDT", price=0.2, side="sell"),
    dict(symbol="NEWCOINUSDT", price=1.0, provider="binance"), dict(symbol="AAPL", price=210.0, avg_daily_volume_usd=9e9),
    dict(symbol="VOD.L", price=72.0, quote_to_usd=0.0127), dict(symbol="VOD.L", price=72.0), dict(symbol="NGX:DANGCEM", price=500.0),
    dict(symbol="SPX", price=6000.0), dict(symbol="DAX", price=19000.0, measured_spread_bps=1.5), dict(symbol="N225", price=39000.0),
    dict(symbol="WTI", price=72.0, account_equity=250000.0), dict(symbol="COFFEE", price=300.0), dict(symbol="ESZ6", price=6000.0, account_equity=1000000.0),
    dict(symbol="ESZ6", price=6000.0), dict(symbol="MESZ6", price=6000.0, account_equity=1000000.0, risk_pct=0.5),
    dict(symbol="AAPL261218C00200000", price=4.2), dict(symbol="EURUSD"), dict(symbol="NOPE???"), dict(symbol="EURUSD", price=1.085, provider="binance"),
    dict(symbol="BTCUSDT", price=70000.0, stop_price=80000.0), dict(symbol="SPX", price=6000.0, provider="alpaca"),
]
REVIEW_CASES = [("BTCUSDT", "binance", "paper"), ("EURUSD", "binance", "paper"), ("EURUSD", "oanda", "live"), ("EURUSD", "oanda", "testnet"),
                ("AAPL", "alpaca", "live"), ("VOD.L", "alpaca", "live"), ("VOD.L", "alpaca", "paper"), ("NEWCOINUSDT", "binance", "paper"),
                ("NGX:DANGCEM", "alpaca", "live"), ("COFFEE", "oanda", "paper"), ("???", "alpaca", "live"), ("1000SATSUSDT", "binance", "live")]


def _dt(s: str) -> datetime:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc)


def build_golden() -> dict:
    return {
        "nows": NOWS,
        "classify": [{"symbol": s, "provider": p, "result": classify(s, provider_hint=p).to_dict()} for s, p in CLASSIFY_CASES],
        "sessions": [{"now": n, "session_id": sid, "result": session_status(sid, _dt(n)).to_dict()} for n in NOWS for sid in SESSIONS],
        "assess": [{"creds": c, "now": n, "args": a, "result": assess(now=_dt(n), settings=CREDS[c], **a)}
                   for c in ("none", "both") for n in (ASSESS_NOWS if c == "both" else ASSESS_NOWS[:1]) for a in ASSESS_CASES],
        "review": [{"symbol": s, "provider": p, "environment": e, "now": n, "result": market_risk_review(s, p, e, now=_dt(n)).to_dict()}
                   for s, p, e in REVIEW_CASES for n in ASSESS_NOWS[:2]],
    }


def render(obj) -> str:
    return json.dumps(obj, default=_jsonable, sort_keys=True, ensure_ascii=False, separators=(",", ":")) + "\n"


if __name__ == "__main__":
    OUT_DATA.write_text(render(build_data()), encoding="utf-8")
    OUT_GOLD.write_text(render(build_golden()), encoding="utf-8")
    print(f"wrote {OUT_DATA.relative_to(ROOT)} ({OUT_DATA.stat().st_size} bytes), {OUT_GOLD.relative_to(ROOT)} ({OUT_GOLD.stat().st_size} bytes)")
