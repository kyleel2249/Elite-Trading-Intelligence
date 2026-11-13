/**
 * LLM Evidence Reviewer: an ADVISORY layer on top of the deterministic agents.
 * The model receives the structured analysis (untrusted data, no tools) and returns a schema-validated review:
 * contradictions, weak evidence, things to verify. Its output is never merged into the decision, never reaches the
 * Risk Manager or the execution path, and cannot place or change an order.
 */
import { AGENT_IDS } from "./types.ts";
import type { AnalysisResult } from "./orchestrator.ts";
import { renderSystem } from "../llm/templates.ts";
import { compactJson } from "../llm/compress.ts";
import { estimateTokens } from "../llm/tokens.ts";
import { cacheGet, cacheKey, cachePut, recordUsage, savingsPct } from "../llm/usage.ts";
import type { KvLike } from "../llm/usage.ts";

export interface LlmEnv { ANTHROPIC_API_KEY?: string; ETI_LLM_MODEL?: string; ETI_LLM_MAX_INPUT_TOKENS?: string; ETI_LLM_CACHE_TTL?: string }
export const DEFAULT_MODEL = "claude-sonnet-5-5";

export const REVIEWER_ROLE = "evidence_reviewer";
/** Rendered from the versioned templates in worker/llm/templates.ts (global security policy + role contract), compressed and proven to keep every critical instruction. */
export const SYSTEM_PROMPT = renderSystem(REVIEWER_ROLE).text;

const cut = (s: unknown, n: number) => String(s ?? "").slice(0, n);

export function buildBriefInput(r: AnalysisResult, withEvidence = true, lean = false) {
  return {
    symbol: r.symbol, interval: r.interval, generatedAt: r.generatedAt,
    commanderDecision: { action: r.decision.action, confidence: r.decision.confidence, vetoedBy: r.decision.vetoedBy, agreement: r.decision.consensus.agreement, participating: r.decision.consensus.participating, abstaining: r.decision.consensus.abstaining.map((a) => ({ agent: a.agent, reason: cut(a.reason, 160) })), rationale: r.decision.rationale.slice(0, 8).map((x) => cut(x, 300)) },
    disagreements: r.decision.disagreements.slice(0, lean ? 2 : 5).map((d) => ({ topic: d.topic, explanation: cut(d.explanation, 400), resolution: cut(d.resolution, 300), positions: d.positions.map((p) => ({ agent: p.agent, stance: p.stance, confidence: p.confidence })) })),
    risk: r.risk ? { decision: r.risk.decision, vetoes: r.risk.vetoes, warnings: r.risk.warnings.slice(0, 6).map((x) => cut(x, 200)) } : null,
    security: { severity: r.security.severity, flags: r.security.flags.slice(0, 8).map((f) => ({ id: f.id, severity: f.severity })) },
    agents: r.reports.map((rep) => ({
      agent: rep.agent, status: rep.status, stance: rep.stance, confidence: rep.confidence, summary: cut(rep.summary, 300),
      warnings: rep.warnings.slice(0, lean ? 1 : 3).map((x) => cut(x, lean ? 120 : 200)), missingInputs: rep.missingInputs.slice(0, lean ? 1 : 3).map((x) => cut(x, lean ? 120 : 200)),
      ...(withEvidence ? { evidence: rep.evidence.slice(0, 6).map((e) => ({ label: cut(e.label, 80), value: typeof e.value === "string" ? cut(e.value, 80) : e.value })) } : {}),
    })),
    dataQuality: r.dataQuality,
  };
}

export interface EvidenceBrief {
  summary: string; agentNotes: { agent: string; assessment: string; concern: string }[];
  contradictions: string[]; weakEvidence: string[]; verifyNext: string[]; evidenceStrength: "low" | "medium" | "high";
}
/** Strict validation: anything that does not match the schema is rejected, unknown keys are dropped, lengths are capped. */
export function parseBrief(text: string): EvidenceBrief | null {
  const m = /\{[\s\S]*\}/.exec(text); if (!m) return null;
  let j: any; try { j = JSON.parse(m[0]); } catch { return null; }
  if (!j || typeof j.summary !== "string" || !["low", "medium", "high"].includes(j.evidenceStrength)) return null;
  const strs = (v: unknown, n: number, len: number) => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, n).map((x: string) => x.slice(0, len)) : []);
  const notes = Array.isArray(j.agentNotes)
    ? j.agentNotes.filter((x: any) => x && typeof x.agent === "string" && (AGENT_IDS as readonly string[]).includes(x.agent) && typeof x.assessment === "string").slice(0, 12)
      .map((x: any) => ({ agent: x.agent as string, assessment: x.assessment.slice(0, 400), concern: typeof x.concern === "string" ? x.concern.slice(0, 300) : "" }))
    : [];
  return { summary: j.summary.slice(0, 900), agentNotes: notes, contradictions: strs(j.contradictions, 10, 300), weakEvidence: strs(j.weakEvidence, 10, 300), verifyNext: strs(j.verifyNext, 10, 300), evidenceStrength: j.evidenceStrength };
}

