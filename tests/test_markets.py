"""Multi-market intelligence: classification, sessions, profiles, sizing, routing, risk integration, API."""
from __future__ import annotations

from datetime import date, datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import app
from app.markets import assess, classify, list_instruments, market_risk_review, profile_for, register_holidays, session_status
from app.markets.live import route_snapshot
from app.markets.providers import routes_for
from app.markets.types import AssetClass
from app.risk.engine import OrderProposal, RiskEngine

U = timezone.utc


def at(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=U)


# ------------------------------------------------------------------ classification
@pytest.mark.parametrize("raw,cls,tier,sym", [
    ("EUR/USD", "forex", "major", "EURUSD"), ("gbpusd", "forex", "major", "GBPUSD"), ("USDJPY", "forex", "major", "USDJPY"),
    ("AUDUSD", "forex", "major", "AUDUSD"), ("USDCAD", "forex", "major", "USDCAD"), ("USDCHF", "forex", "major", "USDCHF"),
    ("NZDUSD", "forex", "major", "NZDUSD"), ("EURGBP", "forex", "minor", "EURGBP"), ("USDZAR", "forex", "exotic", "USDZAR"),
    ("USDNGN", "forex", "exotic", "USDNGN"),
    ("XAUUSD", "metal", "major", "XAUUSD"), ("XAG/USD", "metal", "silver", "XAGUSD"), ("XPTUSD", "metal", "other", "XPTUSD"),
    ("BTCUSDT", "crypto", "major", "BTCUSDT"), ("ETHUSDT", "crypto", "major", "ETHUSDT"), ("SOLUSDT", "crypto", "large", "SOLUSDT"),
    ("XRPUSDT", "crypto", "large", "XRPUSDT"), ("BNBUSDT", "crypto", "large", "BNBUSDT"), ("DOGEUSDT", "crypto", "large", "DOGEUSDT"),
    ("1000SATSUSDT", "crypto", "meme", "1000SATSUSDT"), ("UNIUSDT", "crypto", "defi", "UNIUSDT"),
    ("AAPL", "stock", "us_mega", "AAPL"), ("VOD.L", "stock", "developed", "LSE:VOD"), ("NPN.JO", "stock", "emerging", "JSE:NPN"),
    ("NGX:DANGCEM", "stock", "frontier", "NGX:DANGCEM"), ("7203.T", "stock", "developed", "TSE:7203"),
    ("SPX", "index", "us", "SPX"), ("NAS100", "index", "us", "NDX"), ("US30", "index", "us", "DJI"),
    ("FTSE", "index", "developed", "FTSE100"), ("DAX", "index", "developed", "DAX"), ("N225", "index", "developed", "N225"),
    ("WTI", "commodity", "crude", "WTI"), ("NATGAS", "commodity", "natgas", "NATGAS"), ("WHEAT", "commodity", "agri", "WHEAT"),
    ("CLZ6", "future", "crude", "CLZ6"), ("ESH7", "future", "us", "ESH7"),
    ("AAPL261218C00200000", "option", "equity", "AAPL261218C00200000"),
])
def test_classification(raw, cls, tier, sym):
    i = classify(raw)
    assert (i.asset_class.value, i.tier, i.symbol) == (cls, tier, sym)


def test_names_and_bare_symbols():
    assert classify("Gold").symbol == "XAUUSD"
    assert classify("Bitcoin").symbol == "BTCUSDT"
    assert classify("1000SATS").symbol == "1000SATSUSDT"
    assert classify("XRP").symbol == "XRPUSDT"


def test_alpaca_hint_keeps_us_tickers_as_stocks():
    # CL / NG / BTC are real (or plausible) US tickers when the caller is an equity venue
    assert classify("CL", provider_hint="alpaca").asset_class == AssetClass.STOCK
    assert classify("NG", provider_hint="alpaca").asset_class == AssetClass.STOCK
    assert classify("CL").asset_class == AssetClass.COMMODITY


def test_unknown_crypto_is_emerging_not_silently_blessed():
    i = classify("NEWCOINUSDT")
    assert i.asset_class == AssetClass.CRYPTO and i.tier == "emerging" and i.confidence in ("pattern", "heuristic")


@pytest.mark.parametrize("bad", ["", "   ", "ZZZ!!", "A B C D E F G", "???"])
def test_garbage_is_unknown_never_raises(bad):
    assert classify(bad).asset_class == AssetClass.UNKNOWN


