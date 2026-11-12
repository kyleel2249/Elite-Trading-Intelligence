/** Identity service: accounts, passwords, TOTP MFA with recovery codes, revocable sessions, role management, audit. Pure functions over IdentityStore so they are testable without HTTP. */
import { hmacHex } from "../auth/credentials.ts";
import { randomToken, refOf } from "../auth/session.ts";
import { isD1, type D1DB } from "../portfolio/store.ts";
import { hashPassword, passwordProblems, verifyPassword } from "./password.ts";
import { isRole, requiresMfa, scopesOf, sessionPolicy, type Role } from "./rbac.ts";
import { IdentityStore, sha256Hex, type SessionRow, type UserRow } from "./store.ts";
import { open as openSealed, seal } from "./seal.ts";
import { newRecoveryCodes, newTotpSecret, normaliseRecovery, otpauthUri, verifyTotp } from "./totp.ts";

export interface IdentityEnv { ETI_PORTFOLIO_DB?: unknown; ETI_IDENTITY_KEY?: string; ETI_IDENTITY_KEY_PREVIOUS?: string; ETI_IDENTITY_ISSUER?: string }
export const COOKIE = "eti_user";
export const MAX_FAILED = 5, LOCK_BASE_MS = 15 * 60_000, LOCK_MAX_MS = 24 * 3600_000;
export interface Ctx { store: IdentityStore; keys: string[]; now: number; ipRef: string | null; issuer: string }
export type Fail = { ok: false; status: number; error: string; message?: string; retryAfterSec?: number };
export type Ok<T> = { ok: true } & T;
const fail = (status: number, error: string, message?: string, extra: Partial<Fail> = {}): Fail => ({ ok: false, status, error, message, ...extra });
export const identityKeys = (env: IdentityEnv) => [env.ETI_IDENTITY_KEY, env.ETI_IDENTITY_KEY_PREVIOUS].filter((k): k is string => typeof k === "string" && k.length >= 32);

/** Why identity cannot run, or null when it can. Nothing is faked: without a D1 database and a dedicated key there are no accounts. */
export function identityUnavailable(env: IdentityEnv): { error: string; message: string } | null {
  if (!isD1(env.ETI_PORTFOLIO_DB)) return { error: "identity_storage_missing", message: "Accounts need the ETI_PORTFOLIO_DB D1 database (strong consistency for sessions, lockout and the audit chain)." };
  if (identityKeys(env).length === 0) return { error: "identity_key_missing", message: "Set the ETI_IDENTITY_KEY Worker secret (32+ random characters) before creating accounts. It encrypts MFA seeds and peppers password hashes." };
  return null;
}
export async function openCtx(env: IdentityEnv, now: number, ipRef: string | null = null): Promise<Ctx | null> {
  if (identityUnavailable(env)) return null;
  return { store: await new IdentityStore(env.ETI_PORTFOLIO_DB as D1DB).init(), keys: identityKeys(env), now, ipRef, issuer: env.ETI_IDENTITY_ISSUER || "ETI" };
}
const emailOk = (e: string) => e.length <= 254 && /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(e);
const normEmail = (e: unknown) => typeof e === "string" ? e.trim().toLowerCase() : "";
const uid = () => "u_" + randomToken(12);
const sidOf = (token: string) => sha256Hex("sid|" + token);
export const publicUser = (u: UserRow) => ({ id: u.id, email: u.email, role: u.role, mfaEnabled: !!u.mfa_enabled, disabled: !!u.disabled, locked: u.locked_until > Date.now(), createdAt: u.created_at, lastLogin: u.last_login });
const recoveryHash = (keys: string[], id: string, code: string) => hmacHex(keys[0], "recovery|" + id + "|" + normaliseRecovery(code));

