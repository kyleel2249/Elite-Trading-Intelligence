// Native TypeScript port of the Python Tokenomist client (app/providers/tokenomist.py): API v5, x-api-key header, monthly credit budget.
// The Worker deliberately has no Python origin, so this replaces a "bridge". Licence: Tokenomist data is personal/non-commercial and
// NON-REDISTRIBUTABLE, and the analysis API is public, so only DERIVED metrics leave this module's callers; raw events are never returned.
import { SourceError, type AnalysisEnv, type FetchFn } from "./fundamental-sources.ts";

export interface KVLike { get(key: string): Promise<string | null>; put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void> }
export interface UnlockEvent { date: string; tokens: number; valueUsd?: number; valueToMarketCapPct?: number; insider: boolean }
const INSIDER = new Set(["founderteam", "privateinvestors", "team", "investors"]);
const f = (v: unknown) => { const n = typeof v === "string" ? Number(v) : v; return typeof n === "number" && Number.isFinite(n) ? n : undefined; };
export function normalizeUnlockEvent(row: any): UnlockEvent | null {
  const cliff = row?.cliffUnlocks;
  if (!row?.unlockDate || !cliff || typeof cliff !== "object") return null;
  const date = new Date(row.unlockDate); if (!Number.isFinite(date.getTime())) return null;
  const tokens = f(cliff.cliffAmount); if (!tokens || tokens <= 0) return null;
  const alloc: any[] = Array.isArray(cliff.allocationBreakdown) ? cliff.allocationBreakdown : [];
  let insiderAmt = 0, total = 0;
  for (const a of alloc) { const amt = f(a?.cliffAmount) ?? 0, std = String(a?.standardAllocationName ?? "").toLowerCase().replace(/\s+/g, ""); total += amt; if (INSIDER.has(std)) insiderAmt += amt; }
  return { date: date.toISOString(), tokens, valueUsd: f(cliff.cliffValue), valueToMarketCapPct: f(cliff.valueToMarketCap), insider: total > 0 && insiderAmt / total >= 0.5 };
}
export interface Quota { used: number; limit: number; resetAt?: string }
const QUOTA_KEY = "analysis:tokenomist:quota";
export async function readQuota(kv: KVLike | undefined): Promise<Quota | null> { if (!kv) return null; try { const v = await kv.get(QUOTA_KEY); return v ? JSON.parse(v) : null; } catch { return null; } }
export function creditReserve(env: AnalysisEnv): number { const r = Number(env.TOKENOMIST_CREDIT_RESERVE ?? 0.1); return Number.isFinite(r) && r >= 0 && r < 1 ? r : 0.1; }
/** Refuses to spend credits when the remaining share of the monthly allowance falls below the reserve (same rule as the Python client). */
export function guardCredits(q: Quota | null, reserve: number): void {
  if (q && q.limit > 0 && Number.isFinite(q.used) && (q.limit - q.used) / q.limit < reserve) throw new SourceError("Tokenomist", "monthly credit reserve reached: refusing to spend more credits");
}
export async function fetchUnlockEvents(tokenId: string, env: AnalysisEnv, fetchFn: FetchFn, kv: KVLike | undefined, now: number, horizonDays = 90, maxPages = 2): Promise<{ events: UnlockEvent[]; quota: Quota | null; truncated: boolean }> {
  if (!env.TOKENOMIST_API_KEY) throw new SourceError("Tokenomist", "TOKENOMIST_API_KEY is not configured", "Set TOKENOMIST_API_KEY (Tokenomist Pro: 1,000 credits/month; each page costs one credit)");
  if (!/^[a-z0-9-]{1,64}$/.test(tokenId)) throw new SourceError("Tokenomist", "invalid token id");
  let quota = await readQuota(kv); const reserve = creditReserve(env), events: UnlockEvent[] = []; let truncated = false;
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  for (let page = 1; page <= maxPages; page++) {
    guardCredits(quota, reserve);
    const url = `https://api.tokenomist.ai/v5/unlock/events/${tokenId}?start=${day(now)}&end=${day(now + horizonDays * 86400000)}&page=${page}&pageSize=100`;
    let r: Response; try { r = await fetchFn(url, { headers: { accept: "application/json", "x-api-key": env.TOKENOMIST_API_KEY }, signal: AbortSignal.timeout(9000) }); } catch (e) { throw new SourceError("Tokenomist", `request failed: ${e instanceof Error ? e.message : "network error"}`); }
    if (r.status === 401 || r.status === 403) throw new SourceError("Tokenomist", `authentication or plan restriction (HTTP ${r.status})`);
    if (r.status === 404) return { events: [], quota, truncated: false };
    if (r.status === 429) throw new SourceError("Tokenomist", "rate limited by Tokenomist");
    if (!r.ok) throw new SourceError("Tokenomist", `HTTP ${r.status}`);
    let body: any; try { body = await r.json(); } catch { throw new SourceError("Tokenomist", "invalid JSON"); }
    if (!body || typeof body !== "object" || body.status === false) throw new SourceError("Tokenomist", "status=false in response");
    const c = body.metadata?.credit; if (c && typeof c === "object" && f(c.limit) && f(c.used) !== undefined) { quota = { used: f(c.used)!, limit: f(c.limit)!, resetAt: typeof c.resetAt === "string" ? c.resetAt : undefined }; try { await kv?.put(QUOTA_KEY, JSON.stringify(quota), { expirationTtl: 35 * 86400 }); } catch { /* best effort */ } }
    for (const row of Array.isArray(body.data) ? body.data : []) { const e = normalizeUnlockEvent(row); if (e) events.push(e); }
    const total = f(body.metadata?.totalPages) ?? 1; if (page >= total) break; if (page === maxPages) truncated = true;
  }
  return { events, quota, truncated };
}
/** Derived, redistribution-safe summary for the engine and API responses (no raw schedule). */
export function summarizeUnlocks(events: UnlockEvent[], circulating: number | undefined, now: number) {
  const soon = events.filter(e => Date.parse(e.date) > now).sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  const tokens = soon.reduce((s, e) => s + e.tokens, 0), insider = soon.filter(e => e.insider).reduce((s, e) => s + e.tokens, 0), next = soon[0];
  return { count: soon.length, pctOfCirculating: circulating && circulating > 0 ? Number((tokens / circulating * 100).toFixed(2)) : null, insiderShare: tokens > 0 ? Number((insider / tokens).toFixed(2)) : null, nextUnlockDate: next?.date ?? null, nextUnlockPctOfCirculating: next && circulating ? Number((next.tokens / circulating * 100).toFixed(2)) : null };
}