def test_catalog_covers_every_requested_market():
    found = {i.asset_class.value for i in list_instruments()}
    assert {"forex", "metal", "crypto", "stock", "index", "commodity"} <= found
    symbols = {i.symbol for i in list_instruments()}
    for required in ("EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "XAUUSD", "XAGUSD", "BTCUSDT",
                     "ETHUSDT", "SOLUSDT", "XRPUSDT", "BNBUSDT", "1000SATSUSDT", "DOGEUSDT", "SPX", "NDX", "DJI", "FTSE100",
                     "DAX", "N225", "WTI", "NATGAS", "CORN"):
        assert required in symbols, required


# ------------------------------------------------------------------ sessions
def test_us_equity_open_close_est_and_edt():
    assert session_status("us_equity", at(2026, 11, 9, 14, 29)).state == "extended"   # 09:29 EST
    s = session_status("us_equity", at(2026, 11, 9, 14, 30))                          # 09:30 EST
    assert s.state == "open" and s.regime == "opening_volatility"
    assert session_status("us_equity", at(2026, 7, 6, 13, 29)).state == "extended"    # 09:29 EDT
    assert session_status("us_equity", at(2026, 7, 6, 13, 30)).state == "open"        # DST shifts the UTC open by 1h
    assert session_status("us_equity", at(2026, 11, 9, 21, 0)).state == "extended"    # 16:00 EST close


def test_us_holiday_weekend_and_early_close():
    thanksgiving = session_status("us_equity", at(2026, 11, 26, 15))
    assert thanksgiving.state == "closed" and thanksgiving.reason == "holiday"
    weekend = session_status("us_equity", at(2026, 11, 7, 15))
    assert weekend.state == "closed" and weekend.reason == "weekend"
    assert session_status("us_equity", at(2026, 11, 27, 17, 59)).state == "open"       # 12:59 ET
    assert session_status("us_equity", at(2026, 11, 27, 18, 1)).state != "open"        # after 13:00 ET early close


def test_forex_weekly_boundaries():
    assert session_status("fx_24x5", at(2026, 11, 6, 21, 59)).state == "open"
    assert session_status("fx_24x5", at(2026, 11, 6, 22, 0)).state == "closed"         # Fri 17:00 ET
    assert session_status("fx_24x5", at(2026, 11, 7, 12)).reason == "weekend"
    assert session_status("fx_24x5", at(2026, 11, 8, 21, 59)).state == "closed"
    assert session_status("fx_24x5", at(2026, 11, 8, 22, 0)).state == "open"           # Sun 17:00 ET


def test_metals_daily_break_and_tokyo_lunch():
    assert session_status("metals_otc", at(2026, 11, 9, 22, 30)).state == "closed"     # 17:30 ET break
    assert session_status("metals_otc", at(2026, 11, 9, 23, 0)).state == "open"
    lunch = session_status("tse", at(2026, 11, 9, 3, 0))                                # 12:00 JST
    assert lunch.state == "closed" and lunch.reason == "intraday_break"
    assert session_status("tse", at(2026, 11, 9, 1, 0)).state == "open"


def test_egypt_trades_sunday_not_friday_and_crypto_always_open():
    assert session_status("egx", at(2026, 11, 8, 9)).state == "open"
    assert session_status("egx", at(2026, 11, 6, 9)).state == "closed"
    s = session_status("crypto_24x7", at(2026, 11, 7, 3))
    assert s.state == "open" and s.regime == "continuous"


def test_holiday_calendar_honesty_and_registration():
    assert session_status("us_equity", at(2028, 1, 5, 15)).holiday_calendar == "not_applied"   # beyond loaded years
    assert session_status("us_equity", at(2027, 1, 5, 15)).holiday_calendar == "applied"        # official 2027 calendar
    assert session_status("jse", at(2026, 11, 9, 9)).schedule_confidence == "approximate"
    register_holidays("test_cal_dummy", {date(2026, 1, 1)})   # registering must not disturb other calendars
    assert session_status("us_equity", at(2026, 11, 26, 15)).reason == "holiday"


# ------------------------------------------------------------------ profiles
def test_risk_posture_orders_by_market_quality():
    major = profile_for(classify("BTCUSDT"))
    meme = profile_for(classify("1000SATSUSDT"))
    new = profile_for(classify("1000SATSUSDT"), listing_age_days=3)
    frontier = profile_for(classify("NGX:DANGCEM"))
    assert major.notional_cap_multiplier > meme.notional_cap_multiplier > new.notional_cap_multiplier
    assert new.key == "crypto.new_listing" and new.liquidity == "very_low"
    assert frontier.liquidity == "very_low" and frontier.risk_multiplier < 0.5
    assert profile_for(classify("BTCUSDT"), listing_age_days=1).key == "crypto.major"   # majors are never "new"
    for p in (major, meme, new, frontier):
        assert p.source == "planning_default"


