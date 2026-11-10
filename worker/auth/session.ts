/**
 * ETI server-side execution authorization: sessions, key ring, rotation, expiry, refresh and revocation.
 *
 * Design
 *  - A browser never types or stores a token. The server issues a short-lived signed session and sets it as an
 *    HttpOnly, Secure, SameSite=Strict cookie, so it is invisible to page scripts, bundles, localStorage and API bodies.
 *  - Sessions are scoped to ONE environment ("paper" = ETI internal paper, "testnet" = exchange testnet/broker paper).
 *    The scope is inside the signed payload and in a separate cookie and KV namespace per environment.
 *    There is no "live" scope: live trading is never reachable through a session.
 *  - Signing keys come from the Cloudflare secret ETI_SESSION_SECRET (preferred; ETI_SESSION_SECRET_PREVIOUS keeps old
 *    sessions valid across a manual rotation) or, when no secret is set, from a random 256-bit key the Worker generates
 *    with crypto.getRandomValues and keeps in KV. KV keys rotate automatically; the old key stays valid for the
 *    longest possible session life and is then dropped.
 *  - Revocation is immediate: every token is checked against its KV session record, and a per-environment epoch lets
 *    an operator revoke everything at once.
 */
export type EnvScope = "paper" | "testnet";
export const SCOPES: EnvScope[] = ["paper", "testnet"];
export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list?(opts: { prefix: string; limit?: number; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete?: boolean; cursor?: string }>;
}
export interface AuthEnv {
  ETI_EXECUTION_LOG?: KV | any;
  ETI_SESSION_SECRET?: string;
  ETI_SESSION_SECRET_PREVIOUS?: string;
  /** off | paper | paper_testnet (default). Controls what the server may issue without a manual token. */
  ETI_AUTO_SESSIONS?: string;
  ETI_KEY_ROTATION_DAYS?: string;
}
/** Idle lifetime of one token and the hard ceiling for a refreshed chain, per environment. Testnet is stricter. */
export const POLICY: Record<EnvScope, { ttlSec: number; absoluteSec: number; cookie: string }> = {
  paper: { ttlSec: 30 * 60, absoluteSec: 12 * 3600, cookie: "eti_paper" },
  testnet: { ttlSec: 15 * 60, absoluteSec: 4 * 3600, cookie: "eti_testnet" },
};
const MAX_SESSION_LIFE_SEC = Math.max(...SCOPES.map(s => POLICY[s].absoluteSec));
const enc = new TextEncoder();
const b64u = (u: Uint8Array) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
export const randomToken = (bytes = 32) => b64u(crypto.getRandomValues(new Uint8Array(bytes)));
export async function sha256Hex(s: string): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map(x => x.toString(16).padStart(2, "0")).join(""); }
/** Short, non-reversible reference that is safe to log and store in audit records. */
export const refOf = async (s: string) => (await sha256Hex("ref|" + s)).slice(0, 12);
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; }
async function hmacKey(raw: Uint8Array, usage: KeyUsage) { return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [usage]); }
async function sign(raw: Uint8Array, msg: string): Promise<Uint8Array> { return new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(raw, "sign"), enc.encode(msg))); }

