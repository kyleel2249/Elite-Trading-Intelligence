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
 */
interface GuardEnv { ETI_SPORTS_PAPER_TOKEN?: string }
interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }
interface Entry { at: number; status: number; body: string; headers: Array<[string, string]> }

export const SCAN_CACHE_TTL_MS = 120_000;
const MAX_ENTRIES = 16;
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

function toEntry(res: Response, body: string): Entry {
  const headers: Array<[string, string]> = [];
  res.headers.forEach((value, key) => { headers.push([key, value]); });
  return { at: Date.now(), status: res.status, body, headers };
}

function fromEntry(entry: Entry, state: "hit" | "miss"): Response {
  const headers = new Headers(entry.headers);
  headers.set("x-eti-cache", state);
  return new Response(entry.body, { status: entry.status, headers });
}

export function withSportsGuard<E extends GuardEnv>(next: App<E>): App<E> {
  return {
    async fetch(req, env) {
      const u = new URL(req.url);
      const p = u.pathname.replace(/\/+$/, "") || "/";
      if (!p.startsWith("/api/sports")) return next.fetch(req, env);

      const automatic = u.searchParams.get("automatic") === "1";
      const isScan = p === "/api/sports/football/next";
      const isSettle = /^\/api\/sports\/bets\/[0-9a-f-]+\/settle$/i.test(p);
      const isMutation = req.method === "POST" && (p === "/api/sports/bets" || p === "/api/sports/football/sync-history" || isSettle);
      const needsToken = p === "/api/sports/bets" || p === "/api/sports/football/sync-history" || isSettle || (isScan && automatic);

      const expected = env.ETI_SPORTS_PAPER_TOKEN;
      const supplied = req.headers.get("x-eti-sports-token");
      if (needsToken && expected && supplied !== null && !constantTimeEqual(supplied, expected)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
        });
      }

      if (isMutation) {
        const res = await next.fetch(req, env);
        if (res.ok) cache.clear();
        return res;
      }

      if (isScan && req.method === "GET" && !automatic) {
        const key = scanCacheKey(u.searchParams);
        const hit = cache.get(key);
        if (hit && Date.now() - hit.at < SCAN_CACHE_TTL_MS) return fromEntry(hit, "hit");
        let pending = inflight.get(key);
        if (!pending) {
          pending = (async () => {
            const res = await next.fetch(req, env);
            const entry = toEntry(res, await res.text());
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

      return next.fetch(req, env);
    },
  };
}
