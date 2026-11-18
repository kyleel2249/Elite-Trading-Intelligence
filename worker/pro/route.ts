import { proPage } from "./page.ts";
import { addNonces, buildCsp, nonceValue } from "../security/headers.ts";

interface App<E> { fetch(request: Request, env: E): Promise<Response> | Response }

/** Bitget public market data is read browser-direct (Bitget restricts Cloudflare egress), so /pro must be allowed to connect to it. */
const BITGET_CONNECT = "https://api.bitget.com https://capi.bitget.com";

/**
 * Serves the ETI Pro dashboard at /pro. Every other route is delegated untouched.
 * The page sends its own nonce CSP (built by the shared security-headers helpers, so the policy stays in one place) with the
 * Bitget origins added to connect-src and any operator-configured ETI_CSP_CONNECT origins preserved.
 */
export function withPro<E>(base: App<E>): App<E> {
  return {
    async fetch(request, env) {
      const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
      if (request.method === "GET" && path === "/pro") {
        const nonce = nonceValue();
        const configured = (env as unknown as { ETI_CSP_CONNECT?: string } | undefined)?.ETI_CSP_CONNECT;
        const csp = buildCsp(nonce, { ETI_CSP_CONNECT: [configured, BITGET_CONNECT].filter(Boolean).join(" ") });
        return new Response(addNonces(proPage(), nonce), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "same-origin", "content-security-policy": csp } });
      }
      return base.fetch(request, env);
    },
  };
}
