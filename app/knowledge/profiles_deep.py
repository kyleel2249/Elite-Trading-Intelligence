"""
Deepened profiles with explicit primary/secondary source notes.
Claims remain labeled: verified | reported | estimate | speculation.
Never invent private strategies, win rates, or undisclosed performance.
"""
from app.knowledge.schema import TraderKnowledgeProfile, SourceNote

# Overlay/replace ids in registry merge
DEEP_PROFILES: dict[str, TraderKnowledgeProfile] = {}


def _put(p: TraderKnowledgeProfile) -> None:
    DEEP_PROFILES[p.id] = p


_put(
    TraderKnowledgeProfile(
        id="george_soros",
        full_name="George Soros",
        aliases=["Soros", "Quantum Fund"],
        biography=(
            "Investor and philanthropist; founded Soros Fund Management. "
            "Developed and publicly articulated the concept of reflexivity in markets."
        ),
        trading_history=(
            "Quantum Fund global macro record is extensively covered in financial press and in Soros's own writings. "
            "Exact continuous audited retail-style stats are not published as a single official series."
        ),
        markets_traded=["FX", "equities", "bonds", "commodities"],
        preferred_instruments=["FX forwards/futures", "index futures", "options", "equities"],
        philosophy=(
            "Markets are imperfect; participant bias interacts with fundamentals (reflexivity), "
            "producing self-reinforcing boom-bust sequences. Large, concentrated positions when asymmetry is extreme."
        ),
        documented_patterns=[
            "Macro imbalance identification",
            "Concentrated directional bets",
            "Willingness to reverse quickly when wrong (described in interviews/writings)",
        ],
        entry_criteria=[
            "Perceived gap between market bias and underlying conditions",
            "Asymmetric payoff relative to risk capital",
        ],
        exit_criteria=["Thesis invalidation", "Exhaustion of reflexive process"],
        stop_loss_methodology=[
            "Public materials emphasize cutting when thesis fails; precise stop algorithms are not a published retail rule-set"
        ],
        position_sizing=[
            "Historically willing to size large when conviction high (reported)",
            "Not reducible to a single public % risk formula",
        ],
        risk_reward=["Seek asymmetric macro payoffs (reported philosophy)"],
        technical_indicators=["Tactical; secondary to macro thesis (reported)"],
        fundamental_methodology=["Macro policy", "Credit/FX regimes", "Political economy"],
        preferred_conditions=["Policy transitions", "Large imbalances", "Liquidity shifts"],
        avoid_conditions=["No clear thesis (inferred from stated discipline)"],
        decision_psychology=["Fallibility", "Critical scrutiny of one's own bias"],
        historical_returns=[
            SourceNote(
                "Quantum Fund long-term outperformance widely reported in secondary literature",
                "reported",
                "Financial press; fund marketing history — not a single verified public audit for all years",
            )
        ],
        historical_drawdowns=[
            SourceNote("Material drawdowns including late-1990s stress periods reported", "reported")
        ],
        win_rates=[SourceNote("No complete verified public trade-level win rate", "speculation")],
        net_worth=[
            SourceNote(
                "Multi-billion USD range in wealth media",
                "estimate",
                "Forbes and similar — verify current figure independently",
            )
        ],
        famous_successful_trades=[
            "1992 GBP short (Black Wednesday) — extensively documented in contemporary reporting"
        ],
        famous_unsuccessful_trades=[
            "Losses around 1998 emerging-market stress widely discussed in secondary sources (reported)"
        ],
        predictions_outcomes=["Public commentary mixed by episode; always timestamp claims"],
        strengths=["Macro synthesis", "Flexibility", "Size when asymmetric"],
        weaknesses=["Concentration", "Thesis can be early"],
        eti_lessons=[
            "Tag reflexivity hypotheses in council context",
            "Require invalidation before size-up",
            "Helena Frost veto if macro risk underspecified",
            "Adrian Cole synthesizes; Sofia Rahman supplies macro regime",
        ],
        strategy_module_ids=["soros_reflexivity"],
        tags=["macro", "fx", "reflexivity", "foundational", "deep"],
        expandable_notes=(
            "Primary-leaning sources: The Alchemy of Finance (Soros); contemporary FT/WSJ coverage of 1992. "
            "Secondary: financial biographies and press summaries. Proprietary Quantum risk code is not public."
        ),
    )
)

