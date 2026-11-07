"""Deepen O'Neil, Seykota, Burry — primary/secondary source notes."""
from app.knowledge.schema import TraderKnowledgeProfile, SourceNote

DEEP_PROFILES: dict[str, TraderKnowledgeProfile] = {}


def _put(p: TraderKnowledgeProfile) -> None:
    DEEP_PROFILES[p.id] = p


_put(
    TraderKnowledgeProfile(
        id="william_oneil",
        full_name="William O'Neil",
        biography="Founder of Investor's Business Daily; creator of CAN SLIM growth-stock methodology.",
        trading_history="Publisher, educator, and investor; CAN SLIM documented in How to Make Money in Stocks.",
        markets_traded=["US equities"],
        preferred_instruments=["Growth stocks", "liquid leaders"],
        philosophy="Combine fundamental growth (earnings) with technical bases and market direction (M in CAN SLIM).",
        documented_patterns=["CAN SLIM", "Cup-with-handle / bases", "Relative strength", "Market follow-through days (teaching)"],
        entry_criteria=["Sound base", "Earnings/sales growth characteristics", "Breakout with volume emphasis (teaching)"],
        exit_criteria=["7–8% stop rule widely taught", "Sell into strength / distribution signals (teaching variants)"],
        stop_loss_methodology=["Predetermined percentage stop from buy point (classic teaching)"],
        position_sizing=["Pyramid selectively; risk control emphasized in books"],
        risk_reward=["Cut losses short; let winners run under trend"],
        technical_indicators=["Price bases", "Volume", "RS ratings (IBD methodology)"],
        fundamental_methodology=["Earnings growth", "Institutional sponsorship", "New products/highs narrative"],
        preferred_conditions=["Confirmed uptrending general market"],
        avoid_conditions=["Correction markets without follow-through", "Wide-and-loose bases"],
        decision_psychology=["Discipline on stops", "Avoid arguing with the market"],
        historical_returns=[SourceNote("Personal continuous audited series not a public mutual-fund style track", "reported")],
        historical_drawdowns=[SourceNote("Method acknowledges market correction losses if rules broken", "reported")],
        win_rates=[SourceNote("Not a verified universal statistic", "speculation")],
        net_worth=[SourceNote("Historical private", "estimate")],
        famous_successful_trades=["Case studies in How to Make Money in Stocks"],
        famous_unsuccessful_trades=["Teaching examples of failed bases"],
        predictions_outcomes=["Market timing via distribution/follow-through framework — evaluate episodes separately"],
        strengths=["Rules-based growth framework", "Market direction filter"],
        weaknesses=["Bull-market dependency for best results"],
        eti_lessons=[
            "Elena Varga: base + volume breakout",
            "Helena Frost: enforce stop %",
            "Module oneil_canslim — do not mix with deep-value without isolation",
        ],
        strategy_module_ids=["oneil_canslim"],
        tags=["growth", "CAN SLIM", "foundational", "deep"],
        expandable_notes="Primary: How to Make Money in Stocks (O'Neil). Secondary: IBD educational materials.",
    )
)

