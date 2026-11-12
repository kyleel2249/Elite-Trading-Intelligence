"""Fair-value inputs from SEC XBRL ``companyfacts`` (US-listed issuers only).

Complements Global Alpha's fundamentals *screens* (app.alpha.fundamentals: quality, GARP, explicitly "not a
valuation") by turning the same filings into DCF/DDM *inputs*. It reuses Global Alpha's SEC plumbing for the
CIK map, cached companyfacts, User-Agent and provider-status recording rather than a second client.

What this produces: ``dcf`` inputs (free cash flow per share, growth, net debt) and ``ddm`` inputs (dividends).
What it does NOT produce: peer multiples (needs a peer set / licensed data), so a lone DCF is still
"insufficiently supported" until a second independent model is supplied.

Assumptions that are NOT from filings (discount rate, terminal growth, growth cap) are explicit arguments and are
echoed back in ``assumptions``. Stale filings are withheld rather than used.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any, Optional

OCF = ["NetCashProvidedByUsedInOperatingActivities", "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations"]
CAPEX = ["PaymentsToAcquirePropertyPlantAndEquipment", "PaymentsToAcquireProductiveAssets"]
SHARES = ["WeightedAverageNumberOfDilutedSharesOutstanding", "WeightedAverageNumberOfSharesOutstandingBasic"]
DEBT_LT = ["LongTermDebtNoncurrent", "LongTermDebt"]
DEBT_ST = ["LongTermDebtCurrent", "DebtCurrent"]
CASH = ["CashAndCashEquivalentsAtCarryingValue"]
DPS = ["CommonStockDividendsPerShareDeclared", "CommonStockDividendsPerShareCashPaid"]


def _facts(cf: dict, concepts: list[str], unit: str) -> list[dict]:
    """Annual (10-K, FY) observations for the first concept that has data; latest filing wins per period end."""
    gaap = (cf.get("facts") or {}).get("us-gaap") or {}
    for c in concepts:
        rows = ((gaap.get(c) or {}).get("units") or {}).get(unit) or []
        best: dict[str, dict] = {}
        for r in rows:
            if str(r.get("form", "")).upper() not in ("10-K", "10-K/A") or r.get("fp") != "FY":
                continue
            end = r.get("end")
            if end and (end not in best or str(r.get("filed", "")) > str(best[end].get("filed", ""))):
                best[end] = r
        if best:
            return [best[k] for k in sorted(best)]
    return []


def _cagr(vals: list[float]) -> Optional[float]:
    if len(vals) < 3 or any(v is None or v <= 0 for v in vals):
        return None
    n = len(vals) - 1
    return (vals[-1] / vals[0]) ** (1.0 / n) - 1.0


def build_fair_value_inputs(companyfacts: dict, *, discount_rate: float = 0.10, terminal_growth: float = 0.025,
                            growth_cap: float = 0.10, today: Optional[date] = None,
                            max_age_days: int = 550) -> dict[str, Any]:
    today = today or datetime.now(timezone.utc).date()
    warnings: list[str] = []
    out: dict[str, Any] = {"inputs": {}, "warnings": warnings, "source": "sec_edgar:companyfacts",
                           "assumptions": {"discount_rate": discount_rate, "terminal_growth": terminal_growth,
                                           "growth_cap": growth_cap, "years": 5}}
    ocf, capex, shares = _facts(companyfacts, OCF, "USD"), _facts(companyfacts, CAPEX, "USD"), _facts(companyfacts, SHARES, "shares")
    if not ocf or not shares:
        warnings.append("missing operating cash flow or share count in 10-K facts")
        return out
    capex_by_end = {r["end"]: r["val"] for r in capex}
    sh_by_end = {r["end"]: r["val"] for r in shares}
    series = []
    for r in ocf:
        sh = sh_by_end.get(r["end"])
        if sh and sh > 0:
            series.append((r["end"], (r["val"] - abs(capex_by_end.get(r["end"], 0.0))) / sh, r.get("filed")))
    if not series:
        warnings.append("no fiscal year with both cash flow and share count")
        return out
    latest_end, fcf_ps, filed = series[-1]
    out["as_of"] = latest_end
    out["filed"] = filed
    try:
        age = (today - date.fromisoformat(latest_end)).days
    except ValueError:
        age = 10_000
    if age > max_age_days:
        warnings.append(f"latest annual filing period ended {age} days ago; withheld as stale")
        return out
    if capex and latest_end not in capex_by_end:
        warnings.append("capex missing for latest year; FCF = operating cash flow")
    if not capex:
        warnings.append("no capex tag found; FCF = operating cash flow (overstates FCF if capex is material)")

    # ---- DCF ----
    if fcf_ps > 0:
        hist = [v for _, v, _ in series[-5:]]
        g = _cagr(hist)
        if g is None:
            g = 0.03
            warnings.append("FCF history too short/non-positive for CAGR; using 3% growth")
        g = max(-0.05, min(growth_cap, g))
        lt = _facts(companyfacts, DEBT_LT, "USD")
        st = _facts(companyfacts, DEBT_ST, "USD")
        debt = (lt[-1]["val"] if lt else 0.0) + (st[-1]["val"] if st else 0.0)
        cash = (_facts(companyfacts, CASH, "USD") or [{"val": 0}])[-1]["val"]
        if not lt and not st:
            warnings.append("no debt tags found; assumed zero debt (verify; not valid for banks/insurers)")
        sh_latest = sh_by_end[latest_end]
        out["inputs"]["dcf"] = {"fcf_per_share": fcf_ps, "growth_rate": g, "terminal_growth": terminal_growth,
                                "discount_rate": discount_rate, "years": 5,
                                "net_debt_per_share": (debt - cash) / sh_latest}
    else:
        warnings.append("latest free cash flow per share is not positive; DCF not applicable")

    # ---- Dividend discount ----
    dps = _facts(companyfacts, DPS, "USD/shares")
    if dps and dps[-1]["end"] == latest_end and dps[-1]["val"] > 0:
        vals = [r["val"] for r in dps[-5:]]
        dg = _cagr(vals)
        dg = 0.02 if dg is None else max(0.0, min(0.06, dg))
        if discount_rate > dg:
            out["inputs"]["ddm"] = {"dividend_per_share": dps[-1]["val"], "dividend_growth": dg,
                                    "cost_of_equity": discount_rate}
    if len(out["inputs"]) < 2:
        warnings.append("fewer than two filing-derived models; add an independent model (e.g. peer multiple) "
                        "via fair_value_inputs, otherwise the valuation stays 'insufficiently supported'")
    return out


async def valuation_inputs_for(db, settings, ticker: str, **kw) -> dict[str, Any]:
    """DCF/DDM inputs for a US ticker, reusing Global Alpha's SEC plumbing (CIK map, cached companyfacts,
    SEC User-Agent and provider-status recording) instead of a second client."""
    from app.alpha import context as alpha_ctx
    base = {"inputs": {}, "source": "sec_edgar:companyfacts"}
    res = await alpha_ctx.load_fundamentals(db, settings, ticker, None)
    if res is None:
        return {**base, "warnings": [f"{ticker.upper()} has no SEC XBRL fundamentals (non-US, unlisted, or SEC unavailable)"]}
    hit = alpha_ctx._FACTS.get(res["cik"])
    if not hit:
        return {**base, "warnings": ["SEC facts were not cached; retry"]}
    out = build_fair_value_inputs(hit[1], **kw)
    out["cik"], out["entity"] = res["cik"], res.get("entity")
    return out
