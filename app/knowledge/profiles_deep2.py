"""Additional deepened profiles from public letters/books/secondary literature.
Claims labeled verified | reported | estimate | speculation.
"""
from app.knowledge.schema import TraderKnowledgeProfile, SourceNote

DEEP_PROFILES: dict[str, TraderKnowledgeProfile] = {}


def _put(p: TraderKnowledgeProfile) -> None:
    DEEP_PROFILES[p.id] = p


_put(
    TraderKnowledgeProfile(
        id="ray_dalio",
        full_name="Ray Dalio",
        aliases=["Bridgewater", "Principles"],
        biography="Founder of Bridgewater Associates; author of Principles; known for macro/all-weather style thinking and firm culture of radical transparency (publicly described).",
        trading_history="Built Bridgewater into a major institutional manager; Pure Alpha / All Weather concepts discussed in public materials.",
        markets_traded=["multi-asset", "rates", "FX", "equities", "commodities"],
        preferred_instruments=["futures", "swaps", "global bonds", "equities"],
        philosophy="Understand the economic machine; diversify risk premia; balance portfolios across environments; systematize principles.",
        documented_patterns=["Debt cycle framing", "Risk-balanced allocation concepts", "Principles-based decision culture"],
        entry_criteria=["Environment classification (growth/inflation regimes) as publicly taught", "Strategic tilts when odds skew"],
        exit_criteria=["Regime change", "Risk budget exhaustion (firm-level concepts)"],
        stop_loss_methodology=["Institutional risk overlays — not a retail tick stop published as personal rule"],
        position_sizing=["Risk-parity-like balancing in All Weather narrative (public)", "Not a single personal % formula"],
        risk_reward=["Balance of uncorrelated returns over single-bet heroics (public philosophy)"],
        technical_indicators=["Secondary to macro/regime frameworks in public teaching"],
        fundamental_methodology=["Credit cycles", "Productivity", "Monetary/fiscal policy interactions"],
        preferred_conditions=["Clear regime identification"],
        avoid_conditions=["Concentrated unhedged bets outside process (inferred from stated risk culture)"],
        decision_psychology=["Believability-weighted decisions (firm culture)", "Pain + reflection = progress"],
        historical_returns=[
            SourceNote("Bridgewater fund performance discussed in industry media; series vary by share class",
                       "reported", "Industry databases/press — not a single verified personal track")
        ],
        historical_drawdowns=[SourceNote("Institutional strategies experience drawdowns; 2020/2022 episodes discussed publicly", "reported")],
        win_rates=[SourceNote("Not applicable as retail win-rate metric", "speculation")],
        net_worth=[SourceNote("Billionaire wealth media estimates", "estimate", "Forbes etc. — verify current")],
        famous_successful_trades=["Long-term firm-level success narratives rather than single celebrity trades"],
        famous_unsuccessful_trades=["Publicly discussed challenging periods for macro funds including Bridgewater (reported)"],
        predictions_outcomes=["Economic machine essays — evaluate dated claims separately"],
        strengths=["Systematization", "Regime thinking", "Diversification philosophy"],
        weaknesses=["Complexity", "Model/regime error risk"],
        eti_lessons=[
            "Sofia Rahman: tag growth/inflation regime proxies",
            "Helena Frost: portfolio risk budgets over single-name heroics",
            "Do not treat All Weather marketing as a simple retail indicator set",
            "Adrian Cole synthesizes multi-desk regime views",
        ],
        strategy_module_ids=["druck_liquidity_macro"],
        tags=["macro", "institutional", "foundational", "deep"],
        expandable_notes="Primary-leaning: Principles (Dalio); Bridgewater public essays on economic machine. Secondary: press on fund performance.",
    )
)

