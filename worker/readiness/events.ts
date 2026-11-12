// Event-risk inputs for the Market Readiness Engine: economic announcements, central-bank decisions, geopolitical and
// fundamental events. ETI has no built-in calendar data and never invents events. Events come ONLY from an operator-configured
// source: ETI_EVENT_FEED_URL (HTTPS JSON, optional ETI_EVENT_FEED_TOKEN) and/or ETI_EVENTS_JSON (inline JSON).
// With no source the engine reports the calendar as UNVERIFIED and never claims the calendar is clear.
import { DAY, FX_CURRENCIES, MIN } from "./calendar.ts";

export type Impact = "low" | "medium" | "high";
export type EventCategory = "economic" | "central_bank" | "geopolitical" | "fundamental" | "earnings" | "other";
export interface MarketEvent { id: string; title: string; time: number; impact: Impact; category: EventCategory; currencies: string[]; markets: string[]; symbols: string[]; source: string }
export interface EventsEnv { ETI_EVENT_FEED_URL?: string; ETI_EVENT_FEED_TOKEN?: string; ETI_EVENTS_JSON?: string }
export interface EventsState { status: "loaded" | "not_configured" | "error"; sources: string[]; events: MarketEvent[]; invalid: number; error?: string; fetchedAt: number }

const CATEGORIES: EventCategory[] = ["economic", "central_bank", "geopolitical", "fundamental", "earnings", "other"];
const list = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map(x => String(x).trim().toUpperCase()).filter(Boolean).slice(0, 12);
const toMs = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v > 1e12 ? v : v > 1e9 ? v * 1000 : null;
  if (typeof v === "string" && v.trim()) { const t = /^\d{10,13}$/.test(v.trim()) ? toMs(Number(v.trim())) : Date.parse(v); return t !== null && Number.isFinite(t) ? t : null; }
  return null;
};

/** Strict parser: malformed rows are counted and dropped, never repaired by guessing. */
export function parseEvents(raw: unknown, source: string, now: number): { events: MarketEvent[]; invalid: number } {
  const rows = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { events?: unknown }).events) ? (raw as { events: unknown[] }).events : null;
  if (!rows) return { events: [], invalid: 1 };
  const events: MarketEvent[] = []; let invalid = 0;
  rows.slice(0, 2000).forEach((r, i) => {
    const o = (r ?? {}) as Record<string, unknown>, time = toMs(o.time ?? o.date ?? o.timestamp), impact = String(o.impact ?? "").toLowerCase();
    const title = typeof o.title === "string" ? o.title.trim().slice(0, 200) : typeof o.event === "string" ? o.event.trim().slice(0, 200) : "";
    if (!title || time === null || Math.abs(time - now) > 400 * DAY || !["low", "medium", "high"].includes(impact)) { invalid++; return; }
    const cat = String(o.category ?? "other").toLowerCase() as EventCategory;
    events.push({ id: String(o.id ?? `${source}:${i}`).slice(0, 80), title, time, impact: impact as Impact, category: CATEGORIES.includes(cat) ? cat : "other",
      currencies: list(o.currencies ?? o.currency), markets: list(o.markets ?? o.market).map(m => m.toLowerCase()), symbols: list(o.symbols ?? o.symbol), source });
  });
  if (rows.length > 2000) invalid += rows.length - 2000;
  return { events: events.sort((a, b) => a.time - b.time), invalid };
}