def test_measured_volume_reclassifies_thin_us_stock():
    assert profile_for(classify("XYZ"), avg_daily_volume_usd=1_000_000).key == "stock.emerging"
    assert profile_for(classify("XYZ"), avg_daily_volume_usd=500_000_000).key == "stock.us_mega"


# ------------------------------------------------------------------ assessment
W = at(2026, 11, 9, 15)  # Monday 15:00 UTC: London + New York open
NO_CREDS = Settings(oanda_api_token=None, oanda_account_id=None, alpaca_api_key=None, alpaca_secret_key=None)
WITH_CREDS = Settings(oanda_api_token="t", oanda_account_id="101-001-0000000-001", alpaca_api_key="k", alpaca_secret_key="s")


def test_forex_sizing_is_capped_and_needs_setup_without_oanda_credentials():
    a = assess("EURUSD", now=W, price=1.085, stop_price=1.08, account_equity=10000, settings=NO_CREDS)
    assert a["verdict"] == "needs_setup" and a["execution"]["executable"] is True
    assert a["execution"]["routes"][0]["provider"] == "oanda" and "OANDA_API_TOKEN" in a["reasons"][0]
    assert a["execution"]["data"]["status"] == "needs_setup"
    z = a["sizing"]
    assert z["notional_usd"] <= 600.0 + 1.1 and z["risk_amount_usd"] <= 100.0 + 1e-6
    assert a["session"]["active_centres"] == ["London", "New York"] and a["session"]["liquidity_factor"] == 1.0


def test_usd_base_pair_converts_quote_currency():
    a = assess("USDJPY", now=W, price=150.0, stop_price=149.0)
    assert a["sizing"]["status"] == "ok" and a["sizing"]["notional_usd"] <= 601


def test_non_usd_quote_requires_rate_instead_of_guessing():
    a = assess("EURGBP", now=W, price=0.87, stop_price=0.865)
    assert a["verdict"] == "blocked" and "quote_to_usd" in a["reasons"][0]
    ok = assess("EURGBP", now=W, price=0.87, stop_price=0.865, quote_to_usd=1.27)
    assert ok["sizing"]["status"] == "ok"


def test_never_exceeds_global_caps_for_any_market():
    for sym, px in [("BTCUSDT", 95000), ("1000SATSUSDT", 0.05), ("XAUUSD", 4000), ("AAPL", 230), ("WTI", 65), ("XAGUSD", 50)]:
        a = assess(sym, now=W, price=px, account_equity=10000, risk_pct=1.0)
        z = a["sizing"]
        assert z["notional_usd"] <= 600.0 + 1e-6, sym
        assert z["risk_amount_usd"] <= 100.0 + 1e-6, sym


def test_riskier_markets_get_smaller_positions():
    n = {s: assess(s, now=W, price=p, account_equity=100000)["sizing"]["notional_usd"]
         for s, p in [("BTCUSDT", 95000), ("1000SATSUSDT", 0.05)]}
    assert n["1000SATSUSDT"] < n["BTCUSDT"]
    new = assess("1000SATSUSDT", now=W, price=0.05, account_equity=100000, listing_age_days=2)
    assert new["sizing"]["notional_usd"] < n["1000SATSUSDT"] and new["verdict"] == "caution"


def test_closed_market_waits_and_weekend_gold_etf_route_is_closed():
    a = assess("AAPL", now=at(2026, 11, 8, 15), price=230.0)
    assert a["verdict"] == "wait_for_session" and "weekend" in a["reasons"][0]
    sunday_night = at(2026, 11, 8, 23)                                           # spot gold trades Sun night; GLD does not
    etf_only = assess("XAUUSD", now=sunday_night, price=4000.0, atr=40, provider="alpaca", settings=WITH_CREDS)
    assert etf_only["session"]["state"] == "open" and etf_only["verdict"] == "wait_for_session"
    assert etf_only["execution"]["routes"][0]["kind"] == "etf_proxy"
    spot = assess("XAUUSD", now=sunday_night, price=4000.0, atr=40, settings=WITH_CREDS)   # OANDA spot route is open
    assert spot["execution"]["routes"][0]["provider"] == "oanda" and spot["verdict"] in ("ready", "caution")