// ---------- key ring ----------
interface RingKey { v: number; key: string; createdAt: number; retireAt?: number }
interface Ring { current: RingKey; previous: RingKey[] }
export interface KeySummary { source: "secret" | "kv"; version: number; createdAt: number | null; previousKeys: number }
async function deriveFromSecret(secret: string, label: string): Promise<string> { return b64u(await sign(enc.encode(secret), "eti-session-key|" + label)); }
export async function loadRing(env: AuthEnv, now: number, opts: { rotate?: boolean } = {}): Promise<{ ring: Ring; source: "secret" | "kv" }> {
  if (env.ETI_SESSION_SECRET && env.ETI_SESSION_SECRET.length >= 24) {
    const prev: RingKey[] = [];
    if (env.ETI_SESSION_SECRET_PREVIOUS && env.ETI_SESSION_SECRET_PREVIOUS.length >= 24) prev.push({ v: 0, key: await deriveFromSecret(env.ETI_SESSION_SECRET_PREVIOUS, "k"), createdAt: 0 });
    return { ring: { current: { v: 1, key: await deriveFromSecret(env.ETI_SESSION_SECRET, "k"), createdAt: 0 }, previous: prev }, source: "secret" };
  }
  const kv = env.ETI_EXECUTION_LOG as KV | undefined;
  if (!kv) throw new Error("auth_storage_not_configured");
  let ring: Ring | null = null;
  try { ring = JSON.parse((await kv.get("auth:keyring")) || "null"); } catch { ring = null; }
  const maxAge = Math.max(1, Number(env.ETI_KEY_ROTATION_DAYS ?? "7") || 7) * 86400_000;
  const fresh = (v: number): RingKey => ({ v, key: randomToken(32), createdAt: now });
  let dirty = false;
  if (!ring || !ring.current) { ring = { current: fresh(1), previous: [] }; dirty = true; }
  else if (opts.rotate || now - ring.current.createdAt > maxAge) { ring = { current: fresh(ring.current.v + 1), previous: [{ ...ring.current, retireAt: now + MAX_SESSION_LIFE_SEC * 1000 }, ...ring.previous] }; dirty = true; }
  const kept = ring.previous.filter(k => (k.retireAt ?? 0) > now);
  if (kept.length !== ring.previous.length) { ring.previous = kept; dirty = true; }
  if (dirty) {
    await kv.put("auth:keyring", JSON.stringify(ring));
    // two cold starts can race on first creation: re-read so everyone converges on whichever write won
    try { const again = JSON.parse((await kv.get("auth:keyring")) || "null"); if (again?.current) ring = again; } catch { /* keep local */ }
  }
  return { ring: ring!, source: "kv" };
}
export async function rotateKeys(env: AuthEnv, now: number): Promise<KeySummary> {
  if (env.ETI_SESSION_SECRET) throw new Error("rotate_by_replacing_secret");
  const { ring } = await loadRing(env, now, { rotate: true });
  return { source: "kv", version: ring.current.v, createdAt: ring.current.createdAt, previousKeys: ring.previous.length };
}
export async function keySummary(env: AuthEnv, now: number): Promise<KeySummary> {
  const { ring, source } = await loadRing(env, now);
  return { source, version: ring.current.v, createdAt: source === "kv" ? ring.current.createdAt : null, previousKeys: ring.previous.length };
}

