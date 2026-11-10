"""ETI multi-market intelligence: forex, metals, crypto, stocks, indices, commodities, futures, options."""
from app.markets.assessment import assess, market_risk_review
from app.markets.profiles import PROFILES, MarketProfile, profile_for
from app.markets.providers import CAPABILITIES, overview, routes_for
from app.markets.registry import classify, list_instruments, normalize_symbol
from app.markets.sessions import SESSIONS, calendar_info, register_holidays, session_status
from app.markets.types import AssetClass, Instrument, MarketReview

__all__ = [
    "AssetClass", "Instrument", "MarketReview", "MarketProfile", "PROFILES", "SESSIONS", "CAPABILITIES",
    "assess", "calendar_info", "classify", "list_instruments", "market_risk_review", "normalize_symbol", "overview",
    "profile_for", "register_holidays", "routes_for", "session_status",
]