def test_costs_scale_with_session_liquidity_and_measured_spread_wins():
    busy = assess("EURUSD", now=at(2026, 11, 9, 14), price=1.08)["costs"]["spread_bps"]       # London+NY
    quiet = assess("EURUSD", now=at(2026, 11, 9, 22, 30), price=1.08)["costs"]["spread_bps"]  # post-NY, pre-Tokyo
    assert quiet > busy
    m = assess("EURUSD", now=W, price=1.08, measured_spread_bps=0.4)["costs"]
    assert m["spread_bps"] == 0.4 and m["spread_source"] == "measured"


def test_exotic_costs_dwarf_major_costs():
    maj = assess("EURUSD", now=W, price=1.08)["costs"]["round_trip_bps"]
    exo = assess("USDZAR", now=W, price=18.0)["costs"]["round_trip_bps"]
    assert exo > 10 * maj


def test_frontier_stock_flags_and_minimum_size_guidance():
    a = assess("NGX:DANGCEM", now=at(2026, 11, 9, 11), price=800.0, quote_to_usd=0.00065, avg_daily_volume_usd=40000)
    assert a["verdict"] == "analysis_only"
    assert any("limits" in w.lower() or "liquidity" in w.lower() for w in a["warnings"])
    idx = assess("SPX", now=W, price=6900, account_equity=10000)
    assert idx["verdict"] == "blocked" and "minimum_order" in idx["sizing"]
    assert idx["sizing"]["minimum_order"]["equity_for_notional_cap_usd"] > 10000


def test_invalid_inputs_are_rejected_not_sized():
    assert assess("BTCUSDT", now=W, price=95000, stop_price=96000)["verdict"] == "blocked"        # stop above a long
    assert assess("BTCUSDT", now=W, price=95000, side="sell", stop_price=94000)["verdict"] == "blocked"
    assert assess("ZZZ!!", now=W, price=1)["verdict"] == "blocked"


def test_futures_and_options_sizing_use_multipliers():
    es = assess("ESZ6", now=W, price=6900, account_equity=500000)       # one E-mini is ~$345k: correctly too big for $500k
    assert es["instrument"]["contract_multiplier"] == 50.0 and es["sizing"]["quantity"] == 0.0
    assert es["verdict"] == "blocked" and es["sizing"]["minimum_order"]["notional_usd"] == 345000.0
    mes = assess("MESZ6", now=W, price=6900, account_equity=1_000_000)  # micro contract fits
    assert mes["instrument"]["contract_multiplier"] == 5.0 and mes["sizing"]["quantity"] == 1.0
    assert mes["sizing"]["notional_usd"] == 6900 * 5 and mes["execution"]["executable"] is False
    opt = assess("AAPL261218C00200000", now=W, price=12.5, account_equity=100000)
    assert opt["instrument"]["contract_multiplier"] == 100.0 and opt["sizing"]["stop_source"] == "full_premium_at_risk"


# ------------------------------------------------------------------ routing honesty
def test_routes_match_the_adapters_that_exist():
    assert [r["provider"] for r in routes_for(classify("BTCUSDT"))] == ["binance"]
    assert [r["provider"] for r in routes_for(classify("AAPL"))] == ["alpaca"]
    assert routes_for(classify("VOD.L")) == [] and routes_for(classify("ESZ6")) == []
    fx = routes_for(classify("EURUSD"))
    assert [(r["provider"], r["venue_symbol"], r["kind"]) for r in fx] == [("oanda", "EUR_USD", "direct")]
    gold = routes_for(classify("XAUUSD"))
    assert [(r["provider"], r["kind"]) for r in gold] == [("oanda", "direct"), ("alpaca", "etf_proxy")] and gold[1]["symbol"] == "GLD"
    spx, wti = routes_for(classify("SPX")), routes_for(classify("WTI"))
    assert (spx[0]["kind"], spx[0]["venue_symbol"], spx[1]["symbol"]) == ("cfd", "SPX500_USD", "SPY")
    assert (wti[0]["venue_symbol"], wti[1]["symbol"]) == ("WTICO_USD", "USO")
    assert routes_for(classify("COFFEE"))[0]["kind"] == "etf_proxy"                  # OANDA lists no coffee CFD
    assert [r["provider"] for r in routes_for(classify("AAPL261218C00200000"))] == ["alpaca"]
    assert routes_for(classify("GCZ6")) == []   # futures never route to an ETF: contracts != shares


def test_proxy_routes_carry_notional_sizing_not_a_misleading_quantity():
    a = assess("XAUUSD", now=W, price=4000.0, atr=40, provider="alpaca")     # force the ETF to be the primary route
    p = a["sizing"]["proxy_sizing"]
    assert p["symbol"] == "GLD" and p["size_by_notional_usd"] == a["sizing"]["notional_usd"]
    assert "Do not submit the quantity above" in p["instruction"]
    assert "proxy_sizing" not in assess("BTCUSDT", now=W, price=95000, atr=1500)["sizing"]
    # with OANDA as the primary route the quantity is already in underlying units, so no proxy sizing is attached
    assert "proxy_sizing" not in assess("XAUUSD", now=W, price=4000.0, atr=40)["sizing"]


