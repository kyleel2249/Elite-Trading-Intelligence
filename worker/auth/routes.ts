/**
 * /api/auth/*  Session lifecycle for the dashboard and other same-origin clients.
 *
 *   GET  /api/auth/status    environment readiness, credential status words, caller's session expiry. Never returns a secret.
 *   POST /api/auth/session   {environment:"paper"|"testnet"}  issue a session cookie (HttpOnly). Same-origin only.
 *   POST /api/auth/refresh   {environment}                    replace the current token with a fresh one (old one is revoked)
 *   POST /api/auth/revoke    {environment}                    revoke the caller's own session. With the master token: {environment|"all"} revokes everything.
 *   POST /api/auth/rotate    master token only                rotate the signing key (KV-held keys; for a secret-held key replace the secret)
 *
 * Tokens are only ever delivered in Set-Cookie. No response body contains a token, key or credential.
 */
import { SCOPES, POLICY, authenticate, autoMode, clearCookie, issueSession, keySummary, readCookie, refOf, refreshSession, revokeAll, revokeSession, rateLimit, rotateKeys, sameOrigin, sessionCookie, verifyToken, type AuthEnv, type EnvScope } from "./session.ts";
import { credentialReport, usable, type CredEnv } from "./credentials.ts";

export interface AuthRouteEnv extends AuthEnv, CredEnv { ETI_EXECUTION_TOKEN?: string; ETI_LIVE_TRADING_ENABLED?: string; ETI_KILL_SWITCH?: string }
export interface AuthDeps { now?: () => number; fetchImpl?: typeof fetch }
const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
function reply(body: unknown, status = 200, cookies: string[] = []) { const h = new Headers(H); for (const c of cookies) h.append("set-cookie", c); return new Response(JSON.stringify(body), { status, headers: h }); }
const isScope = (v: unknown): v is EnvScope => v === "paper" || v === "testnet";
const ipRefOf = (req: Request) => refOf(req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown");
async function sessionInfo(req: Request, env: AuthRouteEnv, scope: EnvScope, now: number) {
  const t = readCookie(req, POLICY[scope].cookie); if (!t) return null;
  const v = await verifyToken(env, t, scope, now); if (!v.ok) return { active: false, reason: v.reason };
  const r = v.record; return { active: true, expiresAt: r.expiresAt, absoluteExpiresAt: r.absoluteExpiresAt, refreshAfter: r.createdAt + Math.floor((r.expiresAt - r.createdAt) / 2), refreshes: r.refreshes };
}
export async function testnetEligibility(env: AuthRouteEnv, deps: AuthDeps, validate: boolean) {
  const now = (deps.now ?? Date.now)();
  const brokers = await Promise.all((["alpaca", "binance"] as const).map(b => credentialReport(env, b, { validate, fetchImpl: deps.fetchImpl, now })));
  return { brokers, eligible: brokers.some(b => b.status !== "missing" && usable(b.status)) };
}
export async function handleAuth(req: Request, env: AuthRouteEnv, deps: AuthDeps = {}): Promise<Response> {
  const url = new URL(req.url), now = (deps.now ?? Date.now)(), path = url.pathname.replace(/\/+$/, "");
  if (!env.ETI_EXECUTION_LOG) return reply({ error: "auth_storage_not_configured", message: "Bind the ETI_EXECUTION_LOG KV namespace: sessions, key ring and audit records live there." }, 503);

  if (path === "/api/auth/status" && req.method === "GET") {
    const auth = await authenticate(req, env, now), validate = url.searchParams.get("validate") === "1" && (auth.master || auth.scopes.size > 0);
    const [elig, paper, testnet] = await Promise.all([testnetEligibility(env, deps, validate), sessionInfo(req, env, "paper", now), sessionInfo(req, env, "testnet", now)]);
    let keys = null; try { keys = await keySummary(env, now); } catch { keys = null; }
    const mode = autoMode(env);
    return reply({
      autoSessions: mode,
      environments: {
        internal_paper: { scope: "paper", ready: mode !== "off", authentication: mode === "off" ? "manual_token_required" : "automatic_session", exchangeContacted: false, session: paper },
        exchange_testnet: { scope: "testnet", ready: mode === "paper_testnet" && elig.eligible, authentication: mode === "paper_testnet" ? "automatic_session" : "manual_token_required",
          brokers: Object.fromEntries(elig.brokers.map(b => [b.broker, { environment: b.environment, status: b.status === "unreachable" && !b.checkedAt ? "unverified" : b.status, checkedAt: b.checkedAt }])),
          fallback: elig.eligible ? null : { to: "internal_paper", reason: "exchange_credentials_missing_or_invalid" }, session: testnet },
        live: { status: "disabled", enabledInWorkerConfig: env.ETI_LIVE_TRADING_ENABLED === "true", sessionsIssued: false, requires: "not available: this build has no live order path and never routes orders to a real-money account" },
      },
      killSwitch: env.ETI_KILL_SWITCH === "true", signingKey: keys, withdrawalsAndTransfers: "not implemented",
      caller: { master: auth.master, scopes: [...auth.scopes] },
    });
  }
  const posts = ["/api/auth/session", "/api/auth/refresh", "/api/auth/revoke", "/api/auth/rotate"];
  if (!path.startsWith("/api/auth/") || (!posts.includes(path) && path !== "/api/auth/status")) return reply({ error: "not_found" }, 404);
  if (req.method !== "POST") return reply({ error: "method_not_allowed", allowed: path === "/api/auth/status" ? "GET" : "POST" }, 405);
  const body: any = await req.json().catch(() => ({}));

  if (path === "/api/auth/rotate") {
    const auth = await authenticate(req, env, now); if (!auth.master) return reply({ error: "unauthorized", message: "Rotating the signing key needs the master ETI_EXECUTION_TOKEN." }, 401);
    try { return reply({ ok: true, signingKey: await rotateKeys(env, now), note: "Existing unexpired sessions stay valid until they expire; the previous key is retired after the longest session life." }); }
    catch (e) { return reply({ error: e instanceof Error ? e.message : "rotate_failed", message: "The key is held in the ETI_SESSION_SECRET Worker secret: replace it (and put the old value in ETI_SESSION_SECRET_PREVIOUS)." }, 409); }
  }
  if (path === "/api/auth/revoke") {
    const auth = await authenticate(req, env, now), target = body?.environment;
    if (auth.master && (target === "all" || isScope(target))) { const hit = await revokeAll(env, target); return reply({ ok: true, revoked: hit, note: "Every session of these environments is invalid immediately." }, 200, hit.map(clearCookie)); }
    if (!isScope(target)) return reply({ error: "invalid_environment", allowed: SCOPES }, 400);
    const t = readCookie(req, POLICY[target].cookie); if (t && !sameOrigin(req)) return reply({ error: "csrf_origin_mismatch" }, 403);
    const ok = t ? await revokeSession(env, t, target, now) : false;
    return reply({ ok, revoked: ok ? [target] : [] }, ok ? 200 : 401, [clearCookie(target)]);
  }
  // session / refresh: browser-initiated, same-origin only
  if (!sameOrigin(req)) return reply({ error: "csrf_origin_mismatch", message: "Sessions are only issued to same-origin requests from the ETI dashboard." }, 403);
  const mode = autoMode(env), ipRef = await ipRefOf(req), want = body?.environment;
  if (want === "live") return reply({ error: "live_trading_disabled_by_design", message: "No session can authorise live trading. Live orders need the master token, the live activation secret and the Worker live switch." }, 403);
  if (!isScope(want)) return reply({ error: "invalid_environment", allowed: SCOPES }, 400);
  if (mode === "off") return reply({ error: "automatic_sessions_disabled", message: "ETI_AUTO_SESSIONS=off: use the master execution token." }, 403);
  const rl = await rateLimit(env, (path === "/api/auth/session" ? "issue:" : "refresh:") + ipRef, path === "/api/auth/session" ? 30 : 120, 600, now);
  if (!rl.ok) return reply({ error: "rate_limited", retryAfterSeconds: 600 }, 429);

  if (path === "/api/auth/refresh") {
    const t = readCookie(req, POLICY[want].cookie); if (!t) return reply({ error: "no_session" }, 401);
    const r = await refreshSession(env, t, want, ipRef, now);
    if (!r.ok) return reply({ error: "refresh_failed", reason: r.reason, message: "Request a new session." }, 401, [clearCookie(want)]);
    const rec = r.issued.record;
    return reply({ ok: true, environment: want, expiresAt: rec.expiresAt, absoluteExpiresAt: rec.absoluteExpiresAt, refreshAfter: now + Math.floor((rec.expiresAt - now) / 2), refreshes: rec.refreshes }, 200, [sessionCookie(want, r.issued.token, (rec.expiresAt - now) / 1000)]);
  }
  // issue
  const notices: string[] = []; let scope: EnvScope = want, fallbackFrom: string | null = null, reason: string | null = null;
  if (want === "testnet") {
    const elig = mode === "paper_testnet" ? await testnetEligibility(env, deps, true) : null;
    if (!elig || !elig.eligible) {
      scope = "paper"; fallbackFrom = "exchange_testnet";
      reason = mode !== "paper_testnet" ? "testnet_sessions_disabled_by_ETI_AUTO_SESSIONS" : elig!.brokers.every(b => b.status === "missing") ? "exchange_credentials_missing" : "exchange_credentials_invalid";
      notices.push("Exchange testnet is not available (" + reason + "). Orders will run in ETI INTERNAL PAPER mode. No exchange testnet order will be placed.");
    }
  }
  const issued = await issueSession(env, scope, ipRef, now);
  const rec = issued.record;
  return reply({ ok: true, environment: scope, requested: want, fallback: fallbackFrom ? { from: fallbackFrom, to: "internal_paper", reason } : null, notices,
    expiresAt: rec.expiresAt, absoluteExpiresAt: rec.absoluteExpiresAt, refreshAfter: now + Math.floor((rec.expiresAt - now) / 2) }, 201, [sessionCookie(scope, issued.token, (rec.expiresAt - now) / 1000)]);
}
