/**
 *   POST /api/agents/brief   bearer-authenticated (it spends LLM credit). Runs the deterministic analysis, then asks the LLM Evidence
 *   Reviewer for an advisory review. The decision in the response is the deterministic Commander decision, untouched.
 */
import { AllProvidersFailed, INTERVALS } from "../market.ts";
import type { MarketInput, SuppliedData } from "./types.ts";
import { analyze } from "./orchestrator.ts";
import { integrityFromEnv, loadMarket, mergeSupplied } from "./route.ts";
import type { AgentsEnv, MarketLoader, ProviderLoader } from "./route.ts";
import { fetchProviderData } from "./providers.ts";
import { requestBrief } from "./llm.ts";
import type { LlmEnv } from "./llm.ts";

export type LlmAgentsEnv = AgentsEnv & LlmEnv & { ETI_LLM_MAX_PER_HOUR?: string };
interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }
export interface LlmDeps { loadMarket?: MarketLoader; loadProviders?: ProviderLoader; fetchImpl?: typeof fetch; now?: () => number }

const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: HEADERS });

async function bearerOk(req: Request, env: { ETI_EXECUTION_TOKEN?: string }): Promise<boolean> {
  const token = env.ETI_EXECUTION_TOKEN, supplied = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !supplied || supplied.length !== token.length) return false;
  const [a, b] = await Promise.all([token, supplied].map((v) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
  const x = new Uint8Array(a), y = new Uint8Array(b); let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

export function withLlmBrief<E extends LlmAgentsEnv>(base: App<E>, deps: LlmDeps = {}): App<E> {
  const load = deps.loadMarket ?? loadMarket, clock = deps.now ?? Date.now;
  const loadProv: ProviderLoader = deps.loadProviders ?? ((env, symbol, now) => fetchProviderData(env, symbol, now));
  return {
    async fetch(request, env) {
      const path = new URL(request.url).pathname;
      if (path !== "/api/agents/brief") return base.fetch(request, env);
      if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
      if (!(await bearerOk(request, env))) return reply({ error: "unauthorized" }, 401);
      if (!env.ANTHROPIC_API_KEY) return reply({ error: "llm_not_configured", message: "Set the ANTHROPIC_API_KEY Worker secret to enable the advisory LLM review." }, 503);
      const kv = env.ETI_EXECUTION_LOG;
      if (!kv) return reply({ error: "audit_log_not_configured", message: "The KV binding is required for the hourly LLM usage cap." }, 503);
      let body: Record<string, unknown> = {};
      try { const t = await request.text(); if (t.length > 50_000) return reply({ error: "body_too_large" }, 413); body = t.trim() ? JSON.parse(t) : {}; } catch { return reply({ error: "invalid_json" }, 400); }
      const symbol = typeof body.symbol === "string" ? body.symbol.toUpperCase() : "BTCUSDT", interval = typeof body.interval === "string" && body.interval ? body.interval : "1h";
      if (!/^[A-Z0-9]{5,20}$/.test(symbol)) return reply({ error: "invalid_symbol" }, 400);
      if (!INTERVALS.includes(interval)) return reply({ error: "invalid_interval", intervals: INTERVALS }, 400);

      const hour = Math.floor(clock() / 3_600_000), key = "llm:hour:" + hour, max = Number(env.ETI_LLM_MAX_PER_HOUR ?? "20");
      let used = 0; try { used = Number((await kv.get(key)) ?? 0) || 0; } catch { return reply({ error: "usage_cap_unavailable" }, 503); }
      if (!(max > 0) || used >= max) return reply({ error: "llm_hourly_cap_reached", used, max: Number.isFinite(max) ? max : null }, 429);
      await kv.put(key, String(used + 1), { expirationTtl: 7200 });

      let market: MarketInput;
      try { market = await load(env, symbol, interval, { provider: null, benchmark: null }); }
      catch (e) { return reply({ error: "market_data_unavailable", detail: e instanceof AllProvidersFailed ? e.attempts.map((a) => `${a.provider}:${a.errorClass}`) : "loader_error" }, 503); }
      let pSup: SuppliedData = {};
      if (body.providers !== false) { try { pSup = (await loadProv(env, symbol, clock())).supplied; } catch { pSup = {}; } }
      const result = analyze({ market, supplied: mergeSupplied(pSup, { fundamentals: body.fundamentals, macro: body.macro, news: body.news, onchain: body.onchain }), integrity: integrityFromEnv(env), now: clock() });
      const review = await requestBrief(env, result, deps.fetchImpl ?? fetch);
      const decision = { action: result.decision.action, confidence: result.decision.confidence, vetoedBy: result.decision.vetoedBy };
      if (!review.ok) return reply({ advisory: true, error: review.error, llmStatus: review.status ?? null, analysisId: result.id, decision }, 502);
      return reply({ advisory: true, notice: "LLM review is advisory only: it cannot change the decision, the Risk Manager or any order.", analysisId: result.id, symbol, interval, generatedAt: result.generatedAt, decision, brief: review.brief, model: review.model, usage: review.usage });
    },
  };
}