_put(
    TraderKnowledgeProfile(
        id="stanley_druckenmiller",
        full_name="Stanley Druckenmiller",
        biography="Investor; Duquesne Capital; associated with Soros/Quantum period; multi-decade macro reputation (reported).",
        trading_history="Duquesne Capital performance is frequently cited in media; continuous official public monthly series not universally available.",
        markets_traded=["FX", "equities", "bonds", "commodities"],
        preferred_instruments=["FX", "index futures", "equities", "options"],
        philosophy="Preserve capital; respect liquidity; be aggressive only when asymmetry is clear; flexible holding period.",
        documented_patterns=["Liquidity-first framing", "Fast risk reduction", "Macro theme concentration"],
        entry_criteria=["Liquidity + macro alignment", "Asymmetric upside"],
        exit_criteria=["Thesis break", "Liquidity regime change"],
        stop_loss_methodology=["Cut quickly when wrong — described in interviews (reported)"],
        position_sizing=["Conviction- and liquidity-scaled (reported)", "No single published formula"],
        risk_reward=["Asymmetry preferred"],
        technical_indicators=["Timing overlay (reported)"],
        fundamental_methodology=["Rates, liquidity, growth, policy"],
        preferred_conditions=["Clear liquidity trend"],
        avoid_conditions=["Fighting policy/liquidity without edge (reported)"],
        decision_psychology=["Intellectual honesty", "No ego exits"],
        historical_returns=[
            SourceNote("Exceptional long-term returns frequently cited", "reported", "Interviews, secondary profiles")
        ],
        historical_drawdowns=[SourceNote("Drawdowns occurred; magnitudes source-dependent", "reported")],
        win_rates=[SourceNote("No verified public trade-level win rate", "speculation")],
        net_worth=[SourceNote("Multi-billion range in wealth media", "estimate")],
        famous_successful_trades=["1992 GBP episode with Soros (widely reported)"],
        famous_unsuccessful_trades=["Publicly acknowledged mistakes across career interviews"],
        predictions_outcomes=["Public macro calls mixed; track with dates"],
        strengths=["Liquidity intuition", "Flexibility"],
        weaknesses=["Can be early on public calls"],
        eti_lessons=[
            "Sofia Rahman desk tags liquidity regime",
            "Never max size without asymmetry",
            "Helena Frost enforces daily/drawdown limits",
        ],
        strategy_module_ids=["druck_liquidity_macro"],
        tags=["macro", "liquidity", "foundational", "deep"],
        expandable_notes="Sources: published interviews (e.g. long-form investor conversations), secondary profiles; Duquesne internal docs not public.",
    )
)

_put(
    TraderKnowledgeProfile(
        id="paul_tudor_jones",
        full_name="Paul Tudor Jones",
        biography="Founder, Tudor Investment Corporation; discretionary macro/technical risk culture.",
        trading_history="1987 equity market positioning widely documented; multi-decade fund complex.",
        markets_traded=["futures", "FX", "equities", "commodities"],
        preferred_instruments=["index futures", "FX", "commodities"],
        philosophy="Capital preservation first; technical structure defines risk; selective aggression.",
        documented_patterns=["Structure-based risk", "Macro + technical blend", "Loss-sensitive sizing (reported teaching)"],
        entry_criteria=["Structural setup", "Favorable risk geometry (reported)"],
        exit_criteria=["Stop beyond structure", "Target/thesis end"],
        stop_loss_methodology=["Pre-defined risk emphasis in public teaching materials (reported)"],
        position_sizing=["Risk-based; reduce after losses (reported principles)"],
        risk_reward=[
            SourceNote(
                "High R:R aspirational teachings appear in secondary trading education literature",
                "reported",
                "Not a verified per-trade statistic for Tudor funds",
            ).claim
        ],
        technical_indicators=["Price structure", "Momentum/sentiment concepts (reported)"],
        fundamental_methodology=["Macro context"],
        preferred_conditions=["Clear extremes", "Trend conditions"],
        avoid_conditions=["Poor structure / R:R"],
        decision_psychology=["Defense-first", "Humility after losses"],
        historical_returns=[SourceNote("Strong long-term reputation; figures vary by source", "reported")],
        historical_drawdowns=[SourceNote("Challenging periods discussed publicly at fund-complex level", "reported")],
        win_rates=[SourceNote("No complete public verified win rate", "speculation")],
        net_worth=[SourceNote("Billionaire range in wealth media", "estimate")],
        famous_successful_trades=["1987 crash-related positioning (media/books)"],
        famous_unsuccessful_trades=["Discretionary underperformance episodes reported over long history"],
        predictions_outcomes=["Public forecasts mixed"],
        strengths=["Risk framing", "Technical discipline"],
        weaknesses=["Discretion vs pure systems by regime"],
        eti_lessons=[
            "Elena Varga structure before Omar Diallo execution",
            "Helena Frost hard stops on portfolio limits",
            "Claire Bennett journals every risk event",
        ],
        strategy_module_ids=["ptj_structure_preservation"],
        tags=["macro", "technical", "risk", "foundational", "deep"],
        expandable_notes="Sources: contemporary reporting on 1987; Market Wizards interview tradition; Tudor public comments. Internal models not public.",
    )
)

