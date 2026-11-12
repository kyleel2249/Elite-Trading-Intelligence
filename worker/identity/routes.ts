/**
 * /api/identity/*  accounts, sign-in, MFA, roles and the audit trail.  /account  the sign-in and administration page.
 *
 *   GET  /api/identity/status            availability, whether an administrator exists, caller summary (never a secret)
 *   POST /api/identity/bootstrap         master token only, only while no account exists: creates the first administrator
 *   POST /api/identity/login             {email,password,code?|recoveryCode?}  sets the HttpOnly eti_user cookie
 *   POST /api/identity/logout
 *   GET  /api/identity/me
 *   POST /api/identity/mfa/enroll        signed in: returns the TOTP secret + otpauth URI once
 *   POST /api/identity/mfa/confirm       {code}: enables MFA, returns single-use recovery codes ONCE, replaces the session
 *   POST /api/identity/password          {current,next}
 *   GET  /api/identity/users             users.manage (admin + MFA) or master token
 *   POST /api/identity/users             {email,password,role}
 *   POST /api/identity/users/:id/{role|disable|enable|reset-mfa|revoke}
 *   GET  /api/identity/audit             audit.read; ?limit=&before=
 *   GET  /api/identity/audit/verify      recompute the tamper-evident hash chain
 */
import { constantTimeEqual, rateLimit, refOf, sameOrigin, readCookie, type AuthEnv } from "../auth/session.ts";
import { COOKIE, bootstrapAdmin, changePassword, createUser, identify, identityUnavailable, login, logout, mfaConfirm, mfaEnroll, openCtx, publicUser, resetMfa, revokeUser, setDisabled, setRole, type Ctx, type Fail, type IdentityEnv } from "./service.ts";
import { permissionsOf, roleCan, ROLES, sessionPolicy, type Permission } from "./rbac.ts";
import { ACCOUNT_HTML } from "./ui.ts";