class _FakeMarket:
    async def get_snapshot(self, provider, symbol):
        return {"provider": provider, "symbol": symbol, "price": 100.0, "data_status": "fresh", "ts_utc": W.isoformat()}


@pytest.mark.asyncio
async def test_snapshot_labels_proxies_and_invents_nothing():
    gold = await route_snapshot("XAUUSD", "alpaca", market_service=_FakeMarket())
    assert gold["is_proxy"] is True and gold["symbol"] == "GLD" and "not the underlying" in gold["proxy_notice"]
    spot = await route_snapshot("XAUUSD", market_service=_FakeMarket())
    assert spot["provider"] == "oanda" and "is_proxy" not in spot and spot["price"] == 100.0
    nothing = await route_snapshot("VOD.L", market_service=_FakeMarket())
    assert nothing["price"] is None and nothing["data_status"] == "provider_not_integrated"
    btc = await route_snapshot("BTCUSDT", market_service=_FakeMarket())
    assert btc["provider"] == "binance" and btc["price"] == 100.0 and "is_proxy" not in btc


# ------------------------------------------------------------------ RiskEngine integration
def _settings(**kw):
    base = dict(live_trading_enabled=True, alpaca_paper=False, binance_live_trading_enabled=True, require_live_confirmation=True)
    base.update(kw)
    return Settings(**base)


def _prop(**kw):
    base = dict(provider="binance", environment="paper", symbol="BTCUSDT", side="buy", qty=0.001, equity=10000.0,
                data_age_seconds=5, data_status="fresh", meta={"ref_price": 95000})
    base.update(kw)
    return OrderProposal(**base)


def test_engine_rejects_asset_class_the_provider_cannot_trade():
    d = RiskEngine(_settings()).evaluate(_prop(provider="binance", symbol="AAPL", qty=1, meta={"ref_price": 230}))
    assert not d.approved and any("cannot trade" in r for r in d.reasons)
    d2 = RiskEngine(_settings()).evaluate(_prop(provider="alpaca", symbol="EURUSD", qty=1000, meta={"ref_price": 1.08}))
    assert not d2.approved
    d3 = RiskEngine(_settings()).evaluate(_prop(provider="alpaca", symbol="VOD.L", qty=10, meta={"ref_price": 70}))
    assert not d3.approved


def test_engine_still_approves_the_normal_paths():
    assert RiskEngine(_settings()).evaluate(_prop()).approved
    assert RiskEngine(_settings()).evaluate(_prop(provider="alpaca", symbol="AAPL", qty=2, meta={"ref_price": 230})).approved
    assert RiskEngine(_settings()).evaluate(_prop(provider="alpaca", symbol="GLD", qty=1, meta={"ref_price": 400})).approved


def test_engine_tightens_notional_cap_for_risky_markets_only():
    eng = RiskEngine(_settings())
    # 5.5% of equity: fine for BTC (cap 6%) but over the 3% cap for a meme token (6% x 0.5)
    assert eng.evaluate(_prop(symbol="BTCUSDT", qty=0.005789, meta={"ref_price": 95000})).approved
    d = eng.evaluate(_prop(symbol="1000SATSUSDT", qty=11000, meta={"ref_price": 0.05}))
    assert not d.approved and any("exceeds max 3" in r for r in d.reasons)


def test_engine_tightens_risk_per_trade_for_risky_markets():
    eng = RiskEngine(_settings())
    ok = eng.evaluate(_prop(estimated_risk_amount=100.0))                                 # 1.0% on a major: allowed
    assert ok.approved
    bad = eng.evaluate(_prop(symbol="1000SATSUSDT", qty=100, estimated_risk_amount=100.0, meta={"ref_price": 0.05}))
    assert not bad.approved and any("Risk per trade" in r for r in bad.reasons)


def test_live_order_blocked_when_market_closed_but_paper_only_warns():
    sunday = at(2026, 11, 8, 15)
    review_live = market_risk_review("AAPL", "alpaca", "live", now=sunday)
    review_paper = market_risk_review("AAPL", "alpaca", "paper", now=sunday)
    assert any("closed" in r for r in review_live.blocking_reasons) and review_live.tradeable_now is False
    assert review_paper.blocking_reasons == [] and any("closed" in w for w in review_paper.warnings)
    # crypto never closes, so it is never blocked on session grounds
    assert market_risk_review("BTCUSDT", "binance", "live", now=sunday).blocking_reasons == []


