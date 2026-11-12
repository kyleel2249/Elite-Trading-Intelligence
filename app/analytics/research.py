"""Ranking, watchlists, risk alerts, replay and the evidence-gated research dossier."""
from __future__ import annotations

import re
from typing import Any, Mapping, Sequence

from .detectors import unusual_volume, volatility_breakout
from .regime import detect_regime
from .stats import closes_of, pct_returns, stdev


def scan_symbol(symbol: str, klines: Sequence[dict[str, Any]]) -> dict[str, Any]:
    reg, vol, brk = detect_regime(klines), unusual_volume(klines), volatility_breakout(klines)
    if reg["status"] != "ok":
        return {"symbol": symbol, "status": "insufficient_data", "detail": reg}
    flags = []
    if vol.get("unusual"):
        flags.append("unusual_volume")
    if brk.get("alert"):
        flags.append(f"volatility_breakout_{brk['direction']}")
    return {"symbol": symbol, "status": "ok", "regime": reg["label"], "efficiency_ratio": reg["efficiency_ratio"],
            "volatility_percentile": reg["volatility_percentile"], "relative_volume": vol.get("relative_volume"),
            "flags": flags, "last_close": closes_of(klines)[-1]}


def rank_opportunities(scans: Sequence[Mapping[str, Any]], top: int = 10) -> list[dict[str, Any]]:
    """Transparent heuristic ranking (attention priority, NOT a probability of profit)."""
    ranked = []
    for s in scans:
        if s.get("status") != "ok":
            continue
        score, why = 0.0, []
        if s["regime"].startswith("trending"):
            score += 30 * min(1.0, s["efficiency_ratio"] / 0.6)
            why.append(f"trend efficiency {s['efficiency_ratio']}")
        if "unusual_volume" in s["flags"]:
            score += 25
            why.append("unusual volume")
        if any(f.startswith("volatility_breakout") for f in s["flags"]):
            score += 25
            why.append("volatility breakout")
        if s["volatility_percentile"] >= 90:
            score -= 10
            why.append("extreme volatility penalty")
        if score > 0:
            ranked.append({"symbol": s["symbol"], "score": round(score, 1), "reasons": why, "regime": s["regime"]})
    ranked.sort(key=lambda r: (-r["score"], r["symbol"]))
    return ranked[:top]


def build_watchlist(ranked: Sequence[Mapping[str, Any]], min_score: float = 20.0, max_items: int = 10) -> dict[str, Any]:
    items = [r for r in ranked if r["score"] >= min_score][:max_items]
    return {"status": "ok", "count": len(items), "items": list(items),
            "notes": ["Watchlist = symbols that merit review, not trade recommendations."]}


def risk_alerts(snapshot: Mapping[str, Any], limits: Mapping[str, float] | None = None) -> list[dict[str, Any]]:
    """snapshot: equity, peak_equity, daily_pnl_pct, positions[{symbol, market_value}], optional correlated_pairs."""
    lim = {"max_drawdown_pct": 10.0, "max_daily_loss_pct": 3.0, "max_position_pct": 25.0, **(limits or {})}
    out, eq = [], float(snapshot.get("equity", 0) or 0)
    peak = float(snapshot.get("peak_equity", eq) or eq)
    dd = (peak - eq) / peak * 100 if peak > 0 else 0.0
    if dd >= lim["max_drawdown_pct"]:
        out.append({"rule": "drawdown", "severity": "critical", "value_pct": round(dd, 2), "limit_pct": lim["max_drawdown_pct"]})
    dpl = float(snapshot.get("daily_pnl_pct", 0) or 0)
    if -dpl >= lim["max_daily_loss_pct"]:
        out.append({"rule": "daily_loss", "severity": "critical", "value_pct": round(dpl, 2), "limit_pct": -lim["max_daily_loss_pct"]})
    for p in snapshot.get("positions", []):
        share = abs(float(p["market_value"])) / eq * 100 if eq > 0 else 0.0
        if share >= lim["max_position_pct"]:
            out.append({"rule": "concentration", "severity": "warning", "symbol": p["symbol"], "value_pct": round(share, 2),
                        "limit_pct": lim["max_position_pct"]})
    for pair in snapshot.get("correlated_pairs", []):
        out.append({"rule": "correlated_exposure", "severity": "warning", **pair})
    return out