export type ContextLevel = "full" | "no_evidence" | "lean";
export interface TokenReport { promptVersion: string; contextLevel: ContextLevel; estimatedTokensRaw: number; estimatedTokensSent: number; savedPct: number; dictionaryEntries: number; budget: number }
export interface BriefOptions { kv?: KvLike; now?: number }

/** Intelligent context selection: the fullest document that fits the token budget; nothing is trimmed unless the budget forces it. */
export function selectContext(r: AnalysisResult, budget: number) {
  const system = renderSystem(REVIEWER_ROLE), wrap = "Review this analysis document:\n";
  const rawDoc = JSON.stringify(buildBriefInput(r, true)), rawTokens = system.estimatedTokensRaw + estimateTokens(wrap + rawDoc);
  const tiers: [ContextLevel, any][] = [["full", buildBriefInput(r, true)], ["no_evidence", buildBriefInput(r, false)], ["lean", buildBriefInput(r, false, true)]];
  let pick = tiers[tiers.length - 1], packed = compactJson(pick[1]);
  for (const t of tiers) { const c = compactJson(t[1]); if (system.estimatedTokens + estimateTokens(wrap + c.text) <= budget) { pick = t; packed = c; break; } if (t === tiers[tiers.length - 1]) { pick = t; packed = c; } }
  const sent = system.estimatedTokens + estimateTokens(wrap + packed.text);
  const report: TokenReport = { promptVersion: system.version, contextLevel: pick[0], estimatedTokensRaw: rawTokens, estimatedTokensSent: sent, savedPct: rawTokens ? Math.round((1 - sent / rawTokens) * 1000) / 10 : 0, dictionaryEntries: packed.dictionary.length, budget };
  return { system, content: wrap + packed.text, document: pick[1], report };
}

export type BriefResult =
  | { ok: true; brief: EvidenceBrief; model: string; usage: { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheCreationTokens: number | null }; tokens: TokenReport; cached: boolean }
  | { ok: false; error: "llm_not_configured" | "llm_http_error" | "invalid_model_output" | "llm_unreachable"; status?: number };

export async function requestBrief(env: LlmEnv, result: AnalysisResult, fetchImpl: typeof fetch = fetch, opts: BriefOptions = {}): Promise<BriefResult> {
  if (!env.ANTHROPIC_API_KEY) return { ok: false, error: "llm_not_configured" };
  const model = env.ETI_LLM_MODEL || DEFAULT_MODEL, now = opts.now ?? Date.now();
  const budget = Math.max(1000, Number(env.ETI_LLM_MAX_INPUT_TOKENS) || 8000), ttl = Number(env.ETI_LLM_CACHE_TTL ?? "900");
  const ctx = selectContext(result, budget), key = await cacheKey(model, ctx.report.promptVersion, ctx.document);
  if (ttl > 0) {
    const hit = await cacheGet(opts.kv, key);
    if (hit && parseBrief(JSON.stringify(hit.brief))) {
      await recordUsage(opts.kv, now, { estimatedTokensRaw: ctx.report.estimatedTokensRaw, estimatedTokensSent: 0, actualInputTokens: null, actualOutputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, cacheHit: true });
      return { ok: true, brief: hit.brief, model: hit.model ?? model, usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null }, tokens: { ...ctx.report, estimatedTokensSent: 0, savedPct: 100 }, cached: true };
    }
  }
  try {
    const r = await fetchImpl("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      // The system block is identical on every call, so it is marked cacheable (the provider applies caching only above its minimum prompt size and reports what it did).
      body: JSON.stringify({ model, max_tokens: 1200, system: [{ type: "text", text: ctx.system.text, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: ctx.content }] }),
    });
    const data: any = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: "llm_http_error", status: r.status };
    const text = Array.isArray(data.content) ? data.content.filter((c: any) => c?.type === "text" && typeof c.text === "string").map((c: any) => c.text).join("\n") : "";
    const brief = parseBrief(text);
    if (!brief) return { ok: false, error: "invalid_model_output" };
    const u = data.usage ?? {}, num = (x: unknown) => (typeof x === "number" ? x : null);
    const usage = { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cacheReadTokens: num(u.cache_read_input_tokens), cacheCreationTokens: num(u.cache_creation_input_tokens) };
    const outModel = typeof data.model === "string" ? data.model : model;
    if (ttl > 0) await cachePut(opts.kv, key, { brief, model: outModel }, ttl);
    await recordUsage(opts.kv, now, { estimatedTokensRaw: ctx.report.estimatedTokensRaw, estimatedTokensSent: ctx.report.estimatedTokensSent, actualInputTokens: usage.inputTokens, actualOutputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: usage.cacheCreationTokens, cacheHit: false });
    return { ok: true, brief, model: outModel, usage, tokens: ctx.report, cached: false };
  } catch { return { ok: false, error: "llm_unreachable" }; }
}
export { savingsPct };