def test_engine_fails_closed_if_market_review_breaks(monkeypatch):
    import app.risk.engine as eng_mod

    def boom(*a, **k):
        raise RuntimeError("market data layer down")

    monkeypatch.setattr(eng_mod, "market_risk_review", boom)
    d = RiskEngine(_settings()).evaluate(_prop())
    assert not d.approved and any("fail-closed" in r for r in d.reasons)


def test_unknown_symbols_do_not_get_hard_blocked_by_classification():
    r = market_risk_review("ZZZ123", "alpaca", "paper")
    assert r.blocking_reasons == [] and r.warnings
    assert market_risk_review("RANDOMTICKER", "alpaca", "paper").blocking_reasons == []   # heuristic US ticker passes


# ------------------------------------------------------------------ API
@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def test_markets_page_renders(client):
    r = client.get("/markets")
    assert r.status_code == 200 and "text/html" in r.headers["content-type"]
    assert "Multi-Market" in r.text and "{{" not in r.text and "{%" not in r.text


def test_overview_lists_every_market_and_clock(client):
    j = client.get("/api/markets/overview").json()
    assert {"forex", "metal", "crypto", "stock", "index", "commodity", "future", "option"} <= set(j["asset_classes"])
    ac = j["asset_classes"]
    assert ac["crypto"]["execution"] and ac["forex"]["execution"] and ac["forex"]["direct_providers"] == ["oanda"]
    assert ac["index"]["cfd_providers"] == ["oanda"] and ac["index"]["etf_proxy_via"] == ["alpaca"]
    assert ac["option"]["direct_providers"] == ["alpaca"] and not ac["future"]["execution"] and ac["future"]["gap"]
    assert ac["stock"]["gap"] and {"us_equity", "fx_24x5", "crypto_24x7", "ngx"} <= set(j["sessions"])
    assert "missing" in ac["forex"]["setup"]["oanda"]


def test_instruments_filter_and_search(client):
    j = client.get("/api/markets/instruments", params={"asset_class": "crypto", "q": "sats"}).json()
    assert j["count"] >= 1 and all(i["asset_class"] == "crypto" for i in j["instruments"])
    assert client.get("/api/markets/instruments", params={"asset_class": "bogus"}).status_code == 422


def test_classify_sessions_profile_assess_endpoints(client):
    assert client.get("/api/markets/classify", params={"symbol": "xau/usd"}).json()["symbol"] == "XAUUSD"
    assert client.get("/api/markets/sessions", params={"symbol": "BTCUSDT"}).json()["state"] == "open"
    assert client.get("/api/markets/sessions", params={"session_id": "nope"}).status_code == 404
    assert client.get("/api/markets/profile", params={"symbol": "SOLUSDT"}).json()["profile"]["key"] == "crypto.large"
    j = client.get("/api/markets/assess", params={"symbol": "BTCUSDT", "price": 95000, "atr": 1500}).json()
    assert j["sizing"]["notional_usd"] <= 600.0 + 1e-6 and j["planning_only"] is True


@pytest.mark.parametrize("params", [
    {"symbol": "ZZZ!!"}, {"symbol": "BTC USDT; DROP"}, {"symbol": "EURUSD", "price": -1}, {"symbol": "EURUSD", "price": "nan"},
    {"symbol": "EURUSD", "price": "inf"}, {"symbol": "EURUSD", "risk_pct": 50}, {"symbol": "EURUSD", "side": "hold"},
    {"symbol": "A" * 200},
])
def test_assess_rejects_bad_input(client, params):
    assert client.get("/api/markets/assess", params=params).status_code == 422


def test_snapshot_for_unintegrated_or_unconfigured_market_is_honest(client):
    j = client.get("/api/markets/snapshot", params={"symbol": "VOD.L"}).json()
    assert j["price"] is None and j["data_status"] == "provider_not_integrated"
    fx = client.get("/api/markets/snapshot", params={"symbol": "EURUSD"}).json()   # OANDA route exists but no credentials here
    assert fx["price"] is None and fx["data_status"] == "unavailable" and fx["error"] == "not_configured"