// ---------- sessions ----------
export interface SessionRecord { sid: string; scope: EnvScope; createdAt: number; chainStart: number; expiresAt: number; absoluteExpiresAt: number; refreshes: number; revoked: boolean; ipRef: string; epoch: number }
const sKey = (scope: EnvScope, sid: string) => "auth:s:" + scope + ":" + sid;
async function epochOf(kv: KV, scope: EnvScope): Promise<number> { return Number((await kv.get("auth:epoch:" + scope)) || "0") || 0; }
async function mint(env: AuthEnv, rec: SessionRecord, now: number): Promise<string> {
  const { ring } = await loadRing(env, now);
  const body = ["eti1", ring.current.v, rec.scope, rec.sid, Math.floor(rec.expiresAt / 1000), rec.epoch].join(".");
  return body + "." + b64u(await sign(unb64u(ring.current.key), body));
}
async function persist(kv: KV, rec: SessionRecord, now: number) { await kv.put(sKey(rec.scope, rec.sid), JSON.stringify(rec), { expirationTtl: Math.max(60, Math.ceil((rec.absoluteExpiresAt - now) / 1000) + 60) }); }
export interface Issued { token: string; record: SessionRecord }
export async function issueSession(env: AuthEnv, scope: EnvScope, ipRef: string, now: number, chain?: { chainStart: number; absoluteExpiresAt: number; refreshes: number }): Promise<Issued> {
  const kv = env.ETI_EXECUTION_LOG as KV; if (!kv) throw new Error("auth_storage_not_configured");
  const p = POLICY[scope], absolute = chain?.absoluteExpiresAt ?? now + p.absoluteSec * 1000;
  const rec: SessionRecord = { sid: randomToken(18), scope, createdAt: now, chainStart: chain?.chainStart ?? now, expiresAt: Math.min(now + p.ttlSec * 1000, absolute), absoluteExpiresAt: absolute, refreshes: chain?.refreshes ?? 0, revoked: false, ipRef, epoch: await epochOf(kv, scope) };
  await persist(kv, rec, now);
  return { token: await mint(env, rec, now), record: rec };
}
export type Verified = { ok: true; record: SessionRecord } | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "revoked" | "unknown_session" | "scope_mismatch" | "storage_unavailable" };
export async function verifyToken(env: AuthEnv, token: string, scope: EnvScope, now: number): Promise<Verified> {
  const parts = token.split(".");
  if (parts.length !== 7 || parts[0] !== "eti1") return { ok: false, reason: "malformed" };
  const [, vS, tScope, sid, expS, epochS, sig] = parts, v = Number(vS), exp = Number(expS), epoch = Number(epochS);
  if (!Number.isInteger(v) || !Number.isFinite(exp) || !Number.isFinite(epoch) || !/^[A-Za-z0-9_-]{10,64}$/.test(sid) || !/^[A-Za-z0-9_-]{20,64}$/.test(sig)) return { ok: false, reason: "malformed" };
  if (tScope !== scope) return { ok: false, reason: "scope_mismatch" };
  let ring: Ring; try { ring = (await loadRing(env, now)).ring; } catch { return { ok: false, reason: "storage_unavailable" }; }
  const body = parts.slice(0, 6).join("."), given = unb64u(sig);
  let sigOk = false;
  for (const k of [ring.current, ...ring.previous]) { // compare against every live key (the version field is informational, so a rotation never breaks an unexpired token)
    if (constantTimeEqual(await sign(unb64u(k.key), body), given)) sigOk = true;
  }
  if (!sigOk) return { ok: false, reason: "bad_signature" };
  if (exp * 1000 <= now) return { ok: false, reason: "expired" };
  const kv = env.ETI_EXECUTION_LOG as KV | undefined; if (!kv) return { ok: false, reason: "storage_unavailable" };
  let rec: SessionRecord | null = null; try { rec = JSON.parse((await kv.get(sKey(scope, sid))) || "null"); } catch { rec = null; }
  if (!rec || rec.scope !== scope) return { ok: false, reason: "unknown_session" };
  if (rec.revoked) return { ok: false, reason: "revoked" };
  if (rec.epoch !== (await epochOf(kv, scope))) return { ok: false, reason: "revoked" };
  if (rec.expiresAt <= now || rec.absoluteExpiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: true, record: rec };
}
/** Replace a valid token by a new one on the same chain. The old session is revoked at once. Fails once the absolute lifetime is reached. */
export async function refreshSession(env: AuthEnv, token: string, scope: EnvScope, ipRef: string, now: number): Promise<{ ok: true; issued: Issued } | { ok: false; reason: string }> {
  const v = await verifyToken(env, token, scope, now); if (!v.ok) return v;
  const r = v.record; if (r.absoluteExpiresAt - now < 30_000) return { ok: false, reason: "absolute_lifetime_reached" };
  const kv = env.ETI_EXECUTION_LOG as KV;
  const issued = await issueSession(env, scope, ipRef, now, { chainStart: r.chainStart, absoluteExpiresAt: r.absoluteExpiresAt, refreshes: r.refreshes + 1 });
  await persist(kv, { ...r, revoked: true }, now);
  return { ok: true, issued };
}
export async function revokeSession(env: AuthEnv, token: string, scope: EnvScope, now: number): Promise<boolean> {
  const v = await verifyToken(env, token, scope, now); if (!v.ok) return false;
  await persist(env.ETI_EXECUTION_LOG as KV, { ...v.record, revoked: true }, now); return true;
}
/** Invalidate every session of an environment (or all) by bumping its epoch. */
export async function revokeAll(env: AuthEnv, scope: EnvScope | "all"): Promise<EnvScope[]> {
  const kv = env.ETI_EXECUTION_LOG as KV, hit = scope === "all" ? SCOPES : [scope];
  for (const s of hit) await kv.put("auth:epoch:" + s, String((await epochOf(kv, s)) + 1));
  return hit;
}

