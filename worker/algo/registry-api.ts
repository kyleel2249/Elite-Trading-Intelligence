// Routes for the validated-expectancy store and the signal journal. Reads are public (analytical data only); every write is authenticated
// with the same bearer token as the execution/paper APIs. Nothing here can place an order.
//
//   GET  /api/algo/expectancy?strategy=&symbol=            what the validator will be told for this strategy/symbol
//   POST /api/algo/expectancy                              {strategy,symbol?,source,expectancyR,samples,ciLow95,...} or {fromReplay: <replay result>}
//   POST /api/algo/expectancy/refresh-paper                {strategy?,symbol?}  derive evidence from recorded paper trades
//   GET  /api/algo/journal?limit=&cursor=&symbol=&strategy=&decision=&outcome=
//   GET  /api/algo/journal/entry?id=
//   GET  /api/algo/journal/stats?days=
//   POST /api/algo/journal/resolve                         {limit?}  resolve pending entries against closed bars (max 3 per call)
import { authorized, type ExecutionEnv } from "../execution.ts";
import { getMarketData, providerOrder, type Kline, type MarketEnv } from "../market.ts";
import { checkRecord, expectancyFor, expectancyStatus, MAX_AGE_MS, recordFromReplay, recordFromTrades, saveRecord, SOURCES } from "./expectancy.ts";
import { evaluateOutcome, getEntry, listEntries, statsFor, updateResolution } from "./journal.ts";
import { kvOf } from "./kv.ts";
import { KVPaperStore } from "./paper.ts";
import { MIN_SAMPLE } from "./performance.ts";
import { DEFAULT_WEIGHTS, EXECUTION_TF, TF_SECONDS, type Strategy } from "./timeframes.ts";

export interface RegistryEnv extends ExecutionEnv, MarketEnv { ETI_PAPER_STRATEGY?: string; ETI_JOURNAL_ENABLED?: string }
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "access-control-allow-origin": "*" };
const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: HEADERS });
const STRATEGIES = Object.keys(DEFAULT_WEIGHTS) as Strategy[];
const ROUTES: Record<string, string> = { "/api/algo/expectancy": "GET,POST", "/api/algo/expectancy/refresh-paper": "POST", "/api/algo/journal": "GET", "/api/algo/journal/entry": "GET", "/api/algo/journal/stats": "GET", "/api/algo/journal/resolve": "POST" };
const RULES = `Evidence must come from a replay of the real engine chain or from recorded paper trades (sources: ${SOURCES.join(", ")}), with at least ${MIN_SAMPLE} trades, no older than ${MAX_AGE_MS / 86_400_000} days. A positive claim also needs a 95% interval above zero.`;