_put(
    TraderKnowledgeProfile(
        id="jim_simons",
        full_name="Jim Simons",
        biography="Mathematician; founder of Renaissance Technologies; pioneer of large-scale quantitative trading.",
        trading_history="Medallion Fund performance is widely reported as exceptional; detailed strategy remains proprietary.",
        markets_traded=["multi-asset"],
        preferred_instruments=["highly diversified futures/equities/derivatives (reported at firm level)"],
        philosophy="Scientific method; statistical patterns; rigorous research; capacity and execution matter.",
        documented_patterns=["Quant research culture", "Short-horizon statistical edges (general)", "Secrecy of signals"],
        entry_criteria=["Model-driven (proprietary — not public)"],
        exit_criteria=["Model-driven (proprietary)"],
        stop_loss_methodology=["Firm-level risk systems not publicly specified"],
        position_sizing=["Highly diversified, capacity-aware (reported general principles)"],
        risk_reward=["Many small edges (general quant principle) — not a disclosed formula"],
        technical_indicators=["Statistical features — not disclosed"],
        fundamental_methodology=["Primarily quant/statistical; not classic fundamental discretionary"],
        preferred_conditions=["Conditions where models retain edge (non-public)"],
        avoid_conditions=["Capacity overflow; model decay (general quant lesson)"],
        decision_psychology=["Research over narrative"],
        historical_returns=[
            SourceNote(
                "Medallion returns extensively reported as among the highest in industry",
                "reported",
                "Press and secondary research — full official public disclosure limited",
            )
        ],
        historical_drawdowns=[SourceNote("Even top quant funds have non-zero drawdowns; specifics source-dependent", "reported")],
        win_rates=[SourceNote("Not publicly disclosed at trade level", "speculation")],
        net_worth=[SourceNote("Multi-billion wealth media estimates", "estimate")],
        famous_successful_trades=["Firm-level track record rather than single celebrity trades"],
        famous_unsuccessful_trades=["Not typically framed as single-trade narratives"],
        predictions_outcomes=["Not a public prediction-oriented manager"],
        strengths=["Scientific process", "Scale of research"],
        weaknesses=["Strategies not transferable from public documents"],
        eti_lessons=[
            "Kenji Mori / quant desk: require out-of-sample discipline",
            "Do not claim RenTech signals",
            "Lars Hagen forecasts remain probabilistic scaffolds only",
        ],
        strategy_module_ids=["simons_quant"],
        tags=["quant", "foundational", "deep"],
        expandable_notes="Primary public: Simons interviews, academic background; secondary: industry reporting on Renaissance. No proprietary signal reconstruction.",
    )
)

