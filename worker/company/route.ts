import { handleCompany } from "./api.ts";
interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }
/** Serves /api/company* (see api.ts); everything else is delegated untouched. */
export function withCompany<E extends Record<string, any>>(base: App<E>): App<E> {
  return { async fetch(request, env) {
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    if (path === "/api/company" || path.startsWith("/api/company/")) return handleCompany(request, env);
    return base.fetch(request, env);
  } };
}
