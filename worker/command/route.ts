import { handleIntel, type IntelEnv } from "./intel.ts";
import { commandPageComplete } from "./compose.ts";
import { withReportLinks } from "./nav.ts";

interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }

/** Serves the unified command centre (/command) and /api/intel/*; every other route is delegated untouched. */
export function withCommand<E extends IntelEnv>(base: App<E>): App<E> {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (request.method === "GET" && (url.pathname === "/command" || url.pathname === "/command/")) {
        return new Response(withReportLinks(commandPageComplete()), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "same-origin" } });
      }
      if (url.pathname.startsWith("/api/intel/")) { const r = await handleIntel(request, env); if (r) return r; }
      return base.fetch(request, env);
    },
  };
}
