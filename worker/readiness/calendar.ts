// Deterministic market-clock rules for the ETI Market Readiness Engine.
// Everything here is computed from published rules (time zones, DST law, exchange holiday rules) with no network access,
// so it can never be "stale". Rule-derived holiday lists can still differ from an exchange's one-off announcements
// (special closures, unscheduled bank holidays); callers surface that caveat. Tokyo public holidays are NOT built in.

export type Zone = "UTC" | "America/New_York" | "Europe/London" | "Asia/Tokyo" | "Australia/Sydney";
export const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;

/** Day-of-month of the nth (1-based) or last (n = -1) given weekday (0 = Sunday) of a month (month is 0-based). */
export function nthDow(year: number, month: number, dow: number, n: number): number {
  if (n > 0) { const first = new Date(Date.UTC(year, month, 1)).getUTCDay(); return 1 + ((dow - first + 7) % 7) + (n - 1) * 7; }
  const last = new Date(Date.UTC(year, month + 1, 0)), lastDow = last.getUTCDay();
  return last.getUTCDate() - ((lastDow - dow + 7) % 7);
}

/** UTC offset in minutes for the zone at an instant, from each region's DST law (no Intl dependency, so it is fast and identical everywhere). */
export function utcOffsetMinutes(zone: Zone, ms: number): number {
  const y = new Date(ms).getUTCFullYear();
  switch (zone) {
    case "UTC": return 0;
    case "Asia/Tokyo": return 540;
    case "America/New_York": { // second Sunday of March 02:00 local standard -> first Sunday of November 02:00 local daylight
      const start = Date.UTC(y, 2, nthDow(y, 2, 0, 2), 7), end = Date.UTC(y, 10, nthDow(y, 10, 0, 1), 6);
      return ms >= start && ms < end ? -240 : -300;
    }
    case "Europe/London": { // last Sunday of March 01:00 UTC -> last Sunday of October 01:00 UTC
      const start = Date.UTC(y, 2, nthDow(y, 2, 0, -1), 1), end = Date.UTC(y, 9, nthDow(y, 9, 0, -1), 1);
      return ms >= start && ms < end ? 60 : 0;
    }
    case "Australia/Sydney": { // DST from first Sunday of October until first Sunday of April (both switch at 16:00 UTC the Saturday before)
      const endDst = Date.UTC(y, 3, nthDow(y, 3, 0, 1) - 1, 16), startDst = Date.UTC(y, 9, nthDow(y, 9, 0, 1) - 1, 16);
      return ms < endDst || ms >= startDst ? 660 : 600;
    }
  }
}

export interface LocalTime { y: number; m: number; d: number; dow: number; min: number; key: string; offset: number }
export function localTime(zone: Zone, ms: number): LocalTime {
  const offset = utcOffsetMinutes(zone, ms), d = new Date(ms + offset * MIN);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes(), key: d.toISOString().slice(0, 10), offset };
}
export const fmtClock = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// ------------------------------------------------------------------ holidays
const ymd = (y: number, m0: number, d: number) => new Date(Date.UTC(y, m0, d)).toISOString().slice(0, 10);
const dowOf = (y: number, m0: number, d: number) => new Date(Date.UTC(y, m0, d)).getUTCDay();
/** Western Easter Sunday as [month0, day] (anonymous Gregorian algorithm). */
export function easterSunday(y: number): [number, number] {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  return [Math.floor((h + l - 7 * m + 114) / 31) - 1, ((h + l - 7 * m + 114) % 31) + 1];
}
export interface Closure { date: string; name: string; kind: "closed" | "early_close"; closeLocalMinutes?: number }
/** US observance: Saturday -> preceding Friday (unless disabled), Sunday -> following Monday. */
function observedUS(y: number, m0: number, d: number, satToFri = true): string | null {
  const dow = dowOf(y, m0, d);
  if (dow === 6) return satToFri ? ymd(y, m0, d - 1) : null;
  if (dow === 0) return ymd(y, m0, d + 1);
  return ymd(y, m0, d);
}
const cache = new Map<string, Closure[]>();
const memo = (k: string, f: () => Closure[]) => { let v = cache.get(k); if (!v) { v = f(); cache.set(k, v); } return v; };

