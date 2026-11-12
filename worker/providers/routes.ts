/** GET /api/providers/status (coverage matrix, provider state, data freshness), POST /api/providers/probe (signed-in or master; refreshes now), GET /providers (page). */
import { authenticate, rateLimit, sameOrigin } from "../auth/session.ts";
import { loadHealth, probeAll, report } from "./registry.ts";
import { PROVIDERS_HTML } from "./ui.ts";

const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: H });
export async function handleProviders(req: Request, env: any, deps: { now?: () => number; fetchImpl?: typeof fetch } = {}): Promise<Response> {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, ""), now = (deps.now ?? Date.now)();
  if (path === "/providers" && req.method === "GET") return new Response(PROVIDERS_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  if (path === "/api/providers/status" && req.method === "GET") return reply(report(env, await loadHealth(env.ETI_EXECUTION_LOG), now));
  if (path === "/api/providers/probe") {
    if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
    if (!req.headers.get("authorization") && !sameOrigin(req)) return reply({ error: "csrf_origin_mismatch" }, 403);
    const a = await authenticate(req, env, now); if (!a.master && a.scopes.size === 0 && !a.user) return reply({ error: "unauthorized", message: "Sign in or open the dashboard to start a session." }, 401);
    const rl = await rateLimit(env, "probe", 6, 300, now); if (!rl.ok) return reply({ error: "rate_limited", message: "Providers were probed very recently." }, 429);
    return reply(report(env, await probeAll(env, env.ETI_EXECUTION_LOG, deps.fetchImpl ?? fetch, () => (deps.now ?? Date.now)()), now));
  }
  return reply({ error: "not_found" }, 404);
}
export async function runProviderProbe(env: any, now = Date.now) { return probeAll(env, env.ETI_EXECUTION_LOG, fetch, now); }
export function withProviders(inner: { fetch(req: Request, env: any, ctx?: any): Promise<Response> | Response }) {
  return { ...inner, fetch: (req: Request, env: any, ctx?: any) => { const p = new URL(req.url).pathname; return p === "/providers" || p.startsWith("/api/providers/") ? handleProviders(req, env) : inner.fetch(req, env, ctx); } };
}