export async function createUser(c: Ctx, input: { email: unknown; password: unknown; role: unknown }, actor: string): Promise<Ok<{ user: ReturnType<typeof publicUser> }> | Fail> {
  const email = normEmail(input.email), pw = typeof input.password === "string" ? input.password : "";
  if (!emailOk(email)) return fail(400, "invalid_email");
  if (!isRole(input.role)) return fail(400, "invalid_role");
  const problems = passwordProblems(pw, email); if (problems.length) return fail(400, "weak_password", "Password: " + problems.join("; ") + ".");
  const id = uid();
  try { await c.store.insertUser({ id, email, pw: await hashPassword(pw, c.keys[0]), role: input.role }, c.now); }
  catch (e) { if (/UNIQUE|constraint/i.test(String((e as Error)?.message ?? e))) return fail(409, "email_taken"); throw e; }
  await c.store.audit(c.now, actor, "user_created", id, { role: input.role }, c.ipRef);
  return { ok: true, user: publicUser((await c.store.userById(id))!) };
}
/** First administrator. Allowed only while there are no users, and only the caller who holds the master token reaches it (checked by the route). */
export async function bootstrapAdmin(c: Ctx, email: unknown, password: unknown): Promise<Ok<{ user: ReturnType<typeof publicUser> }> | Fail> {
  if ((await c.store.userCount()) > 0) return fail(409, "already_bootstrapped", "An administrator already exists. Sign in, or ask an administrator for an account.");
  return createUser(c, { email, password, role: "admin" }, "master_token");
}

async function issue(c: Ctx, u: UserRow, mfa: boolean): Promise<{ token: string; row: SessionRow }> {
  const pol = sessionPolicy(u.role), token = "u1." + randomToken(32), sid = await sidOf(token);
  const row: SessionRow = { sid, uid: u.id, created_at: c.now, expires_at: c.now + pol.idleSec * 1000, absolute_at: c.now + pol.absoluteSec * 1000, revoked: 0, ip_ref: c.ipRef, mfa: mfa ? 1 : 0, limited: requiresMfa(u.role) && !mfa ? 1 : 0 };
  await c.store.insertSession(row); await c.store.purgeExpired(c.now);
  return { token, row };
}
const failedAttempt = async (c: Ctx, u: UserRow, why: string) => {
  const failed = u.failed + 1, lock = failed >= MAX_FAILED ? c.now + Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** (failed - MAX_FAILED)) : 0;
  await c.store.update(u.id, { failed, locked_until: lock }, c.now); await c.store.audit(c.now, u.id, "login_failed", u.id, { why, failed, locked: lock > 0 }, c.ipRef);
};
export interface LoginOk { token: string; session: { role: Role; mfa: boolean; limited: boolean; expiresAt: number; absoluteExpiresAt: number }; user: ReturnType<typeof publicUser>; recoveryCodesLeft: number }
export async function login(c: Ctx, input: { email: unknown; password: unknown; code?: unknown; recoveryCode?: unknown }): Promise<Ok<LoginOk> | Fail> {
  const email = normEmail(input.email), pw = typeof input.password === "string" ? input.password : "", u = email ? await c.store.userByEmail(email) : null;
  if (!u) { await hashPassword(pw.slice(0, 256), c.keys[0]); await c.store.audit(c.now, "anonymous", "login_failed", await refOf(email || "none"), { why: "unknown_user" }, c.ipRef); return fail(401, "invalid_credentials", "Email or password is incorrect."); } // same work as a real attempt: no user enumeration by timing
  if (u.locked_until > c.now) return fail(429, "account_locked", "Too many failed attempts. Try again later.", { retryAfterSec: Math.ceil((u.locked_until - c.now) / 1000) });
  const v = await verifyPassword(pw, u.pw, c.keys);
  if (!v.ok || u.disabled) { if (!u.disabled) await failedAttempt(c, u, "bad_password"); else await c.store.audit(c.now, u.id, "login_refused_disabled", u.id, null, c.ipRef); return fail(401, "invalid_credentials", "Email or password is incorrect."); }
  let mfa = false, left = (JSON.parse(u.recovery || "[]") as string[]).length;
  if (u.mfa_enabled) {
    const code = typeof input.code === "string" ? input.code.trim() : "", rc = typeof input.recoveryCode === "string" ? input.recoveryCode.trim() : "";
    if (!code && !rc) return fail(401, "mfa_required", "Enter the 6-digit code from your authenticator app (or a recovery code).");
    if (code) {
      const secret = u.mfa_secret ? await openSealed(c.keys, "mfa|" + u.id, u.mfa_secret) : null, counter = secret ? await verifyTotp(secret, code, c.now, u.mfa_counter) : null;
      if (counter === null) { await failedAttempt(c, u, "bad_totp"); return fail(401, "invalid_mfa_code", "That code is not valid (or was already used)."); }
      await c.store.update(u.id, { mfa_counter: counter }, c.now);
    } else {
      const hashes = JSON.parse(u.recovery || "[]") as string[], h = await recoveryHash(c.keys, u.id, rc), i = hashes.indexOf(h);
      if (i < 0) { await failedAttempt(c, u, "bad_recovery"); return fail(401, "invalid_mfa_code", "That recovery code is not valid."); }
      hashes.splice(i, 1); left = hashes.length; await c.store.update(u.id, { recovery: JSON.stringify(hashes) }, c.now); await c.store.audit(c.now, u.id, "recovery_code_used", u.id, { left }, c.ipRef);
    }
    mfa = true;
  }
  const patch: Partial<UserRow> = { failed: 0, locked_until: 0, last_login: c.now }; if (v.needsRehash) patch.pw = await hashPassword(pw, c.keys[0]);
  await c.store.update(u.id, patch, c.now);
  const { token, row } = await issue(c, u, mfa);
  await c.store.audit(c.now, u.id, "login", u.id, { mfa, limited: !!row.limited }, c.ipRef);
  return { ok: true, token, user: publicUser((await c.store.userById(u.id))!), recoveryCodesLeft: left, session: { role: u.role, mfa, limited: !!row.limited, expiresAt: row.expires_at, absoluteExpiresAt: row.absolute_at } };
}