export type IdentityRouteEnv = AuthEnv & IdentityEnv & { ETI_EXECUTION_TOKEN?: string };
const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (body: unknown, status = 200, cookies: string[] = [], extra: Record<string, string> = {}) => { const h = new Headers({ ...H, ...extra }); for (const c of cookies) h.append("set-cookie", c); return new Response(JSON.stringify(body), { status, headers: h }); };
const fail = (f: Fail) => reply({ error: f.error, message: f.message }, f.status, [], f.retryAfterSec ? { "retry-after": String(f.retryAfterSec) } : {});
export const userCookie = (token: string, maxAgeSec: number) => `${COOKIE}=${token}; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}; Path=/; HttpOnly; Secure; SameSite=Strict`;
export const clearUserCookie = () => `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
const ipRefOf = (req: Request) => refOf(req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "unknown");

async function masterOk(req: Request, token: string | undefined) {
  const given = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""); if (!token || !given) return false;
  const e = new TextEncoder(), [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", e.encode(token)), crypto.subtle.digest("SHA-256", e.encode(given))]);
  return constantTimeEqual(new Uint8Array(a), new Uint8Array(b));
}
export const HTML_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" };

export async function handleIdentity(req: Request, env: IdentityRouteEnv, deps: { now?: () => number } = {}): Promise<Response> {
  const url = new URL(req.url), now = (deps.now ?? Date.now)(), path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/account") return new Response(ACCOUNT_HTML, { headers: HTML_HEADERS });
  const post = req.method === "POST";
  if (post && !sameOrigin(req) && !req.headers.get("authorization")) return reply({ error: "csrf_origin_mismatch" }, 403);
  const why = identityUnavailable(env);
  if (path === "/api/identity/status") {
    const mfaPolicy = { requiredFor: ["trader", "admin"], method: "totp_rfc6238" }, roles = ROLES.map(r => ({ role: r, permissions: permissionsOf(r), session: sessionPolicy(r) }));
    if (why) return reply({ available: false, ...why, roles, mfaPolicy });
    const c = (await openCtx(env, now))!, token = readCookie(req, COOKIE), me = token ? await identify(c, token) : null;
    return reply({ available: true, bootstrapped: (await c.store.userCount()) > 0, roles, mfaPolicy, caller: me ? { email: me.email, role: me.role, mfa: me.mfa, limited: me.limited } : null });
  }
  if (why) return reply(why, 503);
  const ipRef = await ipRefOf(req), c = (await openCtx(env, now, ipRef))!;
  const token = readCookie(req, COOKIE), me = token ? await identify(c, token) : null;
  const master = await masterOk(req, env.ETI_EXECUTION_TOKEN);
  const actorOf = () => master ? "master_token" : me ? me.uid : "anonymous";
  /** A permission is granted to a signed-in user whose role has it and whose session is fully MFA-verified, or to the master token. */
  const allowed = (p: Permission) => master || (!!me && !me.limited && roleCan(me.role, p));

  if (path === "/api/identity/bootstrap" && post) {
    if (!master) return reply({ error: "master_token_required", message: "Creating the first administrator needs the master ETI_EXECUTION_TOKEN as a Bearer token." }, 401);
    const b: any = await req.json().catch(() => ({})), r = await bootstrapAdmin(c, b.email, b.password); return r.ok ? reply({ ok: true, user: r.user, next: "Sign in at /account, then enrol MFA." }, 201) : fail(r);
  }
  if (path === "/api/identity/login" && post) {
    const rl = await rateLimit(env, "login:" + ipRef, 20, 600, now); if (!rl.ok) return reply({ error: "rate_limited", message: "Too many sign-in attempts from this network. Wait a few minutes." }, 429, [], { "retry-after": "600" });
    const b: any = await req.json().catch(() => ({})), r = await login(c, b); if (!r.ok) return fail(r);
    return reply({ ok: true, user: r.user, session: r.session, recoveryCodesLeft: r.recoveryCodesLeft, next: r.session.limited ? "mfa_enrol_required" : null }, 200, [userCookie(r.token, (r.session.expiresAt - now) / 1000)]);
  }
  if (path === "/api/identity/logout" && post) { if (me) await logout(c, me); return reply({ ok: true }, 200, [clearUserCookie()]); }
  if (path === "/api/identity/me") return me ? reply({ user: { id: me.uid, email: me.email, role: me.role, mfa: me.mfa, limited: me.limited, scopes: me.scopes, permissions: me.limited ? [] : permissionsOf(me.role) } }) : reply({ error: "unauthorized" }, 401);
  if (path === "/api/identity/mfa/enroll" && post) { if (!me) return reply({ error: "unauthorized" }, 401); const r = await mfaEnroll(c, me); return r.ok ? reply({ ok: true, secret: r.secret, otpauthUri: r.otpauthUri, note: "Shown once. Add it to an authenticator app, then confirm with a current code." }) : fail(r); }
  if (path === "/api/identity/mfa/confirm" && post) {
    if (!me) return reply({ error: "unauthorized" }, 401);
    const rl = await rateLimit(env, "mfa:" + me.uid, 10, 600, now); if (!rl.ok) return reply({ error: "rate_limited" }, 429);
    const b: any = await req.json().catch(() => ({})), r = await mfaConfirm(c, me, b.code); if (!r.ok) return fail(r);
    return reply({ ok: true, recoveryCodes: r.recoveryCodes, note: "Store these recovery codes offline. Each works once and they are never shown again." }, 200, [userCookie(r.token, (r.session.expiresAt - now) / 1000)]);
  }
  if (path === "/api/identity/password" && post) {
    if (!me) return reply({ error: "unauthorized" }, 401);
    const b: any = await req.json().catch(() => ({})), r = await changePassword(c, me, b.current, b.next); return r.ok ? reply({ ok: true }, 200, [userCookie(r.token, sessionPolicy(me.role).idleSec)]) : fail(r);
  }
  if (path === "/api/identity/users") {
    if (!allowed("users.manage")) return reply({ error: me?.limited ? "mfa_required" : "forbidden", message: "Needs an administrator signed in with MFA, or the master token." }, me || master ? 403 : 401);
    if (req.method === "GET") return reply({ users: (await c.store.users()).map(publicUser) });
    if (post) { const b: any = await req.json().catch(() => ({})), r = await createUser(c, b, actorOf()); return r.ok ? reply({ ok: true, user: r.user }, 201) : fail(r); }
  }
  const m = path.match(/^\/api\/identity\/users\/([A-Za-z0-9_-]{3,40})\/(role|disable|enable|reset-mfa|revoke)$/);
  if (m && post) {
    if (!allowed("users.manage")) return reply({ error: me?.limited ? "mfa_required" : "forbidden" }, me || master ? 403 : 401);
    const [, id, act] = m, b: any = await req.json().catch(() => ({})), actor = actorOf();
    if (me && id === me.uid && (act === "disable" || (act === "role" && b.role !== me.role))) return reply({ error: "self_change_refused", message: "Ask another administrator to change your own role or status." }, 409);
    const r = act === "role" ? await setRole(c, actor, id, b.role) : act === "disable" ? await setDisabled(c, actor, id, true) : act === "enable" ? await setDisabled(c, actor, id, false) : act === "reset-mfa" ? await resetMfa(c, actor, id) : await revokeUser(c, actor, id);
    return r.ok ? reply({ ok: true, ...("user" in r ? { user: r.user } : {}) }) : fail(r);
  }
  if (path === "/api/identity/audit" && req.method === "GET") {
    if (!allowed("audit.read")) return reply({ error: me?.limited ? "mfa_required" : "forbidden" }, me || master ? 403 : 401);
    const lim = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 100)), before = Number(url.searchParams.get("before")) || undefined;
    return reply({ rows: await c.store.auditRows(lim, before) });
  }
  if (path === "/api/identity/audit/verify" && req.method === "GET") {
    if (!allowed("audit.read")) return reply({ error: me?.limited ? "mfa_required" : "forbidden" }, me || master ? 403 : 401);
    return reply(await c.store.verifyAudit());
  }
  return reply({ error: "not_found" }, 404);
}

/** Layer: /account and /api/identity/* are served here; everything else goes to the wrapped app. */
export function withIdentity(inner: { fetch(req: Request, env: any, ctx?: any): Promise<Response> | Response }) {
  return { ...inner, fetch: (req: Request, env: any, ctx?: any) => { const p = new URL(req.url).pathname; return p === "/account" || p.startsWith("/api/identity/") || p === "/api/identity" ? handleIdentity(req, env) : inner.fetch(req, env, ctx); } };
}
