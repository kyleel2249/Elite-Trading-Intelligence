/**
 * Dedicated, validated connection from the Worker to the Python wallet backend.
 *   /api/chain/*               forwarded to BACKEND_URL (the custodial wallet, allowlist, previews and transactions live there)
 *   GET /api/chain-view/backend  connection check: configured? reachable? latency. Never exposes more than the backend's origin.
 *
 * Reliability: a strict origin check, a per-request timeout, one retry for idempotent GETs on a network error or 502/503/504,
 * a short cache for the static network list, only the headers the backend needs (no cookies), and precise error codes
 * (backend_not_configured 503, backend_invalid 500, backend_unreachable 502, backend_timeout 504).
 * It never forwards anything outside /api/chain/ and never retries a POST (a retried send could duplicate a transaction).
 */
interface App<E> { fetch(request: Request, env: E, ctx?: any): Promise<Response> | Response }
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: JSON_HEADERS });
const FORWARD = ["authorization", "x-api-key", "content-type", "accept", "idempotency-key", "x-request-id", "user-agent"];
export const TIMEOUT_MS = { read: 10_000, write: 20_000, probe: 5_000 };
const RETRY_STATUS = new Set([502, 503, 504]);

/** Returns the validated origin, "" when unset, or null when set but invalid. */
export function backendOrigin(env: Record<string, any>): string | null | "" {
  const raw = typeof env.BACKEND_URL === "string" ? env.BACKEND_URL.trim() : "";
  if (!raw) return "";
  let u: URL; try { u = new URL(raw); } catch { return null; }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.pathname !== "/" || u.search || u.hash) return null;
  return u.origin;
}

async function timed(url: string, init: RequestInit, ms: number, fetcher: typeof fetch): Promise<Response> {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await fetcher(url, { ...init, signal: ctl.signal }); } finally { clearTimeout(t); }
}

const cache = new Map<string, { at: number; status: number; body: string }>();
export const resetBackendCache = () => cache.clear();

export async function forward(request: Request, origin: string, fetcher: typeof fetch = fetch, now = Date.now()): Promise<Response> {
  const incoming = new URL(request.url), target = new URL(origin); target.pathname = incoming.pathname; target.search = incoming.search;
  if (target.origin !== origin) return json({ error: "invalid_target" }, 400);
  const headers = new Headers(); for (const k of FORWARD) { const v = request.headers.get(k); if (v) headers.set(k, v); }
  headers.set("x-forwarded-host", incoming.host); headers.set("x-forwarded-proto", "https");
  const get = request.method === "GET", key = target.pathname === "/api/chain/networks" ? "GET " + target.toString() + "|" + (headers.get("authorization") ?? headers.get("x-api-key") ?? "") : "";
  if (get && key) { const c = cache.get(key); if (c && now - c.at < 60_000) return new Response(c.body, { status: c.status, headers: { ...JSON_HEADERS, "x-eti-cache": "hit" } }); }
  const body = get || request.method === "HEAD" ? undefined : await request.arrayBuffer();
  if (body && body.byteLength > 64_000) return json({ error: "payload_too_large" }, 413);
  const init: RequestInit = { method: request.method, headers, body, redirect: "manual" };
  const ms = get ? TIMEOUT_MS.read : TIMEOUT_MS.write;
  for (let attempt = 0; attempt < (get ? 2 : 1); attempt++) {
    try {
      const up = await timed(target.toString(), init, ms, fetcher);
      if (get && RETRY_STATUS.has(up.status) && attempt === 0) { await up.arrayBuffer().catch(() => undefined); continue; }
      const text = await up.text(), out = new Headers(JSON_HEADERS), ct = up.headers.get("content-type"); if (ct) out.set("content-type", ct);
      out.set("x-eti-backend", "ok");
      if (get && key && up.status === 200) cache.set(key, { at: now, status: 200, body: text });
      return new Response(text, { status: up.status, headers: out });
    } catch (e: any) {
      const aborted = e?.name === "AbortError";
      if (attempt === 0 && get) continue;
      return json({ error: aborted ? "backend_timeout" : "backend_unreachable", message: aborted ? "The wallet backend did not answer in time." : "The wallet backend could not be reached.", backend: origin }, aborted ? 504 : 502);
    }
  }
  return json({ error: "backend_unreachable", backend: origin }, 502);
}

export async function backendStatus(env: Record<string, any>, fetcher: typeof fetch = fetch) {
  const origin = backendOrigin(env);
  if (origin === "") return { configured: false, connected: false, error: "backend_not_configured", message: "Set BACKEND_URL to the origin of the Python backend (https://host, no path). See docs/CHAIN.md." };
  if (origin === null) return { configured: true, connected: false, error: "backend_invalid", message: "BACKEND_URL must be an http(s) origin without credentials, path, query or fragment." };
  const t0 = Date.now();
  try {
    const r = await timed(origin + "/api/system/health", { headers: { accept: "application/json" }, redirect: "manual" }, TIMEOUT_MS.probe, fetcher);
    const body: any = await r.json().catch(() => null);
    return { configured: true, connected: r.ok, backend: origin, latencyMs: Date.now() - t0, httpStatus: r.status, chainEnabled: null as boolean | null, status: body?.status ?? null, error: r.ok ? undefined : "backend_unhealthy" };
  } catch (e: any) {
    return { configured: true, connected: false, backend: origin, latencyMs: Date.now() - t0, error: e?.name === "AbortError" ? "backend_timeout" : "backend_unreachable" };
  }
}

export function withChainBackend<E extends Record<string, any>>(base: App<E>, fetcher: typeof fetch = fetch): App<E> {
  return { async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/api/chain-view/backend") return json(await backendStatus(env, fetcher));
    if (!path.startsWith("/api/chain/") && path !== "/api/chain") return base.fetch(request, env, ctx);
    if (!["GET", "POST", "DELETE"].includes(request.method)) return json({ error: "method_not_allowed" }, 405);
    const origin = backendOrigin(env);
    if (origin === "") return json({ error: "backend_not_configured", message: "The wallet backend is not connected: set BACKEND_URL to the Python backend origin." }, 503);
    if (origin === null) return json({ error: "backend_invalid", message: "BACKEND_URL must be an http(s) origin without credentials, path, query or fragment." }, 500);
    return forward(request, origin, fetcher);
  } };
}