def test_pretrade_check_exposes_market_context_without_new_client_inputs(monkeypatch):
    import asyncio

    from app.api import pretrade

    class _Market:
        def __init__(self, settings):
            pass

        async def get_snapshot(self, provider, symbol):
            return {"provider": provider, "symbol": symbol, "price": 100.0, "data_status": "fresh",
                    "ts_utc": datetime.now(U).isoformat()}

    class _Activities:
        def __init__(self, db):
            pass

        def list_activities(self, **kwargs):
            return []

    monkeypatch.setattr(pretrade, "MarketService", _Market)
    monkeypatch.setattr(pretrade, "ActivityStore", _Activities)
    req = pretrade.PretradeRequest(provider="binance", environment="paper", symbol="BTCUSDT", side="buy", quantity=0.01)
    result = asyncio.run(pretrade.pretrade_check(req, settings=Settings(paper_starting_equity=10000.0), db=None, _auth=None))
    assert result["market_context"]["asset_class"] == "crypto" and result["market_context"]["tier"] == "major"
    assert "warnings" in result and result["submits_order"] is False
    assert set(pretrade.PretradeRequest.model_fields) == {"provider", "environment", "symbol", "side", "quantity", "order_type", "limit_price"}


# ------------------------------------------------------------------ holiday calendars (data/holidays.json)
def test_calendar_status_reflects_provenance():
    assert session_status("us_equity", at(2026, 11, 9, 15)).holiday_calendar == "applied"        # official
    assert session_status("tse", at(2026, 11, 9, 1)).holiday_calendar == "applied"               # official
    assert session_status("xetra", at(2026, 11, 9, 10)).holiday_calendar == "applied"            # official
    assert session_status("lse", at(2026, 11, 9, 10)).holiday_calendar == "partial"              # secondary
    assert session_status("jse", at(2027, 6, 1, 10)).holiday_calendar == "partial"               # derived
    for sid in ("ngx", "gse", "egx", "nse_ke", "eu_cet"):                                         # no verifiable source: say so
        assert session_status(sid, at(2026, 11, 9, 10)).holiday_calendar == "not_applied", sid


@pytest.mark.parametrize("sid,when,reason", [
    ("us_equity", at(2027, 11, 25, 15), "holiday"), ("us_equity", at(2027, 3, 26, 15), "holiday"),
    ("xetra", at(2026, 12, 24, 10), "holiday"), ("xetra", at(2027, 3, 29, 10), "holiday"),
    ("tse", at(2026, 12, 31, 3), "holiday"), ("tse", at(2027, 3, 22, 1), "holiday"),
    ("jse", at(2026, 8, 10, 10), "holiday"), ("jse", at(2027, 3, 26, 10), "holiday"), ("jse", at(2027, 8, 9, 10), "holiday"),
    ("hkex", at(2026, 2, 18, 3), "holiday"), ("lse", at(2027, 5, 31, 10), "holiday"),
])
def test_new_holidays_close_their_markets(sid, when, reason):
    s = session_status(sid, when)
    assert s.state == "closed" and s.reason == reason


def test_adjacent_days_are_open_and_early_closes_apply():
    assert session_status("xetra", at(2026, 12, 23, 10)).state == "open"
    assert session_status("jse", at(2026, 8, 11, 8)).state == "open"
    assert session_status("us_equity", at(2027, 11, 26, 17, 59)).state == "open"       # 12:59 ET
    assert session_status("us_equity", at(2027, 11, 26, 18, 1)).state == "extended"    # after the 13:00 early close
    assert session_status("lse", at(2027, 12, 24, 12, 29)).state == "open"
    assert session_status("lse", at(2027, 12, 24, 12, 31)).state == "closed"           # 12:30 early close


def test_dax_and_xetra_stocks_use_the_frankfurt_session_not_the_generic_one():
    assert classify("DAX").session_id == "xetra" and classify("SAP.DE").session_id == "xetra"
    assert classify("XETRA:SAP").session_id == "xetra" and classify("CAC40").session_id == "euronext"


def _holiday_file():
    import json
    from pathlib import Path
    import app.markets.sessions as sessions
    return json.loads(Path(sessions._DATA_FILE).read_text(encoding="utf-8"))


def test_holiday_data_integrity():
    raw = _holiday_file()
    assert raw["calendars"]
    for name, cal in raw["calendars"].items():
        assert cal["verification"] in ("official", "secondary", "derived"), name
        assert cal["source"].strip(), f"{name}: every calendar must cite a source"
        years = set(cal["years"])
        dates = [date.fromisoformat(d) for d in cal["holidays"]]
        assert dates == sorted(dates) and len(dates) == len(set(dates)), f"{name}: unsorted or duplicate dates"
        assert {d.year for d in dates} <= years, f"{name}: holiday outside declared years"
        for d, hhmm in cal.get("early_closes", {}).items():
            assert date.fromisoformat(d).year in years and len(hhmm) == 5
        if name != "nyse":                      # exchanges never schedule a full holiday and an early close on the same day
            assert not (set(cal["holidays"]) & set(cal.get("early_closes", {})))


