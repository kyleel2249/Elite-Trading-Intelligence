"""Fundamental evaluators from SEC XBRL 'companyfacts' (official, free, audited filings).

These are LIVE SCREENS, not backtests: point-in-time fundamentals for past dates are not reconstructed here,
so no historical performance is claimed. Thresholds are ETI parameterizations of publicly described ideas
(quality, growth at a reasonable price); they are NOT the investors' own numbers.
"""
from __future__ import annotations

from datetime import date, datetime
from typing import Any, Optional

from app.alpha.providers import _Base

SEC_DATA = "https://data.sec.gov"
TAGS: dict[str, tuple[str, list[str], str]] = {
    "revenue": ("flow", ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet"], "USD"),
    "net_income": ("flow", ["NetIncomeLoss"], "USD"),
    "cfo": ("flow", ["NetCashProvidedByUsedInOperatingActivities"], "USD"),
    "capex": ("flow", ["PaymentsToAcquirePropertyPlantAndEquipment"], "USD"),
    "equity": ("instant", ["StockholdersEquity"], "USD"),
    "debt": ("instant", ["LongTermDebt", "LongTermDebtNoncurrent"], "USD"),
    "eps": ("flow", ["EarningsPerShareDiluted", "EarningsPerShareBasic"], "USD/shares"),
}
DEFAULT_QUALITY = {"min_years": 5, "min_roe": 0.12, "roe_share": 0.8, "max_debt_to_equity": 1.0, "fcf_share": 0.8}
ETI_PARAM_NOTE = "ETI parameterization of publicly described ideas; not the investors' own thresholds."


def _d(s: str) -> date:
    return datetime.strptime(s[:10], "%Y-%m-%d").date()


def annual_series(facts: dict[str, Any], key: str) -> dict[str, float]:
    """{fiscal-year-end ISO date: value} from 10-K full-year facts. Tags are tried in priority order and a lower
    priority tag never overrides a higher one for the same year-end; within one tag the latest filing wins (restatements)."""
    kind, tags, unit = TAGS[key]
    gaap = (facts.get("facts") or {}).get("us-gaap") or {}
    chosen: dict[str, tuple[int, str, float]] = {}  # end -> (tag priority, filed, value)
    for prio, tag in enumerate(tags):
        for e in ((gaap.get(tag) or {}).get("units") or {}).get(unit, []):
            if e.get("fp") != "FY" or not str(e.get("form", "")).startswith("10-K") or "end" not in e or e.get("val") is None:
                continue
            if kind == "flow":
                if not e.get("start"):
                    continue
                if not 330 <= (_d(e["end"]) - _d(e["start"])).days <= 400:
                    continue
            end, filed = e["end"][:10], e.get("filed", "")
            cur = chosen.get(end)
            if cur is None or prio < cur[0] or (prio == cur[0] and filed >= cur[1]):
                chosen[end] = (prio, filed, float(e["val"]))
    return {k: v[2] for k, v in sorted(chosen.items())}


def _years(series: dict[str, float], n: int) -> list[tuple[str, float]]:
    return list(series.items())[-n:]


def quality_screen(facts: dict[str, Any], params: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    p = {**DEFAULT_QUALITY, **(params or {})}
    ni, eq = annual_series(facts, "net_income"), annual_series(facts, "equity")
    common = sorted(set(ni) & set(eq))[-8:]
    if len(common) < p["min_years"]:
        return {"verdict": "INSUFFICIENT_DATA", "reasons": [f"{len(common)} fiscal years of net income + equity; need {p['min_years']}"], "note": ETI_PARAM_NOTE}
    roe = {y: ni[y] / eq[y] for y in common if eq[y] > 0}
    crit: list[dict[str, Any]] = []
    good_roe = sum(1 for r in roe.values() if r >= p["min_roe"])
    crit.append({"id": "roe_consistency", "pass": bool(roe) and good_roe / len(common) >= p["roe_share"],
                 "detail": f"ROE >= {p['min_roe']:.0%} in {good_roe}/{len(common)} years"})
    crit.append({"id": "profitable_every_year", "pass": all(ni[y] > 0 for y in common), "detail": f"net income positive in {sum(1 for y in common if ni[y] > 0)}/{len(common)} years"})
    debt = annual_series(facts, "debt")
    last = common[-1]
    if last in debt and eq[last] > 0:
        de = debt[last] / eq[last]
        crit.append({"id": "leverage", "pass": de <= p["max_debt_to_equity"], "detail": f"long-term debt/equity {de:.2f} (max {p['max_debt_to_equity']})"})
    else:
        crit.append({"id": "leverage", "pass": None, "detail": "long-term debt or equity not reported for latest year"})
    cfo, capex = annual_series(facts, "cfo"), annual_series(facts, "capex")
    fy = [y for y in common if y in cfo]
    if len(fy) >= p["min_years"]:
        pos = sum(1 for y in fy if cfo[y] - capex.get(y, 0.0) > 0)
        crit.append({"id": "free_cash_flow", "pass": pos / len(fy) >= p["fcf_share"], "detail": f"operating cash flow minus capex positive in {pos}/{len(fy)} years"})
    else:
        crit.append({"id": "free_cash_flow", "pass": None, "detail": "insufficient cash-flow history"})
    known = [c for c in crit if c["pass"] is not None]
    verdict = "PASSES_SCREEN" if known and all(c["pass"] for c in known) and len(known) >= 3 else ("FAILS_SCREEN" if any(c["pass"] is False for c in crit) else "INSUFFICIENT_DATA")
    return {"verdict": verdict, "criteria": crit, "years": common, "latest_fiscal_year_end": last,
            "roe_by_year": {y: round(v, 4) for y, v in roe.items()}, "note": ETI_PARAM_NOTE + " A screen result is not a valuation or a recommendation."}


def garp_screen(facts: dict[str, Any], price: Optional[float], today: Optional[date] = None) -> dict[str, Any]:
    eps = annual_series(facts, "eps")
    pts = _years(eps, 5)
    if price is None or price <= 0:
        return {"verdict": "NOT_EVALUABLE", "reasons": ["no current price"]}
    if len(pts) < 4:
        return {"verdict": "INSUFFICIENT_DATA", "reasons": [f"{len(pts)} years of EPS; need 4"]}
    (y0, e0), (y1, e1) = pts[0], pts[-1]
    if e0 <= 0 or e1 <= 0:
        return {"verdict": "NOT_APPLICABLE", "reasons": ["EPS not positive at both ends of the window; PEG undefined"], "eps_window": [y0, y1]}
    years = (_d(y1) - _d(y0)).days / 365.25
    cagr = (e1 / e0) ** (1 / years) - 1
    pe = price / e1
    stale = ((today or date.today()) - _d(y1)).days
    base = {"eps_window": [y0, y1], "eps_cagr": round(cagr, 4), "pe_trailing": round(pe, 2), "latest_fiscal_year_end": y1,
            "staleness_days": stale, "stale": stale > 550, "note": "Trailing 10-K EPS; Lynch's PEG<1 is a rule of thumb, not a valuation."}
    if cagr <= 0:
        return {**base, "verdict": "NOT_APPLICABLE", "reasons": ["EPS growth not positive; PEG undefined"]}
    peg = pe / (cagr * 100)
    return {**base, "peg": round(peg, 2), "verdict": "FAVORABLE" if peg < 1 else "FAIR" if peg <= 2 else "UNFAVORABLE"}


def valuation_component(garp: Optional[dict[str, Any]]) -> Optional[float]:
    if not garp or garp.get("verdict") not in ("FAVORABLE", "FAIR", "UNFAVORABLE") or garp.get("stale"):
        return None
    return {"FAVORABLE": 80.0, "FAIR": 50.0, "UNFAVORABLE": 20.0}[garp["verdict"]]


class SecFundamentals(_Base):
    """data.sec.gov companyfacts (requires a descriptive User-Agent)."""
    provider = "sec_facts"

    def __init__(self, user_agent: str, **kw: Any):
        super().__init__(**kw)
        self.ua = user_agent

    async def company_facts(self, cik: str | int) -> dict[str, Any]:
        return await self._get(f"{SEC_DATA}/api/xbrl/companyfacts/CIK{int(cik):010d}.json", headers={"User-Agent": self.ua})
