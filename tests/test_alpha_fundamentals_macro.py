import httpx
import pytest

from app.alpha import fusion
from app.alpha.context import _CIK, _FACTS, gather_context, load_fundamentals
from app.alpha.db_models import AlphaAuditLog, AlphaCandidate, AlphaStrategyState, AlphaTradePlan
from app.alpha.fundamentals import annual_series, garp_screen, quality_screen, valuation_component
from app.alpha.macro import credit_cycle, growth_inflation_quadrant, liquidity_regime, load_macro
from app.alpha.providers import SecTickerUniverse
from app.alpha.strategy_library import LIBRARY
from app.config import Settings
from app.database import SessionLocal, init_db
from tests.test_alpha_pipeline import _cand


def _facts(years=8, roe=0.2, eps0=1.0, eps_growth=0.15, debt_ratio=0.3, ni_sign=1, with_fcf=True):
    gaap, base = {}, 2015

    def flow(vals, unit="USD"):
        return {"units": {unit: [{"start": f"{base + i}-01-01", "end": f"{base + i}-12-31", "val": v, "fy": base + i, "fp": "FY", "form": "10-K",
                                  "filed": f"{base + i + 1}-02-15"} for i, v in enumerate(vals)]}}

    def inst(vals):
        return {"units": {"USD": [{"end": f"{base + i}-12-31", "val": v, "fy": base + i, "fp": "FY", "form": "10-K", "filed": f"{base + i + 1}-02-15"}
                                  for i, v in enumerate(vals)]}}
    eq = [1000.0 * (1.1 ** i) for i in range(years)]
    gaap["StockholdersEquity"] = inst(eq)
    gaap["NetIncomeLoss"] = flow([ni_sign * e * roe for e in eq])
    gaap["LongTermDebt"] = inst([e * debt_ratio for e in eq])
    if with_fcf:
        gaap["NetCashProvidedByUsedInOperatingActivities"] = flow([e * roe * 1.2 for e in eq])
        gaap["PaymentsToAcquirePropertyPlantAndEquipment"] = flow([e * roe * 0.3 for e in eq])
    gaap["EarningsPerShareDiluted"] = flow([eps0 * (1 + eps_growth) ** i for i in range(years)], "USD/shares")
    return {"cik": 1, "entityName": "TestCo", "facts": {"us-gaap": gaap}}


def test_annual_series_filters_quarterly_and_prefers_latest_restatement():
    f = _facts(6)
    f["facts"]["us-gaap"]["NetIncomeLoss"]["units"]["USD"].append(
        {"start": "2020-01-01", "end": "2020-03-31", "val": 1.0, "fy": 2020, "fp": "Q1", "form": "10-Q", "filed": "2020-05-01"})
    f["facts"]["us-gaap"]["NetIncomeLoss"]["units"]["USD"].append(
        {"start": "2015-01-01", "end": "2015-12-31", "val": 123.0, "fy": 2015, "fp": "FY", "form": "10-K/A", "filed": "2017-01-01"})
    s = annual_series(f, "net_income")
    assert len(s) == 6 and s["2015-12-31"] == 123.0 and "2020-03-31" not in s


def test_quality_screen_pass_fail_and_insufficient():
    assert quality_screen(_facts())["verdict"] == "PASSES_SCREEN"
    assert quality_screen(_facts(roe=0.03))["verdict"] == "FAILS_SCREEN"
    assert quality_screen(_facts(debt_ratio=2.5))["verdict"] == "FAILS_SCREEN"
    assert quality_screen(_facts(ni_sign=-1))["verdict"] == "FAILS_SCREEN"
    r = quality_screen(_facts(years=3))
    assert r["verdict"] == "INSUFFICIENT_DATA" and "ETI parameterization" in r["note"]
    no_fcf = quality_screen(_facts(with_fcf=False))
    assert any(c["id"] == "free_cash_flow" and c["pass"] is None for c in no_fcf["criteria"])  # missing data is not a pass


