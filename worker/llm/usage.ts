/**
 * LLM usage accounting and response cache, both in the existing KV binding.
 *  - Daily aggregate under llm:usage:<UTC date>: calls, cache hits, estimated tokens before/after compression, and the provider's ACTUAL
 *    input / output / cache-read / cache-creation tokens. KV has no atomic increment, so concurrent calls can under-count slightly; the
 *    numbers are for cost visibility, never for enforcement (the hourly cap in llm-route.ts is the guard).
 *  - Response cache llm:cache:<sha256>, keyed by model + prompt version + compacted input with volatile fields (timestamps, ids) removed,
 *    so an unchanged analysis does not pay for a second review.
 */
export interface KvLike { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void> }

export interface UsageRecord { estimatedTokensRaw: number; estimatedTokensSent: number; actualInputTokens: number | null; actualOutputTokens: number | null; cacheReadTokens: number | null; cacheCreationTokens: number | null; cacheHit: boolean }
export interface UsageTotals { day: string; calls: number; cacheHits: number; estimatedTokensRaw: number; estimatedTokensSent: number; actualInputTokens: number; actualOutputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; callsWithActualUsage: number }

const empty = (day: string): UsageTotals => ({ day, calls: 0, cacheHits: 0, estimatedTokensRaw: 0, estimatedTokensSent: 0, actualInputTokens: 0, actualOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, callsWithActualUsage: 0 });
export const dayKey = (now: number) => new Date(now).toISOString().slice(0, 10);

export async function recordUsage(kv: KvLike | undefined, now: number, u: UsageRecord): Promise<void> {
  if (!kv) return;
  const day = dayKey(now), key = "llm:usage:" + day;
  try {
    const t: UsageTotals = { ...empty(day), ...(JSON.parse((await kv.get(key)) ?? "null") ?? {}) };
    t.calls++; if (u.cacheHit) t.cacheHits++;
    t.estimatedTokensRaw += u.estimatedTokensRaw; t.estimatedTokensSent += u.estimatedTokensSent;
    if (u.actualInputTokens !== null) { t.callsWithActualUsage++; t.actualInputTokens += u.actualInputTokens; t.actualOutputTokens += u.actualOutputTokens ?? 0; t.cacheReadTokens += u.cacheReadTokens ?? 0; t.cacheCreationTokens += u.cacheCreationTokens ?? 0; }
    await kv.put(key, JSON.stringify(t), { expirationTtl: 90 * 86400 });
  } catch { /* accounting must never break a request */ }
}

export async function readUsage(kv: KvLike | undefined, now: number, days = 7): Promise<UsageTotals[]> {
  if (!kv) return [];
  const out: UsageTotals[] = [];
  for (let i = 0; i < days; i++) { const day = dayKey(now - i * 86_400_000); try { const v = await kv.get("llm:usage:" + day); if (v) out.push({ ...empty(day), ...JSON.parse(v) }); } catch { /* skip */ } }
  return out;
}

/** Share of estimated input tokens removed by compression, across the given totals. */
export const savingsPct = (t: { estimatedTokensRaw: number; estimatedTokensSent: number }) => t.estimatedTokensRaw > 0 ? Math.round((1 - t.estimatedTokensSent / t.estimatedTokensRaw) * 1000) / 10 : 0;

const VOLATILE = new Set(["generatedAt", "fetchedAt", "id", "analysisId", "now", "at", "time"]);
export function stable(v: any): any {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") { const o: any = {}; for (const k of Object.keys(v).sort()) if (!VOLATILE.has(k)) o[k] = stable(v[k]); return o; }
  return v;
}
export async function sha256Hex(text: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const cacheKey = async (model: string, promptVersion: string, document: unknown) => "llm:cache:" + (await sha256Hex(model + "|" + promptVersion + "|" + JSON.stringify(stable(document))));
export async function cacheGet(kv: KvLike | undefined, key: string): Promise<any | null> { if (!kv) return null; try { const v = await kv.get(key); return v ? JSON.parse(v) : null; } catch { return null; } }
export async function cachePut(kv: KvLike | undefined, key: string, value: unknown, ttlSeconds: number): Promise<void> { if (!kv) return; try { await kv.put(key, JSON.stringify(value), { expirationTtl: Math.max(60, ttlSeconds) }); } catch { /* best effort */ } }