export async function loadEvents(env: EventsEnv, now: number, fetchImpl: typeof fetch = fetch): Promise<EventsState> {
  const sources: string[] = [], events: MarketEvent[] = []; let invalid = 0; const errors: string[] = [];
  if (env.ETI_EVENTS_JSON) {
    sources.push("ETI_EVENTS_JSON");
    try { const p = parseEvents(JSON.parse(env.ETI_EVENTS_JSON), "inline", now); events.push(...p.events); invalid += p.invalid; } catch { errors.push("ETI_EVENTS_JSON is not valid JSON"); }
  }
  if (env.ETI_EVENT_FEED_URL) {
    let host = "";
    try { const u = new URL(env.ETI_EVENT_FEED_URL); if (u.protocol !== "https:") throw new Error("not https"); host = u.host; } catch { errors.push("ETI_EVENT_FEED_URL must be a valid https URL"); }
    if (host) {
      sources.push(host);
      try {
        const res = await fetchImpl(env.ETI_EVENT_FEED_URL, { headers: { accept: "application/json", ...(env.ETI_EVENT_FEED_TOKEN ? { authorization: `Bearer ${env.ETI_EVENT_FEED_TOKEN}` } : {}) }, signal: AbortSignal.timeout(4000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text(); if (text.length > 1_000_000) throw new Error("feed larger than 1 MB");
        const p = parseEvents(JSON.parse(text), host, now); events.push(...p.events); invalid += p.invalid;
      } catch (e) { errors.push(`Event feed ${host} failed: ${e instanceof Error ? e.message : "unknown"}`); }
    }
  }
  if (!sources.length && !errors.length) return { status: "not_configured", sources, events: [], invalid: 0, fetchedAt: now };
  // Partial failure is still a failure: a missing feed means an unknown calendar, even if inline events loaded.
  return { status: errors.length ? "error" : "loaded", sources, events: events.sort((a, b) => a.time - b.time), invalid, ...(errors.length ? { error: errors.join("; ") } : {}), fetchedAt: now };
}

export interface EventContext { market: string; symbol?: string; currencies: string[] }
export function relevant(e: MarketEvent, c: EventContext): boolean {
  if (!e.currencies.length && !e.markets.length && !e.symbols.length) return true; // unscoped = global
  return (!!c.symbol && e.symbols.includes(c.symbol)) || e.markets.includes(c.market) || e.currencies.some(x => c.currencies.includes(x));
}
/** Currencies that move a symbol: both legs of an FX pair; the USD quote for USD-quoted crypto (global dollar-event sensitivity). */
export function currenciesOf(market: string, symbol?: string): string[] {
  if (!symbol) return market === "forex" ? [...FX_CURRENCIES] : ["USD"]; // market-level report: any currency event is relevant to forex
  if (market === "forex") return [symbol.slice(0, 3), symbol.slice(3, 6)];
  const m = /(USDT|USDC|BUSD|FDUSD|USD)$/.exec(symbol);
  return market === "crypto" ? [...(m ? ["USD"] : []), ...(symbol.replace(/(USDT|USDC|BUSD|FDUSD|USD)$/, "") ? [symbol.replace(/(USDT|USDC|BUSD|FDUSD|USD)$/, "")] : [])] : ["USD"];
}

export type EventSeverity = "none" | "caution" | "high_risk" | "avoid";
export interface EventHit { event: MarketEvent; minutesUntil: number; severity: EventSeverity; phase: "before" | "release" | "after" }
/** Danger zone around a release, minutes [before, after]. High impact: 30/30 is a no-trade blackout, 120/120 is high risk. */
const ZONES: Record<Impact, { avoid: [number, number]; high: [number, number]; caution: [number, number] }> = {
  high: { avoid: [30, 30], high: [120, 120], caution: [240, 240] },
  medium: { avoid: [0, 0], high: [15, 15], caution: [45, 45] },
  low: { avoid: [0, 0], high: [0, 0], caution: [0, 0] },
};
const RANK: Record<EventSeverity, number> = { none: 0, caution: 1, high_risk: 2, avoid: 3 };
/** Worst severity an event poses to the interval [from, to] (a single instant when from === to). */
export function severityFor(e: MarketEvent, from: number, to: number): EventSeverity {
  const z = ZONES[e.impact]; let worst: EventSeverity = "none";
  for (const [name, [b, a]] of [["avoid", z.avoid], ["high_risk", z.high], ["caution", z.caution]] as const) {
    if (b + a === 0) continue;
    if (e.time - b * MIN < to && e.time + a * MIN > from) { worst = name; break; }
  }
  return worst;
}
/** `long` windows (sessions, days) are not blanket no-trade zones: an event only forces AVOID/HIGH_RISK when the evaluation instant itself is inside its danger zone,
 *  otherwise it is a CAUTION that names the blackout hours; two or more high-impact releases, or any central-bank decision, make the window HIGH_RISK. */
export function eventHits(events: MarketEvent[], ctx: EventContext, from: number, to: number, horizonEnd = to, long = false): EventHit[] {
  const out: EventHit[] = [];
  for (const e of events) {
    if (!relevant(e, ctx) || e.impact === "low") continue;
    let sev = long ? severityFor(e, from, from) : severityFor(e, from, to);
    if (long && sev === "none" && severityFor(e, from, to) !== "none") sev = "caution";
    if (sev === "none" && e.impact === "high" && e.time >= from && e.time <= horizonEnd) sev = "caution"; // a high-impact release later inside the evaluated window
    if (sev === "none") continue;
    out.push({ event: e, minutesUntil: Math.round((e.time - from) / MIN), severity: sev, phase: e.time > to ? "before" : e.time >= from ? "release" : "after" });
  }
  if (long) {
    const inWin = out.filter(h => h.event.impact === "high" && h.event.time >= from && h.event.time <= to);
    if (inWin.length >= 2 || inWin.some(h => h.event.category === "central_bank")) for (const h of inWin) if (RANK[h.severity] < RANK.high_risk) h.severity = "high_risk";
  }
  return out.sort((a, b) => RANK[b.severity] - RANK[a.severity] || a.event.time - b.event.time);
}
export const worstSeverity = (h: EventHit[]): EventSeverity => h.reduce<EventSeverity>((w, x) => (RANK[x.severity] > RANK[w] ? x.severity : w), "none");
