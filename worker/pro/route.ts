import { proPage } from "./page.ts";

interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }

/** Serves the ETI Pro dashboard at /pro. Every other route is delegated untouched. */
export function withPro<E>(base: App<E>): App<E> {
  return {
    async fetch(request, env) {
      const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
      if (request.method === "GET" && path === "/pro") return new Response(proPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "same-origin" } });
      return base.fetch(request, env);
    },
  };
}
