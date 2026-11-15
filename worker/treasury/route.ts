import { handleTreasury } from "./api.ts";
import { isSimulatedSource } from "./guards.ts";
import { treasuryPage } from "./ui.ts";

interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };

/**
 * Serves the treasury dashboard (GET /treasury) and /api/treasury* (see api.ts); everything else is delegated untouched.
 * Before an actual-environment profit batch reaches the API, its source and description are checked so paper, testnet or other simulated
 * results can never be recorded as real funds (see guards.ts).
 */
export function withTreasury<E extends Record<string, any>>(base: App<E>): App<E> {
  return { async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    if (request.method === "GET" && path === "/treasury") {
      return new Response(treasuryPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "same-origin" } });
    }
    if (path === "/api/treasury" || path.startsWith("/api/treasury/")) {
      if (request.method === "POST" && path === "/api/treasury/profit-batches") {
        let body: any = null;
        try { const text = await request.clone().text(); if (text.length <= 20_000) body = JSON.parse(text); } catch { body = null; }
        if (body && body.environment === "actual" && (isSimulatedSource(body.source) || isSimulatedSource(body.description))) {
          return new Response(JSON.stringify({ error: "simulated_source_in_actual_environment", message: "This source looks like paper, testnet or simulated trading. Record it in the simulated environment. Actual profit batches must describe real settled funds." }), { status: 400, headers: JSON_HEADERS });
        }
      }
      return handleTreasury(request, env);
    }
    return base.fetch(request, env);
  } };
}