_put(
    TraderKnowledgeProfile(
        id="peter_lynch",
        full_name="Peter Lynch",
        biography="Managed Fidelity Magellan (1977–1990); popularized approachable fundamental equity research.",
        trading_history="Magellan AUM and performance during tenure are part of public mutual-fund history; specific figures should be taken from contemporaneous fund reports.",
        markets_traded=["US and global equities"],
        preferred_instruments=["Common stocks"],
        philosophy="Invest in what you understand; do homework; categorize stocks (slow growers, stalwarts, fast growers, cyclicals, turnarounds, asset plays).",
        documented_patterns=["Bottom-up research", "Growth at reasonable price thinking", "Story + numbers"],
        entry_criteria=["Understandable business", "Attractive growth/value balance relative to category"],
        exit_criteria=["Thesis break", "Overvaluation relative to growth (teaching)"],
        stop_loss_methodology=["Not a tight day-trading stop framework; fundamental thesis-driven"],
        position_sizing=["Diversified mutual-fund context — not a concentrated prop book formula"],
        risk_reward=["Long-term equity compounding vs trading R-multiples"],
        technical_indicators=["Secondary; awareness of price but fundamentals primary in teaching"],
        fundamental_methodology=["Earnings growth", "PEG-style comparisons (popularized)", "Competitive position"],
        preferred_conditions=["Research edge on individual companies"],
        avoid_conditions=["Hot tips without understanding", "Outside competence"],
        decision_psychology=["Curiosity", "Patience", "Ignore noise"],
        historical_returns=[
            SourceNote("Magellan outperformance during Lynch tenure widely documented in fund history",
                       "reported", "Fidelity historical materials / financial press")
        ],
        historical_drawdowns=[SourceNote("Equity fund drawdowns occurred with markets", "reported")],
        win_rates=[SourceNote("Not a short-term win-rate manager", "speculation")],
        net_worth=[SourceNote("Wealth media estimates", "estimate")],
        famous_successful_trades=["Numerous Magellan holdings cited in One Up on Wall Street examples"],
        famous_unsuccessful_trades=["Mistakes discussed in his books (teaching examples)"],
        predictions_outcomes=["Emphasized research over macro prediction"],
        strengths=["Research process", "Communication of method"],
        weaknesses=["Capacity and style differ from short-term trading systems"],
        eti_lessons=[
            "Marcus Okonkwo FA desk: categorize thesis",
            "Incompatible with pure scalping without isolation",
            "Claire Bennett: journal fundamental thesis tags",
        ],
        strategy_module_ids=["lynch_fundamental"],
        tags=["fundamental", "growth", "foundational", "deep"],
        expandable_notes="Primary: One Up on Wall Street; Beating the Street. Secondary: Magellan historical coverage.",
    )
)

_put(
    TraderKnowledgeProfile(
        id="charlie_munger",
        full_name="Charlie Munger",
        biography="Vice Chairman of Berkshire Hathaway; investor and proponent of multidisciplinary mental models.",
        trading_history="Partnership and Berkshire era capital allocation; public speeches and writings.",
        markets_traded=["equities"],
        preferred_instruments=["Quality businesses", "occasional special situations"],
        philosophy="Avoid stupidity; latticework of mental models; prefer quality; inversion; patience.",
        documented_patterns=["Quality bias", "Inversion", "Incentive analysis"],
        entry_criteria=["Within competence", "Fair/attractive price for quality"],
        exit_criteria=["Rare; thesis break"],
        stop_loss_methodology=["Business-owner mindset, not tick stops"],
        position_sizing=["Concentration acceptable when odds and quality align (stated preference historically)"],
        risk_reward=["Avoid ruin; opportunity cost conscious"],
        technical_indicators=["Not central"],
        fundamental_methodology=["Business quality", "Management incentives", "Accounting reality"],
        preferred_conditions=["Clear mispricing of quality"],
        avoid_conditions=["Complexity beyond understanding", "Leverage speculation"],
        decision_psychology=["Temperament", "Patience", "Avoid envy"],
        historical_returns=[SourceNote("Berkshire collective results documented in annual reports", "verified", "Berkshire letters")],
        historical_drawdowns=[SourceNote("Berkshire and equity holdings experienced large drawdowns historically", "verified")],
        win_rates=[SourceNote("Not a trading win-rate framework", "speculation")],
        net_worth=[SourceNote("Billionaire estimates in wealth media", "estimate")],
        famous_successful_trades=["Long-term Berkshire holdings narrative"],
        famous_unsuccessful_trades=["Mistakes discussed in meetings/letters over decades"],
        predictions_outcomes=["Avoided precise short-term market calls as method"],
        strengths=["Mental models", "Quality focus"],
        weaknesses=["Style lags speculative melts"],
        eti_lessons=[
            "Pair with Buffett module",
            "Helena Frost: concentration still needs portfolio limits",
            "Adrian Cole: quality filter in synthesis",
        ],
        strategy_module_ids=["buffett_munger_value"],
        tags=["value", "psychology", "foundational", "deep"],
        expandable_notes="Primary: Poor Charlie's Almanack; Berkshire meeting transcripts/letters. Secondary: biographies.",
    )
)

