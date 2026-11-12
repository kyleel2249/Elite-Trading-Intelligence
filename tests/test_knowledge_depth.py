"""Depth guard for the trader knowledge registry (Python-side twin of worker/knowledge.test.ts).

Profiles that were once template filler must now hold substantive content in all 25 required fields, so
the registry cannot silently regress to "complete on paper" entries.
"""
from app.knowledge.registry import get_trader, list_traders

DEEPENED_IDS = [
    "ed_thorp", "michael_steinhardt", "julian_robertson", "david_shaw", "marty_schwartz", "tom_basso",
    "howard_marks", "chris_hohn", "david_einhorn", "john_w_henry", "robert_mercer",
    "bruce_kovner", "william_eckhardt", "nicolas_darvas", "jesse_livermore", "larry_williams",
    "linda_bradford_raschke", "kathy_lien", "john_paulson", "david_tepper", "john_templeton",
    "bill_ackman", "seth_klarman", "van_tharp", "alexander_elder", "jack_schwager", "nassim_taleb", "steven_cohen",
]

REQUIRED_KEYS = [
    ["full_name", "biography"], ["trading_history"], ["markets_traded"], ["preferred_instruments"], ["philosophy"],
    ["documented_patterns"], ["entry_criteria"], ["exit_criteria"], ["stop_loss_methodology"], ["position_sizing"],
    ["risk_reward"], ["technical_indicators"], ["fundamental_methodology"], ["preferred_conditions"], ["avoid_conditions"],
    ["decision_psychology"], ["historical_returns"], ["historical_drawdowns"], ["win_rates"], ["net_worth"],
    ["famous_successful_trades"], ["famous_unsuccessful_trades"], ["predictions_outcomes"], ["strengths", "weaknesses"],
    ["eti_lessons"],
]

FILLER = {
    "aligned with documented philosophy", "per documented public methodology", "thesis or system exit",
    "often unpublished in precise form", "varies by firm/strategy", "firm/strategy specific", "not assumed without source",
    "see patterns", "see philosophy", "style-favorable regimes", "outside competence / no edge", "outside edge",
    "process discipline", "source-dependent", "usually not fully public", "media estimate if any", "see public case studies",
    "public case studies where available", "evaluate dated claims individually", "timestamped evaluation only",
    "regime sensitivity", "attribution only when evidence matches", "helena frost risk always applies",
}
FILLER_PREFIXES = ("modules:", "public career summary; deepen", "expand with primary sources")


def _text(x):
    if isinstance(x, str):
        return x
    if isinstance(x, dict):
        return x.get("claim") or ""
    return ""


def _is_filler(s):
    t = s.strip().lower().rstrip(".")
    return t in FILLER or t.startswith(FILLER_PREFIXES)


def _substantive(v):
    if isinstance(v, list):
        return any(_text(x).strip() and not _is_filler(_text(x)) for x in v)
    if isinstance(v, str):
        return bool(v.strip()) and not _is_filler(v)
    return v is not None


def test_deepened_profiles_have_substantive_content_in_all_25_fields():
    for pid in DEEPENED_IDS:
        profile = get_trader(pid)
        assert profile is not None, pid
        for keys in REQUIRED_KEYS:
            assert any(_substantive(profile.get(k)) for k in keys), f"{pid}: field {keys} is empty or placeholder"


def test_deepened_profiles_label_every_performance_note():
    allowed = {"verified", "reported", "estimate", "speculation", "not_documented"}
    for pid in DEEPENED_IDS:
        profile = get_trader(pid)
        for key in ("historical_returns", "historical_drawdowns", "win_rates", "net_worth"):
            for note in profile[key]:
                assert note["classification"] in allowed, f"{pid}.{key}"


def test_no_profile_uses_a_strategy_module_that_does_not_exist():
    from app.knowledge.strategies import STRATEGY_MODULES

    for t in list_traders():
        for mid in t["strategy_module_ids"]:
            assert mid in STRATEGY_MODULES, f"{t['id']} references unknown module {mid}"
