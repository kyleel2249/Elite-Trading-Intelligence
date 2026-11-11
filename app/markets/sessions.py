"""Trading-session engine: market hours, DST-correct, with holidays where a calendar exists.

Every market ETI supports has a different clock. Windows are expressed in the
exchange's *local* time zone and converted with ``zoneinfo`` so daylight-saving
changes (US/EU shift on different dates) are handled automatically.

Honest limits (surfaced in every status as ``holiday_calendar`` / ``schedule_confidence``):
  * Holiday calendars live in ``data/holidays.json`` with provenance per year:
    ``applied`` = published by the exchange, ``partial`` = secondary/derived (verify),
    ``not_applied`` = none loaded for that market/year (it may be closed on a public
    holiday this engine does not know about). NGX, GSE, EGX, NSE Kenya and Euronext have
    no verifiable calendar loaded.
  * Schedules marked ``approximate`` (African exchanges, ICE softs, ASX, JSE ...) are
    static reference hours. Verify against the exchange before relying on them.
  * Lunch breaks, auctions and special sessions are modelled only where noted.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional
from zoneinfo import ZoneInfo

UTC = timezone.utc
DAY_END = 1440  # minutes; 24:00 local


def hm(h: int, m: int = 0) -> int:
    return h * 60 + m


@dataclass(frozen=True)
class SessionSpec:
    id: str
    name: str
    tz: str
    windows: tuple = ()                 # (weekday 0=Mon..6=Sun, start_min, end_min) local time
    extended: tuple = ()                # pre/post-market windows, same shape
    always_open: bool = False
    kind: str = "exchange"              # exchange | continuous
    holiday_key: Optional[str] = None
    schedule_confidence: str = "standard"   # standard | approximate
    note: str = ""


def _days(days, start, end):
    return tuple((d, start, end) for d in days)


_MON_FRI = (0, 1, 2, 3, 4)
_SUN_THU = (6, 0, 1, 2, 3)

# Sunday 17:00 ET -> Friday 17:00 ET, continuous (spot FX).
_FX_WINDOWS = ((6, hm(17), DAY_END),) + _days((0, 1, 2, 3), 0, DAY_END) + ((4, 0, hm(17)),)
# Same weekly span with the daily 17:00-18:00 ET maintenance break (spot metals, CME Globex).
_GLOBEX_WINDOWS = (
    ((6, hm(18), DAY_END),)
    + _days((0, 1, 2, 3), 0, hm(17))
    + _days((0, 1, 2, 3), hm(18), DAY_END)
    + ((4, 0, hm(17)),)
)

SESSIONS: dict[str, SessionSpec] = {s.id: s for s in (
    SessionSpec("crypto_24x7", "Crypto (24/7)", "UTC", always_open=True, kind="continuous",
                note="Trades every hour of every day; liquidity thins on weekends and in Asian overnight hours."),
    SessionSpec("fx_24x5", "Spot Forex (Sun 17:00 - Fri 17:00 New York)", "America/New_York",
                windows=_FX_WINDOWS, kind="continuous",
                note="Decentralised; rollover at 17:00 New York. Liquidity follows the Sydney/Tokyo/London/New York centres."),
    SessionSpec("metals_otc", "Spot precious metals (23h/5d, 17:00-18:00 New York break)", "America/New_York",
                windows=_GLOBEX_WINDOWS, kind="continuous",
                note="OTC spot hours; most liquid during London/New York overlap."),
    SessionSpec("cme_globex", "CME Globex (energy, equity-index, metals futures)", "America/New_York",
                windows=_GLOBEX_WINDOWS, kind="continuous", holiday_key=None,
                note="Sun-Fri with a 17:00-18:00 New York daily break. CME holiday schedules are not modelled."),
    SessionSpec("cme_ags", "CBOT agricultural futures (grains)", "America/Chicago",
                windows=((6, hm(19), DAY_END),) + _days(_MON_FRI, 0, hm(7, 45)) + _days(_MON_FRI, hm(8, 30), hm(13, 20))
                + _days((0, 1, 2, 3), hm(19), DAY_END),
                kind="continuous", schedule_confidence="approximate",
                note="Overnight electronic session is thin; the day session (08:30-13:20 Chicago) carries the liquidity."),
    SessionSpec("ice_softs", "ICE US softs (coffee, sugar, cocoa, cotton)", "America/New_York",
                windows=_days(_MON_FRI, hm(4), hm(14)), schedule_confidence="approximate",
                note="Contract-specific hours differ slightly; this is a conservative common window."),
    SessionSpec("us_equity", "US equities (NYSE / Nasdaq)", "America/New_York",
                windows=_days(_MON_FRI, hm(9, 30), hm(16)),
                extended=_days(_MON_FRI, hm(4), hm(9, 30)) + _days(_MON_FRI, hm(16), hm(20)),
                holiday_key="nyse", note="Regular 09:30-16:00 ET; extended 04:00-20:00 ET (thin, wide spreads)."),
    SessionSpec("lse", "London Stock Exchange", "Europe/London",
                windows=_days(_MON_FRI, hm(8), hm(16, 30)), holiday_key="lse"),
    SessionSpec("xetra", "Xetra (Frankfurt)", "Europe/Berlin",
                windows=_days(_MON_FRI, hm(9), hm(17, 30)), holiday_key="xetra"),
    SessionSpec("euronext", "Euronext (Amsterdam, Brussels, Dublin, Lisbon, Paris)", "Europe/Paris",
                windows=_days(_MON_FRI, hm(9), hm(17, 30)), holiday_key="euronext",
                note="Common Euronext closures only. Venue-specific closures and the 24/31 December half days are not modelled."),
    SessionSpec("six", "SIX Swiss Exchange", "Europe/Zurich",
                windows=_days(_MON_FRI, hm(9), hm(17, 30)), holiday_key="six",
                note="Closed days follow SIX's 2026 availability table; 1 Aug (Swiss National Day) is not modelled for 2027."),
    SessionSpec("eu_cet", "Continental Europe (Milan, Madrid)", "Europe/Berlin",
                windows=_days(_MON_FRI, hm(9), hm(17, 30)),
                note="Exchange-specific holidays are not modelled for these venues (Xetra, Euronext and SIX have their own sessions)."),
    SessionSpec("tse", "Tokyo Stock Exchange", "Asia/Tokyo",
                windows=_days(_MON_FRI, hm(9), hm(11, 30)) + _days(_MON_FRI, hm(12, 30), hm(15, 30)),
                holiday_key="tse", note="Lunch break 11:30-12:30 local."),
    SessionSpec("hkex", "Hong Kong Exchange", "Asia/Hong_Kong",
                windows=_days(_MON_FRI, hm(9, 30), hm(12)) + _days(_MON_FRI, hm(13), hm(16)),
                holiday_key="hkex", schedule_confidence="approximate",
                note="Half-day sessions (Christmas Eve, New Year's Eve, Lunar New Year's Eve) are not modelled."),
    SessionSpec("sse", "Shanghai / Shenzhen exchanges", "Asia/Shanghai",
                windows=_days(_MON_FRI, hm(9, 30), hm(11, 30)) + _days(_MON_FRI, hm(13), hm(15)),
                schedule_confidence="approximate"),
    SessionSpec("nse_in", "NSE / BSE India", "Asia/Kolkata",
                windows=_days(_MON_FRI, hm(9, 15), hm(15, 30)), holiday_key="nse_in", schedule_confidence="approximate"),
    SessionSpec("krx", "Korea Exchange", "Asia/Seoul",
                windows=_days(_MON_FRI, hm(9), hm(15, 30)), schedule_confidence="approximate"),
    SessionSpec("asx", "Australian Securities Exchange", "Australia/Sydney",
                windows=_days(_MON_FRI, hm(10), hm(16)), holiday_key="asx", schedule_confidence="approximate",
                note="Normal trading 10:00-16:00 Sydney (closing auction follows); the pre-open and closing auction are not modelled."),
    SessionSpec("jse", "Johannesburg Stock Exchange", "Africa/Johannesburg",
                windows=_days(_MON_FRI, hm(9), hm(17)), holiday_key="jse", schedule_confidence="approximate",
                note="Continuous trading plus closing auction; verify with JSE."),
    SessionSpec("ngx", "Nigerian Exchange (NGX)", "Africa/Lagos",
                windows=_days(_MON_FRI, hm(9), hm(16)), schedule_confidence="approximate",
                note="09:00-16:00 WAT since 27 April 2026 (previously 09:30-14:30), per NGX's announcement. Verify hours, auctions and daily price-move limits with the exchange."),
    SessionSpec("gse", "Ghana Stock Exchange (GSE)", "Africa/Accra",
                windows=_days(_MON_FRI, hm(10), hm(15)), holiday_key="gse", schedule_confidence="approximate",
                note="Verify hours with the exchange."),
    SessionSpec("egx", "Egyptian Exchange (EGX)", "Africa/Cairo",
                windows=_days(_SUN_THU, hm(10), hm(14, 30)), schedule_confidence="approximate",
                note="Trades Sunday-Thursday."),
    SessionSpec("nse_ke", "Nairobi Securities Exchange", "Africa/Nairobi",
                windows=_days(_MON_FRI, hm(9), hm(15)), holiday_key="nse_ke", schedule_confidence="approximate"),
)}

# ---- Holiday calendars (data/holidays.json; extend with register_holidays) ----
_DATA_FILE = Path(__file__).resolve().parent / "data" / "holidays.json"
_HOLIDAYS: dict[str, set[date]] = {}
_EARLY_CLOSES: dict[str, dict[date, int]] = {}
# calendar key -> year -> verification (official | secondary | derived | user)
_CAL_YEARS: dict[str, dict[int, str]] = {}
_CAL_META: dict[str, dict] = {}


def _parse_hhmm(value: str) -> int:
    h, m = value.split(":")
    return hm(int(h), int(m))


def _load_calendars(path: Path = _DATA_FILE) -> None:
    """Load calendars; a malformed file must never take the session engine down (fails to 'not_applied')."""
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return
    for name, cal in (raw.get("calendars") or {}).items():
        try:
            key = cal.get("key", name)
            ver = cal["verification"]
            dates = {date.fromisoformat(d) for d in cal["holidays"]}
            early = {date.fromisoformat(d): _parse_hhmm(v) for d, v in (cal.get("early_closes") or {}).items()}
            years = [int(y) for y in cal["years"]]
        except (KeyError, ValueError, TypeError, AttributeError):
            continue
        _HOLIDAYS.setdefault(key, set()).update(dates)
        _EARLY_CLOSES.setdefault(key, {}).update(early)
        _CAL_YEARS.setdefault(key, {}).update({y: ver for y in years})
        _CAL_META.setdefault(key, {"name": cal.get("name", key), "sources": []})["sources"].append(
            {"years": years, "verification": ver, "source": cal.get("source"), "notes": cal.get("notes")})


_load_calendars()


def register_holidays(key: str, dates, early_closes: Optional[dict] = None) -> None:
    """Add holidays (and optional {date: close_minute} early closes) for a calendar key (treated as user-verified)."""
    dates = set(dates)
    _HOLIDAYS.setdefault(key, set()).update(dates)
    for y in {d.year for d in dates}:
        _CAL_YEARS.setdefault(key, {})[y] = "user"
    if early_closes:
        _EARLY_CLOSES.setdefault(key, {}).update(early_closes)


_VERIFICATION_STATUS = {"official": "applied", "user": "applied", "secondary": "partial", "derived": "partial"}


def holiday_calendar_status(spec: SessionSpec, now: datetime) -> str:
    """applied (official/user) | partial (secondary or derived: verify) | not_applied | not_applicable."""
    if spec.always_open:
        return "not_applicable"
    if not spec.holiday_key:
        return "not_applied"
    ver = _CAL_YEARS.get(spec.holiday_key, {}).get(now.astimezone(ZoneInfo(spec.tz)).year)
    return _VERIFICATION_STATUS.get(ver, "not_applied")


def calendar_info(key: str) -> Optional[dict]:
    """Provenance for a calendar key (sources, years, verification) for the API/dashboard."""
    meta = _CAL_META.get(key)
    if not meta:
        return None
    return {**meta, "years": {str(y): v for y, v in sorted(_CAL_YEARS.get(key, {}).items())}}


def _intervals(spec: SessionSpec, windows: tuple, start_utc: datetime, days: int) -> list[tuple[datetime, datetime]]:
    """Merged UTC intervals for ``windows`` over [start_utc - 1 day, start_utc + days]."""
    tz = ZoneInfo(spec.tz)
    holidays = _HOLIDAYS.get(spec.holiday_key or "", set())
    early = _EARLY_CLOSES.get(spec.holiday_key or "", {})
    first = start_utc.astimezone(tz).date() - timedelta(days=1)
    raw: list[tuple[datetime, datetime]] = []
    for i in range(days + 2):
        d = first + timedelta(days=i)
        if d in holidays:
            continue
        base = datetime(d.year, d.month, d.day, tzinfo=tz)
        for wd, s, e in windows:
            if wd != d.weekday():
                continue
            if d in early:
                cap = early[d]
                if windows is spec.windows:
                    e = min(e, cap)
                elif s >= hm(16):          # post-market shortens to a 17:00 end on early-close days
                    s, e = cap, hm(17)
                if e <= s:
                    continue
            raw.append(((base + timedelta(minutes=s)).astimezone(UTC), (base + timedelta(minutes=e)).astimezone(UTC)))
    raw.sort()
    merged: list[tuple[datetime, datetime]] = []
    for st, en in raw:
        if merged and st <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], en))
        else:
            merged.append((st, en))
    return merged


@dataclass
class SessionStatus:
    session_id: str
    name: str
    state: str                       # open | extended | closed
    regime: str                      # continuous | opening_volatility | regular | closing_flow | extended | closed
    reason: Optional[str]            # why closed: weekend | holiday | outside_hours | intraday_break
    now_utc: str
    local_time: str
    tz: str
    next_open_utc: Optional[str]
    next_close_utc: Optional[str]
    minutes_since_open: Optional[int]
    minutes_to_close: Optional[int]
    holiday_calendar: str
    schedule_confidence: str
    note: str

    @property
    def is_open(self) -> bool:
        return self.state == "open"

    def to_dict(self) -> dict:
        return {k: getattr(self, k) for k in self.__dataclass_fields__} | {"is_open": self.is_open}


def _iso(dt: Optional[datetime]) -> Optional[str]:
    return dt.astimezone(UTC).isoformat() if dt else None


def session_status(session_id: str, now: Optional[datetime] = None) -> SessionStatus:
    spec = SESSIONS[session_id]
    now = (now or datetime.now(UTC)).astimezone(UTC)
    tz = ZoneInfo(spec.tz)
    local = now.astimezone(tz)
    cal = holiday_calendar_status(spec, now)
    common = dict(session_id=spec.id, name=spec.name, now_utc=_iso(now), local_time=local.isoformat(timespec="seconds"),
                  tz=spec.tz, holiday_calendar=cal, schedule_confidence=spec.schedule_confidence, note=spec.note)

    if spec.always_open:
        return SessionStatus(state="open", regime="continuous", reason=None, next_open_utc=None, next_close_utc=None,
                             minutes_since_open=None, minutes_to_close=None, **common)

    regular = _intervals(spec, spec.windows, now, 10)
    current = next(((s, e) for s, e in regular if s <= now < e), None)
    next_open = next((s for s, _ in regular if s > now), None)

    if current:
        since = int((now - current[0]).total_seconds() // 60)
        to_close = int((current[1] - now).total_seconds() // 60)
        if spec.kind == "continuous":
            regime = "continuous"
        elif since <= 30:
            regime = "opening_volatility"
        elif to_close <= 30:
            regime = "closing_flow"
        else:
            regime = "regular"
        return SessionStatus(state="open", regime=regime, reason=None, next_open_utc=_iso(next_open),
                             next_close_utc=_iso(current[1]), minutes_since_open=since, minutes_to_close=to_close, **common)

    if spec.extended:
        ext = _intervals(spec, spec.extended, now, 10)
        if any(s <= now < e for s, e in ext):
            return SessionStatus(state="extended", regime="extended", reason=None, next_open_utc=_iso(next_open),
                                 next_close_utc=None, minutes_since_open=None, minutes_to_close=None, **common)

    local_date = local.date()
    if spec.holiday_key and local_date in _HOLIDAYS.get(spec.holiday_key, set()):
        reason = "holiday"
    elif not any(w[0] == local.weekday() for w in spec.windows) or (
            next_open is not None and (next_open - now) > timedelta(hours=40) and local.weekday() in (4, 5, 6)):
        reason = "weekend"
    elif spec.kind == "exchange" and any(s <= now for s, _ in regular if s.astimezone(tz).date() == local_date) \
            and next_open is not None and next_open.astimezone(tz).date() == local_date:
        reason = "intraday_break"
    else:
        reason = "outside_hours"
    return SessionStatus(state="closed", regime="closed", reason=reason, next_open_utc=_iso(next_open),
                         next_close_utc=None, minutes_since_open=None, minutes_to_close=None, **common)


# ---------------------------------------------------------------------------
# Liquidity by time of day
# ---------------------------------------------------------------------------
_FX_CENTRES = (("Sydney", "Australia/Sydney", 7, 16), ("Tokyo", "Asia/Tokyo", 9, 18),
               ("London", "Europe/London", 8, 17), ("New York", "America/New_York", 8, 17))


def fx_centres_active(now: datetime) -> list[str]:
    now = now.astimezone(UTC)
    out = []
    for name, tzname, start, end in _FX_CENTRES:
        loc = now.astimezone(ZoneInfo(tzname))
        if loc.weekday() < 5 and start <= loc.hour < end:
            out.append(name)
    return out


def liquidity_factor(asset_class: str, status: SessionStatus, now: Optional[datetime] = None) -> tuple[float, dict]:
    """Liquidity multiplier in [0, 1] for the current moment (1.0 = best this market offers) plus context."""
    now = (now or datetime.now(UTC)).astimezone(UTC)
    ctx: dict = {}
    if status.state == "closed":
        return 0.0, ctx
    if status.state == "extended":
        return 0.3, {"note": "extended-hours liquidity is thin; spreads typically several times wider"}

    if asset_class in ("forex", "metal") or status.session_id in ("fx_24x5", "metals_otc"):
        active = fx_centres_active(now)
        ctx["active_centres"] = active
        if "London" in active and "New York" in active:
            return 1.0, ctx
        if "London" in active:
            return 0.8, ctx
        if "New York" in active:
            return 0.75, ctx
        if active:
            return 0.45, ctx
        return 0.25, ctx

    if asset_class == "crypto":
        if now.weekday() >= 5:
            ctx["note"] = "weekend: order books are thinner and moves can gap on low volume"
            return 0.8, ctx
        return (1.0 if 13 <= now.hour < 21 else 0.9), ctx

    if status.session_id == "cme_ags":
        local_hour = datetime.fromisoformat(status.local_time).hour
        if local_hour >= 19 or local_hour < 8:
            ctx["note"] = "overnight electronic session: thin"
            return 0.5, ctx
        return 1.0, ctx

    if status.regime == "opening_volatility":
        ctx["note"] = "first 30 minutes after the open: wide spreads, fast repricing"
        return 0.8, ctx
    if status.regime == "closing_flow":
        ctx["note"] = "final 30 minutes: heavy order flow ahead of the close"
        return 0.9, ctx
    return 1.0, ctx


def spread_multiplier(factor: float) -> Optional[float]:
    """How much wider than the in-session baseline the spread is expected to be."""
    if factor <= 0:
        return None
    return round(min(max(1.0 / factor, 1.0), 8.0), 2)
