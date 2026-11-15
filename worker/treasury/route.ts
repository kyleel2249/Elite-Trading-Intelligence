import { handleTreasury } from "./api.ts";
interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }
/** Serves /api/treasury* (see api.ts); everything else is delegated untouched. */
export function withTreasury<E extends Record<string, any>>(base: App<E>): App<E> {
  return { async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    if (path === "/api/treasury" || path.startsWith("/api/treasury/")) return handleTreasury(request, env);
    return base.fetch(request, env);
  } };
}
