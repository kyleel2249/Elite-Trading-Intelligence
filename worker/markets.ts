/**
 * ETI multi-market intelligence for the Cloudflare Worker.
 *
 * A faithful TypeScript port of the Python layer in app/markets (classifier, DST-correct session engine,
 * per-market profiles, routing, sizing, assessment, per-order risk review). Data tables come from
 * worker/markets.generated.json, exported from Python by scripts/export_markets.py, and worker/markets.golden.json
 * holds Python-computed results this port must reproduce exactly (see markets-intel.test.ts).
 *
 * Scope: deterministic planning logic only. The Worker has NO OANDA/Alpaca adapter, so these routes never fetch a
 * price and never place an order; `execution.routes[].setup.configured` reflects whether the matching secrets exist
 * in the Worker environment, not that a broker integration is present here. Live quotes and calibration remain in the
 * Python service.
 */
import generated from "./markets.generated.json" with { type: "json" };

export interface MarketsSettings {
  oanda_api_token?: string | null; oanda_account_id?: string | null;
  alpaca_api_key?: string | null; alpaca_secret_key?: string | null;
  binance_api_key?: string | null; binance_secret_key?: string | null;
}
export type Json = any;

const G = generated as Json;
const REG = G.registry;
const SESSIONS: Record<string, Json> = G.sessions;
const PROFILES: Record<string, Json> = G.profiles;
const CAPS: Record<string, Json> = G.capabilities;
const set = (a: string[]) => new Set<string>(a);
const FX_MAJOR_CCY = set(REG.fx_major_ccy), FX_ALL_CCY = set(REG.fx_all_ccy), FX_MAJOR_PAIRS = set(REG.fx_major_pairs);
const STABLE_QUOTES = set(REG.stable_quotes), STABLECOINS = set(REG.stablecoins), CRYPTO_BASE_SKIP = set(REG.crypto_base_skip);
const US_MEGA = set(REG.us_mega), LIQUID_ETFS = set(REG.liquid_etfs), US_ETFS = set(REG.us_etfs), BARE_CRYPTO = set(REG.bare_crypto);
const EXCHANGES: Record<string, string[]> = REG.exchanges;
const USD_LIKE = new Set(["USD", "USDT", "USDC", "FDUSD", "BUSD", "TUSD"]);
const COST_TO_RISK_WARN = 0.25;
const NEW_LISTING_DAYS = 30;

