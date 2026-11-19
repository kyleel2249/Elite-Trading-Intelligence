/**
 * JARVIS — orchestration, context and command layer for ETI's existing agent council.
 *
 * JARVIS delegates analysis to the existing deterministic agents and never replaces
 * the Commander, Risk Manager, Security Analyst or execution gateway. Its tools are
 * deliberately allow-listed and read-only. The only memory stored here is a bounded
 * operational conversation summary in KV; exchange credentials and account secrets
 * are never accepted or persisted.
 */
import type { ExecutionEnv } from "../execution.ts";

export interface JarvisEnv extends ExecutionEnv {
  ETI_EXECUTION_LOG?: any;
  ANTHROPIC_API_KEY?: string;
}
interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const MEMORY_KEY = "jarvis:memory:v1";
const MEMORY_TTL = 60 * 60 * 24 * 30;
const MAX_MEMORY = 20;

export type JarvisIntent = "analyze" | "status" | "audit" | "deep_review" | "help";
export interface JarvisCommand {
  intent: JarvisIntent;
  symbol: string;
  interval: string;
  message: string;
}
export function parseJarvisCommand(message: string): JarvisCommand {
  const text = message.trim().slice(0, 2000);
  const symbolMatch = text.match(/\b([A-Z0-9]{2,12}(?:USDT|USDC|USD|BTC|ETH))\b/i);
  const symbol = (symbolMatch?.[1] ?? "BTCUSDT").toUpperCase();
  const intervalMatch = text.match(/\b(1m|3m|5m|15m|30m|1h|2h|4h|6h|12h|1d|1w)\b/i);
  const lower = text.toLowerCase();
  let intent: JarvisIntent = "help";
  if (/\b(deep review|llm review|second opinion|explain in depth)\b/.test(lower)) intent = "deep_review";
  else if (/\b(audit|performance|accuracy|historical decisions|trade history)\b/.test(lower)) intent = "audit";
  else if (/\b(status|health|system check|autopilot|agent status|how are you)\b/.test(lower)) intent = "status";
  else if (symbolMatch || /\b(analy[sz]e|analysis|market|chart|signal|trade setup|should i buy|should i sell|opportunity)\b/.test(lower)) intent = "analyze";
  return { intent, symbol, interval: intervalMatch?.[1]?.toLowerCase() ?? "1h", message: text };
}

async function bearerOk(req: Request, env: JarvisEnv): Promise<boolean> {
  const token = env.ETI_EXECUTION_TOKEN, supplied = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token || !supplied || supplied.length !== token.length) return false;
  const [a, b] = await Promise.all([token, supplied].map(v => crypto.subtle.digest("SHA-256", new TextEncoder().encode(v))));
  const x = new Uint8Array(a), y = new Uint8Array(b); let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