def test_garp_screen_peg_buckets_and_guards():
    f = _facts(eps0=1.0, eps_growth=0.20)
    eps = annual_series(f, "eps")
    last = list(eps.values())[-1]
    cheap = garp_screen(f, price=last * 10)  # PE 10, growth ~20% -> PEG 0.5
    assert cheap["verdict"] == "FAVORABLE" and cheap["peg"] < 1
    assert garp_screen(f, price=last * 40)["verdict"] == "UNFAVORABLE"
    assert garp_screen(f, price=None)["verdict"] == "NOT_EVALUABLE"
    assert garp_screen(_facts(years=3), price=10)["verdict"] == "INSUFFICIENT_DATA"
    assert garp_screen(_facts(eps_growth=-0.05), price=10)["verdict"] == "NOT_APPLICABLE"
    assert garp_screen(f, price=last * 10)["stale"] is True  # fixture is old: staleness is reported
    assert valuation_component(cheap) is None  # stale data never feeds the score
    from datetime import date
    fresh = garp_screen(f, price=last * 10, today=date(2023, 3, 1))
    assert valuation_component(fresh) == 80.0


def _pts(vals):
    return [{"date": f"d{i}", "value": v} for i, v in enumerate(vals)]


def test_liquidity_regime():
    easing = liquidity_regime({"DFF": _pts([5.0] * 100 + [4.0] * 40), "WALCL": _pts([100] * 20 + [103]), "T10Y2Y": _pts([0.5])})
    assert easing["regime"] == "EASING_LIQUIDITY"
    tight = liquidity_regime({"DFF": _pts([1.0] * 100 + [2.0] * 40), "WALCL": _pts([100] * 20 + [97]), "T10Y2Y": _pts([-0.4])})
    assert tight["regime"] == "TIGHTENING_LIQUIDITY" and tight["curve_inverted"] is True
    assert liquidity_regime({"T10Y2Y": _pts([0.2])})["regime"] == "UNKNOWN"  # < 2 inputs
    assert "not a forecast" in easing["note"]


def test_growth_inflation_and_credit_cycle():
    cpi = [100 * (1.002 ** i) for i in range(10)] + [100 * (1.002 ** 10) * (1.006 ** i) for i in range(1, 11)]
    q = growth_inflation_quadrant({"CPIAUCSL": _pts(cpi), "UNRATE": _pts([5.0, 5.0, 5.0, 4.9, 4.8, 4.7, 4.6, 4.5, 4.4, 4.4])})
    assert q["quadrant"] == "GROWTH_UP_INFLATION_UP"
    assert growth_inflation_quadrant({"CPIAUCSL": _pts([1] * 5), "UNRATE": _pts([5] * 3)})["quadrant"] == "UNKNOWN"
    tight = credit_cycle({"BAMLH0A0HYM2": _pts([4.0 + (i % 50) / 10 for i in range(299)] + [3.9])})
    assert tight["state"] == "TIGHT_SPREADS_LATE_CYCLE_CAUTION"
    wide = credit_cycle({"BAMLH0A0HYM2": _pts([3.0 + (i % 50) / 10 for i in range(299)] + [12.0])})
    assert wide["state"] == "WIDE_SPREADS_STRESS_OR_OPPORTUNITY"
    assert credit_cycle({"BAMLH0A0HYM2": _pts([4] * 10)})["state"] == "UNKNOWN"


async def test_load_macro_uses_fetcher_and_reports_failures():
    assert (await load_macro(Settings(fred_api_key=None)))["status"] == "not_configured"
    calls = []

    async def fake(sid, lim, settings):
        calls.append(sid)
        if sid == "WALCL":
            return {"status": "error"}
        return {"status": "ok", "points": _pts([1.0] * 300)}
    r = await load_macro(Settings(fred_api_key="k"), fetch=fake, use_cache=False)
    assert r["status"] == "ok" and r["failed_series"] == ["WALCL"] and set(calls) == {"DFF", "WALCL", "T10Y2Y", "CPIAUCSL", "UNRATE", "BAMLH0A0HYM2"}


@pytest.fixture()
def db():
    init_db()
    s = SessionLocal()
    for m in (AlphaTradePlan, AlphaCandidate, AlphaAuditLog, AlphaStrategyState):
        s.query(m).delete()
    s.commit()
    yield s
    s.close()


def _eq_cand(db):
    c, bars = _cand(db, symbol="EQFUND")
    c.asset_class = "equity"
    db.commit()
    return c, bars


