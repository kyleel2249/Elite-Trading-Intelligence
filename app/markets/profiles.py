"""Per-market characteristics: liquidity, volatility, transaction costs and risk posture.

IMPORTANT - what these numbers are:
  They are *planning defaults* (``source="planning_default"``), not measured market data.
  Real spreads, fees and volatility vary by broker, venue, size, time and regime. Whenever
  a live spread / ATR / ADV is available, pass it to ``assess()`` and it overrides the
  default. Replace the defaults with your own broker's schedule for production sizing.

How they are used:
  * ``notional_cap_multiplier`` and ``risk_multiplier`` only ever *tighten* ETI's global
    limits (MAX_POSITION_NOTIONAL_PCT, DEFAULT_RISK_PER_TRADE_PCT); they never loosen them.
  * Costs feed round-trip cost estimates and a cost-vs-risk check on every plan.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from app.markets.types import AssetClass, Instrument


@dataclass(frozen=True)
class MarketProfile:
    key: str
    label: str
    liquidity: str                       # very_high | high | medium | low | very_low
    spread_bps: float                    # full quoted spread, in-session baseline
    commission_bps_per_side: float       # explicit fees / levies per side (planning)
    slippage_bps_per_side: float         # typical market-impact for small size
    daily_vol_pct: float                 # typical absolute daily move (planning)
    stop_vol_mult: float                 # default stop distance = mult x daily_vol x price
    notional_cap_multiplier: float
    risk_multiplier: float
    leverage_hint: str
    gap_risk: str                        # weekend | overnight | limit_moves | event | none
    volatility_notes: tuple[str, ...] = ()
    cost_notes: tuple[str, ...] = ()
    source: str = "planning_default"

    def to_dict(self) -> dict:
        return {
            "key": self.key, "label": self.label, "liquidity": self.liquidity, "spread_bps": self.spread_bps,
            "commission_bps_per_side": self.commission_bps_per_side, "slippage_bps_per_side": self.slippage_bps_per_side,
            "daily_vol_pct": self.daily_vol_pct, "stop_vol_mult": self.stop_vol_mult,
            "notional_cap_multiplier": self.notional_cap_multiplier, "risk_multiplier": self.risk_multiplier,
            "leverage_hint": self.leverage_hint, "gap_risk": self.gap_risk,
            "volatility_notes": list(self.volatility_notes), "cost_notes": list(self.cost_notes), "source": self.source,
        }


def _p(key, label, liq, spread, comm, slip, vol, stop, ncap, rmult, lev, gap, vnotes=(), cnotes=()) -> MarketProfile:
    return MarketProfile(key, label, liq, spread, comm, slip, vol, stop, ncap, rmult, lev, gap, tuple(vnotes), tuple(cnotes))


_FX_VOL = ("Volatility concentrates around central-bank decisions and major US data (NFP, CPI).",
           "Liquidity peaks in the London/New York overlap and is thinnest around the 17:00 New York rollover.")
_FX_COST = ("Cost is mostly spread (plus overnight swap when holding past rollover).",)
_CRYPTO_VOL = ("Trades 24/7: weekend and Asian-overnight books are thinner and gap more easily.",
               "Large liquidation cascades and funding-rate resets can move prices sharply.")
_CRYPTO_COST = ("Exchange taker fee (default tier ~0.10%) dominates cost on liquid pairs; spread dominates on small caps.",)
_EQ_VOL = ("Largest moves cluster in the first and last 30 minutes and around earnings releases.",
           "Overnight gaps are not protected by stop orders.")

PROFILES: dict[str, MarketProfile] = {p.key: p for p in (
    # ---- Forex
    _p("forex.major", "Forex major", "very_high", 1.0, 0.0, 0.3, 0.55, 0.8, 1.0, 1.0, "regulator/broker dependent (e.g. up to 30:1 retail EU)", "weekend", _FX_VOL, _FX_COST),
    _p("forex.minor", "Forex minor / cross", "high", 2.5, 0.0, 0.6, 0.65, 0.8, 0.9, 0.9, "regulator/broker dependent", "weekend", _FX_VOL, _FX_COST),
    _p("forex.exotic", "Forex exotic", "low", 18.0, 0.0, 4.0, 1.0, 0.8, 0.5, 0.6, "lower than majors (e.g. 20:1)", "event",
       _FX_VOL + ("Exotics can gap on policy moves, devaluations and capital-control changes.",),
       _FX_COST + ("Wide spreads and high swap/carry costs; liquidity can vanish around events.",)),
    # ---- Precious metals
    _p("metal.gold", "Gold (XAU)", "very_high", 2.5, 0.0, 0.8, 1.1, 0.8, 1.0, 1.0, "regulator/broker dependent (e.g. 20:1)", "weekend",
       ("Reacts to real yields, USD strength, geopolitical risk and central-bank buying.", "Most liquid in the London/New York overlap.")),
    _p("metal.silver", "Silver (XAG)", "high", 8.0, 0.0, 2.5, 1.9, 0.8, 0.75, 0.8, "lower than gold", "weekend",
       ("Roughly 1.5-2x gold's volatility; industrial demand adds growth sensitivity.",)),
    _p("metal.other", "Platinum / palladium", "low", 25.0, 0.0, 8.0, 2.2, 0.8, 0.5, 0.6, "lower than gold", "event",
       ("Thin markets; supply shocks and auto-sector demand drive sharp moves.",)),
    # ---- Crypto
    _p("crypto.major", "Crypto major (BTC, ETH)", "very_high", 1.0, 10.0, 1.5, 2.8, 1.0, 1.0, 1.0, "spot only in ETI", "none", _CRYPTO_VOL, _CRYPTO_COST),
    _p("crypto.large", "Crypto large cap", "high", 3.0, 10.0, 4.0, 4.0, 1.0, 0.75, 0.85, "spot only in ETI", "none", _CRYPTO_VOL, _CRYPTO_COST),
    _p("crypto.defi", "DeFi token", "medium", 8.0, 10.0, 10.0, 5.5, 1.0, 0.5, 0.6, "spot only in ETI", "event",
       _CRYPTO_VOL + ("Protocol exploits, governance votes and token unlocks cause abrupt repricing.",), _CRYPTO_COST),
    _p("crypto.meme", "Meme / micro-cap token", "medium", 10.0, 10.0, 12.0, 6.5, 1.0, 0.5, 0.6, "spot only in ETI", "event",
       _CRYPTO_VOL + ("Sentiment-driven; very large intraday swings and thin depth beyond the top of the book.",), _CRYPTO_COST),
    _p("crypto.emerging", "Emerging / unlisted-in-catalog token", "low", 25.0, 10.0, 25.0, 8.0, 1.0, 0.35, 0.4, "spot only in ETI", "event",
       _CRYPTO_VOL + ("Unvetted token: rug-pull, delisting and manipulation risk is materially higher.",), _CRYPTO_COST),
    _p("crypto.new_listing", "Newly listed token", "very_low", 60.0, 10.0, 60.0, 14.0, 1.0, 0.2, 0.25, "spot only in ETI", "event",
       _CRYPTO_VOL + ("First days after listing: price discovery, extreme volatility, spreads that can be 1%+.",), _CRYPTO_COST),
    _p("crypto.stablecoin", "Stablecoin pair", "high", 0.5, 10.0, 0.5, 0.1, 1.0, 1.0, 1.0, "spot only in ETI", "event",
       ("Depeg risk is the real risk; day-to-day volatility is tiny.",), _CRYPTO_COST),
    # ---- Stocks
    _p("stock.us_mega", "US mega-cap / liquid ETF", "very_high", 1.0, 0.0, 1.0, 1.6, 1.0, 1.0, 1.0, "cash account (unleveraged)", "overnight", _EQ_VOL,
       ("Zero-commission brokers still incur small regulatory fees on sells and wider spreads in extended hours.",)),
    _p("stock.us_standard", "US listed stock (unrated depth)", "high", 4.0, 0.0, 3.0, 2.2, 1.0, 0.8, 0.85, "cash account (unleveraged)", "overnight", _EQ_VOL,
       ("Depth is assumed, not measured: pass avg_daily_volume_usd to size against real liquidity.",)),
    _p("stock.developed", "Developed-market stock (EU/UK/JP/AU/HK/KR)", "high", 6.0, 5.0, 4.0, 1.7, 1.0, 0.8, 0.85, "broker dependent", "overnight",
       _EQ_VOL + ("Local-currency FX exposure is added to equity risk.",), ("Stamp duty / transaction taxes apply in some markets (e.g. UK).",)),
    _p("stock.emerging", "Emerging-market stock (ZA/IN/CN)", "medium", 15.0, 10.0, 10.0, 2.0, 1.0, 0.6, 0.7, "broker dependent", "overnight",
       _EQ_VOL + ("Local-currency and capital-flow risk; some markets restrict foreign access.",)),
    _p("stock.frontier", "Frontier-market stock (NG/GH/KE/EG)", "very_low", 100.0, 80.0, 40.0, 2.2, 1.0, 0.3, 0.4, "none / cash", "limit_moves",
       ("Daily price-move limits can freeze trading; thin books mean exits at size may be impossible.",
        "Currency devaluation and repatriation rules can erase local-currency gains."),
       ("Brokerage plus exchange/SEC levies are a large fixed drag on every round trip (planning default - use your broker's schedule).",)),
    # ---- Indices (traded via futures / CFD / ETF)
    _p("index.us", "US equity index", "very_high", 1.0, 0.0, 0.8, 1.1, 1.0, 1.0, 1.0, "futures/CFD margined or ETF unleveraged", "overnight", _EQ_VOL),
    _p("index.developed", "Developed-market index", "high", 2.0, 0.0, 1.5, 1.2, 1.0, 1.0, 1.0, "futures/CFD margined or ETF", "overnight", _EQ_VOL),
    _p("index.emerging", "Emerging-market index", "medium", 4.0, 0.0, 3.0, 1.5, 1.0, 0.8, 0.8, "futures/CFD margined", "overnight", _EQ_VOL),
    # ---- Commodities
    _p("commodity.crude", "Crude oil", "very_high", 3.0, 0.0, 2.0, 2.2, 1.0, 1.0, 0.9, "futures margined", "event",
       ("Weekly EIA inventory (Wednesdays), OPEC+ decisions and geopolitical headlines drive gaps.",),
       ("ETF/CFD proxies suffer roll decay in contango.",)),
    _p("commodity.natgas", "Natural gas", "high", 8.0, 0.0, 6.0, 3.8, 1.0, 0.6, 0.6, "futures margined", "event",
       ("Very weather- and storage-sensitive (EIA storage report, Thursdays); frequent violent spikes.",),
       ("Steep contango makes long-only ETF proxies bleed over time.",)),
    _p("commodity.agri", "Agricultural (grains)", "high", 6.0, 0.0, 4.0, 1.6, 1.0, 0.8, 0.8, "futures margined", "limit_moves",
       ("USDA reports (WASDE, crop progress) and weather drive moves; exchange daily limits can lock the market.",)),
    _p("commodity.softs", "Agricultural (softs)", "medium", 10.0, 0.0, 8.0, 2.2, 1.0, 0.6, 0.7, "futures margined", "limit_moves",
       ("Weather, crop disease and FX (BRL) drive moves; thinner than grains.",)),
    # ---- Options
    _p("option.equity", "US equity option", "medium", 250.0, 5.0, 100.0, 4.0, 1.0, 0.3, 0.5, "premium paid (defined risk when long)", "overnight",
       ("Time decay accelerates into expiry; implied volatility crush after events.",),
       ("Spreads are quoted on premium and are often several percent wide.",)),
)}

_UNKNOWN = MarketProfile("unknown", "Unclassified", "low", 20.0, 10.0, 10.0, 3.0, 1.0, 1.0, 1.0, "n/a", "event")

# A crypto token listed fewer than this many days ago is treated as a new listing.
NEW_LISTING_DAYS = 30


def profile_for(inst: Instrument, *, listing_age_days: Optional[float] = None,
                avg_daily_volume_usd: Optional[float] = None) -> MarketProfile:
    """Profile for an instrument, refined with listing age (crypto) or measured volume (stocks/crypto)."""
    key = inst.profile_key
    if inst.asset_class == AssetClass.CRYPTO and listing_age_days is not None and listing_age_days < NEW_LISTING_DAYS \
            and inst.tier not in ("major", "stablecoin"):
        key = "crypto.new_listing"
    elif inst.asset_class == AssetClass.STOCK and avg_daily_volume_usd is not None and inst.tier in ("us_standard", "us_mega"):
        if avg_daily_volume_usd >= 50_000_000:
            key = "stock.us_mega"
        elif avg_daily_volume_usd >= 5_000_000:
            key = "stock.us_standard"
        else:
            key = "stock.emerging"          # thin US name: treat with emerging-market caution
    return PROFILES.get(key, _UNKNOWN)
