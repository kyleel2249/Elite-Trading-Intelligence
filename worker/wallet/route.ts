import { walletPage } from "./page.ts";

interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }

/** Serves the Wallet page at /wallet (and /funding is left to other layers). Every other route is delegated untouched. */
export function withWallet<E>(base: App<E>): App<E> {
  return {
    async fetch(request, env) {
      const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
      if ((request.method === "GET" || request.method === "HEAD") && path === "/wallet") {
        return new Response(request.method === "HEAD" ? null : walletPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
      }
      return base.fetch(request, env);
    },
  };
}
