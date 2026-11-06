"""Continuously expandable additional traders (standing order)."""
from app.knowledge.schema import TraderKnowledgeProfile, SourceNote

PROFILES: dict[str, TraderKnowledgeProfile] = {}


def _add(pid, name, bio, markets, phil, patterns, modules, tags):
    PROFILES[pid] = TraderKnowledgeProfile(
        id=pid,
        full_name=name,
        biography=bio,
        trading_history="Expand with primary sources over time.",
        markets_traded=markets,
        preferred_instruments=list(markets),
        philosophy=phil,
        documented_patterns=patterns,
        entry_criteria=["Per documented public methodology"],
        exit_criteria=["Thesis or system exit"],
        stop_loss_methodology=["Often unpublished in precise form"],
        position_sizing=["Firm/strategy specific"],
        risk_reward=["Not assumed without source"],
        technical_indicators=["See patterns"],
        fundamental_methodology=["See philosophy"],
        preferred_conditions=["Style-favorable regimes"],
        avoid_conditions=["Outside edge"],
        decision_psychology=["Process discipline"],
        historical_returns=[SourceNote("Source-dependent", "reported")],
        historical_drawdowns=[SourceNote("Source-dependent", "reported")],
        win_rates=[SourceNote("Usually not fully public", "speculation")],
        net_worth=[SourceNote("Media estimate if any", "estimate")],
        famous_successful_trades=["Public case studies where available"],
        famous_unsuccessful_trades=["Public case studies where available"],
        predictions_outcomes=["Timestamped evaluation only"],
        strengths=patterns[:2],
        weaknesses=["Regime sensitivity"],
        eti_lessons=[f"Modules: {', '.join(modules)}", "Helena Frost risk always applies"],
        strategy_module_ids=modules,
        tags=tags + ["expandable"],
    )


_add("bill_ackman", "Bill Ackman", "Pershing Square; concentrated activist/long-form equity campaigns (public).",
     ["equities"], "Concentrated fundamental activism and special situations.",
     ["Activist campaigns", "Concentration"], ["buffett_munger_value", "lynch_fundamental"], ["activist"])
_add("seth_klarman", "Seth Klarman", "Baupost; margin of safety; absolute return credit/equity value.",
     ["equities", "credit"], "Margin of safety; opportunistic credit and equity.",
     ["Deep value", "Credit opportunities"], ["burry_contrarian", "buffett_munger_value"], ["value", "credit"])
_add("van_tharp", "Van K. Tharp", "Trading coach; position sizing and psychology frameworks (educational).",
     ["multi-asset"], "R-multiples, expectancy, psychological discipline.",
     ["Position sizing education", "Expectancy"], ["seykota_mechanical"], ["psychology", "education"])
_add("alexander_elder", "Alexander Elder", "Psychiatrist-trader; psychology + triple screen educational framework.",
     ["equities", "futures"], "Psychology, risk, multi-timeframe screens.",
     ["Triple screen (educational)"], ["ptj_structure_preservation"], ["psychology", "education"])
_add("jack_schwager", "Jack Schwager", "Author of Market Wizards; interviewer/documentarian of trader methods.",
     ["multi-asset"], "Document rather than promote a single proprietary system.",
     ["Interview synthesis"], ["seykota_mechanical"], ["documentation"])
_add("nassim_taleb", "Nassim Nicholas Taleb", "Author/trader; antifragility, optionality, barbell risk (public writings).",
     ["options", "futures"], "Convex payoffs; limit ruin; skepticism of fragile forecasts.",
     ["Barbell", "Convexity"], ["ptj_structure_preservation", "simons_quant"], ["risk", "optionality"])
_add("steven_cohen", "Steven Cohen", "Point72 / SAC history; discretionary multi-strategy equity trading culture (public).",
     ["equities"], "Trading-oriented multi-strategy process; risk infrastructure (firm-level, reported).",
     ["Trading culture", "Risk systems (firm)"], ["ptj_structure_preservation"], ["multi-strategy"])