/** NYSE / Nasdaq regular holiday and early-close rules. Early closes are 13:00 ET. */
export function nyseCalendar(y: number): Closure[] {
  return memo("NYSE" + y, () => {
    const out: Closure[] = [], add = (date: string | null, name: string) => { if (date) out.push({ date, name, kind: "closed" }); };
    add(observedUS(y, 0, 1, false), "New Year's Day");
    add(ymd(y, 0, nthDow(y, 0, 1, 3)), "Martin Luther King Jr. Day");
    add(ymd(y, 1, nthDow(y, 1, 1, 3)), "Washington's Birthday");
    const [em, ed] = easterSunday(y); add(ymd(y, em, ed - 2), "Good Friday");
    add(ymd(y, 4, nthDow(y, 4, 1, -1)), "Memorial Day");
    if (y >= 2022) add(observedUS(y, 5, 19), "Juneteenth");
    add(observedUS(y, 6, 4), "Independence Day");
    add(ymd(y, 8, nthDow(y, 8, 1, 1)), "Labor Day");
    const tg = nthDow(y, 10, 4, 4); add(ymd(y, 10, tg), "Thanksgiving Day");
    add(observedUS(y, 11, 25), "Christmas Day");
    const closed = new Set(out.map(c => c.date)), early = (date: string, name: string) => { if (!closed.has(date)) out.push({ date, name, kind: "early_close", closeLocalMinutes: 13 * 60 }); };
    early(ymd(y, 10, tg + 1), "Day after Thanksgiving (early close)");
    if (dowOf(y, 6, 3) >= 1 && dowOf(y, 6, 3) <= 4) early(ymd(y, 6, 3), "Day before Independence Day (early close)");
    if (dowOf(y, 11, 24) >= 1 && dowOf(y, 11, 24) <= 5) early(ymd(y, 11, 24), "Christmas Eve (early close)");
    return out.sort((a, b) => a.date.localeCompare(b.date));
  });
}
/** London Stock Exchange regular bank-holiday rules with England substitute days. Special one-off bank holidays cannot be derived. */
export function lseCalendar(y: number): Closure[] {
  return memo("LSE" + y, () => {
    const out: Closure[] = [], taken = new Set<string>();
    const place = (m0: number, d: number, name: string, substitute: boolean) => {
      let t = Date.UTC(y, m0, d);
      while (substitute && (new Date(t).getUTCDay() === 0 || new Date(t).getUTCDay() === 6 || taken.has(new Date(t).toISOString().slice(0, 10)))) t += DAY;
      const date = new Date(t).toISOString().slice(0, 10); taken.add(date); out.push({ date, name, kind: "closed" });
    };
    const [em, ed] = easterSunday(y);
    place(0, 1, "New Year's Day", true); place(em, ed - 2, "Good Friday", false); place(em, ed + 1, "Easter Monday", false);
    place(4, nthDow(y, 4, 1, 1), "Early May bank holiday", false); place(4, nthDow(y, 4, 1, -1), "Spring bank holiday", false); place(7, nthDow(y, 7, 1, -1), "Summer bank holiday", false);
    place(11, 25, "Christmas Day", true); place(11, 26, "Boxing Day", true);
    for (const d of [24, 31]) { const date = ymd(y, 11, d), w = dowOf(y, 11, d); if (w >= 1 && w <= 5 && !taken.has(date)) out.push({ date, name: d === 24 ? "Christmas Eve (early close)" : "New Year's Eve (early close)", kind: "early_close", closeLocalMinutes: 12 * 60 + 30 }); }
    return out.sort((a, b) => a.date.localeCompare(b.date));
  });
}
/** Additional US federal bank holidays that close the US bond/bank system (and thin USD liquidity) while equities trade. */
export function usBankExtras(y: number): Closure[] {
  return memo("USBANK" + y, () => [
    { date: ymd(y, 9, nthDow(y, 9, 1, 2)), name: "Columbus / Indigenous Peoples' Day (US bank holiday)", kind: "closed" as const },
    { date: observedUS(y, 10, 11) as string, name: "Veterans Day (US bank holiday)", kind: "closed" as const },
  ]);
}

