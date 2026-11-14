// Automatic ingestion of the scheduled-event calendar into the Precision engine's news context.
// The only source is the operator-configured calendar the Readiness engine already uses (ETI_EVENT_FEED_URL and/or
// ETI_EVENTS_JSON). ETI has no built-in calendar and invents nothing: with no source, or a feed that failed or was
// partly invalid, nothing is written and the news component stays "unavailable". Fundamentals are NOT ingested here:
// turning raw statistics into a bullish/bearish bias would be a made-up judgement, so they stay operator-supplied.
import { loadEvents, relevant, type EventsEnv, type MarketEvent } from "../readiness/events.ts";
import { parseNewsContext, type NewsContext, type NewsEvent } from "./context.ts";
import { keys, precisionStore, type PrecisionEnv } from "./stores.ts";
import { DAY_MS } from "./util.ts";

export const INGEST_REFRESH_MS = 15 * 60_000;
export const OPERATOR_DATA_MAX_AGE_MS = 12 * 3_600_000;
export const MAX_SYMBOL_WRITES = 4;
const WINDOW_BEFORE_MS = 6 * 3_600_000, WINDOW_AFTER_MS = 3 * DAY_MS;
const SCHEDULED = new Set(["economic", "central_bank", "earnings"]);
const AUTO = "auto:";

export interface IngestReport { status: "not_configured" | "skipped" | "error" | "ok"; detail: string; written: string[] }

const toNews = (e: MarketEvent): NewsEvent => ({ title: e.title, time: new Date(e.time).toISOString(), impact: e.impact, sentiment: null, scheduled: SCHEDULED.has(e.category), source: e.source, url: null });
const baseOf = (symbol: string) => symbol.replace(/(USDT|USDC|BUSD|FDUSD|USD)$/, "") || symbol;

export function buildNewsContexts(events: MarketEvent[], sources: string[], symbols: string[], now: number): { market: NewsContext; perBase: Map<string, NewsContext> } {
  const inWindow = events.filter(e => e.time >= now - WINDOW_BEFORE_MS && e.time <= now + WINDOW_AFTER_MS);
  const asOf = new Date(now).toISOString(), source = AUTO + (sources.join("+") || "calendar");
  const market = { asOf, source, events: inWindow.filter(e => !e.symbols.length && relevant(e, { market: "crypto", currencies: ["USD"] })).map(toNews) };
  const perBase = new Map<string, NewsContext>();
  for (const s of symbols) {
    const hits = inWindow.filter(e => e.symbols.includes(s));
    if (hits.length && perBase.size < MAX_SYMBOL_WRITES) perBase.set(baseOf(s), { asOf, source, events: hits.map(toNews) });
  }
  return { market, perBase };
}

async function keepExisting(kv: { get(k: string): Promise<string | null> }, key: string, now: number): Promise<string | null> {
  let ctx: NewsContext | null = null;
  try { const t = await kv.get(key); ctx = t ? parseNewsContext(JSON.parse(t)) : null; } catch { ctx = null; }
  if (!ctx) return null;
  const age = now - Date.parse(ctx.asOf);
  if (ctx.source.startsWith(AUTO)) return age < INGEST_REFRESH_MS ? "refreshed recently" : null;
  return age < OPERATOR_DATA_MAX_AGE_MS ? "operator-supplied data is still fresh and is not overwritten" : null;
}

export async function ingestEventCalendar(env: PrecisionEnv & EventsEnv, symbols: string[], now: number, fetchImpl: typeof fetch = fetch): Promise<IngestReport> {
  if (!env.ETI_EVENT_FEED_URL && !env.ETI_EVENTS_JSON) return { status: "not_configured", detail: "No ETI_EVENT_FEED_URL or ETI_EVENTS_JSON is set", written: [] };
  const kv = precisionStore(env);
  if (!kv) return { status: "skipped", detail: "No KV namespace is bound", written: [] };
  const reason = await keepExisting(kv, keys.marketNews(), now);
  if (reason) return { status: "skipped", detail: `Market news ${reason}`, written: [] };
  const state = await loadEvents(env, now, fetchImpl);
  if (state.status !== "loaded") return { status: "error", detail: state.error ?? "Event calendar not loaded; nothing written", written: [] };
  if (state.invalid > 0) return { status: "error", detail: `${state.invalid} calendar row(s) were invalid; the calendar is treated as unverified and nothing was written`, written: [] };
  const { market, perBase } = buildNewsContexts(state.events, state.sources, symbols, now);
  const written: string[] = [];
  await kv.put(keys.marketNews(), JSON.stringify(market)); written.push(keys.marketNews());
  for (const [base, ctx] of perBase) {
    if (await keepExisting(kv, keys.news(base), now)) continue;
    await kv.put(keys.news(base), JSON.stringify(ctx)); written.push(keys.news(base));
  }
  return { status: "ok", detail: `${market.events.length} market-wide event(s) from ${state.sources.join(", ")}`, written };
}