def test_macro_is_context_not_agreement_and_never_vetoes(db):
    c, bars = _cand(db, symbol="MACROUSDT")
    easing = {"status": "ok", "liquidity": {"regime": "EASING_LIQUIDITY"}, "growth_inflation": {}, "credit": {}}
    tight = {"status": "ok", "liquidity": {"regime": "TIGHTENING_LIQUIDITY"}, "growth_inflation": {}, "credit": {}}
    fusion.register_engine("plugin_b1", lambda ctx: fusion.EngineEvidence("plugin_b1", True, "bullish", 0.7))
    try:
        base = fusion.validate(db, c, bars, settings=Settings(), equity=10000, macro=tight, record=False)
        assert any(e["engine"] == "macro_regime" and e["bias"] == "bearish" and not e["hard_veto"] for e in base["engines"])
        assert base["executable"]  # tightening macro alone cannot block
    finally:
        fusion._ENGINES.pop("plugin_b1", None)
    # with only technical + strategy_lab bullish, a bullish macro must not be counted as a third independent engine
    r = fusion.validate(db, c, bars, settings=Settings(), equity=10000, macro=easing, record=False)
    detail = next(x["detail"] for x in r["checks"] if x["id"] == "V7_independent_engine_agreement")
    assert "macro_regime" not in detail


def test_fundamentals_feed_valuation_and_engine(db):
    c, bars = _eq_cand(db)
    f = _facts()
    last = list(annual_series(f, "eps").values())[-1]
    from datetime import date
    fund = {"quality": quality_screen(f), "garp": garp_screen(f, price=last * 10, today=date(2023, 3, 1))}
    r = fusion.validate(db, c, bars, settings=Settings(), equity=10000, fundamentals=fund, record=False)
    e = next(x for x in r["engines"] if x["engine"] == "fundamentals")
    assert e["bias"] == "bullish" and e["available"]
    bad = {"quality": quality_screen(_facts(roe=0.02)), "garp": {"verdict": "NOT_APPLICABLE"}}
    eb = fusion.engine_fundamentals({"fundamentals": bad})
    assert eb.bias == "bearish" and not eb.hard_veto
    assert not fusion.engine_fundamentals({"fundamentals": None}).available


async def test_load_fundamentals_maps_ticker_to_cik_with_mock_sec(db):
    _CIK.update(ts=0.0, map={})
    _FACTS.clear()
    f = _facts()
    seen = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(str(req.url))
        if "company_tickers_exchange" in str(req.url):
            return httpx.Response(200, json={"fields": ["cik", "name", "ticker", "exchange"], "data": [[320193, "Apple", "AAPL", "Nasdaq"], [1, "TestCo", "TEST", "NYSE"]]})
        return httpx.Response(200, json=f)
    cl = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    from app.alpha.fundamentals import SecFundamentals
    out = await load_fundamentals(db, Settings(), "test", 50.0, tickers=SecTickerUniverse(client=cl, db=db), facts_src=SecFundamentals("ua", client=cl, db=db))
    assert out["cik"] == 1 and out["quality"]["verdict"] == "PASSES_SCREEN"
    assert any("CIK0000000001.json" in u for u in seen)
    assert await load_fundamentals(db, Settings(), "NOPE", 1.0, tickers=SecTickerUniverse(client=cl, db=db)) is None


async def test_gather_context_injects_macro_and_fundamentals(db):
    c, bars = _eq_cand(db)

    async def macro(settings):
        return {"status": "ok", "liquidity": {"regime": "MIXED"}}

    async def fund(db_, settings, ticker, price):
        return {"quality": {"verdict": "PASSES_SCREEN"}, "garp": {"verdict": "FAIR"}}
    ctx = await gather_context(db, Settings(), c, bars, macro_fn=macro, fundamentals_fn=fund)
    assert ctx["macro"]["liquidity"]["regime"] == "MIXED" and ctx["fundamentals"]["quality"]["verdict"] == "PASSES_SCREEN"
    off = await gather_context(db, Settings(), c, bars, macro_fn=lambda s: _raise(), fundamentals_fn=fund)
    assert off["macro"] is None  # a failing macro feed degrades quietly


async def _raise():
    raise RuntimeError("feed down")


def test_library_marks_live_evaluators_without_pretending_to_backtest():
    for sid in ("buffett_quality_value", "lynch_garp", "druck_liquidity_regime", "dalio_cycle_balance", "special_situations"):
        m = LIBRARY[sid]
        assert m.evaluator and not m.executable and any("NOT a backtest" in c or "unimplemented" in c for c in m.caveats)
    assert LIBRARY["soros_reflexivity_macro"].evaluator is None