_put(
    TraderKnowledgeProfile(
        id="ed_seykota",
        full_name="Ed Seykota",
        biography="Pioneer of computerized trend following; featured in Market Wizards; educator on system psychology.",
        trading_history="Managed customer and personal capital with systematic trend systems; public discussions emphasize process over prediction.",
        markets_traded=["futures"],
        preferred_instruments=["Liquid futures markets"],
        philosophy="Trend follow; risk a defined fraction of equity; system adherence; psychology determines long-run results.",
        documented_patterns=["Mechanical trend systems", "Equity curve awareness", "Risk % per trade"],
        entry_criteria=["System-defined trend entries (variants not all public as single code)"],
        exit_criteria=["System exits / trailing logic (teaching)"],
        stop_loss_methodology=["Risk small % of equity; volatility-aware sizing principles (public teaching)"],
        position_sizing=["Fixed fractional risk concepts popularized in interviews/teaching"],
        risk_reward=["Convex trend payoff profile"],
        technical_indicators=["Trend measures; system-specific"],
        fundamental_methodology=["Primarily price-based systematic"],
        preferred_conditions=["Trending regimes"],
        avoid_conditions=["Discretionary override of system without process"],
        decision_psychology=["Whims are expensive", "Stick to system"],
        historical_returns=[SourceNote("Strong long-term reputation in trader literature; not a public daily NAV series", "reported")],
        historical_drawdowns=[SourceNote("Trend systems experience deep DD — inherent", "reported")],
        win_rates=[SourceNote("Typically modest win rate with large winners — general trend property", "estimate")],
        net_worth=[SourceNote("Private", "estimate")],
        famous_successful_trades=["Career system results rather than single celebrity stocks"],
        famous_unsuccessful_trades=["Chop periods inherent to method"],
        predictions_outcomes=["Anti-prediction philosophy"],
        strengths=["Process", "Risk framing", "Psychology"],
        weaknesses=["Long flat/DD stretches"],
        eti_lessons=[
            "Kenji Mori: mechanical rules",
            "Helena Frost: % risk cap",
            "Claire Bennett: journal every discretionary override",
        ],
        strategy_module_ids=["seykota_mechanical"],
        tags=["trend", "mechanical", "foundational", "deep"],
        expandable_notes="Primary: Market Wizards interview; Seykota public FAQ/teaching materials. No claim to private system code.",
    )
)

_put(
    TraderKnowledgeProfile(
        id="michael_burry",
        full_name="Michael Burry",
        biography="Founder of Scion Capital; known for subprime CDS positioning depicted in The Big Short; value/contrarian investor.",
        trading_history="Scion Capital record discussed in public accounts; later Scion Asset Management 13F filings are regulatory snapshots.",
        markets_traded=["equities", "credit derivatives (historical campaign)"],
        preferred_instruments=["Equities", "credit instruments when thesis requires"],
        philosophy="Deep independent research; willingness to be early and alone; valuation discrepancies.",
        documented_patterns=["Forensic/credit structure analysis (subprime era)", "Concentrated value bets", "Public letter communication"],
        entry_criteria=["Large discrepancy between price and estimated value"],
        exit_criteria=["Thesis completion or invalidation; time can be long"],
        stop_loss_methodology=["Not classic retail tick stops; thesis and risk capital framing"],
        position_sizing=["Can be concentrated (historical) — requires firm risk limits in ETI"],
        risk_reward=["Asymmetric mispricing focus"],
        technical_indicators=["Secondary"],
        fundamental_methodology=["Deep fundamental / structure analysis"],
        preferred_conditions=["Clear mispricing"],
        avoid_conditions=["Consensus comfort without research"],
        decision_psychology=["Independence", "Patience", "Tolerance for being early"],
        historical_returns=[SourceNote("Scion-era performance widely reported; treat secondary sources carefully", "reported")],
        historical_drawdowns=[SourceNote("Being early implies mark-to-market pain", "reported")],
        win_rates=[SourceNote("Not a short-term win-rate framework", "speculation")],
        net_worth=[SourceNote("Media estimates", "estimate")],
        famous_successful_trades=["Subprime CDS campaign (widely documented in books/press)"],
        famous_unsuccessful_trades=["Public positions can underperform for long stretches (reported)"],
        predictions_outcomes=["Macro/bubble commentary — evaluate with timestamps; mixed by episode"],
        strengths=["Independent research depth"],
        weaknesses=["Timing risk; concentration"],
        eti_lessons=[
            "13F ≠ live portfolio",
            "Helena Frost: concentration limits",
            "Marcus Okonkwo: document discrepancy thesis",
        ],
        strategy_module_ids=["burry_contrarian"],
        tags=["contrarian", "value", "foundational", "deep"],
        expandable_notes="Primary-leaning: contemporaneous reporting; The Big Short (Lewis) as secondary narrative; 13F filings as HISTORICAL SNAPSHOT only.",
    )
)
