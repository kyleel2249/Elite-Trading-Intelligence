"""Instrument catalog and symbol classifier.

``classify`` turns any reasonable symbol spelling into an :class:`Instrument`:
``EUR/USD``, ``eurusd``, ``XAUUSD``, ``BTCUSDT``, ``1000SATSUSDT``, ``SPX``, ``VOD.L``,
``NGX:DANGCEM``, ``CLZ6``, ``AAPL261218C00200000`` ...

Classification confidence is explicit. Curated and strictly-patterned matches may drive
risk blocks; ``heuristic`` guesses (an unlisted ticker) never do.
"""
from __future__ import annotations

import re
from typing import Iterable, Optional

from app.markets.types import AssetClass, Instrument

# --------------------------------------------------------------------------- forex
FX_MAJOR_CCY = {"USD", "EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "NZD"}
FX_EXOTIC_CCY = {
    "ZAR", "TRY", "MXN", "NGN", "GHS", "KES", "EGP", "MAD", "BRL", "ARS", "CLP", "COP", "PEN", "PLN", "CZK", "HUF",
    "RON", "SEK", "NOK", "DKK", "SGD", "HKD", "CNH", "CNY", "INR", "IDR", "KRW", "THB", "TWD", "PHP", "MYR", "ILS",
    "SAR", "AED", "QAR", "RUB", "UAH", "ISK", "VND", "PKR", "BDT", "LKR", "TZS", "UGX", "XOF", "XAF", "ZMW", "BWP",
}
FX_ALL_CCY = FX_MAJOR_CCY | FX_EXOTIC_CCY
_FX_MAJOR_PAIRS = {"EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD"}

_FX_PIP = {"JPY": 0.01}

# --------------------------------------------------------------------------- metals
METALS = {
    "XAU": ("Gold", "major", "metal.gold"),
    "XAG": ("Silver", "silver", "metal.silver"),
    "XPT": ("Platinum", "other", "metal.other"),
    "XPD": ("Palladium", "other", "metal.other"),
    "XCU": ("Copper", "industrial", "metal.copper"),
}
METAL_UNITS = {"XCU": "pound"}                               # everything else is quoted per troy ounce
METAL_CODE_ALIASES = {"COPPER": "XCU"}                       # exchange tickers that differ from the ISO-style code
METAL_PROXY_QUALITY = {"XCU": "futures_based"}               # default is "close" (spot-tracking physical-backed fund)
INDUSTRIAL_METALS = {"XCU"}
# Tokenised gold: spot tokens redeemable for physical gold (1 token = 1 troy oz). Trade 24/7 on crypto venues.
GOLD_TOKENS = {"PAXG": "PAX Gold", "XAUT": "Tether Gold"}
# Execution / data proxies reachable through Alpaca (US-listed ETFs). Tracking differs from spot.
METAL_PROXIES = {"XAU": "GLD", "XAG": "SLV", "XPT": "PPLT", "XPD": "PALL", "XCU": "CPER"}

# --------------------------------------------------------------------------- crypto
CRYPTO_QUOTES = ("USDT", "USDC", "FDUSD", "BUSD", "TUSD", "USD", "EUR", "BTC", "ETH", "BNB")
_STABLE_QUOTES = {"USDT", "USDC", "FDUSD", "BUSD", "TUSD"}
STABLECOINS = {"USDT", "USDC", "FDUSD", "BUSD", "TUSD", "DAI", "USDP"}
CRYPTO_MAJOR = {"BTC": "Bitcoin", "ETH": "Ethereum"}
CRYPTO_LARGE = {
    "BNB": "BNB", "SOL": "Solana", "XRP": "XRP", "DOGE": "Dogecoin", "ADA": "Cardano", "TRX": "TRON",
    "AVAX": "Avalanche", "LINK": "Chainlink", "DOT": "Polkadot", "LTC": "Litecoin", "BCH": "Bitcoin Cash",
    "TON": "Toncoin", "XLM": "Stellar", "ATOM": "Cosmos", "NEAR": "NEAR Protocol", "POL": "Polygon",
    "MATIC": "Polygon (legacy)", "ETC": "Ethereum Classic", "APT": "Aptos", "SUI": "Sui", "ARB": "Arbitrum",
    "OP": "Optimism", "FIL": "Filecoin", "HBAR": "Hedera", "ICP": "Internet Computer",
}
CRYPTO_DEFI = {
    "UNI": "Uniswap", "AAVE": "Aave", "MKR": "Maker", "CRV": "Curve", "LDO": "Lido DAO", "SNX": "Synthetix",
    "COMP": "Compound", "SUSHI": "SushiSwap", "1INCH": "1inch", "CAKE": "PancakeSwap", "DYDX": "dYdX",
    "GMX": "GMX", "PENDLE": "Pendle", "JUP": "Jupiter", "RUNE": "THORChain", "ENA": "Ethena", "INJ": "Injective",
}
CRYPTO_MEME = {
    "SHIB": "Shiba Inu", "PEPE": "Pepe", "BONK": "Bonk", "WIF": "dogwifhat", "FLOKI": "Floki", "SATS": "SATS (Ordinals)",
    "MEME": "Memecoin", "TURBO": "Turbo", "BOME": "Book of Meme",
}
CRYPTO_BASE_SKIP = {"USD", "EUR", "GBP", "JPY"}

# --------------------------------------------------------------------------- stocks
US_MEGA = {"AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "GOOG", "META", "TSLA", "AVGO", "BRK.B", "JPM", "V", "LLY", "WMT",
           "XOM", "UNH", "MA", "COST", "ORCL", "NFLX"}
_LIQUID_ETFS = {"SPY", "QQQ", "DIA", "IWM", "VOO", "VTI", "GLD", "TLT", "EEM", "SLV", "USO"}
_US_ETFS = {"SPY", "QQQ", "DIA", "IWM", "VOO", "VTI", "GLD", "SLV", "USO", "UNG", "PPLT", "PALL", "DBA", "EWU", "EWG",
            "EWJ", "EEM", "TLT", "XLE", "XLF", "XLK", "PDBC", "DBC", "WEAT", "CORN", "SOYB", "NIB", "JO", "SGG", "BNO"}

# exchange code -> (session, region, tier, currency)
EXCHANGES: dict[str, tuple[str, str, str, str]] = {
    "US": ("us_equity", "US", "us_standard", "USD"), "NYSE": ("us_equity", "US", "us_standard", "USD"),
    "NASDAQ": ("us_equity", "US", "us_standard", "USD"), "AMEX": ("us_equity", "US", "us_standard", "USD"),
    "ARCA": ("us_equity", "US", "us_standard", "USD"),
    "LSE": ("lse", "UK", "developed", "GBX"),
    "XETRA": ("xetra", "DE", "developed", "EUR"), "EURONEXT": ("euronext", "EU", "developed", "EUR"),
    "MIL": ("eu_cet", "IT", "developed", "EUR"), "BME": ("eu_cet", "ES", "developed", "EUR"),
    "SIX": ("six", "CH", "developed", "CHF"),
    "TSE": ("tse", "JP", "developed", "JPY"), "HKEX": ("hkex", "HK", "developed", "HKD"),
    "SSE": ("sse", "CN", "emerging", "CNY"), "SZSE": ("sse", "CN", "emerging", "CNY"),
    "NSE_IN": ("nse_in", "IN", "emerging", "INR"), "BSE": ("nse_in", "IN", "emerging", "INR"),
    "KRX": ("krx", "KR", "developed", "KRW"), "ASX": ("asx", "AU", "developed", "AUD"),
    "JSE": ("jse", "ZA", "emerging", "ZAR"),
    "NGX": ("ngx", "NG", "frontier", "NGN"), "GSE": ("gse", "GH", "frontier", "GHS"),
    "EGX": ("egx", "EG", "frontier", "EGP"), "NSE_KE": ("nse_ke", "KE", "frontier", "KES"),
}
_EXCHANGE_ALIASES = {"NSEKE": "NSE_KE", "NSE-KE": "NSE_KE", "NAIROBI": "NSE_KE", "NSE": "NSE_IN", "XNYS": "NYSE",
                     "XNAS": "NASDAQ", "LON": "LSE", "FRA": "XETRA", "ETR": "XETRA", "EPA": "EURONEXT", "AMS": "EURONEXT",
                     "TYO": "TSE", "HKG": "HKEX", "SHA": "SSE", "SHE": "SZSE", "JNB": "JSE", "LAG": "NGX", "ACC": "GSE",
                     "CAI": "EGX", "ASX": "ASX"}
_SUFFIX_TO_EXCHANGE = {
    "L": "LSE", "DE": "XETRA", "F": "XETRA", "PA": "EURONEXT", "AS": "EURONEXT", "BR": "EURONEXT", "LS": "EURONEXT",
    "MI": "MIL", "MC": "BME", "SW": "SIX", "T": "TSE", "HK": "HKEX", "SS": "SSE", "SZ": "SZSE", "NS": "NSE_IN",
    "BO": "BSE", "KS": "KRX", "AX": "ASX", "JO": "JSE", "CA": "EGX", "NR": "NSE_KE",
}

# --------------------------------------------------------------------------- indices
# canonical -> (name, region, cash session, profile_key, aliases, ETF proxy or None, proxy_quality)
_INDEX_ROWS = [
    ("SPX", "S&P 500", "US", "us_equity", "index.us", ("SPX500", "US500", "SP500", "^GSPC", "GSPC", "SPX500USD"), "SPY", "close"),
    ("NDX", "NASDAQ 100", "US", "us_equity", "index.us", ("NAS100", "US100", "NASDAQ100", "^NDX", "USTEC"), "QQQ", "close"),
    ("DJI", "Dow Jones Industrial Average", "US", "us_equity", "index.us", ("US30", "DOW", "DJIA", "^DJI", "DOWJONES"), "DIA", "close"),
    ("RUT", "Russell 2000", "US", "us_equity", "index.us", ("US2000", "RUSSELL2000", "^RUT"), "IWM", "close"),
    ("FTSE100", "FTSE 100", "UK", "lse", "index.developed", ("FTSE", "UK100", "^FTSE", "UKX"), "EWU", "approximate"),
    ("DAX", "DAX 40", "DE", "xetra", "index.developed", ("DE40", "GER40", "DE30", "^GDAXI", "GDAXI"), "EWG", "approximate"),
    ("CAC40", "CAC 40", "FR", "euronext", "index.developed", ("FR40", "^FCHI", "FCHI"), None, ""),
    ("STOXX50", "Euro Stoxx 50", "EU", "eu_cet", "index.developed", ("EU50", "SX5E", "ESTX50", "^STOXX50E"), None, ""),
    ("N225", "Nikkei 225", "JP", "tse", "index.developed", ("NIKKEI", "NIKKEI225", "JP225", "^N225"), "EWJ", "approximate"),
    ("HSI", "Hang Seng Index", "HK", "hkex", "index.developed", ("HK50", "HANGSENG", "^HSI"), None, ""),
    ("ASX200", "S&P/ASX 200", "AU", "asx", "index.developed", ("AUS200", "AU200", "^AXJO", "XJO"), None, ""),
    ("NIFTY50", "Nifty 50", "IN", "nse_in", "index.emerging", ("NIFTY", "IN50", "^NSEI"), None, ""),
    ("KOSPI", "KOSPI", "KR", "krx", "index.developed", ("KR200", "^KS11"), None, ""),
    ("TOP40", "FTSE/JSE Top 40", "ZA", "jse", "index.emerging", ("JSETOP40", "SA40", "J200", "ZA40"), None, ""),
]

# --------------------------------------------------------------------------- commodities
# canonical -> (name, tier, profile_key, session, aliases, ETF proxy)
_COMMODITY_ROWS = [
    ("WTI", "WTI crude oil", "crude", "commodity.crude", "cme_globex", ("CL", "USOIL", "CRUDE", "CRUDEOIL", "OIL", "XTIUSD", "WTIUSD"), "USO"),
    ("BRENT", "Brent crude oil", "crude", "commodity.crude", "cme_globex", ("BZ", "UKOIL", "XBRUSD", "BRENTUSD"), "BNO"),
    ("NATGAS", "Henry Hub natural gas", "natgas", "commodity.natgas", "cme_globex", ("NG", "NATURALGAS", "XNGUSD", "NGAS"), "UNG"),
    ("CORN", "Corn", "agri", "commodity.agri", "cme_ags", ("ZC",), "CORN"),
    ("WHEAT", "Wheat", "agri", "commodity.agri", "cme_ags", ("ZW",), "WEAT"),
    ("SOYBEANS", "Soybeans", "agri", "commodity.agri", "cme_ags", ("ZS", "SOY"), "SOYB"),
    ("COFFEE", "Coffee", "softs", "commodity.softs", "ice_softs", ("KC",), "JO"),
    ("SUGAR", "Sugar #11", "softs", "commodity.softs", "ice_softs", ("SB",), "SGG"),
    ("COCOA", "Cocoa", "softs", "commodity.softs", "ice_softs", ("CC",), None),
    ("COTTON", "Cotton #2", "softs", "commodity.softs", "ice_softs", ("CT",), None),
]

# --------------------------------------------------------------------------- futures
_FUT_MONTHS = "FGHJKMNQUVXZ"
# root -> (name, profile_key, session, multiplier, underlying canonical, quote ccy)
_FUT_ROOTS = {
    "ES": ("E-mini S&P 500", "index.us", "cme_globex", 50.0, "SPX"), "MES": ("Micro E-mini S&P 500", "index.us", "cme_globex", 5.0, "SPX"),
    "NQ": ("E-mini Nasdaq-100", "index.us", "cme_globex", 20.0, "NDX"), "MNQ": ("Micro E-mini Nasdaq-100", "index.us", "cme_globex", 2.0, "NDX"),
    "YM": ("E-mini Dow", "index.us", "cme_globex", 5.0, "DJI"), "RTY": ("E-mini Russell 2000", "index.us", "cme_globex", 50.0, "RUT"),
    "CL": ("WTI crude oil", "commodity.crude", "cme_globex", 1000.0, "WTI"), "MCL": ("Micro WTI crude", "commodity.crude", "cme_globex", 100.0, "WTI"),
    "BZ": ("Brent crude", "commodity.crude", "cme_globex", 1000.0, "BRENT"), "NG": ("Henry Hub natural gas", "commodity.natgas", "cme_globex", 10000.0, "NATGAS"),
    "GC": ("Gold", "metal.gold", "cme_globex", 100.0, "XAU"), "MGC": ("Micro gold", "metal.gold", "cme_globex", 10.0, "XAU"),
    "SI": ("Silver", "metal.silver", "cme_globex", 5000.0, "XAG"), "PL": ("Platinum", "metal.other", "cme_globex", 50.0, "XPT"),
    "PA": ("Palladium", "metal.other", "cme_globex", 100.0, "XPD"),
    "ZC": ("Corn", "commodity.agri", "cme_ags", 50.0, "CORN"), "ZW": ("Wheat", "commodity.agri", "cme_ags", 50.0, "WHEAT"),
    "ZS": ("Soybeans", "commodity.agri", "cme_ags", 50.0, "SOYBEANS"),
    "KC": ("Coffee", "commodity.softs", "ice_softs", 375.0, "COFFEE"), "SB": ("Sugar #11", "commodity.softs", "ice_softs", 1120.0, "SUGAR"),
    "CC": ("Cocoa", "commodity.softs", "ice_softs", 10.0, "COCOA"), "CT": ("Cotton", "commodity.softs", "ice_softs", 500.0, "COTTON"),
}
_FUT_RE = re.compile(r"^([A-Z]{1,3})([FGHJKMNQUVXZ])(\d{1,4})$")
_OPT_RE = re.compile(r"^([A-Z]{1,6})(\d{6})([CP])(\d{8})$")

# --------------------------------------------------------------------------- helpers
_NAME_ALIASES = {
    "BITCOIN": "BTCUSDT", "ETHEREUM": "ETHUSDT", "SOLANA": "SOLUSDT", "RIPPLE": "XRPUSDT", "DOGECOIN": "DOGEUSDT",
    "GOLD": "XAUUSD", "SILVER": "XAGUSD", "PLATINUM": "XPTUSD", "PALLADIUM": "XPDUSD", "COPPER": "XCUUSD",
}
_BARE_CRYPTO = {"BTC", "ETH", "SOL", "XRP", "BNB", "DOGE"}
_CLEAN_RE = re.compile(r"[\s_\-]")


def normalize_symbol(raw: str) -> str:
    """Upper-case, trim, and strip separators that vary between sources (EUR/USD, eur_usd)."""
    s = (raw or "").strip().upper()
    if ":" in s:
        ex, tk = s.split(":", 1)
        return f"{ex.strip()}:{_CLEAN_RE.sub('', tk)}"
    return _CLEAN_RE.sub("", s.replace("/", ""))


def _fx_pip_size(quote: str) -> float:
    return _FX_PIP.get(quote, 0.0001)


def _fx_instrument(base: str, quote: str, confidence: str = "pattern") -> Instrument:
    pair = base + quote
    if pair in _FX_MAJOR_PAIRS:
        tier = "major"
    elif base in FX_MAJOR_CCY and quote in FX_MAJOR_CCY:
        tier = "minor"
    else:
        tier = "exotic"
    tags = ("pip_size_" + str(_fx_pip_size(quote)),)
    notes = ("Quoted per unit of base currency; sizing is in units - round to your broker's minimum lot.",)
    if tier == "exotic":
        notes += ("Exotic pair: wide spreads, event/devaluation and convertibility risk.",)
    return Instrument(symbol=pair, asset_class=AssetClass.FOREX, tier=tier, profile_key=f"forex.{tier}", region="global",
                      session_id="fx_24x5", name=f"{base}/{quote}", base=base, quote=quote, tags=tags,
                      confidence=confidence, qty_step=1.0, min_qty=1.0, notes=notes)


def _crypto_instrument(base: str, quote: str, confidence: str, raw_symbol: str) -> Instrument:
    tags: list[str] = []
    stripped = base
    if base.startswith("1000") and len(base) > 4:
        tags.append("x1000_denominated")
        stripped = base[4:]
    name = ""
    if base in STABLECOINS:
        tier, name = "stablecoin", base
        tags.append("stablecoin")
    elif stripped in CRYPTO_MAJOR:
        tier, name = "major", CRYPTO_MAJOR[stripped]
    elif stripped in CRYPTO_MEME:
        tier, name = "meme", CRYPTO_MEME[stripped]
        tags += ["meme", "micro_cap"]
    elif stripped in CRYPTO_DEFI:
        tier, name = "defi", CRYPTO_DEFI[stripped]
        tags.append("defi")
    elif base in GOLD_TOKENS:
        tier, name = "gold_token", GOLD_TOKENS[base]
        tags += ["gold_backed", "commodity_linked"]
    elif stripped in CRYPTO_LARGE:
        tier, name = "large", CRYPTO_LARGE[stripped]
        if stripped == "DOGE":
            tags.append("meme")
        if stripped == "BNB":
            tags.append("exchange_token")
    else:
        tier, name = "emerging", base
        tags.append("unclassified_token")
        confidence = "heuristic" if confidence != "catalog" else confidence
    notes: tuple[str, ...] = ()
    if tier == "gold_token":
        notes = (f"{name} is a token redeemable for physical gold (1 token = 1 troy oz). It trades 24/7, so it can move while OTC spot gold is closed, "
                 "and can trade at a premium or discount to spot; issuer and custody risk apply.",)
    if tier == "emerging":
        notes = ("Token is not in ETI's catalog: treated as emerging/high risk. Pass listing_age_days to flag new listings.",)
    step = 1e-6 if tier in ("major",) else 1e-4 if tier in ("large", "stablecoin", "gold_token") else 1.0 if "x1000_denominated" in tags else 1e-2
    return Instrument(symbol=raw_symbol, asset_class=AssetClass.CRYPTO, tier=tier, profile_key=f"crypto.{tier}", region="global",
                      session_id="crypto_24x7", name=name, base=base, quote=quote, tags=tuple(tags), confidence=confidence,
                      qty_step=step, min_qty=step, notes=notes)


def _metal_lookup(s: str) -> Optional[Instrument]:
    if len(s) == 6 and s[:3] in METALS and s[3:] in FX_ALL_CCY:
        code, quote, contract = s[:3], s[3:], False
    else:
        code = quote = ""
        contract = True
        for q in sorted(_STABLE_QUOTES, key=len, reverse=True):
            if s.endswith(q) and len(s) > len(q):
                c = METAL_CODE_ALIASES.get(s[: -len(q)], s[: -len(q)])
                if c in METALS:
                    code, quote = c, q
                    break
        if not code:
            return None
    name, tier, pkey = METALS[code]
    unit = METAL_UNITS.get(code, "troy ounce")
    proxy = METAL_PROXIES.get(code)
    notes = [f"Spot {name.lower()} quoted per {unit}."]
    if contract:
        notes = [f"{name} contract quoted in {quote} per {unit} (e.g. an exchange perpetual): it follows the metal through the exchange, can quote while OTC spot is closed, "
                 "and is chart/analysis-only in ETI (orders go to OANDA or an ETF proxy)."]
    if proxy:
        quality = METAL_PROXY_QUALITY.get(code, "close")
        notes.append(f"ETF proxy {proxy} ({'tracks spot closely but carries fund fees' if quality == 'close' else 'futures-based: roll yield diverges from spot'}; hours follow US equities).")
    tags = ["industrial_metal" if code in INDUSTRIAL_METALS else "precious_metal"] + (["stablecoin_quoted"] if contract else [])
    return Instrument(symbol=s, asset_class=AssetClass.METAL, tier=tier, profile_key=pkey, region="global", session_id="metals_otc",
                      name=f"{name} ({code}/{quote})", base=code, quote=quote, tags=tuple(tags), confidence="pattern",
                      qty_step=0.01, min_qty=0.01, notes=tuple(notes))


def _split_crypto(s: str) -> Optional[tuple[str, str]]:
    for q in sorted(CRYPTO_QUOTES, key=len, reverse=True):
        if s.endswith(q) and len(s) > len(q):
            base = s[: -len(q)]
            if 2 <= len(base) <= 15 and base not in CRYPTO_BASE_SKIP:
                return base, q
    return None


def _known_crypto_base(base: str) -> bool:
    b = base[4:] if base.startswith("1000") and len(base) > 4 else base
    return any(b in table for table in (CRYPTO_MAJOR, CRYPTO_LARGE, CRYPTO_DEFI, CRYPTO_MEME)) or base in STABLECOINS


def _stock_instrument(ticker: str, exchange: str, confidence: str) -> Instrument:
    session, region, tier, ccy = EXCHANGES[exchange]
    sym = ticker if exchange in ("US", "NYSE", "NASDAQ", "AMEX", "ARCA") else f"{exchange}:{ticker}"
    tags: list[str] = []
    notes: list[str] = []
    if region == "US":
        if ticker in US_MEGA or ticker in _LIQUID_ETFS:
            tier = "us_mega"
        if ticker in _US_ETFS:
            tags.append("etf")
    if ccy == "GBX":
        notes.append("LSE prices are quoted in pence (GBX), not pounds; convert before sizing.")
    if tier == "frontier":
        notes.append("Frontier market: thin books, daily price-move limits and settlement frictions; exit at size may be impossible.")
    if confidence == "heuristic":
        notes.append("Ticker not in the curated catalog: classified by pattern; cost and liquidity are baseline assumptions.")
    return Instrument(symbol=sym, asset_class=AssetClass.STOCK, tier=tier, profile_key=f"stock.{tier}", region=region,
                      session_id=session, name=ticker, quote=ccy, tags=tuple(tags), confidence=confidence,
                      qty_step=1.0, min_qty=1.0, notes=tuple(notes))


def _index_lookup(s: str, aliases_ok: bool = True) -> Optional[Instrument]:
    for canon, name, region, session, pkey, aliases, proxy, pq in _INDEX_ROWS:
        if s == canon or (aliases_ok and s in aliases):
            notes = ["Cash indices are not directly tradable; trade via futures, CFDs or ETFs. Cash hours shown; futures run longer."]
            if proxy:
                notes.append(f"ETF proxy {proxy} ({'close tracking' if pq == 'close' else 'tracks a different/approximate index'}).")
            return Instrument(symbol=canon, asset_class=AssetClass.INDEX, tier=pkey.split(".", 1)[1], profile_key=pkey,
                              region=region, session_id=session, name=name, quote="USD" if region == "US" else None,
                              tags=("cash_index",), confidence="catalog", qty_step=1.0, min_qty=1.0, notes=tuple(notes))
    return None


def _commodity_lookup(s: str, aliases_ok: bool = True) -> Optional[Instrument]:
    for canon, name, tier, pkey, session, aliases, proxy in _COMMODITY_ROWS:
        # Short aliases (CL, NG, ZS ...) collide with real US tickers, so they are ignored for equity-venue callers.
        if s == canon or (aliases_ok and s in aliases):
            notes = ["Futures-based commodity: contango/backwardation and roll costs affect ETF/CFD proxies."]
            if proxy:
                notes.append(f"ETF proxy {proxy} (tracks futures strategy, not spot).")
            return Instrument(symbol=canon, asset_class=AssetClass.COMMODITY, tier=tier, profile_key=pkey, region="global",
                              session_id=session, name=name, quote="USD", tags=("commodity",), confidence="catalog",
                              qty_step=1.0, min_qty=1.0, notes=tuple(notes))
    return None


def _future_lookup(s: str) -> Optional[Instrument]:
    m = _FUT_RE.match(s)
    if not m or m.group(1) not in _FUT_ROOTS:
        return None
    root, month, year = m.groups()
    name, pkey, session, mult, underlying = _FUT_ROOTS[root]
    return Instrument(symbol=s, asset_class=AssetClass.FUTURE, tier=pkey.split(".", 1)[1], profile_key=pkey, region="global",
                      session_id=session, name=f"{name} future ({month}{year})", quote="USD", tags=("future", "margined"),
                      confidence="pattern", qty_step=1.0, min_qty=1.0, contract_multiplier=mult, underlying=underlying,
                      notes=("Leveraged, margined contract with expiry: roll or close before expiry; gap and limit-move risk.",))


def _option_lookup(s: str) -> Optional[Instrument]:
    m = _OPT_RE.match(s)
    if not m:
        return None
    root, yymmdd, cp, strike8 = m.groups()
    return Instrument(symbol=s, asset_class=AssetClass.OPTION, tier="equity", profile_key="option.equity", region="US",
                      session_id="us_equity", name=f"{root} {yymmdd} {'call' if cp == 'C' else 'put'} {int(strike8) / 1000:g}",
                      quote="USD", tags=("option", "call" if cp == "C" else "put"), confidence="pattern", qty_step=1.0,
                      min_qty=1.0, contract_multiplier=100.0, underlying=root,
                      notes=("US equity option (OCC format): 100x multiplier, time decay, wide spreads; long premium is the max loss.",))


def classify(symbol: str, *, provider_hint: Optional[str] = None) -> Instrument:
    """Classify a symbol. Unknown shapes return AssetClass.UNKNOWN (never raises)."""
    s = normalize_symbol(symbol)
    s = _NAME_ALIASES.get(s, s)
    unknown = Instrument(symbol=s or "", asset_class=AssetClass.UNKNOWN, tier="unknown", profile_key="unknown", region="unknown",
                         session_id="", confidence="heuristic", notes=("Symbol could not be classified.",))
    if not s:
        return unknown
    hint = (provider_hint or "").lower()
    aliases_ok = hint != "alpaca"
    if hint != "alpaca" and (s in _BARE_CRYPTO or (s.startswith("1000") and len(s) > 4 and _known_crypto_base(s))):
        s = s + "USDT"

    if ":" in s:
        ex, tk = s.split(":", 1)
        ex = _EXCHANGE_ALIASES.get(ex, ex)
        if ex in EXCHANGES and tk:
            return _stock_instrument(tk, ex, "catalog")
        return unknown

    if (inst := _option_lookup(s)):
        return inst
    if (inst := _future_lookup(s)):
        return inst

    # Metals: XAUUSD, XAGUSD, XAUEUR ... and stablecoin-quoted contracts (XAUUSDT, COPPERUSDT: e.g. Binance perpetuals).
    if (metal := _metal_lookup(s)):
        return metal

    # Forex: both halves must be ISO currencies we know.
    if len(s) == 6 and s[:3] in FX_ALL_CCY and s[3:] in FX_ALL_CCY and s[:3] != s[3:]:
        return _fx_instrument(s[:3], s[3:])

    # Indices & commodities by name (before crypto/stock so "NG", "CL", "DAX" are not mistaken for tickers).
    if (inst := _index_lookup(s, aliases_ok)):
        return inst
    if (inst := _commodity_lookup(s, aliases_ok)):
        return inst

    # Crypto
    split = _split_crypto(s)
    if split:
        base, quote = split
        if _known_crypto_base(base):
            return _crypto_instrument(base, quote, "catalog", s)
        if quote in _STABLE_QUOTES or hint == "binance":
            return _crypto_instrument(base, quote, "pattern" if quote in _STABLE_QUOTES else "heuristic", s)

    # Exchange-suffixed equity: VOD.L, SAP.DE, 7203.T, NPN.JO
    if "." in s:
        tk, suf = s.rsplit(".", 1)
        if suf in _SUFFIX_TO_EXCHANGE and tk:
            return _stock_instrument(tk, _SUFFIX_TO_EXCHANGE[suf], "pattern")
        if re.fullmatch(r"[A-Z]{1,5}\.[AB]", s):  # BRK.B style share class
            return _stock_instrument(s, "US", "catalog" if s in US_MEGA else "heuristic")
        return unknown

    # Bare ticker: US-listed by convention (the Alpaca universe).
    if re.fullmatch(r"[A-Z]{1,5}", s):
        return _stock_instrument(s, "US", "catalog" if (s in US_MEGA or s in _US_ETFS) else "heuristic")
    return unknown


# --------------------------------------------------------------------------- catalog listing
def _catalog() -> list[Instrument]:
    out: list[Instrument] = []
    for p in ("EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD",
              "EURGBP", "EURJPY", "GBPJPY", "EURCHF", "AUDJPY", "EURAUD", "GBPAUD", "AUDNZD", "CADJPY",
              "USDZAR", "USDTRY", "USDMXN", "USDNGN", "USDGHS", "USDKES", "USDSGD", "USDNOK", "USDSEK", "USDPLN"):
        out.append(classify(p))
    for m in METALS:
        out.append(classify(f"{m}USD"))
    for base in list(CRYPTO_MAJOR) + list(CRYPTO_LARGE) + list(CRYPTO_DEFI) + list(CRYPTO_MEME) + ["1000SATS", "1000PEPE", "1000SHIB"]:
        out.append(classify(f"{base}USDT"))
    for t in sorted(US_MEGA):
        out.append(classify(t))
    for row in _INDEX_ROWS:
        out.append(classify(row[0]))
    for row in _COMMODITY_ROWS:
        out.append(classify(row[0]))
    return out


def list_instruments(asset_class: Optional[str] = None, q: Optional[str] = None, tier: Optional[str] = None) -> list[Instrument]:
    items: Iterable[Instrument] = _catalog()
    if asset_class:
        items = [i for i in items if i.asset_class.value == asset_class.lower()]
    if tier:
        items = [i for i in items if i.tier == tier.lower()]
    if q:
        needle = q.strip().upper()
        items = [i for i in items if needle in i.symbol or needle in (i.name or "").upper()]
    return list(items)


def execution_proxy(inst: Instrument) -> Optional[tuple[str, str]]:
    """(ETF symbol, quality) for instruments that have a US-listed ETF stand-in, else None."""
    root = inst.underlying or inst.symbol
    if inst.asset_class == AssetClass.METAL and inst.base in METAL_PROXIES and (inst.quote == "USD" or "stablecoin_quoted" in inst.tags):
        return METAL_PROXIES[inst.base], METAL_PROXY_QUALITY.get(inst.base, "close")
    for canon, _n, _r, _s, _p, _a, proxy, pq in _INDEX_ROWS:
        if proxy and canon == root:
            return proxy, pq or "approximate"
    for canon, _n, _t, _p, _s, _a, proxy in _COMMODITY_ROWS:
        if proxy and canon == root:
            return proxy, "futures_based"
    return None