// ------------------------------------------------------------------ exchanges
export type Exchange = "NYSE" | "LSE" | "TSE";
const EXCHANGES: Record<Exchange, { zone: Zone; name: string; segments: [number, number][]; cal: ((y: number) => Closure[]) | null }> = {
  NYSE: { zone: "America/New_York", name: "NYSE / Nasdaq", segments: [[570, 960]], cal: nyseCalendar },
  LSE: { zone: "Europe/London", name: "London Stock Exchange", segments: [[480, 990]], cal: lseCalendar },
  TSE: { zone: "Asia/Tokyo", name: "Tokyo Stock Exchange", segments: [[540, 690], [750, 930]], cal: null },
};
export interface ExchangeStatus { exchange: Exchange; name: string; open: boolean; reason: string; closure: Closure | null; holidaysKnown: boolean }
export function exchangeStatus(ex: Exchange, ms: number): ExchangeStatus {
  const spec = EXCHANGES[ex], lt = localTime(spec.zone, ms), closure = spec.cal ? spec.cal(lt.y).find(c => c.date === lt.key) ?? null : null;
  const base = { exchange: ex, name: spec.name, closure, holidaysKnown: !!spec.cal };
  if (lt.dow === 0 || lt.dow === 6) return { ...base, open: false, reason: "Weekend" };
  if (closure?.kind === "closed") return { ...base, open: false, reason: `Closed: ${closure.name}` };
  const segs = spec.segments.map(([a, b], i) => (closure?.kind === "early_close" && i === spec.segments.length - 1 ? [a, Math.min(b, closure.closeLocalMinutes!)] : [a, b]) as [number, number]);
  const inside = segs.some(([a, b]) => lt.min >= a && lt.min < b);
  return { ...base, open: inside, reason: inside ? (closure ? `Open (${closure.name})` : "Open") : lt.min < segs[0][0] ? "Before the open" : lt.min >= segs.at(-1)![1] ? "After the close" : "Midday break" };
}

// ------------------------------------------------------------------ forex week
/** The interbank FX week runs from Sunday 17:00 to Friday 17:00 New York time. */
export function fxOpen(ms: number): { open: boolean; reason: string } {
  const lt = localTime("America/New_York", ms);
  if (lt.dow === 6) return { open: false, reason: "Weekend: interbank FX is closed (Fri 17:00 to Sun 17:00 New York time)" };
  if (lt.dow === 0 && lt.min < 17 * 60) return { open: false, reason: "Weekend: FX reopens Sunday 17:00 New York time" };
  if (lt.dow === 5 && lt.min >= 17 * 60) return { open: false, reason: "Weekend: FX closed since Friday 17:00 New York time" };
  return { open: true, reason: "FX week open" };
}

/** Calendar-day liquidity flags that matter for FX and crypto even when markets are technically open. */
export function holidayFlags(ms: number): string[] {
  const flags: string[] = [], ny = localTime("America/New_York", ms), ld = localTime("Europe/London", ms);
  const us = [...nyseCalendar(ny.y), ...usBankExtras(ny.y)].find(c => c.date === ny.key && c.kind === "closed");
  if (us && ny.dow >= 1 && ny.dow <= 5) flags.push(`US holiday (${us.name}): USD liquidity is typically thin`);
  const uk = lseCalendar(ld.y).find(c => c.date === ld.key && c.kind === "closed");
  if (uk && ld.dow >= 1 && ld.dow <= 5) flags.push(`UK bank holiday (${uk.name}): GBP and EUR-hours liquidity is typically thin`);
  const u = new Date(ms), md = (u.getUTCMonth() + 1) * 100 + u.getUTCDate();
  if (md >= 1224 || md <= 102) flags.push("Year-end period (24 Dec to 2 Jan): participation is typically thin and gaps are more likely");
  return flags;
}

