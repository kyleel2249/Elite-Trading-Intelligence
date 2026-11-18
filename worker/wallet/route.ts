import { walletPage } from "./page.ts";
import { injectWallet } from "./inject.ts";

interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }

/**
 * Serves the Wallet page at /wallet and adds a Wallet section to the main dashboard ("/").
 * Every other route is delegated untouched.
 */
export function withWallet<E>(base: App<E>): App<E> {
  return {
    async fetch(request, env) {
      const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
      if ((request.method === "GET" || request.method === "HEAD") && path === "/wallet") {
        return new Response(request.method === "HEAD" ? null : walletPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
      }
      const res = await base.fetch(request, env);
      if (request.method === "GET" && path === "/" && res.status === 200 && (res.headers.get("content-type") || "").includes("text/html")) {
        const html = await res.text();
        const headers = new Headers(res.headers);
        headers.delete("content-length"); headers.delete("etag");
        return new Response(injectWallet(html), { status: res.status, headers });
      }
      return res;
    },
  };
}