export async function handleAlgoRegistry(req: Request, env: RegistryEnv, deps: { now?: () => number } = {}): Promise<Response> {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, ""), now = (deps.now ?? Date.now)(), allowed = ROUTES[path];
  if (!allowed) return reply({ error: "not_found" }, 404);
  if (!allowed.split(",").includes(req.method)) return reply({ error: "method_not_allowed", allowed }, 405);
  if (req.method === "POST" && !(await authorized(req, env))) return reply({ error: "unauthorized" }, 401);
  const kv = kvOf(env), q = url.searchParams;

  if (path === "/api/algo/expectancy" && req.method === "GET") {
    const strategy = (q.get("strategy") || "intraday") as Strategy, symbol = (q.get("symbol") || "*").toUpperCase();
    if (!STRATEGIES.includes(strategy) || (symbol !== "*" && !/^[A-Z0-9]{5,20}$/.test(symbol))) return reply({ error: "invalid_strategy_or_symbol", strategies: STRATEGIES }, 400);
    return reply({ strategy, symbol, lookup: expectancyStatus(await expectancyFor(env, strategy, symbol, now)), rules: RULES });
  }
  if (!kv) return reply({ error: "store_not_configured", message: "Bind the ETI_EXECUTION_LOG KV namespace; expectancy evidence and the signal journal are stored there." }, 503);

  if (path === "/api/algo/expectancy" && req.method === "POST") {
    const body: any = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return reply({ error: "invalid_json_body" }, 400);
    const raw = body.fromReplay ? recordFromReplay(body.fromReplay) : body;
    if (raw === null) return reply({ error: "insufficient_evidence", message: `The replay has fewer than ${MIN_SAMPLE} closed trades, so no expectancy can be recorded.` }, 422);
    const c = checkRecord(raw, now);
    if (!c.ok) return reply({ error: "rejected", errors: c.errors, rules: RULES }, 422);
    await saveRecord(kv, c.record);
    return reply({ saved: c.record, lookup: expectancyStatus(await expectancyFor(env, c.record.strategy, c.record.symbol, now)) });
  }
  if (path === "/api/algo/expectancy/refresh-paper") {
    const body: any = await req.json().catch(() => ({})), strategy = (body?.strategy ?? env.ETI_PAPER_STRATEGY) as Strategy, symbol = body?.symbol ? String(body.symbol).toUpperCase() : "*";
    if (!STRATEGIES.includes(strategy)) return reply({ error: "strategy_required", message: "Say which strategy produced the paper trades (body.strategy or ETI_PAPER_STRATEGY).", strategies: STRATEGIES }, 400);
    const state = await new KVPaperStore(kv).load(), all = state?.closed ?? [], trades = symbol === "*" ? all : all.filter(t => t.symbol === symbol);
    const raw = recordFromTrades(trades, { strategy, symbol, source: "paper" });
    if (raw === null) return reply({ error: "insufficient_evidence", closedTrades: trades.length, minimum: MIN_SAMPLE }, 422);
    const c = checkRecord(raw, now);
    if (!c.ok) return reply({ error: "rejected", errors: c.errors }, 422);
    await saveRecord(kv, c.record);
    return reply({ saved: c.record, lookup: expectancyStatus(await expectancyFor(env, strategy, symbol, now)) });
  }

  if (path === "/api/algo/journal") {
    const r = await listEntries(kv, { symbol: q.get("symbol")?.toUpperCase(), strategy: q.get("strategy") ?? undefined, decision: q.get("decision")?.toUpperCase(), outcome: q.get("outcome") ?? undefined, limit: Number(q.get("limit") ?? 50) || 50, cursor: q.get("cursor") ?? undefined });
    return r ? reply({ ...r, recording: env.ETI_JOURNAL_ENABLED === "true" ? "enabled" : "disabled (set ETI_JOURNAL_ENABLED=true to record from the signal routes)" }) : reply({ error: "listing_not_supported" }, 501);
  }
  if (path === "/api/algo/journal/entry") {
    const e = await getEntry(kv, q.get("id") ?? "");
    return e ? reply(e) : reply({ error: "not_found" }, 404);
  }
  if (path === "/api/algo/journal/stats") {
    const days = Math.min(Math.max(Number(q.get("days") ?? 30) || 30, 1), 90), s = await statsFor(kv, now - days * 86_400_000);
    return s ? reply({ days, ...s }) : reply({ error: "listing_not_supported" }, 501);
  }
  if (path === "/api/algo/journal/resolve") {
    const body: any = await req.json().catch(() => ({})), limit = Math.min(Math.max(Number(body?.limit ?? 3) || 3, 1), 3), page = await listEntries(kv, { outcome: "pending", limit: 100 });
    if (!page) return reply({ error: "listing_not_supported" }, 501);
    const out: unknown[] = [], order = providerOrder(env, null);
    for (const item of [...page.entries].reverse().slice(0, limit)) {   // oldest pending first
      const e = await getEntry(kv, item.id); if (!e) continue;
      try {
        const interval = now - e.ts <= 4.5 * 3600_000 ? "1m" : EXECUTION_TF[e.strategy], barMs = TF_SECONDS[interval] * 1000;
        const bars = (await getMarketData("klines", { symbol: e.symbol, interval, limit: 300 }, order)).data as Kline[], res = evaluateOutcome(e, bars, barMs, now);
        if (res.status !== "pending") await updateResolution(kv, e, res);
        out.push({ id: e.id, outcome: res.status, r: res.r ?? null, granularity: res.granularity ?? null, updated: res.status !== "pending" });
      } catch (err) { out.push({ id: e.id, error: err instanceof Error ? err.message : "unknown" }); }
    }
    return reply({ processed: out.length, results: out, pendingRemaining: Math.max(0, page.entries.length - out.length), note: "Hypothetical outcomes only; see /api/algo/journal/stats." });
  }
  return reply({ error: "not_found" }, 404);
}
