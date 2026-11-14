"""Live evaluators for investment styles that cannot be backtested from price alone.

Each returns a state plus the evidence it used. They are ETI parameterizations of publicly described ideas
(contrarian value, deep value from statements, boom-bust reflexivity, activist presence), NOT the investors' own
rules or thresholds, and they are not backtested. Outputs are soft evidence: they never approve or veto a trade."""
from __future__ import annotations

from typing import Any, Optional

PARAMS = {"contrarian_min_drawdown": 0.40, "contrarian_min_off_low": 0.02, "deep_min_fcf_yield": 0.08, "deep_max_pb": 1.5,
          "boom_extension_equity": 0.25, "boom_extension_crypto": 0.50, "boom_rsi": 75.0}
NOTE = "ETI parameterization of publicly described ideas; not the investor's own rules; not backtested."


def contrarian_value(features: dict[str, Any], fundamentals: Optional[dict[str, Any]]) -> dict[str, Any]:
    """Templeton-style: buy where pessimism is extreme, but only if the business passes a quality screen and price has stopped falling."""
    if not features.get("sufficient") or not fundamentals:
        return {"state": "NOT_EVALUABLE", "reason": "needs price history and SEC fundamentals", "note": NOTE}
    dd, off = features.get("dist_to_high"), features.get("off_low_20")
    q = (fundamentals.get("quality") or {}).get("verdict")
    ev = [f"{(dd or 0):.0%} below the {features['bars'] if features['bars'] < 120 else 120}-bar high", f"{(off or 0):.1%} above the 20-bar low", f"quality={q}"]
    ok = (dd or 0) >= PARAMS["contrarian_min_drawdown"] and (off or 0) >= PARAMS["contrarian_min_off_low"] and q == "PASSES_SCREEN"
    return {"state": "CANDIDATE" if ok else "NO_FLAG", "evidence": ev, "note": NOTE + " Drawdown is measured over the available window, not 52 weeks."}


def deep_value(price: Optional[float], fundamentals: Optional[dict[str, Any]]) -> dict[str, Any]:
    """Burry-style statement screen: high free-cash-flow yield and low price-to-book, excluding businesses that fail the quality screen."""
    m = (fundamentals or {}).get("metrics") or {}
    if not price or not m.get("shares") or not m.get("equity"):
        return {"state": "NOT_EVALUABLE", "reason": "needs price, shares outstanding, equity and free cash flow from SEC data", "note": NOTE}
    cap = price * m["shares"]
    fcf_yield = (m["fcf"] / cap) if m.get("fcf") is not None and cap > 0 else None
    pb = cap / m["equity"] if m["equity"] > 0 else None
    q = ((fundamentals or {}).get("quality") or {}).get("verdict")
    ev = [f"FCF yield {fcf_yield:.1%}" if fcf_yield is not None else "FCF yield unavailable", f"price/book {pb:.2f}" if pb is not None else "price/book unavailable", f"quality={q}"]
    ok = fcf_yield is not None and pb is not None and fcf_yield >= PARAMS["deep_min_fcf_yield"] and pb <= PARAMS["deep_max_pb"] and q != "FAILS_SCREEN"
    return {"state": "CANDIDATE" if ok else "NO_FLAG", "evidence": ev, "market_cap": round(cap, 2),
            "note": NOTE + " Share count is the latest cover-page figure and may be stale; this screen can surface value traps."}


def reflexivity(features: dict[str, Any], derivatives: Optional[dict[str, Any]], asset_class: str) -> dict[str, Any]:
    """Soros-style boom-bust description: an extended trend plus crowded positioning or overbought momentum is a late-stage boom, a fragility signal."""
    if not features.get("sufficient"):
        return {"state": "NOT_EVALUABLE", "reason": "insufficient price history", "note": NOTE}
    cap = PARAMS["boom_extension_crypto"] if asset_class in ("crypto", "token") else PARAMS["boom_extension_equity"]
    ext, rsi = features.get("extension_50") or 0.0, features.get("rsi14") or 0.0
    crowded = (derivatives or {}).get("state") == "CROWDED_LONG_RISK"
    ev = [f"extension vs 50-bar mean {ext:.0%} (flag at {cap:.0%})", f"RSI {rsi:.0f}", f"derivatives crowded={crowded}"]
    late = ext >= cap and (crowded or rsi >= PARAMS["boom_rsi"])
    return {"state": "BOOM_LATE_STAGE" if late else "NO_FLAG", "evidence": ev,
            "note": NOTE + " Soros's macro leg (rates, currencies, credit) is not implemented; this is the price/positioning leg only."}


def activist_presence(catalysts: Optional[dict[str, Any]], fundamentals: Optional[dict[str, Any]]) -> dict[str, Any]:
    """Activist/concentrated-holder interest: a recent 13D/13G filing on a business that passes the quality screen."""
    if catalysts is None:
        return {"state": "NOT_EVALUABLE", "reason": "no SEC filing data", "note": NOTE}
    own = catalysts.get("ownership_filings") or []
    q = ((fundamentals or {}).get("quality") or {}).get("verdict")
    ev = [f"{len(own)} large-holder filing(s) in the last year", f"quality={q}"]
    return {"state": "ACTIVIST_INTEREST_PRESENT" if own and q == "PASSES_SCREEN" else ("LARGE_HOLDER_FILING_ONLY" if own else "NO_FLAG"),
            "evidence": ev, "filings": own[:5],
            "note": NOTE + " Filing contents (stake size, intent) are not parsed; a 13G is a passive-holder filing and not activism."}


def evaluate_styles(features: dict[str, Any], fundamentals: Optional[dict[str, Any]], derivatives: Optional[dict[str, Any]],
                    catalysts: Optional[dict[str, Any]], price: Optional[float], asset_class: str) -> dict[str, Any]:
    out: dict[str, Any] = {"reflexivity": reflexivity(features, derivatives, asset_class)}
    if asset_class == "equity":
        out["contrarian_value"] = contrarian_value(features, fundamentals)
        out["deep_value"] = deep_value(price, fundamentals)
        out["activist_presence"] = activist_presence(catalysts, fundamentals)
    return out