// ------------------------------------------------------------------ sessions
export type SessionId = "sydney" | "asian" | "london" | "new_york" | "london_ny_overlap";
export const SESSION_IDS: SessionId[] = ["sydney", "asian", "london", "new_york", "london_ny_overlap"];
export const SESSION_DEFS: Record<Exclude<SessionId, "london_ny_overlap">, { label: string; zone: Zone; start: number; end: number }> = {
  sydney: { label: "Sydney session", zone: "Australia/Sydney", start: 7 * 60, end: 16 * 60 },
  asian: { label: "Asian session (Tokyo)", zone: "Asia/Tokyo", start: 9 * 60, end: 18 * 60 },
  london: { label: "London session", zone: "Europe/London", start: 8 * 60, end: 17 * 60 },
  new_york: { label: "New York session", zone: "America/New_York", start: 8 * 60, end: 17 * 60 },
};
export const sessionLabel = (id: SessionId) => (id === "london_ny_overlap" ? "London/New York overlap" : SESSION_DEFS[id].label);
export type MarketKind = "crypto" | "forex" | "equities";

/** Whether a named trading session is active. Crypto trades every day; sessions are still weekday constructs unless anyDay is set. */
export function sessionActive(id: SessionId, ms: number, anyDay = false): boolean {
  if (id === "london_ny_overlap") return sessionActive("london", ms, anyDay) && sessionActive("new_york", ms, anyDay);
  const d = SESSION_DEFS[id], lt = localTime(d.zone, ms);
  return (anyDay || (lt.dow >= 1 && lt.dow <= 5)) && lt.min >= d.start && lt.min < d.end;
}
/** Session activity in the context of a market: FX sessions also need the FX week to be open; crypto sessions follow the clock. */
export function sessionActiveFor(market: MarketKind, id: SessionId, ms: number): boolean {
  if (market === "forex") return fxOpen(ms).open && sessionActive(id, ms);
  return sessionActive(id, ms, market === "crypto");
}
/** First instant (30-minute resolution, all transitions fall on :00 or :30) at which the predicate changes from its value at `ms`. */
export function nextChange(pred: (t: number) => boolean, ms: number, stepMin = 30, maxDays = 9, coarseMin = 0): { at: number; becomes: boolean } | null {
  const now = pred(ms), step = stepMin * MIN, limit = ms + maxDays * DAY;
  let from = Math.floor(ms / step) * step + step;
  if (coarseMin > 0) { // coarse scan then fine refinement; only valid when the predicate cannot flip twice inside one coarse block (e.g. the FX weekend)
    const c = coarseMin * MIN; let t = Math.floor(ms / c) * c + c;
    while (t <= limit && pred(t) === now) t += c;
    if (t > limit) return null;
    from = Math.max(from, t - c);
  }
  for (let t = from; t <= limit; t += step) if (pred(t) !== now) return { at: t, becomes: !now };
  return null;
}
/** Window of the session: the current instance when active, otherwise the next one. */
export function sessionWindow(market: MarketKind, id: SessionId, ms: number): { active: boolean; start: number; end: number } | null {
  const pred = (t: number) => sessionActiveFor(market, id, t), active = pred(ms);
  if (active) { let s = Math.floor(ms / (30 * MIN)) * (30 * MIN); while (pred(s - 30 * MIN) && ms - s < DAY) s -= 30 * MIN; const e = nextChange(pred, ms); return e ? { active, start: s, end: e.at } : null; }
  const open = nextChange(pred, ms); if (!open) return null;
  const close = nextChange(pred, open.at); return close ? { active, start: open.at, end: close.at } : null;
}

/** Structural (schedule-based, NOT measured) fit of a currency pair to a session, from where each currency's home market trades. */
const HOME: Record<string, SessionId[]> = { JPY: ["asian"], AUD: ["sydney", "asian"], NZD: ["sydney", "asian"], CNH: ["asian"], SGD: ["asian"], HKD: ["asian"], EUR: ["london"], GBP: ["london"], CHF: ["london"], SEK: ["london"], NOK: ["london"], PLN: ["london"], ZAR: ["london"], TRY: ["london"], USD: ["new_york"], CAD: ["new_york"], MXN: ["new_york"] };
export const FX_CURRENCIES = Object.keys(HOME);
export function structuralSessionFit(pair: string, id: SessionId): "primary" | "partial" | "weak" {
  const sess: SessionId[] = id === "london_ny_overlap" ? ["london", "new_york"] : [id];
  const hits = [pair.slice(0, 3), pair.slice(3, 6)].filter(c => (HOME[c] ?? []).some(h => sess.includes(h))).length;
  return hits === 2 ? "primary" : hits === 1 ? "partial" : "weak";
}
