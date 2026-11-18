import { handleBitget } from "./api.ts";
import { handleBitgetPrivateWebSocket } from "./websocket.ts";

interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }

/** Serves /api/bitget/* (status, read-only connectivity verification, account, positions, orders, fills, trades, sync, margin-pairs); everything else is untouched. */
export function withBitget<E extends Record<string, any>>(base: App<E>): App<E> {
  return { fetch(request, env) {
    const p = new URL(request.url).pathname;
    if (p === "/api/bitget/ws/private") return handleBitgetPrivateWebSocket(request, env);
    if (p === "/api/bitget" || p.startsWith("/api/bitget/")) return handleBitget(request, env);
    return base.fetch(request, env);
  } };
}