// ---------- request authentication ----------
export interface Auth { master: boolean; scopes: Set<EnvScope>; refs: Partial<Record<EnvScope, string>>; viaCookie: boolean; rejected: string[] }
export function readCookie(req: Request, name: string): string | null {
  const h = req.headers.get("cookie"); if (!h) return null;
  for (const part of h.split(";")) { const i = part.indexOf("="); if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim(); }
  return null;
}
async function masterMatches(supplied: string, token: string | undefined): Promise<boolean> {
  if (!token || !supplied || supplied.length !== token.length) return false;
  const [a, b] = await Promise.all([token, supplied].map(v => crypto.subtle.digest("SHA-256", enc.encode(v))));
  return constantTimeEqual(new Uint8Array(a), new Uint8Array(b));
}
export function sameOrigin(req: Request): boolean {
  const o = req.headers.get("origin"), u = new URL(req.url);
  if (o) return o === u.origin;
  return req.headers.get("sec-fetch-site") === "same-origin";
}
/** Who is calling? The master ETI_EXECUTION_TOKEN (programmatic clients) and/or per-environment sessions (browser cookie or eti1 bearer). */
export async function authenticate(req: Request, env: AuthEnv & { ETI_EXECUTION_TOKEN?: string }, now = Date.now()): Promise<Auth> {
  const auth: Auth = { master: false, scopes: new Set(), refs: {}, viaCookie: false, rejected: [] };
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  if (bearer && !bearer.startsWith("eti1.")) { auth.master = await masterMatches(bearer, env.ETI_EXECUTION_TOKEN); return auth; }
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  for (const scope of SCOPES) {
    const fromBearer = bearer.startsWith("eti1.") ? bearer : "", fromCookie = readCookie(req, POLICY[scope].cookie) || "";
    const token = fromBearer || fromCookie; if (!token) continue;
    const usingCookie = !fromBearer && !!fromCookie;
    if (usingCookie && mutating && !sameOrigin(req)) { auth.rejected.push(scope + ":csrf_origin_mismatch"); continue; }
    const v = await verifyToken(env, token, scope, now);
    if (v.ok) { auth.scopes.add(scope); auth.refs[scope] = await refOf(v.record.sid); if (usingCookie) auth.viaCookie = true; }
    else if (v.reason !== "scope_mismatch") auth.rejected.push(scope + ":" + v.reason);
  }
  return auth;
}
export const can = (a: Auth, scope: EnvScope) => a.master || a.scopes.has(scope);

// ---------- cookies and rate limiting ----------
export function sessionCookie(scope: EnvScope, token: string, maxAgeSec: number): string {
  return `${POLICY[scope].cookie}=${token}; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}
export const clearCookie = (scope: EnvScope) => `${POLICY[scope].cookie}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`;
/** Fixed-window counter in KV. KV is eventually consistent, so this limits abuse approximately rather than exactly. */
export async function rateLimit(env: AuthEnv, bucket: string, limit: number, windowSec: number, now: number): Promise<{ ok: boolean; remaining: number }> {
  const kv = env.ETI_EXECUTION_LOG as KV | undefined; if (!kv) return { ok: true, remaining: limit };
  const win = Math.floor(now / (windowSec * 1000)), key = "auth:rl:" + bucket + ":" + win;
  const n = (Number(await kv.get(key)) || 0) + 1;
  await kv.put(key, String(n), { expirationTtl: Math.max(60, windowSec * 2) });
  return { ok: n <= limit, remaining: Math.max(0, limit - n) };
}
export const autoMode = (env: AuthEnv): "off" | "paper" | "paper_testnet" => { const v = (env.ETI_AUTO_SESSIONS || "paper_testnet").toLowerCase(); return v === "off" || v === "paper" ? v : "paper_testnet"; };
/** Housekeeping for the cron: rotate an aged key and drop expired retired keys. Session records expire through KV TTL. */
export async function maintain(env: AuthEnv, now: number): Promise<KeySummary | null> { try { return await keySummary(env, now); } catch { return null; } }
