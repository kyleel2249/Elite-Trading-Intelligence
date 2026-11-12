// HTTP surface and scheduler for the ETI Daily Intelligence Report.
//   GET /api/daily-report[?format=json|markdown|text][&refresh=1][&date=YYYY-MM-DD]   today's report (cached a few minutes); date= returns a stored past report
//   GET /api/daily-report/status                                                          which inputs are connected and the generation limits
// Read-only and analytical. It never places an order. Generated reports are stored in the ETI_EXECUTION_LOG KV namespace (14 days) when it is bound.
import { buildDailyReport, tradingDayInfo, type CollectedData, type DailyReport } from "./report.ts";
import { collectDailyData, budgetOf, parseStocks, riskPctOf, COST, type DailyEnv } from "./collect.ts";
import { sourceFor } from "../readiness/sources.ts";
import { eventsFor } from "../readiness/api.ts";

const HEADERS = { "cache-control": "no-store", "access-control-allow-origin": "*", "x-content-type-options": "nosniff" };
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...HEADERS, "content-type": "application/json; charset=utf-8", ...extra } });
const FORMATS = ["json", "markdown", "text"];
export const FRESH_MS = 5 * 60_000, REFRESH_MIN_MS = 60_000, TTL_SECONDS = 14 * 86_400;
export const keyFor = (date: string) => `daily:report:${date}`, LATEST_KEY = "daily:report:latest";

export interface DailyDeps { collect?: (env: DailyEnv, now: number) => Promise<CollectedData>; now?: () => number }
interface Stored { report: DailyReport; generatedAtMs: number }
// Per-isolate memo so polling cannot multiply upstream calls; the KV copy is shared across isolates.
let memo: Stored | null = null;
export function resetDailyMemo() { memo = null; }

async function kvGet(env: DailyEnv, key: string): Promise<Stored | null> {
  if (!env.ETI_EXECUTION_LOG) return null;
  try { const raw = await env.ETI_EXECUTION_LOG.get(key); if (!raw) return null; const s = JSON.parse(raw) as Stored; return s && s.report && typeof s.generatedAtMs === "number" ? s : null; } catch { return null; }
}
async function kvPut(env: DailyEnv, report: DailyReport, now: number): Promise<boolean> {
  if (!env.ETI_EXECUTION_LOG) return false;
  try {
    const body = JSON.stringify({ report, generatedAtMs: now });
    await env.ETI_EXECUTION_LOG.put(keyFor(report.date), body, { expirationTtl: TTL_SECONDS });
    await env.ETI_EXECUTION_LOG.put(LATEST_KEY, body, { expirationTtl: TTL_SECONDS });
    return true;
  } catch { return false; }
}

export async function generateAndStore(env: DailyEnv, now: number, deps: DailyDeps = {}): Promise<Stored & { stored: boolean }> {
  const data = await (deps.collect ?? collectDailyData)(env, now);
  const report = buildDailyReport(data), stored = await kvPut(env, report, now), s = { report, generatedAtMs: now };
  memo = s;
  return { ...s, stored };
}

