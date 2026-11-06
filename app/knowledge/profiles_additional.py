"""Additional documented traders/investors — expandable registry."""
from app.knowledge.schema import TraderKnowledgeProfile, SourceNote

PROFILES: dict[str, TraderKnowledgeProfile] = {}


def _add(p: TraderKnowledgeProfile) -> None:
    PROFILES[p.id] = p


def _simple(pid, name, bio, markets, phil, patterns, modules, tags):
    _add(
        TraderKnowledgeProfile(
            id=pid,
            full_name=name,
            biography=bio,
            trading_history="Public career summary; deepen with primary sources.",
            markets_traded=markets,
            preferred_instruments=markets[:],
            philosophy=phil,
            documented_patterns=patterns,
            entry_criteria=["Aligned with documented philosophy"],
            exit_criteria=["Thesis or system exit"],
            stop_loss_methodology=["Often unpublished in precise form"],
            position_sizing=["Varies by firm/strategy"],
            risk_reward=["Not assumed without source"],
            technical_indicators=["See patterns"],
            fundamental_methodology=["See philosophy"],
            preferred_conditions=["Style-favorable regimes"],
            avoid_conditions=["Outside competence / no edge"],
            decision_psychology=["Process discipline"],
            historical_returns=[SourceNote("Source-dependent", "reported")],
            historical_drawdowns=[SourceNote("Source-dependent", "reported")],
            win_rates=[SourceNote("Usually not fully public", "speculation")],
            net_worth=[SourceNote("Media estimate if any", "estimate")],
            famous_successful_trades=["See public case studies"],
            famous_unsuccessful_trades=["See public case studies"],
            predictions_outcomes=["Evaluate dated claims individually"],
            strengths=patterns[:2],
            weaknesses=["Regime sensitivity"],
            eti_lessons=[f"Modules: {', '.join(modules)}", "Attribution only when evidence matches"],
            strategy_module_ids=modules,
            tags=tags + ["additional"],
            expandable_notes="Continuously expandable.",
        )
    )


_simple("ed_thorp", "Ed Thorp", "Mathematician; beat the dealer; early quant hedge fund pioneer (Princeton/Newport).",
        ["equities", "warrants", "derivatives"], "Statistical edge, convert arbitrage, disciplined bankroll.",
        ["Card counting lineage to quant finance", "Warrant hedges"], ["simons_quant"], ["quant", "arbitrage"])
_simple("michael_steinhardt", "Michael Steinhardt", "Early hedge fund pioneer; block trading and macro/equity hybrids (historical).",
        ["equities", "macro"], "Aggressive variant perception; opportunistic.",
        ["Block trading era techniques (historical)"], ["druck_liquidity_macro"], ["macro", "equities"])
_simple("julian_robertson", "Julian Robertson", "Tiger Management; long/short equity seed for Tiger Cubs.",
        ["equities"], "Long best ideas, short weakest; fundamental stock picking.",
        ["Long/short fundamental"], ["lynch_fundamental", "buffett_munger_value"], ["long-short"])
_simple("david_shaw", "David Shaw", "D. E. Shaw founder; computational finance.",
        ["multi-asset"], "Technology-driven quantitative research.",
        ["Computational signals (general)"], ["simons_quant"], ["quant"])
_simple("marty_schwartz", "Marty Schwartz", "Championship trader; Market Wizards; technical/momentum lean.",
        ["futures", "equities"], "Technical discipline; respect risk; adapt methods.",
        ["Technical momentum", "Risk control"], ["ptj_structure_preservation"], ["technical"])
_simple("tom_basso", "Tom Basso", "Systematic trader; Mr. Serenity; process and psychology emphasis.",
        ["futures"], "Mechanical process; emotional stability; diversification of systems.",
        ["Multi-system", "Psychology"], ["seykota_mechanical", "turtle_trend"], ["systematic"])
_simple("howard_marks", "Howard Marks", "Oaktree; credit cycles and second-level thinking.",
        ["credit", "equities"], "Cycle awareness; risk is uncertainty of outcome; second-level thinking.",
        ["Credit cycle memos", "Margin of safety in credit"], ["burry_contrarian", "buffett_munger_value"], ["credit", "cycles"])
_simple("chris_hohn", "Chris Hohn", "TCI Fund Management; concentrated activist/quality investing (reported).",
        ["equities"], "Concentrated high-quality ideas; engagement where relevant.",
        ["Concentration", "Quality"], ["buffett_munger_value"], ["activist", "quality"])
_simple("david_einhorn", "David Einhorn", "Greenlight Capital; long/short value; forensic accounting emphasis (public shorts).",
        ["equities"], "Fundamental value with short-side research depth.",
        ["Forensic fundamentals", "Value long/short"], ["burry_contrarian", "lynch_fundamental"], ["long-short", "value"])
_simple("john_w_henry", "John W. Henry", "Systematic trend following pioneer; later sports ownership.",
        ["futures"], "Diversified systematic trend capture.",
        ["Trend systems"], ["turtle_trend", "seykota_mechanical"], ["trend", "systematic"])
_simple("robert_mercer", "Robert Mercer", "Renaissance Technologies executive/researcher (public role); quant research culture.",
        ["multi-asset"], "Statistical research at scale (proprietary details not public).",
        ["Quant research culture"], ["simons_quant"], ["quant"])
