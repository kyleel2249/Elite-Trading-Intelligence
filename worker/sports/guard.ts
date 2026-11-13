/**
 * Hardening layer placed directly around withSports (see worker/main.ts).
 *
 *  1. Paper-token checks use a constant-time comparison. A supplied but wrong token is rejected here,
 *     before the sports route runs, so the route's own `===` check is only reached with a correct token.
 *     A missing token is delegated unchanged, so the route keeps answering with its existing 401/503 bodies.
 *  2. The public football scan (GET /api/sports/football/next, non-automatic) calls the paid OddsPapi API
 *     and writes to D1. Identical requests are coalesced and cached per isolate for a short time so
 *     anonymous callers cannot burn the provider quota. The cache key is the effective scan limit AND the
 *     competition filter, so switching between UEFA Nations League and all football never serves the wrong
 *     feed. Only 200 responses are cached; the cache is cleared after any successful history sync, paper bet
 *     or settlement so the dashboard never shows data older than its own last action.
 *  3. GET /api/sports/health probes both paid providers and checks the D1 schema. Anonymous callers get a cached,
 *     sanitised copy (no quota counters, no raw database errors); the full report needs a valid paper token.
 *  4. GET /api/sports/events proxies the paid The Odds API and requires a valid paper token.
 *  5. After every authorised history sync, stored results are reconciled against still-OPEN paper bets and unsettled
 *     predictions (see settlement.ts), so a sync that failed part-way can never strand a bet.
 */
import { settleFromStoredResults } from "./settlement.ts";
interface GuardEnv { ETI_SPORTS_PAPER_TOKEN?: string; ETI_PORTFOLIO_DB?: D1Database }
interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }
interface Entry { at: number; status: number; body: string; headers: Array<[string, string]> }

export const SCAN_CACHE_TTL_MS = 120_000;
const MAX_ENTRIES = 16;
const HEALTH_KEY = "health";
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();
const encoder = new TextEncoder();

export function resetSportsGuardCache(): void {
  cache.clear();
  inflight.clear();
}

export function constantTimeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Cache key for a public scan: mirrors the route's own defaults so two different feeds can never share an entry. */
export function scanCacheKey(params: URLSearchParams): string {
  const competition = (params.get("competition") || "all").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 64) || "all";
  const fallback = competition === "uefa_nations_league" ? 12 : 8;
  const limit = Math.max(1, Math.min(12, Number(params.get("limit") || fallback) || fallback));
  return limit + ":" + competition;
}

/** Removes operational detail (provider quota counters, raw database errors) from a health report served to anonymous callers. */
export function sanitizeHealth(raw: string): string {
  try {
    const j = JSON.parse(raw);
    const o = j?.providers?.oddspapi;
    if (o) { delete o.request_limit; delete o.request_count; delete o.sports; }
    const t = j?.providers?.the_odds_api;
    if (t) delete t.requests_remaining;
    if (j?.database?.error) j.database.error = "database_query_failed";
    return JSON.stringify(j);
  } catch { return raw; }
}

function toEntry(res: Response, body: string): Entry {
  const headers: Array<[string, string]> = [];
  res.headers.forEach((value, key) => { headers.push([key, value]); });
  return { at: Date.now(), status: res.status, body, headers };
}

function fromEntry(entry: Entry, state: "hit" | "miss"): Response {
  const headers = new Headers(entry.headers);
  headers.delete("content-length");
  headers.set("x-eti-cache", state);
  return new Response(entry.body, { status: entry.status, headers });
}

/** Serves a cached 200 response for `key`, or runs `produce` once (concurrent callers share the same call) and caches a 200. */
async function cachedResponse(key: string, produce: () => Promise<Response>, transform: (body: string) => string = b => b): Promise<Response> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < SCAN_CACHE_TTL_MS) return fromEntry(hit, "hit");
  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      const res = await produce();
      const entry = toEntry(res, transform(await res.text()));
      if (entry.status === 200) {
        cache.set(key, entry);
        while (cache.size > MAX_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
      }
      return entry;
    })().finally(() => { inflight.delete(key); });
    inflight.set(key, pending);
  }
  return fromEntry(await pending, "miss");
}

const jsonHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };

export function withSportsGuard<E extends GuardEnv>(next: App<E>): App<E> {
  return {
    async fetch(req, env) {
      const u = new URL(req.url);
      const p = u.pathname.replace(/\/+$/, "") || "/";
      if (!p.startsWith("/api/sports")) return next.fetch(req, env);

      const automatic = u.searchParams.get("automatic") === "1";
      const isScan = p === "/api/sports/football/next";
      const isSettle = /^\/api\/sports\/bets\/[0-9a-f-]+\/settle$/i.test(p);
      const isHistorySync = p === "/api/sports/football/sync-history";
      const isMutation = req.method === "POST" && (p === "/api/sports/bets" || isHistorySync || isSettle);
      const needsToken = p === "/api/sports/bets" || isHistorySync || isSettle || (isScan && automatic);

      const expected = env.ETI_SPORTS_PAPER_TOKEN;
      const supplied = req.headers.get("x-eti-sports-token");
      const authed = !!expected && supplied !== null && constantTimeEqual(supplied, expected);
      if (needsToken && expected && supplied !== null && !authed) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: jsonHeaders });
      }

      if (p === "/api/sports/events" && req.method === "GET" && !authed) {
        return new Response(JSON.stringify({ error: "unauthorized", message: "Live bookmaker odds use paid provider quota; supply the ETI Sports Paper Token." }), { status: 401, headers: jsonHeaders });
      }

      if (p === "/api/sports/health" && req.method === "GET" && !authed) {
        return cachedResponse(HEALTH_KEY, async () => await next.fetch(req, env), sanitizeHealth);
      }

      if (isMutation) {
        const res = await next.fetch(req, env);
        if (res.ok) cache.clear();
        if (isHistorySync && authed && env.ETI_PORTFOLIO_DB) {
          try {
            const s = await settleFromStoredResults(env.ETI_PORTFOLIO_DB, Date.now());
            if (s.betsSettled || s.predictionsSettled) cache.clear();
            const headers = new Headers(res.headers);
            headers.set("x-eti-backlog-settled", s.betsSettled + " bets, " + s.predictionsSettled + " predictions");
            return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
          } catch (e) {
            console.error("sports backlog settlement failed", e instanceof Error ? e.message : e);
          }
        }
        return res;
      }

      if (isScan && req.method === "GET" && !automatic) {
        return cachedResponse(scanCacheKey(u.searchParams), async () => await next.fetch(req, env));
      }

      return next.fetch(req, env);
    },
  };
}