const text = (report: DailyReport, status = 200) => new Response(report.markdown, { status, headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" } });

export async function handleDailyReport(req: Request, env: DailyEnv, deps: DailyDeps = {}): Promise<Response> {
  const url = new URL(req.url), q = url.searchParams, now = (deps.now ?? Date.now)(), path = url.pathname.replace(/\/+$/, "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...HEADERS, "access-control-allow-methods": "GET,OPTIONS" } });
  if (req.method !== "GET") return json({ error: "method_not_allowed", note: "The daily report is analytical and read-only." }, 405, { allow: "GET, OPTIONS" });

  if (path === "/api/daily-report/status") {
    const ev = await eventsFor(env, now).catch(() => null);
    return json({ engine: "ETI Daily Intelligence Report", title: "ETI GLOBAL MARKET INTELLIGENCE", tradingDay: tradingDayInfo(now),
      inputs: {
        crypto: "connected (Binance/Bybit/OKX public APIs)",
        forex_and_gold: sourceFor("forex", env) ? "connected (operator FX adapter)" : "not connected: set ETI_FX_CANDLES_URL (and ETI_FX_QUOTE_URL); EUR/USD and XAU/USD report schedule and calendar conditions only",
        equities: sourceFor("equities", env) ? "connected (Alpaca Market Data, IEX feed)" : "not connected: set ALPACA_API_KEY and ALPACA_SECRET_KEY; no stock can be selected",
        economicCalendar: ev ? { status: ev.status, events: ev.events.length, sources: ev.sources, error: ev.error ?? null } : { status: "error" },
        storage: env.ETI_EXECUTION_LOG ? "ETI_EXECUTION_LOG bound: generated reports are kept 14 days" : "no KV bound: reports are generated on demand and not stored",
      },
      limits: { subrequestBudget: budgetOf(env), costs: COST, watchlist: parseStocks(env.ETI_DAILY_STOCKS), planningRiskPerTradePct: riskPctOf(env), cacheSeconds: FRESH_MS / 1000, minRefreshSeconds: REFRESH_MIN_MS / 1000 },
      schedule: { automatic: env.ETI_DAILY_ENABLED === "false" ? "disabled (ETI_DAILY_ENABLED=false)" : `weekdays from ${String(dailyHour(env)).padStart(2, "0")}:00 UTC on the Worker cron ticks, once per day`, kv: !!env.ETI_EXECUTION_LOG }, submitsOrders: false });
  }
  if (path !== "/api/daily-report" && path !== "/api/daily-report/latest") return json({ error: "not_found" }, 404);

  const format = (q.get("format") || "json").toLowerCase();
  if (!FORMATS.includes(format)) return json({ error: "invalid_format", formats: FORMATS }, 400);
  const date = q.get("date");
  if (date !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) return json({ error: "invalid_date", detail: "date must be YYYY-MM-DD" }, 400);
    const old = await kvGet(env, keyFor(date));
    if (!old) return json({ error: "not_found", detail: env.ETI_EXECUTION_LOG ? `No stored report for ${date} (reports are kept 14 days and only exist for days a report was generated).` : "No KV namespace is bound, so past reports are not stored." }, 404);
    return format === "json" ? json({ ...old.report, cache: { hit: true, stored: true, ageSeconds: Math.round((now - old.generatedAtMs) / 1000) } }, 200, { "x-eti-cache": "stored" }) : text(old.report);
  }

  const today = new Date(now).toISOString().slice(0, 10), refresh = q.get("refresh") === "1" || q.get("refresh") === "true";
  let cur: Stored | null = memo && memo.report.date === today ? memo : null;
  if (!cur || now - cur.generatedAtMs >= FRESH_MS) { const kv = await kvGet(env, LATEST_KEY); if (kv && kv.report.date === today && (!cur || kv.generatedAtMs > cur.generatedAtMs)) { cur = kv; memo = kv; } }
  const age = cur ? now - cur.generatedAtMs : Infinity, fresh = age < FRESH_MS, limited = refresh && age < REFRESH_MIN_MS;
  let hit = !!cur && (fresh && !refresh || limited), stored = true;
  if (!hit) {
    try { const g = await generateAndStore(env, now, deps); cur = g; stored = g.stored; hit = false; }
    catch (e) { return json({ error: "report_generation_failed", detail: e instanceof Error ? e.message : "unknown", note: "No report is shown because none could be produced." }, 502); }
  }
  const report = cur!.report, ageSeconds = Math.round((now - cur!.generatedAtMs) / 1000);
  const cache = { hit, stored: hit ? true : stored, ageSeconds, refreshLimited: limited || undefined, freshForSeconds: Math.max(0, Math.round((FRESH_MS - (now - cur!.generatedAtMs)) / 1000)) };
  if (format === "json") return json({ ...report, cache }, 200, { "x-eti-cache": hit ? "hit" : "miss" });
  return new Response(report.markdown, { status: 200, headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8", "x-eti-cache": hit ? "hit" : "miss" } });
}

export const dailyHour = (env: { ETI_DAILY_HOUR_UTC?: string }): number => { const n = Number(env.ETI_DAILY_HOUR_UTC); return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 6; };

/** Cron entry: generate and store one report per UTC weekday once the configured hour has passed. Returns what it did, for logs and tests. */
export async function runDailyReportCycle(env: DailyEnv, now = Date.now(), deps: DailyDeps = {}): Promise<"disabled" | "no_kv" | "weekend" | "too_early" | "exists" | "generated" | "generated_not_stored"> {
  if (env.ETI_DAILY_ENABLED === "false") return "disabled";
  if (!env.ETI_EXECUTION_LOG) return "no_kv";
  const d = new Date(now); if (!tradingDayInfo(now).isTradingDay) return "weekend";
  if (d.getUTCHours() < dailyHour(env)) return "too_early";
  if (await kvGet(env, keyFor(d.toISOString().slice(0, 10)))) return "exists";
  const g = await generateAndStore(env, now, deps);
  return g.stored ? "generated" : "generated_not_stored";
}
