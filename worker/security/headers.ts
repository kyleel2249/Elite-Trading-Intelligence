/**
 * Response hardening applied to every route (outermost layer).
 *  - HTML: a per-response nonce is added to every inline <script>/<style> and a Content-Security-Policy that only allows
 *    same-origin scripts plus those nonced blocks. Pages that already send their own CSP keep it.
 *  - Every response: nosniff, no referrer, locked-down permissions policy, HSTS.
 *  - WebSocket upgrades (status 101) pass through untouched.
 * Extra browser connection targets can be added with ETI_CSP_CONNECT (space-separated origins).
 */
export interface HeaderEnv { ETI_CSP_CONNECT?: string }
const DEFAULT_CONNECT = ["'self'", "wss://data-stream.binance.vision", "https://data-api.binance.vision"];
const ORIGIN = /^(https?|wss?):\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/;
export const nonceValue = () => { const b = crypto.getRandomValues(new Uint8Array(16)); return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, c => c === "+" ? "-" : c === "/" ? "_" : ""); };
export function buildCsp(nonce: string, env: HeaderEnv = {}): string {
  const extra = String(env.ETI_CSP_CONNECT || "").split(/\s+/).filter(o => ORIGIN.test(o));
  return [
    "default-src 'self'", `script-src 'self' 'nonce-${nonce}'`, `style-src-elem 'self' 'nonce-${nonce}'`, "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:", "font-src 'self' data:", `connect-src ${[...DEFAULT_CONNECT, ...extra].join(" ")}`,
    "base-uri 'none'", "object-src 'none'", "form-action 'self'", "frame-ancestors 'none'",
  ].join("; ");
}
export const addNonces = (html: string, nonce: string) => html.replace(/<(script|style)(?=[\s>])(?![^>]*\snonce=)/gi, `<$1 nonce="${nonce}"`);
export async function harden(res: Response, env: HeaderEnv = {}): Promise<Response> {
  if (res.status === 101 || (res as any).webSocket) return res;
  const h = new Headers(res.headers), type = h.get("content-type") || "";
  const set = (k: string, v: string) => { if (!h.has(k)) h.set(k, v); };
  set("x-content-type-options", "nosniff"); set("referrer-policy", "no-referrer");
  set("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
  set("strict-transport-security", "max-age=31536000; includeSubDomains");
  if (!/^text\/html/i.test(type)) return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  set("x-frame-options", "DENY"); set("cross-origin-opener-policy", "same-origin");
  let body = await res.text();
  if (!h.has("content-security-policy")) { const n = nonceValue(); body = addNonces(body, n); h.set("content-security-policy", buildCsp(n, env)); }
  h.delete("content-length");
  return new Response(body, { status: res.status, statusText: res.statusText, headers: h });
}
export function withSecurityHeaders(inner: { fetch(req: Request, env: any, ctx?: any): Promise<Response> | Response }) {
  return { ...inner, fetch: async (req: Request, env: any, ctx?: any) => harden(await inner.fetch(req, env, ctx), env) };
}