_put(
    TraderKnowledgeProfile(
        id="warren_buffett",
        full_name="Warren Buffett",
        biography="Chairman/CEO Berkshire Hathaway; long-term value investor.",
        trading_history="Decades of capital allocation via Berkshire; public annual letters are primary source material.",
        markets_traded=["equities", "whole companies", "insurance float investments"],
        preferred_instruments=["Common stocks", "control acquisitions", "occasionally derivatives at firm level"],
        philosophy="Buy wonderful businesses at fair prices; margin of safety; long holding periods; circle of competence.",
        documented_patterns=["Owner earnings focus", "Moat quality", "Patient capital allocation"],
        entry_criteria=["Understandable business", "Able management", "Attractive price vs value (letters)"],
        exit_criteria=["Rare; thesis break or extreme mis-valuation (general teaching)"],
        stop_loss_methodology=["Not short-term trading stops; business-owner mindset"],
        position_sizing=["Concentrated when conviction high (historical Berkshire practice)"],
        risk_reward=["Permanent capital loss risk primary — not day-trade R multiples"],
        technical_indicators=["Generally not central"],
        fundamental_methodology=["Business analysis", "Accounting literacy", "Capital allocation"],
        preferred_conditions=["Understandable opportunities within competence"],
        avoid_conditions=["Outside circle of competence", "Excessive leverage speculation"],
        decision_psychology=["Patience", "Temperament over IQ (stated theme)"],
        historical_returns=[
            SourceNote(
                "Berkshire book/market value growth documented in annual reports over decades",
                "verified",
                "Berkshire Hathaway annual reports — interpret carefully vs tradable strategy",
            )
        ],
        historical_drawdowns=[
            SourceNote("Multiple multi-year underperformance and price drawdowns documented", "verified", "Market data + letters")
        ],
        win_rates=[SourceNote("Not a short-term win-rate framework", "speculation")],
        net_worth=[SourceNote("Among world's largest fortunes — media estimates", "estimate", "Forbes etc.")],
        famous_successful_trades=["Long-term core holdings (e.g. historic Coca-Cola stake) widely documented"],
        famous_unsuccessful_trades=["Publicly discussed mistakes in annual letters (e.g. certain acquisitions)"],
        predictions_outcomes=["Avoids precise short-term market prediction as a method"],
        strengths=["Capital allocation", "Temperament", "Business judgment"],
        weaknesses=["Style lags in speculative melts; large size constraints"],
        eti_lessons=[
            "Marcus Okonkwo FA desk: quality + valuation framing",
            "Do not force Buffett logic onto high-frequency crypto scalps",
            "Incompatible with pure scalping modules",
        ],
        strategy_module_ids=["buffett_munger_value"],
        tags=["value", "foundational", "deep"],
        expandable_notes="Primary: Berkshire annual letters (buffett.cnbc.com / berkshirehathaway.com). Secondary: biographies. Letters are the gold standard source.",
    )
)

_put(
    TraderKnowledgeProfile(
        id="richard_dennis",
        full_name="Richard Dennis",
        biography="Chicago traders' hall-of-fame figure; co-originator of the Turtle experiment.",
        trading_history="Futures trading career; Turtle program documented in multiple trader accounts and rule summaries.",
        markets_traded=["futures"],
        preferred_instruments=["Liquid futures"],
        philosophy="Trend following; rules can be taught; aggressive opportunity within defined risk units.",
        documented_patterns=["N-day breakouts", "Unit-based sizing", "Pyramiding (Turtle literature)"],
        entry_criteria=["Breakout rules as published in Turtle secondary literature"],
        exit_criteria=["Opposite breakout / stops per system variants"],
        stop_loss_methodology=["Volatility/unit-based risk (Turtle literature)"],
        position_sizing=["1% equity style risk units in common Turtle rule presentations (secondary)"],
        risk_reward=["Trend convexity — many small losses, large winners (system property)"],
        technical_indicators=["Donchian-style channels / breakouts (literature)"],
        fundamental_methodology=["Primarily systematic price"],
        preferred_conditions=["Trending regimes"],
        avoid_conditions=["Chop without adaptation (system pain)"],
        decision_psychology=["Rule adherence under drawdown"],
        historical_returns=[SourceNote("Career and Turtle outcomes discussed in trader literature", "reported")],
        historical_drawdowns=[SourceNote("Trend systems have deep equity DD by design", "reported")],
        win_rates=[SourceNote("Typically sub-50% for trend breakout systems — general property, not a verified personal certificate", "estimate")],
        net_worth=[SourceNote("Media estimates vary", "estimate")],
        famous_successful_trades=["Trend campaigns rather than single celebrity stocks"],
        famous_unsuccessful_trades=["Chop-market pain periods inherent to method"],
        predictions_outcomes=["System, not prediction narrative"],
        strengths=["Rules", "Scalability of teaching experiment"],
        weaknesses=["Long flat/DD periods"],
        eti_lessons=[
            "Kenji Mori quantifies rules",
            "Helena Frost still caps portfolio risk",
            "Do not mix with tight mean-reversion without isolation",
        ],
        strategy_module_ids=["turtle_trend"],
        tags=["trend", "systematic", "foundational", "deep"],
        expandable_notes="Sources: Turtle rules as circulated in trader education (Covel and others — secondary); original private contracts not fully public. Treat rule sets as reconstructed literature.",
    )
)