class Replay:
    """Historical replay cursor: exposes only candles up to the cursor, so a strategy cannot see the future."""

    def __init__(self, klines: Sequence[dict[str, Any]], start: int = 60):
        if len(klines) < 2:
            raise ValueError("need at least 2 candles")
        self._k, self.cursor = list(klines), min(max(start, 1), len(klines))

    def visible(self) -> list[dict[str, Any]]:
        return self._k[:self.cursor]

    def step(self, n: int = 1) -> dict[str, Any]:
        self.cursor = min(self.cursor + max(n, 1), len(self._k))
        return {"cursor": self.cursor, "total": len(self._k), "finished": self.cursor >= len(self._k), "last": self._k[self.cursor - 1]}


INTENTS = [
    ("regime", r"\b(regime|trending|ranging|market state)\b"),
    ("volume", r"\b(unusual volume|volume spike|rvol|relative volume)\b"),
    ("breakout", r"\b(breakout|squeeze|volatility)\b"),
    ("correlation", r"\b(correlat\w*|diversif\w*)\b"),
    ("monte_carlo", r"\b(monte carlo|simulat\w*|risk of ruin)\b"),
    ("scan", r"\b(scan|opportunit\w*|watchlist|what should i watch)\b"),
    ("research", r"\b(research|investigate|analy[sz]e|should i buy|due diligence)\b"),
]
_TICKER = re.compile(r"\b[A-Z]{2,6}(?:USDT|USD)?\b")
_STOP = {"AND", "THE", "FOR", "WITH", "WHAT", "WHICH", "ARE", "IS", "ME", "MY", "TO", "OF", "ON", "IN", "ALL", "SHOW", "MONTE", "CARLO"}


def parse_query(text: str) -> dict[str, Any]:
    """Rule-based natural-language router: maps a question to an ETI analytics endpoint. No LLM, no guessing."""
    t = text.strip()
    if not t:
        raise ValueError("empty query")
    low = t.lower()
    intent = next((name for name, pat in INTENTS if re.search(pat, low)), None)
    symbols = [s for s in _TICKER.findall(t) if s not in _STOP]
    interval = next((v for k, v in {"daily": "1d", "hourly": "1h", "weekly": "1w", "15m": "15m", "4h": "4h", "1h": "1h", "1d": "1d"}.items() if k in low), "1h")
    routes = {"regime": "/api/analytics/regime", "volume": "/api/analytics/unusual-volume", "breakout": "/api/analytics/volatility-breakout",
              "correlation": "/api/analytics/correlation", "monte_carlo": "/api/analytics/monte-carlo",
              "scan": "/api/analytics/scan", "research": "/api/analytics/research"}
    if intent is None:
        return {"status": "unrecognized", "detail": "Could not map the question to an analytics function.", "supported": sorted(routes)}
    return {"status": "ok", "intent": intent, "endpoint": routes[intent], "symbols": symbols, "interval": interval,
            "needs_symbol": intent not in ("scan",) and not symbols}


REQUIRED_EVIDENCE: dict[str, list[str]] = {
    "stock": ["price_history", "fundamentals", "earnings_calendar", "institutional_holdings", "news"],
    "crypto": ["price_history", "token_unlocks", "on_chain_or_whale", "liquidity", "news"],
    "commodity": ["price_history", "supply_demand", "macro_calendar", "news"],
    "currency": ["price_history", "rate_differentials", "macro_calendar", "news"],
}


def research_dossier(asset: str, asset_class: str, evidence: Mapping[str, Any], klines: Sequence[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Evidence-gated research. Exposure is never recommended while required evidence is missing."""
    ac = asset_class.lower()
    if ac not in REQUIRED_EVIDENCE:
        raise ValueError(f"asset_class must be one of {sorted(REQUIRED_EVIDENCE)}")
    required = REQUIRED_EVIDENCE[ac]
    have = [k for k in required if evidence.get(k) not in (None, "", [], {})]
    missing = [k for k in required if k not in have]
    tech = detect_regime(klines) if klines else {"status": "insufficient_data"}
    if tech["status"] == "ok" and "price_history" in missing:
        missing.remove("price_history")
        have.append("price_history")
    gate = len(missing) == 0
    return {"status": "ok", "asset": asset.upper(), "asset_class": ac, "evidence_present": sorted(have), "evidence_missing": sorted(missing),
            "technical": tech,
            "exposure_recommendation": "research_complete_human_review_required" if gate else "no_recommendation_insufficient_evidence",
            "notes": ["ETI will not recommend exposure until required evidence for the asset class is supplied and sourced.",
                      "Even a complete dossier is research support, not investment advice; sizing must pass the RiskEngine."]}
