"""Synthetic companyfacts fixtures (NOT real filings) exercising the extraction logic."""
from datetime import date

from app.quant.fair_value import estimate_fair_value
from app.quant.fundamentals import build_fair_value_inputs


def rows(vals, unit_key="USD", filed_suffix="-02-15", fy_end="-12-31", form="10-K", start=2020):
    return {"units": {unit_key: [{"end": f"{start + i}{fy_end}", "val": v, "fy": start + i, "fp": "FY", "form": form,
                                  "filed": f"{start + i + 1}{filed_suffix}"} for i, v in enumerate(vals)]}}


def facts(**over):
    g = {
        "NetCashProvidedByUsedInOperatingActivities": rows([100e6, 110e6, 125e6, 140e6, 160e6]),
        "PaymentsToAcquirePropertyPlantAndEquipment": rows([20e6, 22e6, 25e6, 28e6, 30e6]),
        "WeightedAverageNumberOfDilutedSharesOutstanding": rows([50e6] * 5, "shares"),
        "LongTermDebtNoncurrent": rows([100e6] * 5), "CashAndCashEquivalentsAtCarryingValue": rows([60e6] * 5),
        "CommonStockDividendsPerShareDeclared": rows([0.5, 0.55, 0.6, 0.66, 0.72], "USD/shares"),
    }
    g.update(over)
    return {"facts": {"us-gaap": g}}


TODAY = date(2025, 6, 1)


def test_dcf_and_ddm_inputs_are_derived_from_filing_facts():
    r = build_fair_value_inputs(facts(), today=TODAY)
    dcf = r["inputs"]["dcf"]
    assert abs(dcf["fcf_per_share"] - (160e6 - 30e6) / 50e6) < 1e-9
    assert abs(dcf["net_debt_per_share"] - (100e6 - 60e6) / 50e6) < 1e-9
    assert 0 < dcf["growth_rate"] <= 0.10 and "ddm" in r["inputs"]
    assert r["assumptions"]["discount_rate"] == 0.10      # assumptions are disclosed, not hidden


def test_two_filing_models_can_support_a_valuation_and_one_cannot():
    both = build_fair_value_inputs(facts(), today=TODAY)["inputs"]
    assert estimate_fair_value("X", "equity", 50.0, both).supported in (True, False)   # may disagree; must not crash
    only_dcf = build_fair_value_inputs(facts(CommonStockDividendsPerShareDeclared={"units": {}}), today=TODAY)
    assert "ddm" not in only_dcf["inputs"] and any("fewer than two" in w for w in only_dcf["warnings"])
    assert not estimate_fair_value("X", "equity", 50.0, only_dcf["inputs"]).supported


def test_stale_filings_are_withheld():
    r = build_fair_value_inputs(facts(), today=date(2027, 6, 1))
    assert r["inputs"] == {} and any("stale" in w for w in r["warnings"])


def test_negative_fcf_means_no_dcf():
    r = build_fair_value_inputs(facts(NetCashProvidedByUsedInOperatingActivities=rows([10e6] * 5)), today=TODAY)
    assert "dcf" not in r["inputs"] and any("not positive" in w for w in r["warnings"])


def test_missing_data_returns_warnings_not_guesses():
    r = build_fair_value_inputs({"facts": {"us-gaap": {}}}, today=TODAY)
    assert r["inputs"] == {} and r["warnings"]


def test_only_10k_annual_rows_are_used_and_amendments_prefer_latest_filing():
    q = rows([1e9], "USD", form="10-Q")
    ocf = rows([100e6, 100e6, 100e6, 100e6, 160e6])
    ocf["units"]["USD"] += q["units"]["USD"]
    ocf["units"]["USD"].append({"end": "2024-12-31", "val": 170e6, "fy": 2024, "fp": "FY", "form": "10-K/A", "filed": "2026-03-01"})
    r = build_fair_value_inputs(facts(NetCashProvidedByUsedInOperatingActivities=ocf), today=TODAY)
    assert abs(r["inputs"]["dcf"]["fcf_per_share"] - (170e6 - 30e6) / 50e6) < 1e-9


def test_growth_is_capped_and_no_debt_tags_are_flagged():
    wild = rows([50e6, 60e6, 90e6, 140e6, 260e6])
    r = build_fair_value_inputs(facts(NetCashProvidedByUsedInOperatingActivities=wild, LongTermDebtNoncurrent={"units": {}}),
                                today=TODAY)
    assert r["inputs"]["dcf"]["growth_rate"] == 0.10 and any("no debt tags" in w for w in r["warnings"])