def test_jse_2027_is_consistent_with_easter_from_the_official_nyse_calendar():
    # Good Friday 2027 per NYSE is Mar 26 -> Family Day (Easter Monday) is Mar 29; the rejected aggregator list said Apr 3 / Apr 6.
    cals = _holiday_file()["calendars"]
    nyse_good_friday = next(d for d in cals["nyse"]["holidays"] if d.startswith("2027-03"))
    jse = set(cals["jse_2027"]["holidays"])
    assert nyse_good_friday == "2027-03-26" and "2027-03-26" in jse and "2027-03-29" in jse
    assert "2027-04-03" not in jse and "2027-04-06" not in jse
    assert "2027-08-09" in jse and "2027-12-27" in jse            # Women's Day; Dec 26 is a Sunday so Monday is the holiday
    assert {"2026-08-10"} <= set(cals["jse"]["holidays"])           # Women's Day 2026 (Aug 9 is a Sunday)


def test_easter_based_holidays_agree_across_calendars():
    cals = _holiday_file()["calendars"]
    for y, good_friday in ((2026, "2026-04-03"), (2027, "2027-03-26")):
        for name in ("nyse", "lse", "xetra"):
            assert good_friday in cals[name]["holidays"], (name, y)


def test_malformed_calendar_file_degrades_to_not_applied(tmp_path):
    import app.markets.sessions as sessions
    bad = tmp_path / "h.json"
    bad.write_text("{not json")
    before = {k: set(v) for k, v in sessions._HOLIDAYS.items()}
    sessions._load_calendars(bad)                     # must not raise or corrupt loaded data
    assert {k: set(v) for k, v in sessions._HOLIDAYS.items()} == before
    worse = tmp_path / "w.json"
    worse.write_text('{"calendars": {"x": {"verification": "official", "holidays": ["not-a-date"], "years": [2026]}}}')
    sessions._load_calendars(worse)
    assert "x" not in sessions._HOLIDAYS


def test_calendars_endpoint_reports_coverage_and_gaps(client):
    j = client.get("/api/markets/calendars").json()
    assert {"us_equity", "xetra", "tse", "lse", "jse", "hkex"} <= set(j["covered"])
    assert j["covered"]["us_equity"]["years"] == {"2026": "official", "2027": "official"}
    assert j["covered"]["jse"]["years"] == {"2026": "secondary", "2027": "derived"}
    assert {"ngx", "gse", "egx", "nse_ke", "eu_cet"} <= {m["session_id"] for m in j["missing"]}


# ------------------------------------------------------------------ Euronext / ASX calendars, NGX hours
def test_euronext_official_closures_and_scope():
    assert session_status("euronext", at(2026, 12, 25, 10)).reason == "holiday"
    assert session_status("euronext", at(2027, 3, 26, 10)).reason == "holiday"                    # Good Friday 2027
    assert session_status("euronext", at(2026, 12, 25, 10)).holiday_calendar == "applied"
    assert session_status("euronext", at(2026, 11, 10, 10)).state == "open"
    assert session_status("eu_cet", at(2026, 12, 25, 10)).holiday_calendar == "not_applied"      # Milan/Madrid/SIX: still no calendar
    assert classify("EURONEXT:MC").session_id == "euronext" and classify("MIL:ENI").session_id == "eu_cet"


def test_asx_holidays_and_early_close():
    assert session_status("asx", at(2026, 1, 25, 23)).reason == "holiday"                         # Mon 26 Jan 10:00 AEDT = 23:00Z Sun
    assert session_status("asx", at(2026, 12, 24, 2, 50)).state == "open"                         # 13:50 AEDT, before the 14:10 early close
    assert session_status("asx", at(2026, 12, 24, 3, 20)).state == "closed"                       # 14:20 AEDT
    assert session_status("asx", at(2026, 12, 23, 3, 20)).state == "open"                         # a normal day at the same hour
    assert session_status("asx", at(2027, 12, 27, 0)).reason == "holiday"                         # Christmas substitute


def test_ngx_uses_the_extended_2026_hours():
    assert session_status("ngx", at(2026, 11, 10, 14, 0)).state == "open"                         # 15:00 WAT, closed under the old 14:30 close
    assert session_status("ngx", at(2026, 11, 10, 8, 30)).state == "open"                         # 09:30 WAT
    assert session_status("ngx", at(2026, 11, 10, 16, 30)).state == "closed"
