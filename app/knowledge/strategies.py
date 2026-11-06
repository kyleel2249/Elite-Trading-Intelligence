"""Testable strategy modules extracted from documented trader philosophies."""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Optional


@dataclass
class StrategyModule:
    id: str
    name: str
    inspired_by: list[str]
    summary: str
    principles: list[str]
    testable_rules: list[str]
    incompatible_with: list[str] = field(default_factory=list)
    markets: list[str] = field(default_factory=list)
    risk_notes: list[str] = field(default_factory=list)
    attribution_keywords: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


STRATEGY_MODULES: dict[str, StrategyModule] = {
    "soros_reflexivity": StrategyModule(
        id="soros_reflexivity",
        name="Reflexivity & Macro Imbalance",
        inspired_by=["George Soros"],
        summary="Price and fundamentals can reinforce each other; exploit large macro imbalances with asymmetric risk.",
        principles=[
            "Markets are imperfect information systems",
            "Self-reinforcing boom-bust sequences",
            "Concentrate when conviction and asymmetry align",
        ],
        testable_rules=[
            "Flag regimes where price trend and fundamental gap widen together",
            "Require explicit invalidation level before size-up",
            "Do not average into failed reflexivity trades without new evidence",
        ],
        incompatible_with=["pure_mean_reversion_only"],
        markets=["FX", "rates", "equities", "commodities"],
        risk_notes=["Large concentrated bets require hard risk limits (Helena Frost veto applies)"],
        attribution_keywords=["reflexivity", "macro imbalance", "boom-bust"],
    ),
    "druck_liquidity_macro": StrategyModule(
        id="druck_liquidity_macro",
        name="Liquidity, Macro Trends & Asymmetry",
        inspired_by=["Stanley Druckenmiller"],
        summary="Follow liquidity and macro regime; seek asymmetric payoff with flexible timeframe.",
        principles=["Liquidity drives asset prices", "Preserve capital to stay in the game", "Go big only when odds skew"],
        testable_rules=[
            "Classify liquidity regime (tightening/easing proxy)",
            "Prefer trend-aligned positions when liquidity supportive",
            "Cut quickly when thesis breaks",
        ],
        markets=["FX", "equities", "bonds", "commodities"],
        risk_notes=["Avoid fighting central-bank liquidity shifts without hedge"],
        attribution_keywords=["liquidity", "macro trend", "asymmetric"],
    ),
    "ptj_structure_preservation": StrategyModule(
        id="ptj_structure_preservation",
        name="Technical Structure & Capital Preservation",
        inspired_by=["Paul Tudor Jones"],
        summary="Respect technical structure; defense first; 5:1 style asymmetry aspirational where documented.",
        principles=["Capital preservation primary", "Technical levels define risk", "Home-run mindset selectively"],
        testable_rules=[
            "Define stop beyond structural invalidation",
            "Skip trades without favorable reward:risk structure",
            "Reduce size after losses (equity curve awareness)",
        ],
        markets=["futures", "FX", "equities"],
        risk_notes=["Reported R:R preferences are illustrative — not guaranteed"],
        attribution_keywords=["structure", "preservation", "technical level"],
    ),
    "turtle_trend": StrategyModule(
        id="turtle_trend",
        name="Systematic Trend Following (Turtle lineage)",
        inspired_by=["Richard Dennis", "William Eckhardt"],
        summary="Rules-based breakout trend following with defined risk units.",
        principles=["Trade breakouts", "Systematic size", "Let winners run, cut losers"],
        testable_rules=[
            "Enter on N-day breakout (parameterized)",
            "Risk fixed fraction of equity per unit",
            "Exit on opposite breakout or trailing stop",
        ],
        incompatible_with=["tight_mean_reversion_scalp"],
        markets=["futures", "FX"],
        risk_notes=["Long losing streaks are normal; size for survival"],
        attribution_keywords=["breakout", "trend following", "turtle"],
    ),
    "seykota_mechanical": StrategyModule(
        id="seykota_mechanical",
        name="Mechanical Trading & Risk Discipline",
        inspired_by=["Ed Seykota"],
        summary="Systematize edge; risk small; psychology and process over prediction.",
        principles=["Trend following", "Risk a small % of equity", "Stick to system"],
        testable_rules=[
            "Pre-commit entry/exit rules",
            "Position size from volatility and equity risk %",
            "No discretionary override without logged reason",
        ],
        markets=["futures"],
        attribution_keywords=["mechanical", "system", "risk %"],
    ),
    "minervini_vcp": StrategyModule(
        id="minervini_vcp",
        name="Trend Template & VCP",
        inspired_by=["Mark Minervini"],
        summary="Stage analysis, volatility contraction patterns, momentum growth entries.",
        principles=["Trade strongest stocks in strong markets", "Volatility contraction before expansion", "Cut losses short"],
        testable_rules=[
            "Require trend template filters (e.g., above rising MAs)",
            "Detect contracting range / volume dry-up",
            "Buy breakout with stop under pivot",
        ],
        markets=["US equities"],
        attribution_keywords=["VCP", "trend template", "pivot"],
    ),
    "darvas_box": StrategyModule(
        id="darvas_box",
        name="Darvas Box Breakout",
        inspired_by=["Nicolas Darvas"],
        summary="Price boxes; buy confirmed upside breakouts; trail with box structure.",
        principles=["Boxes define accumulation", "Breakout + volume confirmation", "Trail stops"],
        testable_rules=[
            "Identify N-bar high/low box",
            "Enter on close above box high",
            "Stop below box low or prior box",
        ],
        markets=["equities"],
        attribution_keywords=["box", "breakout confirmation"],
    ),
    "wyckoff_supply_demand": StrategyModule(
        id="wyckoff_supply_demand",
        name="Wyckoff Accumulation / Distribution",
        inspired_by=["Richard Wyckoff"],
        summary="Map supply/demand phases; spring/upthrust events; effort vs result.",
        principles=["Composite operator model", "Accumulation before markup", "Distribution before markdown"],
        testable_rules=[
            "Label range phases where data allows",
            "Watch for spring/test volume patterns",
            "Confirm with markup/markdown trend",
        ],
        markets=["equities", "futures"],
        attribution_keywords=["accumulation", "distribution", "spring", "supply-demand"],
    ),
    "oneil_canslim": StrategyModule(
        id="oneil_canslim",
        name="CAN SLIM Growth Momentum",
        inspired_by=["William O'Neil"],
        summary="Growth + institutional sponsorship + technical base breakouts.",
        principles=["Earnings growth", "Relative strength", "Market direction filter"],
        testable_rules=[
            "Filter by growth/RS proxies when available",
            "Require constructive base",
            "Follow general market health rules",
        ],
        markets=["US equities"],
        attribution_keywords=["CAN SLIM", "relative strength", "base breakout"],
    ),
    "simons_quant": StrategyModule(
        id="simons_quant",
        name="Statistical Patterns & Quant Research",
        inspired_by=["Jim Simons"],
        summary="Data-driven short-horizon edges; scientific method; capacity-aware.",
        principles=["Research over story", "Diversified small edges", "Execution quality"],
        testable_rules=[
            "Require out-of-sample validation before size",
            "Track capacity and decay",
            "No single-bet narrative dominance",
        ],
        markets=["multi-asset"],
        risk_notes=["Private RenTech methods not public — only general quant principles used"],
        attribution_keywords=["statistical", "quant", "out-of-sample"],
    ),
    "buffett_munger_value": StrategyModule(
        id="buffett_munger_value",
        name="Business Quality & Intrinsic Value",
        inspired_by=["Warren Buffett", "Charlie Munger"],
        summary="Own wonderful businesses at fair prices; long horizon; margin of safety.",
        principles=["Circle of competence", "Owner earnings", "Psychological discipline"],
        testable_rules=[
            "Require quality/valuation framework inputs",
            "Avoid leverage-driven short-term trading mindset for this module",
            "Document margin-of-safety assumption",
        ],
        incompatible_with=["high_frequency_scalping"],
        markets=["equities"],
        attribution_keywords=["intrinsic value", "margin of safety", "quality business"],
    ),
    "lynch_fundamental": StrategyModule(
        id="lynch_fundamental",
        name="Bottom-Up Growth Research",
        inspired_by=["Peter Lynch"],
        summary="Know what you own; categorize stocks; growth at reasonable price mindset.",
        principles=["Fundamental homework", "Story + numbers", "Long holding when thesis intact"],
        testable_rules=[
            "Require company/sector thesis tag",
            "Re-evaluate on earnings regime change",
        ],
        markets=["equities"],
        attribution_keywords=["GARP", "bottom-up", "know what you own"],
    ),
    "burry_contrarian": StrategyModule(
        id="burry_contrarian",
        name="Contrarian Valuation Discrepancy",
        inspired_by=["Michael Burry"],
        summary="Deep fundamental discrepancy hunting; willingness to be early and alone.",
        principles=["Independent research", "Asymmetric mispricing", "Patience"],
        testable_rules=[
            "Document discrepancy thesis",
            "Define catalyst or time-stop",
            "Size for long adversity periods",
        ],
        markets=["equities", "credit"],
        attribution_keywords=["contrarian", "mispricing", "deep value"],
    ),
}


def list_strategy_modules() -> list[dict[str, Any]]:
    return [m.to_dict() for m in STRATEGY_MODULES.values()]


def get_strategy_module(module_id: str) -> Optional[dict[str, Any]]:
    m = STRATEGY_MODULES.get(module_id)
    return m.to_dict() if m else None