export interface Identity { uid: string; email: string; role: Role; mfa: boolean; limited: boolean; sid: string; scopes: ("paper" | "testnet")[] }
/** Resolve a session cookie. A "limited" session (privileged role without MFA yet) is identified but receives no scopes and no privileges. */
export async function identify(c: Ctx, token: string): Promise<Identity | null> {
  if (!token.startsWith("u1.") || token.length > 120) return null;
  const sid = await sidOf(token), s = await c.store.session(sid); if (!s || s.revoked || s.expires_at <= c.now || s.absolute_at <= c.now) return null;
  const u = await c.store.userById(s.uid); if (!u || u.disabled) return null;
  const pol = sessionPolicy(u.role), want = Math.min(c.now + pol.idleSec * 1000, s.absolute_at);
  if (want - s.expires_at > pol.idleSec * 500) await c.store.touchSession(sid, want); // slide the idle window at most every half period
  const mfa = !!s.mfa && !s.limited;
  return { uid: u.id, email: u.email, role: u.role, mfa, limited: !!s.limited, sid, scopes: s.limited ? [] : scopesOf(u.role) };
}
export async function logout(c: Ctx, id: Identity) { await c.store.revokeSession(id.sid); await c.store.audit(c.now, id.uid, "logout", id.uid, null, c.ipRef); }

export async function mfaEnroll(c: Ctx, id: Identity): Promise<Ok<{ secret: string; otpauthUri: string }> | Fail> {
  const u = await c.store.userById(id.uid); if (!u) return fail(404, "no_user");
  if (u.mfa_enabled) return fail(409, "mfa_already_enabled", "MFA is already on. An administrator can reset it.");
  const secret = newTotpSecret(); await c.store.update(u.id, { mfa_secret: await seal(c.keys[0], "mfa|" + u.id, secret) }, c.now);
  await c.store.audit(c.now, u.id, "mfa_enrol_started", u.id, null, c.ipRef);
  return { ok: true, secret, otpauthUri: otpauthUri(c.issuer, u.email, secret) };
}
export async function mfaConfirm(c: Ctx, id: Identity, code: unknown): Promise<Ok<{ recoveryCodes: string[]; token: string; session: LoginOk["session"] }> | Fail> {
  const u = await c.store.userById(id.uid); if (!u || !u.mfa_secret) return fail(409, "no_pending_enrolment", "Start enrolment first.");
  if (u.mfa_enabled) return fail(409, "mfa_already_enabled");
  const secret = await openSealed(c.keys, "mfa|" + u.id, u.mfa_secret), counter = secret && typeof code === "string" ? await verifyTotp(secret, code.trim(), c.now, -1) : null;
  if (counter === null) { await c.store.audit(c.now, u.id, "mfa_confirm_failed", u.id, null, c.ipRef); return fail(401, "invalid_mfa_code", "That code is not valid. Check the authenticator entry and your device clock.") }
  const codes = newRecoveryCodes(10), hashes = await Promise.all(codes.map(x => recoveryHash(c.keys, u.id, x)));
  await c.store.update(u.id, { mfa_enabled: 1, mfa_counter: counter, recovery: JSON.stringify(hashes) }, c.now);
  await c.store.revokeUserSessions(u.id); // every older session, including this one, is replaced by a fully privileged MFA session
  const { token, row } = await issue(c, { ...u, mfa_enabled: 1 }, true);
  await c.store.audit(c.now, u.id, "mfa_enabled", u.id, null, c.ipRef);
  return { ok: true, recoveryCodes: codes, token, session: { role: u.role, mfa: true, limited: false, expiresAt: row.expires_at, absoluteExpiresAt: row.absolute_at } };
}
export async function changePassword(c: Ctx, id: Identity, current: unknown, next: unknown): Promise<Ok<{ token: string }> | Fail> {
  const u = await c.store.userById(id.uid); if (!u) return fail(404, "no_user");
  if (!(await verifyPassword(typeof current === "string" ? current : "", u.pw, c.keys)).ok) { await failedAttempt(c, u, "bad_password_on_change"); return fail(401, "invalid_credentials", "Current password is incorrect."); }
  const pw = typeof next === "string" ? next : "", problems = passwordProblems(pw, u.email); if (problems.length) return fail(400, "weak_password", "Password: " + problems.join("; ") + ".");
  await c.store.update(u.id, { pw: await hashPassword(pw, c.keys[0]), failed: 0 }, c.now); await c.store.revokeUserSessions(u.id);
  const { token } = await issue(c, u, id.mfa); await c.store.audit(c.now, u.id, "password_changed", u.id, null, c.ipRef);
  return { ok: true, token };
}