async function readMemory(env: JarvisEnv): Promise<any[]> {
  if (!env.ETI_EXECUTION_LOG) return [];
  try {
    const value = JSON.parse(await env.ETI_EXECUTION_LOG.get(MEMORY_KEY) || "[]");
    return Array.isArray(value) ? value.slice(-MAX_MEMORY) : [];
  } catch { return []; }
}
async function remember(env: JarvisEnv, item: Record<string, unknown>): Promise<boolean> {
  if (!env.ETI_EXECUTION_LOG) return false;
  try {
    const history = await readMemory(env);
    history.push({ at: new Date().toISOString(), ...item });
    await env.ETI_EXECUTION_LOG.put(MEMORY_KEY, JSON.stringify(history.slice(-MAX_MEMORY)), { expirationTtl: MEMORY_TTL });
    return true;
  } catch { return false; }
}
async function invoke<E>(app: App<E>, env: E, url: URL, path: string, method = "GET", token?: string, body?: unknown): Promise<any> {
  const headers = new Headers();
  if (token) headers.set("authorization", "Bearer " + token);
  if (body !== undefined) headers.set("content-type", "application/json");
  const req = new Request(new URL(path, url.origin), { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await app.fetch(req, env);
  const data = await res.json().catch(() => ({ error: "invalid_upstream_response" }));
  return { status: res.status, data };
}

export function withJarvis<E extends JarvisEnv>(base: App<E>): App<E> {
  return {
    async fetch(request, env) {
      const url = new URL(request.url), path = url.pathname;
      if (path !== "/api/agents/jarvis" && path !== "/api/agents/jarvis/memory") return base.fetch(request, env);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...JSON_HEADERS, "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "authorization,content-type" } });
      if (!(await bearerOk(request, env))) return reply({ error: "unauthorized" }, 401);
      if (path.endsWith("/memory")) {
        if (request.method !== "GET") return reply({ error: "method_not_allowed" }, 405);
        return reply({ schema: "eti.jarvis.memory/1", available: !!env.ETI_EXECUTION_LOG, entries: await readMemory(env), maxEntries: MAX_MEMORY, ttlDays: 30 });
      }
      if (request.method === "GET") return reply({
        schema: "eti.jarvis/1", name: "JARVIS", role: "ETI agent orchestration and situational-awareness layer",
        capabilities: ["natural-language command routing", "existing-agent council coordination", "market analysis delegation", "runtime and autopilot health checks", "performance audit retrieval", "optional advisory deep review", "bounded operational memory", "risk-aware explanations"],
        tools: ["analyze", "status", "audit", "deep_review", "help"], memoryAvailable: !!env.ETI_EXECUTION_LOG,
        safety: { analysisReadOnly: true, liveExecutionAllowed: false, commanderAndRiskVetoPreserved: true, secretsStored: false },
      });
      if (request.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
      let body: any;
      try { const raw = await request.text(); if (raw.length > 8000) return reply({ error: "body_too_large" }, 413); body = raw.trim() ? JSON.parse(raw) : {}; }
      catch { return reply({ error: "invalid_json" }, 400); }
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.message !== "string" || !body.message.trim()) return reply({ error: "message_required" }, 400);
      const command = parseJarvisCommand(body.message), token = env.ETI_EXECUTION_TOKEN!;
      let result: any;
      if (command.intent === "analyze") {
        if (!/^[A-Z0-9]{5,20}$/.test(command.symbol)) return reply({ error: "invalid_symbol" }, 400);
        const upstream = await invoke(base, env, url, "/api/agents/analyze", "POST", token, { symbol: command.symbol, interval: command.interval, providers: true });
        if (upstream.status !== 200) result = { error: upstream.data?.error ?? "analysis_failed", detail: upstream.data };
        else {
          const a = upstream.data;
          result = {
            kind: "market_analysis", symbol: a.symbol, interval: a.interval, generatedAt: a.generatedAt,
            decision: a.decision, consensus: a.deliberation,
            marketRead: {
              direction: a.deliberation?.direction ?? "none",
              agreement: a.deliberation?.agreement ?? 0,
              technicalSummary: a.reports?.find((r: any) => r.agent === "technical")?.summary ?? "Technical report unavailable.",
              entrySetup: (() => {
                const t = a.reports?.find((r: any) => r.agent === "technical");
                const ev = (label: string) => t?.evidence?.find((e: any) => e.label === label)?.value;
                const eligible = ev("liquidity_fvg_autopilot_eligible") === true;
                return { status: eligible ? "confirmed" : "not_actionable", direction: ev("liquidity_fvg_direction") ?? "WAIT", entry: eligible ? ev("liquidity_fvg_entry") : null, stop: eligible ? ev("liquidity_fvg_stop") : null, reason: eligible ? "Liquidity sweep, market structure and FVG conditions passed the fusion engine." : (ev("liquidity_fvg_autopilot_eligible") === false ? "No confirmed actionable liquidity/FVG setup. Do not treat the last close as an entry." : "Liquidity/FVG evidence unavailable.") };
              })(),
              tradeReadiness: a.decision?.action === "NO_TRADE" ? "not_ready" : "risk_approved",
              accountState: a.risk?.checks?.find((c: any) => c.id === "account_state")?.passed ? "available" : "missing_or_unverified",
              priceCrossCheck: a.dataQuality?.priceCrossCheck ?? { status: "not_performed" },
            },
            agents: (a.reports ?? []).map((r: any) => ({ agent: r.agent, status: r.status, stance: r.stance, confidence: r.confidence, summary: r.summary, evidence: r.evidence, missingInputs: r.missingInputs, warnings: r.warnings })),
            risk: a.risk, security: a.security, dataQuality: a.dataQuality,
            explanation: a.decision?.rationale ?? [],
            nextSteps: [
              ...(a.risk?.vetoes?.includes("account_state") ? ["Connect or supply verified account equity and available balance; do not bypass the Risk Manager."] : []),
              ...(a.risk?.checks?.some((c: any) => c.id === "pnl_state_unknown" && !c.passed) ? ["Supply verified daily P&L and account drawdown so loss limits can be checked."] : []),
              ...(a.dataQuality?.priceCrossCheck?.status !== "verified" ? ["Independent exchange price cross-check was not performed; provider confirmation is incomplete."] : []),
              ...(a.decision?.action === "NO_TRADE" ? ["Wait for a confirmed setup and all risk checks to pass; no order is authorised."] : []),
            ],
            disclosures: a.disclosures,
          };
        }
      } else if (command.intent === "status") {
        const [runtime, autopilot, roster] = await Promise.all([
          invoke(base, env, url, "/api/agents/runtime"),
          invoke(base, env, url, "/api/agents/autopilot"),
          invoke(base, env, url, "/api/agents"),
        ]);
        result = { kind: "system_status", runtime: runtime.data, autopilot: autopilot.data, agentCount: roster.data?.agents?.length ?? null, riskVeto: "binding", liveExecutionAllowed: false };
      } else if (command.intent === "audit") {
        const upstream = await invoke(base, env, url, "/api/agents/audit", "GET", token);
        result = { kind: "performance_audit", ...upstream.data, status: upstream.status };
      } else if (command.intent === "deep_review") {
        if (!env.ANTHROPIC_API_KEY) result = { kind: "deep_review_unavailable", message: "The advisory LLM reviewer is not configured. Set ANTHROPIC_API_KEY as a Worker secret; ordinary deterministic analysis remains available." };
        else {
          const upstream = await invoke(base, env, url, "/api/agents/brief", "POST", token, { symbol: command.symbol, interval: command.interval, providers: true });
          result = { kind: "advisory_deep_review", ...upstream.data, status: upstream.status };
        }
      } else {
        result = { kind: "help", commands: [
          "Analyse BTCUSDT on 15m",
          "Check system status and autopilot",
          "Show performance audit",
          "Run a deep review on ETHUSDT 1h",
        ], note: "JARVIS routes requests to ETI's existing agents. It does not invent missing provider data or override risk controls." };
      }
      const summary = command.intent === "analyze" ? String(result?.decision?.action ?? result?.error ?? "analysis complete") :
        command.intent === "status" ? "runtime and autopilot status checked" :
        command.intent === "audit" ? "performance audit retrieved" :
        command.intent === "deep_review" ? "advisory review requested" : "help displayed";
      const memorySaved = await remember(env, { intent: command.intent, symbol: command.symbol, interval: command.interval, summary });
      return reply({ schema: "eti.jarvis.response/1", assistant: "JARVIS", command: { intent: command.intent, symbol: command.symbol, interval: command.interval }, result, memory: { saved: memorySaved, entries: memorySaved ? (await readMemory(env)).length : null }, safety: { readOnly: true, advisoryOnly: true, liveExecutionAllowed: false, riskVetoPreserved: true } });
    },
  };
}
