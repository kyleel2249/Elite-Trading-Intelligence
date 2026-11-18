import { constantTimeEqual } from "../auth/session.ts";
import { loadBybitAccountSnapshot, type BybitAccountDeps } from "./account.ts";

interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }
const encoder = new TextEncoder();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
});

export interface BybitRouteEnv {
  ETI_EXECUTION_TOKEN?: string;
  BYBIT_API_KEY?: string;
  BYBIT_API_SECRET?: string;
  BYBIT_ACCOUNT_ENV?: string;
}
function authorized(req: Request, env: BybitRouteEnv): boolean {
  const expected = env.ETI_EXECUTION_TOKEN || "";
  const header = req.headers.get("authorization") || "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7).trim() : (req.headers.get("x-eti-execution-token") || "").trim();
  return !!expected && !!supplied && constantTimeEqual(encoder.encode(supplied), encoder.encode(expected));
}

/** Master-token-only, GET-only private Bybit account snapshot. No trading endpoints are exposed. */
export async function handleBybitAccount(req: Request, env: BybitRouteEnv, deps: BybitAccountDeps = {}): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== "/api/bybit/account") return json({ error: "not_found" }, 404);
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  if (!authorized(req, env)) return json({ error: "master_token_required", message: "A valid ETI execution token is required for private account snapshots." }, 401);
  try {
    const snapshot = await loadBybitAccountSnapshot(env, deps);
    return json(snapshot);
  } catch (error) {
    return json({ venue: "bybit", status: "unavailable", error: "account_snapshot_failed", message: error instanceof Error ? error.message : "Bybit account snapshot failed.", checkedAt: (deps.now ?? Date.now)() }, 502);
  }
}

export function withBybitAccount<E extends BybitRouteEnv>(base: App<E>): App<E> {
  return { fetch(request, env) {
    if (new URL(request.url).pathname === "/api/bybit/account") return handleBybitAccount(request, env);
    return base.fetch(request, env);
  } };
}