// ------------------------------------------------------------------ Python-compatible formatting
const pyRound = (x: number, n: number) => Number(x.toFixed(n));
function fmtG(x: number, p = 6): string {            // Python's format spec "g"
  if (x === 0) return "0";
  const ex = x.toExponential(p - 1);
  const exp = parseInt(ex.split("e")[1], 10);
  if (exp < -4 || exp >= p) {
    const [m0, e0] = ex.split("e");
    const m = m0.includes(".") ? m0.replace(/0+$/, "").replace(/\.$/, "") : m0;
    return `${m}e${e0[0] === "-" ? "-" : "+"}${e0.replace(/[+-]/, "").padStart(2, "0")}`;
  }
  const s = x.toFixed(Math.max(0, p - 1 - exp));
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
const pct0 = (ratio: number) => {                      // Python "{:.0%}": exact ties round half to even
  const v = ratio * 100, f = Math.floor(v);
  return `${v - f === 0.5 ? (f % 2 === 0 ? f : f + 1) : Math.round(v)}%`;
};
const comma0 = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 0 });
const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function pyRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  return q + s.replace(/\\/g, "\\\\").split(q).join("\\" + q) + q;
}
function isoUtc(ms: number): string {                // Python datetime.isoformat() for a UTC datetime
  const d = new Date(ms);
  const frac = ms % 1000 ? "." + pad(d.getUTCMilliseconds(), 3) + "000" : "";
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${frac}+00:00`;
}

// ------------------------------------------------------------------ time zones
const fmtCache = new Map<string, Intl.DateTimeFormat>();
interface Local { y: number; mo: number; d: number; h: number; mi: number; s: number }
function localParts(ms: number, tz: string): Local {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    fmtCache.set(tz, f);
  }
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second };
}
function offsetMin(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000) / 60000);
}
const wallToUtc = (y: number, mo: number, d: number, minutes: number, tz: string): number => {
  const wall = Date.UTC(y, mo - 1, d) + minutes * 60000;
  return wall - offsetMin(wall - offsetMin(wall, tz) * 60000, tz) * 60000;
};
const weekdayOf = (y: number, mo: number, d: number) => (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7;   // Monday = 0
const dateKey = (y: number, mo: number, d: number) => `${y}-${pad(mo)}-${pad(d)}`;
const addDays = (y: number, mo: number, d: number, n: number) => { const t = new Date(Date.UTC(y, mo - 1, d + n)); return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }; };
function localIso(ms: number, tz: string): string {
  const p = localParts(ms, tz), off = offsetMin(ms, tz), a = Math.abs(off);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${off < 0 ? "-" : "+"}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// ------------------------------------------------------------------ holiday calendars
const HOLIDAYS = new Map<string, Set<string>>();
const EARLY = new Map<string, Map<string, number>>();
const CAL_YEARS = new Map<string, Map<number, string>>();
const CAL_META = new Map<string, { name: string; sources: Json[] }>();
const parseHHMM = (v: string) => { const [h, m] = v.split(":"); return +h * 60 + +m; };
(function loadCalendars() {
  for (const [name, cal] of Object.entries<Json>(G.holidays_file?.calendars ?? {})) {
    try {
      const key = cal.key ?? name, ver = cal.verification;
      if (!ver || !Array.isArray(cal.holidays) || !Array.isArray(cal.years)) continue;
      const hs = HOLIDAYS.get(key) ?? new Set<string>(); for (const d of cal.holidays) hs.add(String(d)); HOLIDAYS.set(key, hs);
      const em = EARLY.get(key) ?? new Map<string, number>(); for (const [d, v] of Object.entries<string>(cal.early_closes ?? {})) em.set(d, parseHHMM(v)); EARLY.set(key, em);
      const cy = CAL_YEARS.get(key) ?? new Map<number, string>(); for (const y of cal.years) cy.set(Number(y), ver); CAL_YEARS.set(key, cy);
      const meta = CAL_META.get(key) ?? { name: cal.name ?? key, sources: [] };
      meta.sources.push({ years: cal.years.map(Number), verification: ver, source: cal.source ?? null, notes: cal.notes ?? null });
      CAL_META.set(key, meta);
    } catch { /* a malformed entry must never take the session engine down */ }
  }
})();
const VERIFICATION_STATUS: Record<string, string> = { official: "applied", user: "applied", secondary: "partial", derived: "partial" };
function holidayCalendarStatus(spec: Json, nowMs: number): string {
  if (spec.always_open) return "not_applicable";
  if (!spec.holiday_key) return "not_applied";
  const ver = CAL_YEARS.get(spec.holiday_key)?.get(localParts(nowMs, spec.tz).y);
  return (ver && VERIFICATION_STATUS[ver]) || "not_applied";
}
export function calendarInfo(key: string): Json | null {
  const m = CAL_META.get(key);
  if (!m) return null;
  const years: Record<string, string> = {};
  for (const y of [...(CAL_YEARS.get(key)?.keys() ?? [])].sort((a, b) => a - b)) years[String(y)] = CAL_YEARS.get(key)!.get(y)!;
  return { ...m, years };
}
export const calendarKeys = () => [...CAL_META.keys()].sort();

// ------------------------------------------------------------------ session engine
type Interval = [number, number];
function intervals(spec: Json, windows: number[][], isRegular: boolean, startMs: number, days: number): Interval[] {
  const hols = HOLIDAYS.get(spec.holiday_key ?? "") ?? new Set<string>();
  const early = EARLY.get(spec.holiday_key ?? "") ?? new Map<string, number>();
  const lp = localParts(startMs, spec.tz);
  const first = addDays(lp.y, lp.mo, lp.d, -1);
  const raw: Interval[] = [];
  for (let i = 0; i < days + 2; i++) {
    const d = addDays(first.y, first.mo, first.d, i), key = dateKey(d.y, d.mo, d.d);
    if (hols.has(key)) continue;
    const wd = weekdayOf(d.y, d.mo, d.d);
    for (const w of windows) {
      if (w[0] !== wd) continue;
      let s = w[1], e = w[2];
      if (early.has(key)) {
        const cap = early.get(key)!;
        if (isRegular) e = Math.min(e, cap);
        else if (s >= 16 * 60) { s = cap; e = 17 * 60; }
        if (e <= s) continue;
      }
      raw.push([wallToUtc(d.y, d.mo, d.d, s, spec.tz), wallToUtc(d.y, d.mo, d.d, e, spec.tz)]);
    }
  }
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Interval[] = [];
  for (const [st, en] of raw) {
    const last = merged[merged.length - 1];
    if (last && st <= last[1]) last[1] = Math.max(last[1], en); else merged.push([st, en]);
  }
  return merged;
}

export interface SessionStatus {
  session_id: string; name: string; state: string; regime: string; reason: string | null; now_utc: string; local_time: string; tz: string;
  next_open_utc: string | null; next_close_utc: string | null; minutes_since_open: number | null; minutes_to_close: number | null;
  holiday_calendar: string; schedule_confidence: string; note: string; is_open: boolean;
}
export const sessionIds = () => Object.keys(SESSIONS);
export function sessionStatus(sessionId: string, nowMs: number = Date.now()): SessionStatus {
  const spec = SESSIONS[sessionId];
  if (!spec) throw new Error(`unknown session ${sessionId}`);
  nowMs = Math.floor(nowMs);
  const local = localParts(nowMs, spec.tz);
  const common = { session_id: spec.id, name: spec.name, now_utc: isoUtc(nowMs), local_time: localIso(nowMs, spec.tz), tz: spec.tz,
                   holiday_calendar: holidayCalendarStatus(spec, nowMs), schedule_confidence: spec.schedule_confidence, note: spec.note };
  const mk = (state: string, regime: string, reason: string | null, no: number | null, nc: number | null, since: number | null, toClose: number | null): SessionStatus =>
    ({ ...common, state, regime, reason, next_open_utc: no === null ? null : isoUtc(no), next_close_utc: nc === null ? null : isoUtc(nc),
       minutes_since_open: since, minutes_to_close: toClose, is_open: state === "open" });
  if (spec.always_open) return mk("open", "continuous", null, null, null, null, null);

  const regular = intervals(spec, spec.windows, true, nowMs, 10);
  const current = regular.find(([s, e]) => s <= nowMs && nowMs < e);
  const nextOpen = regular.find(([s]) => s > nowMs)?.[0] ?? null;
  if (current) {
    const since = Math.floor((nowMs - current[0]) / 60000), toClose = Math.floor((current[1] - nowMs) / 60000);
    const regime = spec.kind === "continuous" ? "continuous" : since <= 30 ? "opening_volatility" : toClose <= 30 ? "closing_flow" : "regular";
    return mk("open", regime, null, nextOpen, current[1], since, toClose);
  }
  if (spec.extended.length) {
    const ext = intervals(spec, spec.extended, false, nowMs, 10);
    if (ext.some(([s, e]) => s <= nowMs && nowMs < e)) return mk("extended", "extended", null, nextOpen, null, null, null);
  }
  const localKey = dateKey(local.y, local.mo, local.d), wd = weekdayOf(local.y, local.mo, local.d);
  let reason: string;
  const sameLocalDate = (ms: number) => { const p = localParts(ms, spec.tz); return dateKey(p.y, p.mo, p.d) === localKey; };
  if (spec.holiday_key && (HOLIDAYS.get(spec.holiday_key)?.has(localKey))) reason = "holiday";
  else if (!spec.windows.some((w: number[]) => w[0] === wd) || (nextOpen !== null && nextOpen - nowMs > 40 * 3600000 && [4, 5, 6].includes(wd))) reason = "weekend";
  else if (spec.kind === "exchange" && regular.some(([s]) => s <= nowMs && sameLocalDate(s)) && nextOpen !== null && sameLocalDate(nextOpen)) reason = "intraday_break";
  else reason = "outside_hours";
  return mk("closed", "closed", reason, nextOpen, null, null, null);
}

const FX_CENTRES: [string, string, number, number][] = [["Sydney", "Australia/Sydney", 7, 16], ["Tokyo", "Asia/Tokyo", 9, 18], ["London", "Europe/London", 8, 17], ["New York", "America/New_York", 8, 17]];
function fxCentresActive(nowMs: number): string[] {
  const out: string[] = [];
  for (const [name, tz, start, end] of FX_CENTRES) {
    const p = localParts(nowMs, tz);
    if (weekdayOf(p.y, p.mo, p.d) < 5 && start <= p.h && p.h < end) out.push(name);
  }
  return out;
}
export function liquidityFactor(assetClass: string, st: SessionStatus, nowMs: number): [number, Json] {
  if (st.state === "closed") return [0.0, {}];
  if (st.state === "extended") return [0.3, { note: "extended-hours liquidity is thin; spreads typically several times wider" }];
  if (assetClass === "forex" || assetClass === "metal" || st.session_id === "fx_24x5" || st.session_id === "metals_otc") {
    const active = fxCentresActive(nowMs), ctx = { active_centres: active };
    if (active.includes("London") && active.includes("New York")) return [1.0, ctx];
    if (active.includes("London")) return [0.8, ctx];
    if (active.includes("New York")) return [0.75, ctx];
    return [active.length ? 0.45 : 0.25, ctx];
  }
  if (assetClass === "crypto") {
    const d = new Date(nowMs), wd = (d.getUTCDay() + 6) % 7;
    if (wd >= 5) return [0.8, { note: "weekend: order books are thinner and moves can gap on low volume" }];
    return [d.getUTCHours() >= 13 && d.getUTCHours() < 21 ? 1.0 : 0.9, {}];
  }
  if (st.session_id === "cme_ags") {
    const h = localParts(nowMs, SESSIONS.cme_ags.tz).h;
    if (h >= 19 || h < 8) return [0.5, { note: "overnight electronic session: thin" }];
    return [1.0, {}];
  }
  if (st.regime === "opening_volatility") return [0.8, { note: "first 30 minutes after the open: wide spreads, fast repricing" }];
  if (st.regime === "closing_flow") return [0.9, { note: "final 30 minutes: heavy order flow ahead of the close" }];
  return [1.0, {}];
}
export const spreadMultiplier = (f: number): number | null => f <= 0 ? null : pyRound(Math.min(Math.max(1 / f, 1), 8), 2);

// ------------------------------------------------------------------ classifier
export type Instrument = Json;
const norm = (s: string) => s.replace(/[\s_\-]/g, "");
export function normalizeSymbol(raw: string): string {
  const s = (raw ?? "").trim().toUpperCase();
  const i = s.indexOf(":");
  if (i >= 0) return `${s.slice(0, i).trim()}:${norm(s.slice(i + 1))}`;
  return norm(s.replace(/\//g, ""));
}
const inst = (o: Json): Instrument => ({ base: null, quote: null, name: "", tags: [], classification_confidence: "catalog", qty_step: 1.0, min_qty: 1.0,
                                         contract_multiplier: 1.0, underlying: null, notes: [], ...o });
const UNKNOWN = (s: string): Instrument => inst({ symbol: s, asset_class: "unknown", tier: "unknown", profile_key: "unknown", region: "unknown", session_id: "",
                                                  classification_confidence: "heuristic", notes: ["Symbol could not be classified."] });
const knownCryptoBase = (b: string) => {
  const x = b.startsWith("1000") && b.length > 4 ? b.slice(4) : b;
  return [REG.crypto_major, REG.crypto_large, REG.crypto_defi, REG.crypto_meme].some((t) => x in t) || STABLECOINS.has(b);
};
function splitCrypto(s: string): [string, string] | null {
  for (const q of [...REG.crypto_quotes].sort((a: string, b: string) => b.length - a.length)) {
    if (s.endsWith(q) && s.length > q.length) {
      const base = s.slice(0, -q.length);
      if (base.length >= 2 && base.length <= 15 && !CRYPTO_BASE_SKIP.has(base)) return [base, q];
    }
  }
  return null;
}
function stockInstrument(ticker: string, exchange: string, confidence: string): Instrument {
  let [session, region, tier, ccy] = EXCHANGES[exchange];
  const sym = ["US", "NYSE", "NASDAQ", "AMEX", "ARCA"].includes(exchange) ? ticker : `${exchange}:${ticker}`;
  const tags: string[] = [], notes: string[] = [];
  if (region === "US") {
    if (US_MEGA.has(ticker) || LIQUID_ETFS.has(ticker)) tier = "us_mega";
    if (US_ETFS.has(ticker)) tags.push("etf");
  }
  if (ccy === "GBX") notes.push("LSE prices are quoted in pence (GBX), not pounds; convert before sizing.");
  if (tier === "frontier") notes.push("Frontier market: thin books, daily price-move limits and settlement frictions; exit at size may be impossible.");
  if (confidence === "heuristic") notes.push("Ticker not in the curated catalog: classified by pattern; cost and liquidity are baseline assumptions.");
  return inst({ symbol: sym, asset_class: "stock", tier, profile_key: `stock.${tier}`, region, session_id: session, name: ticker, quote: ccy, tags, classification_confidence: confidence, notes });
}
function indexLookup(s: string, aliasesOk: boolean): Instrument | null {
  for (const [canon, name, region, session, pkey, aliases, proxy, pq] of REG.index_rows) {
    if (s === canon || (aliasesOk && aliases.includes(s))) {
      const notes = ["Cash indices are not directly tradable; trade via futures, CFDs or ETFs. Cash hours shown; futures run longer."];
      if (proxy) notes.push(`ETF proxy ${proxy} (${pq === "close" ? "close tracking" : "tracks a different/approximate index"}).`);
      return inst({ symbol: canon, asset_class: "index", tier: pkey.split(".")[1], profile_key: pkey, region, session_id: session, name,
                    quote: region === "US" ? "USD" : null, tags: ["cash_index"], notes });
    }
  }
  return null;
}
function commodityLookup(s: string, aliasesOk: boolean): Instrument | null {
  for (const [canon, name, tier, pkey, session, aliases, proxy] of REG.commodity_rows) {
    if (s === canon || (aliasesOk && aliases.includes(s))) {
      const notes = ["Futures-based commodity: contango/backwardation and roll costs affect ETF/CFD proxies."];
      if (proxy) notes.push(`ETF proxy ${proxy} (tracks futures strategy, not spot).`);
      return inst({ symbol: canon, asset_class: "commodity", tier, profile_key: pkey, region: "global", session_id: session, name, quote: "USD", tags: ["commodity"], notes });
    }
  }
  return null;
}
function futureLookup(s: string): Instrument | null {
  const m = /^([A-Z]{1,3})([FGHJKMNQUVXZ])(\d{1,4})$/.exec(s);
  if (!m || !(m[1] in REG.fut_roots)) return null;
  const [name, pkey, session, mult, underlying] = REG.fut_roots[m[1]];
  return inst({ symbol: s, asset_class: "future", tier: pkey.split(".")[1], profile_key: pkey, region: "global", session_id: session,
                name: `${name} future (${m[2]}${m[3]})`, quote: "USD", tags: ["future", "margined"], classification_confidence: "pattern",
                contract_multiplier: mult, underlying,
                notes: ["Leveraged, margined contract with expiry: roll or close before expiry; gap and limit-move risk."] });
}
function optionLookup(s: string): Instrument | null {
  const m = /^([A-Z]{1,6})(\d{6})([CP])(\d{8})$/.exec(s);
  if (!m) return null;
  return inst({ symbol: s, asset_class: "option", tier: "equity", profile_key: "option.equity", region: "US", session_id: "us_equity",
                name: `${m[1]} ${m[2]} ${m[3] === "C" ? "call" : "put"} ${fmtG(parseInt(m[4], 10) / 1000)}`, quote: "USD",
                tags: ["option", m[3] === "C" ? "call" : "put"], classification_confidence: "pattern", contract_multiplier: 100.0, underlying: m[1],
                notes: ["US equity option (OCC format): 100x multiplier, time decay, wide spreads; long premium is the max loss."] });
}
function fxInstrument(base: string, quote: string): Instrument {
  const pair = base + quote;
  const tier = FX_MAJOR_PAIRS.has(pair) ? "major" : FX_MAJOR_CCY.has(base) && FX_MAJOR_CCY.has(quote) ? "minor" : "exotic";
  const pip = REG.fx_pip[quote] ?? 0.0001;
  const notes = ["Quoted per unit of base currency; sizing is in units - round to your broker's minimum lot."];
  if (tier === "exotic") notes.push("Exotic pair: wide spreads, event/devaluation and convertibility risk.");
  return inst({ symbol: pair, asset_class: "forex", tier, profile_key: `forex.${tier}`, region: "global", session_id: "fx_24x5", name: `${base}/${quote}`, base, quote,
                tags: ["pip_size_" + String(pip)], classification_confidence: "pattern", notes });
}
function cryptoInstrument(base: string, quote: string, confidence: string, raw: string): Instrument {
  const tags: string[] = [];
  let stripped = base, tier: string, name = "";
  if (base.startsWith("1000") && base.length > 4) { tags.push("x1000_denominated"); stripped = base.slice(4); }
  if (STABLECOINS.has(base)) { tier = "stablecoin"; name = base; tags.push("stablecoin"); }
  else if (stripped in REG.crypto_major) { tier = "major"; name = REG.crypto_major[stripped]; }
  else if (stripped in REG.crypto_meme) { tier = "meme"; name = REG.crypto_meme[stripped]; tags.push("meme", "micro_cap"); }
  else if (stripped in REG.crypto_defi) { tier = "defi"; name = REG.crypto_defi[stripped]; tags.push("defi"); }
  else if (stripped in REG.crypto_large) {
    tier = "large"; name = REG.crypto_large[stripped];
    if (stripped === "DOGE") tags.push("meme");
    if (stripped === "BNB") tags.push("exchange_token");
  } else { tier = "emerging"; name = base; tags.push("unclassified_token"); if (confidence !== "catalog") confidence = "heuristic"; }
  const notes = tier === "emerging" ? ["Token is not in ETI's catalog: treated as emerging/high risk. Pass listing_age_days to flag new listings."] : [];
  const step = tier === "major" ? 1e-6 : tier === "large" || tier === "stablecoin" ? 1e-4 : tags.includes("x1000_denominated") ? 1.0 : 1e-2;
  return inst({ symbol: raw, asset_class: "crypto", tier, profile_key: `crypto.${tier}`, region: "global", session_id: "crypto_24x7", name, base, quote,
                tags, classification_confidence: confidence, qty_step: step, min_qty: step, notes });
}
export function classify(symbol: string, providerHint?: string | null): Instrument {
  let s = normalizeSymbol(symbol);
  s = REG.name_aliases[s] ?? s;
  if (!s) return UNKNOWN("");
  const hint = (providerHint ?? "").toLowerCase(), aliasesOk = hint !== "alpaca";
  if (hint !== "alpaca" && (BARE_CRYPTO.has(s) || (s.startsWith("1000") && s.length > 4 && knownCryptoBase(s)))) s += "USDT";
  if (s.includes(":")) {
    const i = s.indexOf(":");
    let ex = s.slice(0, i); const tk = s.slice(i + 1);
    ex = REG.exchange_aliases[ex] ?? ex;
    return ex in EXCHANGES && tk ? stockInstrument(tk, ex, "catalog") : UNKNOWN(s);
  }
  let r: Instrument | null;
  if ((r = optionLookup(s))) return r;
  if ((r = futureLookup(s))) return r;
  if (s.length === 6 && s.slice(0, 3) in REG.metals && FX_ALL_CCY.has(s.slice(3))) {
    const [name, tier, pkey] = REG.metals[s.slice(0, 3)], proxy = REG.metal_proxies[s.slice(0, 3)];
    const notes = [`Spot ${name.toLowerCase()} quoted per troy ounce.`];
    if (proxy) notes.push(`ETF proxy ${proxy} (tracks spot closely but carries fund fees; hours follow US equities).`);
    return inst({ symbol: s, asset_class: "metal", tier, profile_key: pkey, region: "global", session_id: "metals_otc", name: `${name} (${s.slice(0, 3)}/${s.slice(3)})`,
                  base: s.slice(0, 3), quote: s.slice(3), tags: ["precious_metal"], classification_confidence: "pattern", qty_step: 0.01, min_qty: 0.01, notes });
  }
  if (s.length === 6 && FX_ALL_CCY.has(s.slice(0, 3)) && FX_ALL_CCY.has(s.slice(3)) && s.slice(0, 3) !== s.slice(3)) return fxInstrument(s.slice(0, 3), s.slice(3));
  if ((r = indexLookup(s, aliasesOk))) return r;
  if ((r = commodityLookup(s, aliasesOk))) return r;
  const split = splitCrypto(s);
  if (split) {
    const [base, quote] = split;
    if (knownCryptoBase(base)) return cryptoInstrument(base, quote, "catalog", s);
    if (STABLE_QUOTES.has(quote) || hint === "binance") return cryptoInstrument(base, quote, STABLE_QUOTES.has(quote) ? "pattern" : "heuristic", s);
  }
  if (s.includes(".")) {
    const i = s.lastIndexOf("."), tk = s.slice(0, i), suf = s.slice(i + 1);
    if (suf in REG.suffix_to_exchange && tk) return stockInstrument(tk, REG.suffix_to_exchange[suf], "pattern");
    if (/^[A-Z]{1,5}\.[AB]$/.test(s)) return stockInstrument(s, "US", US_MEGA.has(s) ? "catalog" : "heuristic");
    return UNKNOWN(s);
  }
  if (/^[A-Z]{1,5}$/.test(s)) return stockInstrument(s, "US", US_MEGA.has(s) || US_ETFS.has(s) ? "catalog" : "heuristic");
  return UNKNOWN(s);
}
export function listInstruments(assetClass?: string | null, q?: string | null, tier?: string | null): Instrument[] {
  const syms: string[] = [];
  for (const p of ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF", "NZDUSD", "EURGBP", "EURJPY", "GBPJPY", "EURCHF", "AUDJPY", "EURAUD", "GBPAUD", "AUDNZD", "CADJPY",
                   "USDZAR", "USDTRY", "USDMXN", "USDNGN", "USDGHS", "USDKES", "USDSGD", "USDNOK", "USDSEK", "USDPLN"]) syms.push(p);
  for (const m of Object.keys(REG.metals)) syms.push(`${m}USD`);
  for (const b of [...Object.keys(REG.crypto_major), ...Object.keys(REG.crypto_large), ...Object.keys(REG.crypto_defi), ...Object.keys(REG.crypto_meme), "1000SATS", "1000PEPE", "1000SHIB"]) syms.push(`${b}USDT`);
  syms.push(...[...US_MEGA].sort());
  for (const r of REG.index_rows) syms.push(r[0]);
  for (const r of REG.commodity_rows) syms.push(r[0]);
  let items = syms.map((x) => classify(x));
  if (assetClass) items = items.filter((i) => i.asset_class === assetClass.toLowerCase());
  if (tier) items = items.filter((i) => i.tier === tier.toLowerCase());
  if (q) { const n = q.trim().toUpperCase(); items = items.filter((i) => i.symbol.includes(n) || (i.name || "").toUpperCase().includes(n)); }
  return items;
}

// ------------------------------------------------------------------ profiles
const UNKNOWN_PROFILE = { key: "unknown", label: "Unclassified", liquidity: "low", spread_bps: 20.0, commission_bps_per_side: 10.0, slippage_bps_per_side: 10.0, daily_vol_pct: 3.0,
                          stop_vol_mult: 1.0, notional_cap_multiplier: 1.0, risk_multiplier: 1.0, leverage_hint: "n/a", gap_risk: "event", volatility_notes: [], cost_notes: [], source: "planning_default" };
export function profileFor(i: Instrument, listingAgeDays?: number | null, avgDailyVolumeUsd?: number | null): Json {
  let key = i.profile_key;
  if (i.asset_class === "crypto" && listingAgeDays != null && listingAgeDays < NEW_LISTING_DAYS && !["major", "stablecoin"].includes(i.tier)) key = "crypto.new_listing";
  else if (i.asset_class === "stock" && avgDailyVolumeUsd != null && ["us_standard", "us_mega"].includes(i.tier)) {
    key = avgDailyVolumeUsd >= 50_000_000 ? "stock.us_mega" : avgDailyVolumeUsd >= 5_000_000 ? "stock.us_standard" : "stock.emerging";
  }
  return PROFILES[key] ?? UNKNOWN_PROFILE;
}
export const profileKeys = () => Object.keys(PROFILES).sort();

// ------------------------------------------------------------------ providers / routing
export const NOT_INTEGRATED: Record<string, string> = {
  forex: "OANDA adapter exists but is not configured (set OANDA_API_TOKEN and OANDA_ACCOUNT_ID), or this pair is not offered by OANDA.",
  metal: "OANDA adapter exists but is not configured, or this metal is not offered; ETF proxies (GLD/SLV/PPLT/PALL) need Alpaca keys.",
  index: "No route for this index (OANDA does not list it and no ETF stand-in exists).",
  commodity: "No route for this commodity (OANDA does not list it and no ETF stand-in exists).",
  future: "No futures adapter (and no ETF stand-in: contract sizing does not map to shares). Analysis, sizing and sessions work; execution is unavailable.",
  option: "Options route via Alpaca for US equity options (OCC symbols); other options are unsupported.",
  stock_non_us: "No non-US equity adapter (EU/Asia/Africa). Analysis, sessions and sizing work; execution is unavailable.",
};
const CFD_NOTE = "OANDA CFD: tracks the underlying with financing costs and OANDA's own hours/spreads; it is not the cash index or the exchange future, and CFDs are not offered in every jurisdiction (e.g. US accounts).";
export function oandaInstrument(i: Instrument): string | null {
  const ac = i.asset_class;
  if ((ac === "forex" || ac === "metal") && i.base && i.quote) return `${i.base}_${i.quote}`;
  if (ac === "index") return G.oanda.indices[i.symbol] ?? null;
  if (ac === "commodity") return G.oanda.commodities[i.symbol] ?? null;
  return null;
}
export function providerSupports(provider: string | null | undefined, i: Instrument): boolean | null {
  const cap = CAPS[(provider ?? "").toLowerCase()];
  if (!cap || i.asset_class === "unknown") return null;
  if (!cap.asset_classes.includes(i.asset_class)) return false;
  if (cap.us_stocks_only && i.asset_class === "stock" && i.region !== "US") return false;
  if (cap.name === "oanda" && oandaInstrument(i) === null) return false;
  return true;
}
export function setupStatus(provider: string, s: MarketsSettings = {}): Json {
  const p = provider.toLowerCase();
  if (p === "oanda") { const missing = [["OANDA_API_TOKEN", s.oanda_api_token], ["OANDA_ACCOUNT_ID", s.oanda_account_id]].filter(([, v]) => !v).map(([n]) => n); return { configured: !missing.length, missing }; }
  if (p === "alpaca") { const missing = [["ALPACA_API_KEY", s.alpaca_api_key], ["ALPACA_SECRET_KEY", s.alpaca_secret_key]].filter(([, v]) => !v).map(([n]) => n); return { configured: !missing.length, missing }; }
  if (p === "binance") {
    const has = !!(s.binance_api_key && s.binance_secret_key);
    return { configured: true, missing: [], note: has ? null : "public data and simulated paper fills work without keys; real testnet/live orders need BINANCE_API_KEY and BINANCE_SECRET_KEY" };
  }
  return { configured: false, missing: [] };
}
function executionProxy(i: Instrument): [string, string] | null {
  const root = i.underlying || i.symbol;
  if (i.asset_class === "metal" && i.base in REG.metal_proxies && i.quote === "USD") return [REG.metal_proxies[i.base], "close"];
  for (const r of REG.index_rows) if (r[6] && r[0] === root) return [r[6], r[7] || "approximate"];
  for (const r of REG.commodity_rows) if (r[6] && r[0] === root) return [r[6], "futures_based"];
  return null;
}
export function routesFor(i: Instrument, s: MarketsSettings = {}): Json[] {
  const routes: Json[] = [], ac = i.asset_class;
  if (ac === "crypto") routes.push({ provider: "binance", symbol: i.symbol, kind: "direct", session_id: "crypto_24x7", environments: [...CAPS.binance.environments], note: "Spot order via TradingService; the pair must exist on Binance spot." });
  else if (ac === "stock" && i.region === "US") routes.push({ provider: "alpaca", symbol: i.symbol, kind: "direct", session_id: "us_equity", environments: [...CAPS.alpaca.environments], note: "Whole-share day orders via TradingService." });
  else if (ac === "option") routes.push({ provider: "alpaca", symbol: i.symbol, kind: "direct", session_id: "us_equity", environments: [...CAPS.alpaca.environments],
    note: "US equity option via Alpaca (whole contracts, day orders). Requires an options-approved account; prefer limit orders - option spreads are wide." });
  else if (["forex", "metal", "index", "commodity"].includes(ac)) {
    const venue = oandaInstrument(i);
    if (venue) {
      const cfd = ac === "index" || ac === "commodity";
      routes.push({ provider: "oanda", symbol: i.symbol, venue_symbol: venue, kind: cfd ? "cfd" : "direct",
        session_id: ac === "forex" ? "fx_24x5" : ac === "metal" ? "metals_otc" : ac === "index" ? "cme_globex" : i.session_id, environments: [...CAPS.oanda.environments],
        note: (cfd ? CFD_NOTE : `Spot ${i.name || i.symbol} via OANDA (${venue}); units are base-currency/ounces.`) + (cfd ? " Session hours are approximate; the live quote's tradeable flag is authoritative." : "") });
    }
    if (ac !== "forex") {
      const proxy = executionProxy(i);
      if (proxy) {
        const [etf, quality] = proxy;
        const caveat = ({ close: "Tracks the underlying closely but carries fund fees and trades only in US equity hours.", approximate: "Tracks a different/approximate benchmark; basis risk vs the named index.",
                         futures_based: "Futures-based fund: roll yield (contango/backwardation) diverges from spot." } as Record<string, string>)[quality] ?? "";
        routes.push({ provider: "alpaca", symbol: etf, kind: "etf_proxy", proxy_quality: quality, session_id: "us_equity", environments: [...CAPS.alpaca.environments],
                      note: `Not the instrument itself: ${i.symbol} exposure via ${etf}. ${caveat}`.trim() });
      }
    }
  }
  for (const r of routes) r.setup = setupStatus(r.provider, s);
  return routes;
}
export function dataCoverage(i: Instrument, s: MarketsSettings = {}): Json {
  const routes = routesFor(i, s);
  if (routes.length) { const r = routes[0]; return { status: r.setup.configured ? "available" : "needs_setup", provider: r.provider, symbol: r.symbol, via: r.kind, missing: r.setup.missing }; }
  return { status: "provider_not_integrated", provider: null, symbol: null, via: null, missing: [] };
}
export function notIntegratedReason(i: Instrument): string | null {
  if (routesFor(i).length) return null;
  return i.asset_class === "stock" ? NOT_INTEGRATED.stock_non_us : NOT_INTEGRATED[i.asset_class] ?? null;
}
export function overview(s: MarketsSettings = {}): Json {
  const matrix: Record<string, Json> = {};
  for (const ac of ["forex", "metal", "crypto", "stock", "index", "commodity", "future", "option"]) {
    const caps = Object.values<Json>(CAPS).filter((c) => c.asset_classes.includes(ac)), cfd = ac === "index" || ac === "commodity";
    const direct = caps.filter((c) => !(cfd && c.name === "oanda")).map((c) => c.name), cfdVia = caps.filter((c) => cfd && c.name === "oanda").map((c) => c.name);
    const proxyVia = ["metal", "index", "commodity"].includes(ac) ? ["alpaca"] : [];
    const providers = [...new Set([...direct, ...cfdVia, ...proxyVia])].sort();
    matrix[ac] = { direct_providers: direct, cfd_providers: cfdVia, etf_proxy_via: proxyVia, analysis: true, execution: providers.length > 0,
                   setup: Object.fromEntries(providers.map((p) => [p, setupStatus(p, s)])), gap: providers.length ? null : NOT_INTEGRATED[ac] ?? null };
  }
  matrix.stock.gap = NOT_INTEGRATED.stock_non_us; matrix.stock.execution_scope = "US-listed only"; matrix.option.execution_scope = "US equity options only";
  return { providers: CAPS, asset_classes: matrix };
}

// ------------------------------------------------------------------ sizing + assessment
function quoteToUsd(i: Instrument, price: number, supplied?: number | null): [number | null, string | null] {
  if (supplied != null) return [supplied, null];
  const q = i.quote;
  if ((i.asset_class === "forex" || i.asset_class === "metal") && i.base === "USD" && price > 0) return [1.0 / price, null];
  if (q == null || USD_LIKE.has(q)) return [1.0, q && q !== "USD" ? "quote currency treated as 1:1 with USD" : null];
  return [null, `quote currency ${q} needs a USD conversion rate: pass quote_to_usd`];
}
function floorToStep(qty: number, step: number): number {
  if (step <= 0) return qty;
  const n = Math.floor(qty / step + 1e-9);
  const decimals = step < 1 ? Math.max(0, -Math.floor(Math.log10(step))) : 0;
  return pyRound(n * step, decimals + 2);
}
function size(i: Instrument, prof: Json, a: { price: number; equity: number; riskPct: number; side: string; stopPrice?: number | null; atr?: number | null; factor: number;
  quoteToUsd?: number | null; maxNotionalPct: number; advUsd?: number | null; maxAdvPct: number }): Json {
  const out: Json = { status: "ok" };
  const { price, equity, riskPct, side, factor } = a;
  if (!(price > 0) || !(equity > 0) || !(riskPct > 0)) return { status: "invalid_input", reason: "price, account_equity and risk_pct must be positive" };
  const [q2u, note] = quoteToUsd(i, price, a.quoteToUsd);
  if (q2u === null) return { status: "needs_quote_usd_rate", reason: note };
  if (note) out.note = note;
  const mult = i.contract_multiplier || 1.0, usdPerUnit = price * mult * q2u;
  let dist: number, source: string;
  if (a.stopPrice != null) {
    const wrong = (side === "buy" && a.stopPrice >= price) || (side === "sell" && a.stopPrice <= price);
    if (a.stopPrice <= 0 || wrong) return { status: "invalid_input", reason: `stop_price must be ${side === "buy" ? "below" : "above"} price for a ${side}` };
    dist = Math.abs(price - a.stopPrice); source = "provided_stop";
  } else if (a.atr != null && a.atr > 0) { dist = a.atr * 1.5; source = "atr_x1.5"; }
  else if (i.asset_class === "option") { dist = price; source = "full_premium_at_risk"; }
  else { dist = price * prof.daily_vol_pct / 100.0 * prof.stop_vol_mult; source = "profile_volatility_default"; }
  if (!(dist > 0)) return { status: "invalid_input", reason: "stop distance must be positive" };
  const haircut = factor > 0 && factor < 0.5 ? 0.5 : 1.0;
  const budget = equity * (riskPct / 100.0) * prof.risk_multiplier * haircut;
  const qtyRisk = budget / (dist * mult * q2u);
  const capUsd = equity * (a.maxNotionalPct / 100.0) * prof.notional_cap_multiplier;
  const limits: Record<string, number> = { risk_budget: qtyRisk, notional_cap: capUsd / usdPerUnit };
  if (a.advUsd != null && a.advUsd > 0) limits.liquidity_participation = (a.advUsd * a.maxAdvPct / 100.0) / usdPerUnit;
  let binding = "";
  for (const k of Object.keys(limits)) if (binding === "" || limits[k] < limits[binding]) binding = k;
  let qty = floorToStep(limits[binding], i.qty_step);
  if (qty < i.min_qty - 1e-12) {
    const minNotional = i.min_qty * usdPerUnit, minRisk = i.min_qty * dist * mult * q2u, effCapPct = a.maxNotionalPct * prof.notional_cap_multiplier;
    const riskFrac = (riskPct / 100.0) * prof.risk_multiplier * haircut;
    Object.assign(out, { status: "below_minimum_size", quantity: 0.0, binding_constraint: binding,
      reason: `Allowed size (${fmtG(limits[binding])}) is below the minimum order size (${fmtG(i.min_qty)}) under the ${binding.replace(/_/g, " ")} limit. The smallest order is ~$${comma0(minNotional)} notional (~$${comma0(minRisk)} at risk): that needs account equity of about $${comma0(minNotional / (effCapPct / 100.0))} for the ${fmtG(effCapPct)}% notional cap and $${comma0(minRisk / riskFrac)} for the risk budget.`,
      minimum_order: { notional_usd: pyRound(minNotional, 2), risk_usd: pyRound(minRisk, 2), equity_for_notional_cap_usd: pyRound(minNotional / (effCapPct / 100.0), 2), equity_for_risk_budget_usd: pyRound(minRisk / riskFrac, 2) } });
    qty = 0.0;
  } else { out.quantity = qty; out.binding_constraint = binding; }
  const notional = qty * usdPerUnit, riskActual = qty * dist * mult * q2u, buy = side === "buy";
  Object.assign(out, { notional_usd: pyRound(notional, 2), risk_amount_usd: pyRound(riskActual, 2), risk_pct_of_equity: pyRound(riskActual / equity * 100.0, 4), risk_budget_usd: pyRound(budget, 2),
    stop_distance: pyRound(dist, 8), stop_source: source, stop_price: pyRound(buy ? price - dist : price + dist, 8), target_1r: pyRound(buy ? price + dist : price - dist, 8),
    target_2r: pyRound(buy ? price + 2 * dist : price - 2 * dist, 8), limits: Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, pyRound(v, 8)])),
    max_notional_pct_applied: pyRound(a.maxNotionalPct * prof.notional_cap_multiplier, 4), liquidity_haircut_applied: haircut < 1.0 });
  return out;
}

export interface AssessArgs {
  now?: number; price?: number | null; account_equity?: number; risk_pct?: number; side?: string; stop_price?: number | null; atr?: number | null;
  measured_spread_bps?: number | null; avg_daily_volume_usd?: number | null; listing_age_days?: number | null; quote_to_usd?: number | null;
  max_notional_pct?: number; max_adv_participation_pct?: number; provider?: string | null; environment?: string; settings?: MarketsSettings;
}
export function assess(symbol: string, o: AssessArgs = {}): Json {
  const nowMs = Math.floor(o.now ?? Date.now()), side = (o.side ?? "buy").toLowerCase(), provider = o.provider ?? null, settings = o.settings ?? {};
  const i = classify(symbol, provider);
  const base = { as_of_utc: isoUtc(nowMs), planning_only: true, disclaimer: "Planning aid built on static baselines unless live inputs are supplied; not investment advice." };
  if (i.asset_class === "unknown") return { ...base, instrument: i, verdict: "blocked", reasons: [`${pyRepr(symbol)} could not be classified as a supported market`], warnings: [] };
  const status = sessionStatus(i.session_id, nowMs);
  const prof = profileFor(i, o.listing_age_days, o.avg_daily_volume_usd);
  const [factor, liqCtx] = liquidityFactor(i.asset_class, status, nowMs), smult = spreadMultiplier(factor);
  const allRoutes = routesFor(i, settings), routes = allRoutes.filter((r) => !provider || r.provider === provider.toLowerCase());
  let spread: number, spreadSrc: string;
  if (o.measured_spread_bps != null) { spread = Number(o.measured_spread_bps); spreadSrc = "measured"; }
  else { spread = prof.spread_bps * (smult || 1.0); spreadSrc = "baseline_scaled_for_session_liquidity"; }
  const slip = prof.slippage_bps_per_side * (smult || 1.0), roundTrip = spread + 2 * (prof.commission_bps_per_side + slip);
  const costs: Json = { spread_bps: pyRound(spread, 3), spread_source: spreadSrc, commission_bps_per_side: prof.commission_bps_per_side, slippage_bps_per_side: pyRound(slip, 3), round_trip_bps: pyRound(roundTrip, 3), source: prof.source };
  const reasons: string[] = [], warnings: string[] = [];
  let verdict = "ready", sizing: Json | null = null;
  if (o.price != null) {
    sizing = size(i, prof, { price: o.price, equity: o.account_equity ?? 10000, riskPct: o.risk_pct ?? 1, side, stopPrice: o.stop_price, atr: o.atr, factor, quoteToUsd: o.quote_to_usd,
                             maxNotionalPct: o.max_notional_pct ?? 6, advUsd: o.avg_daily_volume_usd, maxAdvPct: o.max_adv_participation_pct ?? 1 });
    if (sizing!.notional_usd) {
      costs.round_trip_usd = pyRound(sizing!.notional_usd * roundTrip / 1e4, 2);
      if (sizing!.risk_amount_usd) {
        const ratio = costs.round_trip_usd / sizing!.risk_amount_usd;
        costs.cost_to_risk_ratio = pyRound(ratio, 3);
        if (ratio > COST_TO_RISK_WARN) warnings.push(`Round-trip costs consume ${pct0(ratio)} of the risk budget; a tight edge here is eaten by friction`);
      }
    }
    const proxy = routes.length && routes[0].kind === "etf_proxy" ? routes[0] : null;
    if (proxy && sizing!.notional_usd) sizing!.proxy_sizing = { symbol: proxy.symbol, size_by_notional_usd: sizing!.notional_usd,
      instruction: `Do not submit the quantity above to ${proxy.symbol}: it is in ${i.symbol} units. Divide notional_usd by ${proxy.symbol}'s current price and round down to whole shares; re-derive the stop in the ETF's own price terms.` };
    if (["invalid_input", "needs_quote_usd_rate", "below_minimum_size"].includes(sizing!.status)) { reasons.push(sizing!.reason ?? sizing!.status); verdict = "blocked"; }
  }
  const routeStatus = new Map<string, SessionStatus>();
  for (const r of routes) routeStatus.set(r.session_id, sessionStatus(r.session_id, nowMs));
  if (verdict !== "blocked") {
    const when = (s: SessionStatus) => (s.next_open_utc ? `; next open ${s.next_open_utc}` : "");
    if (!routes.length) {
      verdict = "analysis_only"; reasons.push(notIntegratedReason(i) || "No execution route for this instrument");
      if (status.state !== "open") warnings.push(`Market is ${status.state} (${status.reason || status.regime})${when(status)}`);
    } else if (![...routeStatus.values()].some((s) => s.state === "open")) {
      verdict = "wait_for_session";
      const first = routeStatus.values().next().value as SessionStatus, via = first.session_id === i.session_id ? "" : ` (execution route trades in ${first.name} hours)`;
      reasons.push(`Execution market is ${first.state} (${first.reason || first.regime})${via}${when(first)}`);
    } else if (!routes.some((r) => r.setup.configured)) {
      verdict = "needs_setup"; reasons.push(`${routes[0].provider} route exists but is not configured: set ${routes[0].setup.missing.join(", ")}`);
    } else if (warnings.length || ["low", "very_low"].includes(prof.liquidity) || status.state !== "open") {
      verdict = "caution";
      if (status.state !== "open") warnings.push(`The underlying market itself is ${status.state}; the execution route may not reflect current prices`);
    }
  }
  if (status.regime === "opening_volatility" || status.regime === "closing_flow") warnings.push(`Session regime: ${status.regime.replace(/_/g, " ")}`);
  if (liqCtx.note) warnings.push(liqCtx.note);
  if (["low", "very_low"].includes(prof.liquidity)) warnings.push(`${prof.label}: ${prof.liquidity.replace(/_/g, " ")} liquidity - exit at size may be slow or costly`);
  const gap = ({ weekend: "Weekend gap risk: stops do not protect across the weekly close.", overnight: "Overnight gap risk: stops do not protect across the close.",
                 limit_moves: "Daily price limits can lock the market and prevent exit." } as Record<string, string>)[prof.gap_risk];
  if (gap) warnings.push(gap);
  if (i.classification_confidence === "heuristic") warnings.push("Classification is a heuristic guess; verify the instrument and its venue.");
  if (prof.key === "crypto.new_listing") warnings.push("Listed < 30 days ago: treated as a new listing (extreme volatility, wide spreads).");
  if (i.asset_class === "crypto" && i.tier === "emerging" && o.listing_age_days == null) warnings.push("Listing age unknown: pass listing_age_days to detect newly listed tokens.");
  if (status.schedule_confidence === "approximate") warnings.push("Session hours are approximate reference hours; verify with the exchange.");
  if (status.holiday_calendar === "not_applied") warnings.push("No holiday calendar applied for this market; it may be closed on a public holiday.");
  for (const r of routes) {
    if (r.kind === "etf_proxy" || r.kind === "cfd") warnings.push(r.note);
    if (r.setup.note) warnings.push(`${r.provider}: ${r.setup.note}`);
  }
  if (i.asset_class === "future" || i.asset_class === "option") warnings.push(...i.notes);
  if (provider && !routes.length && allRoutes.length) reasons.push(`${provider} has no route for ${i.symbol}; available: ${[...new Set(allRoutes.map((r) => r.provider))].sort().join(", ")}`);
  return { ...base, instrument: i, session: { ...status, liquidity_factor: factor, spread_multiplier: smult, ...liqCtx }, profile: prof, costs, sizing,
           execution: { executable: routes.length > 0, routes, environment_requested: o.environment ?? "paper", data: dataCoverage(i, settings), live_trading: "disabled unless explicitly enabled and risk-gated" },
           verdict, reasons, warnings: [...new Set(warnings)] };
}

export function marketRiskReview(symbol: string, provider: string | null, environment: string, nowMs: number = Date.now()): Json {
  const i = classify(symbol, provider), prof = profileFor(i), env = (environment ?? "").toLowerCase();
  const r: Json = { asset_class: i.asset_class, tier: i.tier, blocking_reasons: [] as string[], warnings: [] as string[], notional_cap_multiplier: prof.notional_cap_multiplier,
                    risk_multiplier: prof.risk_multiplier, session_state: "unknown", tradeable_now: true };
  if (i.asset_class === "unknown") { r.warnings.push(`${pyRepr(symbol)} could not be classified; market-specific limits were not applied`); return r; }
  if (providerSupports(provider, i) === false) {
    const msg = `${provider} cannot trade ${i.asset_class} instrument ${i.symbol} (no adapter for this market, or not offered by this provider)`;
    (i.classification_confidence === "heuristic" ? r.warnings : r.blocking_reasons).push(msg);
  }
  if ((provider ?? "").toLowerCase() === "oanda" && env === "testnet") r.blocking_reasons.push("OANDA has no testnet environment; use environment=paper (OANDA practice account) or live");
  if (i.session_id in SESSIONS) {
    const st = sessionStatus(i.session_id, nowMs);
    r.session_state = st.state; r.tradeable_now = st.state === "open";
    if (!r.tradeable_now) {
      const msg = `${i.symbol} market is ${st.state} (${st.reason || st.regime})${st.next_open_utc ? `; next open ${st.next_open_utc}` : ""}`;
      (env === "live" ? r.blocking_reasons : r.warnings).push(msg);
    }
  }
  if (i.tier === "emerging" || i.tier === "frontier" || i.tags.includes("meme")) r.warnings.push(`${i.symbol} is a ${i.tier} / high-risk instrument: position and risk limits are tightened`);
  return r;
}
export { SESSIONS, PROFILES };