_put(
    TraderKnowledgeProfile(
        id="mark_minervini",
        full_name="Mark Minervini",
        biography="US equity trader and educator; known for SEPA methodology and volatility contraction patterns (VCP); reported US Investing Championship results in public trading education materials.",
        trading_history="Active trading career and coaching; championship claims appear in his public materials and industry coverage (treat as reported unless primary contest records verified).",
        markets_traded=["US equities"],
        preferred_instruments=["Liquid growth stocks"],
        philosophy="Trade strongest stocks in strong markets; tighten setups via VCP; cut losses short; let winners work under trend templates.",
        documented_patterns=["Trend template", "VCP", "Pivot buy points", "Stage analysis"],
        entry_criteria=["Trend template filters", "VCP tightness", "Breakout through pivot with volume emphasis (teaching)"],
        exit_criteria=["Stop under pivot/structure", "Trailing under rising MAs / swing lows (teaching variants)"],
        stop_loss_methodology=["Predetermined risk from pivot; tight initial risk (educational materials)"],
        position_sizing=["Risk-based sizing from stop distance (teaching)"],
        risk_reward=["Favor setups with expansion potential after contraction"],
        technical_indicators=["Moving averages", "Relative strength", "Volume", "Chart patterns"],
        fundamental_methodology=["Growth/earnings emphasis as filter in SEPA narrative"],
        preferred_conditions=["Healthy market environment", "Leadership stocks"],
        avoid_conditions=["Weak market", "Wide-and-loose bases", "Extended chases"],
        decision_psychology=["Discipline on stops", "Patience for tightness"],
        historical_returns=[SourceNote("Championship and career return figures cited in educational materials/press", "reported")],
        historical_drawdowns=[SourceNote("Trading drawdowns inevitable; personal series not fully public", "reported")],
        win_rates=[SourceNote("Educational examples may cite rates — not treated as verified universal statistic", "speculation")],
        net_worth=[SourceNote("Not reliably public", "estimate")],
        famous_successful_trades=["Case studies in his books (illustrative)"],
        famous_unsuccessful_trades=["Teaching examples of failed breakouts"],
        predictions_outcomes=["Method is setup-driven, not macro prediction"],
        strengths=["Setup selectivity", "Risk definition"],
        weaknesses=["Equity bull-regime dependence"],
        eti_lessons=[
            "Elena Varga: implement VCP contraction metrics",
            "Helena Frost: enforce stop distance sizing",
            "Omar Diallo: avoid chasing extended pivots",
        ],
        strategy_module_ids=["minervini_vcp"],
        tags=["momentum", "equities", "VCP", "foundational", "deep"],
        expandable_notes="Primary-leaning: Trade Like a Stock Market Wizard; Think & Trade Like a Champion. Secondary: interviews/championship coverage.",
    )
)

_put(
    TraderKnowledgeProfile(
        id="richard_wyckoff",
        full_name="Richard Wyckoff",
        biography="Early 20th-century market educator and trader; developed a supply/demand framework and composite operator model still taught widely.",
        trading_history="Trading and publishing career in early US securities markets; methods preserved through courses and later schools of Wyckoff analysis.",
        markets_traded=["equities"],
        preferred_instruments=["Stocks", "historical tape/volume studies"],
        philosophy="Price and volume reveal supply and demand; identify accumulation/distribution; follow the composite operator.",
        documented_patterns=["Accumulation/distribution schematics", "Springs and upthrusts", "Effort vs result", "Cause and effect (point-and-figure tradition)"],
        entry_criteria=["Sign of strength after accumulation", "Spring + test (classic teaching)"],
        exit_criteria=["Signs of weakness", "Distribution completion", "Target from cause/effect counts (teaching)"],
        stop_loss_methodology=["Beyond spring/support invalidation (teaching)"],
        position_sizing=["Not a modern % equity formula in original materials — risk via structural invalidation"],
        risk_reward=["Seek markup after cause built in range"],
        technical_indicators=["Price", "Volume", "Relative strength vs market", "PnF counts in classical school"],
        fundamental_methodology=["Secondary to tape in classic Wyckoff; context optional"],
        preferred_conditions=["Clear range then directional expansion"],
        avoid_conditions=["No volume confirmation", "Ambiguous structure"],
        decision_psychology=["Patience through ranges", "Objectivity on volume"],
        historical_returns=[SourceNote("Historical personal P&L not available as modern audited series", "speculation")],
        historical_drawdowns=[SourceNote("Unknown in modern verified form", "speculation")],
        win_rates=[SourceNote("Not documented as modern statistic", "speculation")],
        net_worth=[SourceNote("Historical — not meaningful in modern lists", "estimate")],
        famous_successful_trades=["Methodological legacy more than single ticker fame"],
        famous_unsuccessful_trades=["Not centrally documented as celebrity blowups"],
        predictions_outcomes=["Framework for reading markets, not prediction celebrity"],
        strengths=["Structure + volume logic", "Educational durability"],
        weaknesses=["Subjectivity in phase labeling without strict rules"],
        eti_lessons=[
            "Nadia Petrova / structure desk: label ranges",
            "Jamal Reed liquidity: volume confirmation",
            "Implement spring/upthrust heuristics without overclaiming",
        ],
        strategy_module_ids=["wyckoff_supply_demand"],
        tags=["supply-demand", "classic", "foundational", "deep"],
        expandable_notes="Primary tradition: Wyckoff course materials as preserved by later schools; classic books on tape reading. Secondary: modern Wyckoff educators (interpret carefully).",
    )
)