// ----- administration (callers have already proven users.manage) -----
async function lastAdminGuard(c: Ctx, u: UserRow): Promise<Fail | null> { return u.role === "admin" && !u.disabled && (await c.store.activeAdmins()) <= 1 ? fail(409, "last_admin", "This is the only active administrator. Create another first.") : null; }
export async function setRole(c: Ctx, actor: string, userId: string, role: unknown): Promise<Ok<{ user: ReturnType<typeof publicUser> }> | Fail> {
  const u = await c.store.userById(userId); if (!u) return fail(404, "no_user"); if (!isRole(role)) return fail(400, "invalid_role");
  if (u.role === "admin" && role !== "admin") { const g = await lastAdminGuard(c, u); if (g) return g; }
  await c.store.update(u.id, { role }, c.now); await c.store.revokeUserSessions(u.id); // privileges changed: force a fresh sign-in
  await c.store.audit(c.now, actor, "role_changed", u.id, { from: u.role, to: role }, c.ipRef); return { ok: true, user: publicUser((await c.store.userById(u.id))!) };
}
export async function setDisabled(c: Ctx, actor: string, userId: string, disabled: boolean): Promise<Ok<{ user: ReturnType<typeof publicUser> }> | Fail> {
  const u = await c.store.userById(userId); if (!u) return fail(404, "no_user");
  if (disabled) { const g = await lastAdminGuard(c, u); if (g) return g; }
  await c.store.update(u.id, { disabled: disabled ? 1 : 0, failed: 0, locked_until: 0 }, c.now); if (disabled) await c.store.revokeUserSessions(u.id);
  await c.store.audit(c.now, actor, disabled ? "user_disabled" : "user_enabled", u.id, null, c.ipRef); return { ok: true, user: publicUser((await c.store.userById(u.id))!) };
}
export async function resetMfa(c: Ctx, actor: string, userId: string): Promise<Ok<{ user: ReturnType<typeof publicUser> }> | Fail> {
  const u = await c.store.userById(userId); if (!u) return fail(404, "no_user");
  await c.store.update(u.id, { mfa_enabled: 0, mfa_secret: null, mfa_counter: -1, recovery: "[]" }, c.now); await c.store.revokeUserSessions(u.id);
  await c.store.audit(c.now, actor, "mfa_reset", u.id, null, c.ipRef); return { ok: true, user: publicUser((await c.store.userById(u.id))!) };
}
export async function revokeUser(c: Ctx, actor: string, userId: string): Promise<Ok<{}> | Fail> { if (!(await c.store.userById(userId))) return fail(404, "no_user"); await c.store.revokeUserSessions(userId); await c.store.audit(c.now, actor, "sessions_revoked", userId, null, c.ipRef); return { ok: true }; }
