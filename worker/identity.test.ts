import { test } from "node:test";
import assert from "node:assert/strict";
import { sqliteD1 } from "./portfolio/testing.ts";
import { handleIdentity } from "./identity/routes.ts";
import { hotp, base32Encode, base32Decode, verifyTotp, totpCode, totpCounter, newRecoveryCodes, normaliseRecovery } from "./identity/totp.ts";
import { hashPassword, verifyPassword, passwordProblems } from "./identity/password.ts";
import { seal, open } from "./identity/seal.ts";
import { roleCan, requiresMfa, scopesOf, ROLES, permissionsOf } from "./identity/rbac.ts";
import { authenticate, isOperator } from "./auth/session.ts";
import { exportBackup, restoreBackup } from "./backup/backup.ts";
import { IdentityStore } from "./identity/store.ts";

const KEY = "k".repeat(40), MASTER = "master-token-0123456789abcdef0123456789";
const memKV = () => { const m = new Map<string, string>(); return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); } }; };
const mkEnv = (extra: any = {}) => ({ ETI_PORTFOLIO_DB: sqliteD1(), ETI_IDENTITY_KEY: KEY, ETI_EXECUTION_LOG: memKV(), ETI_EXECUTION_TOKEN: MASTER, ...extra });
const ORIGIN = "https://eti.test";
let clock = Date.UTC(2026, 10, 11, 9, 0, 0);
const jar = () => { const c: Record<string, string> = {}; return c; };
async function call(env: any, path: string, o: { method?: string; body?: unknown; cookies?: Record<string, string>; master?: boolean; now?: number } = {}) {
  const headers: any = { "content-type": "application/json", origin: ORIGIN };
  if (o.cookies && Object.keys(o.cookies).length) headers.cookie = Object.entries(o.cookies).map(([k, v]) => k + "=" + v).join("; ");
  if (o.master) headers.authorization = "Bearer " + MASTER;
  const req = new Request(ORIGIN + path, { method: o.method ?? (o.body !== undefined ? "POST" : "GET"), headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const r = await handleIdentity(req, env, { now: () => o.now ?? clock });
  const sc = r.headers.get("set-cookie"); if (sc && o.cookies) { const [kv] = sc.split(";"), i = kv.indexOf("="); if (/Max-Age=0/.test(sc)) delete o.cookies[kv.slice(0, i)]; else o.cookies[kv.slice(0, i)] = kv.slice(i + 1); }
  return { r, b: await r.json().catch(() => null) as any, setCookie: sc };
}
const PW = "Correct-Horse-Battery-9";
async function bootstrap(env: any) { const x = await call(env, "/api/identity/bootstrap", { master: true, body: { email: "Boss@Example.com", password: PW } }); assert.equal(x.r.status, 201); return x; }
async function enrol(env: any, cookies: Record<string, string>, now = clock) {
  const e = await call(env, "/api/identity/mfa/enroll", { body: {}, cookies, now }); assert.equal(e.r.status, 200);
  const code = await totpCode(e.b.secret, now), c = await call(env, "/api/identity/mfa/confirm", { body: { code }, cookies, now }); assert.equal(c.r.status, 200);
  return { secret: e.b.secret as string, codes: c.b.recoveryCodes as string[], counter: totpCounter(now) };
}

test("TOTP matches RFC 4226 and RFC 6238 test vectors", async () => {
  const k = new TextEncoder().encode("12345678901234567890");
  assert.equal(await hotp(k, 0), "755224"); assert.equal(await hotp(k, 1), "287082"); assert.equal(await hotp(k, 9), "520489");
  assert.equal(await hotp(k, 1, 8), "94287082"); // RFC 6238, T=59 s
  assert.equal(base32Encode(k), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"); assert.deepEqual([...base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ")], [...k]);
});
test("TOTP: drift window, replay protection and bad input", async () => {
  const s = base32Encode(crypto.getRandomValues(new Uint8Array(20))), now = 1_800_000_000_000;
  const code = await totpCode(s, now), c = totpCounter(now);
  assert.equal(await verifyTotp(s, code, now), c);
  assert.equal(await verifyTotp(s, code, now + 30_000), c); // one step late
  assert.equal(await verifyTotp(s, code, now + 120_000), null); // out of window
  assert.equal(await verifyTotp(s, code, now, c), null); // replay of a used counter
  for (const bad of ["", "12345", "1234567", "abcdef", "12 456"]) assert.equal(await verifyTotp(s, bad, now), null);
});
test("recovery codes are random, formatted and normalised", () => {
  const a = newRecoveryCodes(10), b = newRecoveryCodes(10); assert.equal(new Set([...a, ...b]).size, 20); assert.ok(a.every(x => /^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(x)));
  assert.equal(normaliseRecovery(a[0].toLowerCase().replace("-", " ")), a[0]);
});
test("password hashing: peppered PBKDF2, key rotation, policy", async () => {
  const h = await hashPassword(PW, KEY); assert.match(h, /^pbkdf2-sha256\$100000\$/);
  assert.deepEqual(await verifyPassword(PW, h, [KEY]), { ok: true, needsRehash: false });
  assert.equal((await verifyPassword("wrong-password-123", h, [KEY])).ok, false);
  assert.equal((await verifyPassword(PW, h, ["x".repeat(40)])).ok, false); // a stolen database without the pepper cannot be checked
  const rot = await verifyPassword(PW, h, ["n".repeat(40), KEY]); assert.deepEqual(rot, { ok: true, needsRehash: true });
  const weak = await hashPassword(PW, KEY, 5000); assert.equal((await verifyPassword(PW, weak, [KEY])).needsRehash, true);
  assert.notEqual(await hashPassword(PW, KEY), await hashPassword(PW, KEY)); // unique salts
  assert.ok(passwordProblems("short").length > 0); assert.ok(passwordProblems("password12345").length > 0); assert.ok(passwordProblems("boss-is-here-123", "boss@x.com").length > 0);
  assert.deepEqual(passwordProblems("tr1cky-Phrase-ok!x"), []); assert.deepEqual(passwordProblems("a long phrase of lower case words"), []);
});
test("seal: AES-GCM round trip, context binding, tamper and key rotation", async () => {
  const s = await seal(KEY, "mfa|u1", "SECRET"); assert.ok(!s.includes("SECRET"));
  assert.equal(await open([KEY], "mfa|u1", s), "SECRET"); assert.equal(await open([KEY], "mfa|u2", s), null); assert.equal(await open(["z".repeat(40)], "mfa|u1", s), null);
  assert.equal(await open(["z".repeat(40), KEY], "mfa|u1", s), "SECRET");
  const parts = s.split("."); parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith("AA") ? "BB" : "AA"); assert.equal(await open([KEY], "mfa|u1", parts.join(".")), null);
});
test("RBAC: roles only add privileges; MFA required for trader/admin; live is never a scope", () => {
  const order = ROLES.map(r => permissionsOf(r).length); assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(roleCan("viewer", "orders.paper"), false); assert.equal(roleCan("paper_trader", "orders.testnet"), false); assert.equal(roleCan("trader", "orders.testnet"), true);
  assert.equal(roleCan("trader", "users.manage"), false); assert.equal(roleCan("admin", "backup.manage"), true);
  assert.deepEqual(ROLES.filter(requiresMfa), ["trader", "admin"]);
  assert.deepEqual(scopesOf("paper_trader"), ["paper"]); assert.deepEqual(scopesOf("analyst"), []); for (const r of ROLES) assert.ok(!(scopesOf(r) as string[]).includes("live"));
});

test("availability is explicit: no D1 or no key means no accounts, never a fake mode", async () => {
  const a = await call({ ETI_IDENTITY_KEY: KEY }, "/api/identity/status"); assert.equal(a.b.available, false); assert.equal(a.b.error, "identity_storage_missing");
  const b = await call({ ETI_PORTFOLIO_DB: sqliteD1() }, "/api/identity/status"); assert.equal(b.b.error, "identity_key_missing");
  const c = await call({ ETI_PORTFOLIO_DB: sqliteD1(), ETI_IDENTITY_KEY: "short" }, "/api/identity/login", { body: { email: "a@b.co", password: "x" } }); assert.equal(c.r.status, 503);
});
test("bootstrap: master token only, first account only, strong password", async () => {
  const env = mkEnv();
  assert.equal((await call(env, "/api/identity/bootstrap", { body: { email: "a@b.co", password: PW } })).r.status, 401);
  assert.equal((await call(env, "/api/identity/bootstrap", { master: true, body: { email: "a@b.co", password: "weak" } })).b.error, "weak_password");
  assert.equal((await call(env, "/api/identity/bootstrap", { master: true, body: { email: "not-an-email", password: PW } })).b.error, "invalid_email");
  const ok = await bootstrap(env); assert.equal(ok.b.user.role, "admin"); assert.equal(ok.b.user.email, "boss@example.com"); assert.ok(!JSON.stringify(ok.b).includes("pbkdf2"));
  assert.equal((await call(env, "/api/identity/bootstrap", { master: true, body: { email: "b@b.co", password: PW } })).b.error, "already_bootstrapped");
});
test("login: generic errors, no user enumeration, limited session for an admin without MFA", async () => {
  const env = mkEnv(); await bootstrap(env);
  const bad = await call(env, "/api/identity/login", { body: { email: "boss@example.com", password: "Wrong-Password-123" } }), none = await call(env, "/api/identity/login", { body: { email: "ghost@example.com", password: "Wrong-Password-123" } });
  assert.equal(bad.r.status, 401); assert.deepEqual(bad.b, none.b);
  const cookies = jar(), ok = await call(env, "/api/identity/login", { body: { email: "BOSS@example.com", password: PW }, cookies });
  assert.equal(ok.r.status, 200); assert.equal(ok.b.session.limited, true); assert.equal(ok.b.next, "mfa_enrol_required");
  assert.match(ok.setCookie!, /eti_user=u1\.[\w-]+; Max-Age=\d+; Path=\/; HttpOnly; Secure; SameSite=Strict/); assert.ok(!JSON.stringify(ok.b).includes("u1."));
  const me = await call(env, "/api/identity/me", { cookies }); assert.equal(me.b.user.limited, true); assert.deepEqual(me.b.user.permissions, []); assert.deepEqual(me.b.user.scopes, []);
  assert.equal((await call(env, "/api/identity/users", { cookies })).r.status, 403); // limited session cannot administer
});
test("MFA enrolment, TOTP login, replay refusal, recovery code single use", async () => {
  const env = mkEnv(); await bootstrap(env); const cookies = jar();
  await call(env, "/api/identity/login", { body: { email: "boss@example.com", password: PW }, cookies });
  const old = { ...cookies }, m = await enrol(env, cookies);
  assert.equal(m.codes.length, 10); assert.notEqual(cookies.eti_user, old.eti_user);
  assert.equal((await call(env, "/api/identity/me", { cookies: old })).r.status, 401); // the limited session was replaced
  const me = await call(env, "/api/identity/me", { cookies }); assert.equal(me.b.user.mfa, true); assert.ok(me.b.user.permissions.includes("users.manage"));
  assert.equal((await call(env, "/api/identity/mfa/enroll", { body: {}, cookies })).b.error, "mfa_already_enabled");
  const stored = await env.ETI_PORTFOLIO_DB.prepare("SELECT mfa_secret, recovery FROM id_users").first(); assert.ok(!String(stored.mfa_secret).includes(m.secret)); assert.ok(!stored.recovery.includes(m.codes[0])); // sealed / hashed at rest
  const login = (extra: any, now = clock + 120_000) => call(env, "/api/identity/login", { body: { email: "boss@example.com", password: PW, ...extra }, now });
  assert.equal((await login({})).b.error, "mfa_required");
  const t1 = clock + 120_000, code = await totpCode(m.secret, t1);
  assert.equal((await login({ code }, t1)).r.status, 200);
  assert.equal((await login({ code }, t1)).b.error, "invalid_mfa_code"); // replay
  assert.equal((await login({ code: "000000" }, t1)).r.status, 401);
  const rc = await login({ recoveryCode: m.codes[0].toLowerCase() }); assert.equal(rc.r.status, 200); assert.equal(rc.b.recoveryCodesLeft, 9);
  assert.equal((await login({ recoveryCode: m.codes[0] })).r.status, 401); // single use
});
test("lockout after repeated failures, with backoff and audit", async () => {
  const env = mkEnv(); await bootstrap(env);
  for (let i = 0; i < 5; i++) assert.equal((await call(env, "/api/identity/login", { body: { email: "boss@example.com", password: "Nope-Nope-Nope-1" }, now: clock + i })).r.status, 401);
  const locked = await call(env, "/api/identity/login", { body: { email: "boss@example.com", password: PW }, now: clock + 10 });
  assert.equal(locked.r.status, 429); assert.equal(locked.b.error, "account_locked"); assert.ok(Number(locked.r.headers.get("retry-after")) > 800);
  assert.equal((await call(env, "/api/identity/login", { body: { email: "boss@example.com", password: PW }, now: clock + 16 * 60_000 })).r.status, 200); // lock expires
});
test("sessions: sliding idle expiry, absolute cap, logout and CSRF origin check", async () => {
  const env = mkEnv({}); await bootstrap(env); const cookies = jar();
  await call(env, "/api/identity/login", { body: { email: "boss@example.com", password: PW }, cookies }); await enrol(env, cookies);
  assert.equal((await call(env, "/api/identity/me", { cookies, now: clock + 14 * 60_000 })).r.status, 200);
  assert.equal((await call(env, "/api/identity/me", { cookies, now: clock + 14 * 60_000 + 14 * 60_000 })).r.status, 200); // activity extended the idle window
  assert.equal((await call(env, "/api/identity/me", { cookies, now: clock + 4 * 3600_000 + 1 })).r.status, 401); // absolute cap for privileged roles
  const req = new Request(ORIGIN + "/api/identity/users", { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example", cookie: "eti_user=" + cookies.eti_user }, body: JSON.stringify({ email: "x@y.co", password: PW, role: "viewer" }) });
  assert.equal((await handleIdentity(req, env, { now: () => clock })).status, 403);
  const out = await call(env, "/api/identity/logout", { body: {}, cookies }); assert.equal(out.r.status, 200); assert.equal(cookies.eti_user, undefined);
});
test("administration: create users, role limits, self-protection, last admin guard, revoke on change", async () => {
  const env = mkEnv(); await bootstrap(env); const adm = jar();
  await call(env, "/api/identity/login", { body: { email: "boss@example.com", password: PW }, cookies: adm }); await enrol(env, adm);
  const mk = await call(env, "/api/identity/users", { body: { email: "p@example.com", password: "Paper-Trader-Pass-7", role: "paper_trader" }, cookies: adm }); assert.equal(mk.r.status, 201);
  assert.equal((await call(env, "/api/identity/users", { body: { email: "p@example.com", password: "Paper-Trader-Pass-7", role: "viewer" }, cookies: adm })).b.error, "email_taken");
  assert.equal((await call(env, "/api/identity/users", { body: { email: "q@example.com", password: "Paper-Trader-Pass-7", role: "root" }, cookies: adm })).b.error, "invalid_role");
  const pt = jar(); await call(env, "/api/identity/login", { body: { email: "p@example.com", password: "Paper-Trader-Pass-7" }, cookies: pt });
  const ptMe = await call(env, "/api/identity/me", { cookies: pt }); assert.deepEqual(ptMe.b.user.scopes, ["paper"]); assert.equal(ptMe.b.user.limited, false);
  assert.equal((await call(env, "/api/identity/users", { cookies: pt })).r.status, 403); assert.equal((await call(env, "/api/identity/audit", { cookies: pt })).r.status, 403);
  const uid = mk.b.user.id, my = (await call(env, "/api/identity/me", { cookies: adm })).b.user.id;
  assert.equal((await call(env, `/api/identity/users/${my}/disable`, { body: {}, cookies: adm })).b.error, "self_change_refused");
  assert.equal((await call(env, `/api/identity/users/${my}/role`, { body: { role: "viewer" }, master: true })).b.error, "last_admin");
  assert.equal((await call(env, `/api/identity/users/${uid}/role`, { body: { role: "trader" }, cookies: adm })).r.status, 200);
  assert.equal((await call(env, "/api/identity/me", { cookies: pt })).r.status, 401); // privilege change forces re-login
  await call(env, "/api/identity/login", { body: { email: "p@example.com", password: "Paper-Trader-Pass-7" }, cookies: pt });
  assert.equal((await call(env, "/api/identity/me", { cookies: pt })).b.user.limited, true); // trader now needs MFA
  assert.equal((await call(env, `/api/identity/users/${uid}/disable`, { body: {}, cookies: adm })).r.status, 200);
  assert.equal((await call(env, "/api/identity/me", { cookies: pt })).r.status, 401);
  assert.equal((await call(env, "/api/identity/login", { body: { email: "p@example.com", password: "Paper-Trader-Pass-7" } })).r.status, 401);
  assert.equal((await call(env, `/api/identity/users/${uid}/enable`, { body: {}, cookies: adm })).r.status, 200);
  assert.equal((await call(env, `/api/identity/users/${uid}/reset-mfa`, { body: {}, cookies: adm })).r.status, 200);
});
test("password change revokes other sessions and enforces policy", async () => {
  const env = mkEnv(); await bootstrap(env); const a = jar(), b = jar();
  await call(env, "/api/identity/login", { body: { email: "boss@example.com", password: PW }, cookies: a }); const m = await enrol(env, a);
  const t = clock + 90_000; await call(env, "/api/identity/login", { body: { email: "boss@example.com", password: PW, code: await totpCode(m.secret, t) }, cookies: b, now: t });
  assert.equal((await call(env, "/api/identity/password", { body: { current: "bad-current-pass-1", next: "Another-Strong-Pass-3" }, cookies: a, now: t })).r.status, 401);
  assert.equal((await call(env, "/api/identity/password", { body: { current: PW, next: "short" }, cookies: a, now: t })).b.error, "weak_password");
  assert.equal((await call(env, "/api/identity/password", { body: { current: PW, next: "Another-Strong-Pass-3" }, cookies: a, now: t })).r.status, 200);
  assert.equal((await call(env, "/api/identity/me", { cookies: b, now: t })).r.status, 401); assert.equal((await call(env, "/api/identity/me", { cookies: a, now: t })).r.status, 200);
});
test("audit trail is a tamper-evident hash chain and records privileged events without secrets", async () => {
  const env = mkEnv(); await bootstrap(env); const adm = jar();
  await call(env, "/api/identity/login", { body: { email: "boss@example.com", password: PW }, cookies: adm }); const m = await enrol(env, adm);
  const rows = await call(env, "/api/identity/audit?limit=50", { cookies: adm }); const actions = rows.b.rows.map((r: any) => r.action);
  for (const a of ["user_created", "login", "mfa_enrol_started", "mfa_enabled"]) assert.ok(actions.includes(a), a);
  const dump = JSON.stringify(rows.b); assert.ok(!dump.includes(m.secret) && !dump.includes(m.codes[0]) && !dump.includes(PW));
  const v = await call(env, "/api/identity/audit/verify", { cookies: adm }); assert.equal(v.b.ok, true); assert.ok(v.b.rows >= 4);
  await env.ETI_PORTFOLIO_DB.prepare("UPDATE id_audit SET action = 'nothing' WHERE seq = 2").run();
  const v2 = await call(env, "/api/identity/audit/verify", { cookies: adm }); assert.equal(v2.b.ok, false); assert.equal(v2.b.brokenAt, 2);
});
test("audit chain stays linear under concurrent writers", async () => {
  const db = sqliteD1(), s = await new IdentityStore(db).init();
  await Promise.all(Array.from({ length: 12 }, (_, i) => s.audit(clock + i, "t", "evt", String(i), { i }, null)));
  const v = await s.verifyAudit(); assert.equal(v.ok, true); assert.equal(v.rows, 12);
});
test("authenticate(): a signed-in account yields role scopes; limited and invalid sessions yield none; operators are master or MFA admin", async () => {
  const env = mkEnv(); await bootstrap(env); const adm = jar(); await call(env, "/api/identity/login", { body: { email: "boss@example.com", password: PW }, cookies: adm });
  const req = (c: Record<string, string>, method = "GET", origin = ORIGIN) => new Request(ORIGIN + "/api/portfolio/summary", { method, headers: { cookie: Object.entries(c).map(([k, v]) => k + "=" + v).join("; "), origin } });
  const lim = await authenticate(req(adm), env, clock); assert.equal(lim.scopes.size, 0); assert.equal(lim.user?.limited, true); assert.equal(isOperator(lim), false);
  await enrol(env, adm);
  const a = await authenticate(req(adm), env, clock); assert.deepEqual([...a.scopes].sort(), ["paper", "testnet"]); assert.equal(isOperator(a), true); assert.ok(!JSON.stringify(a.refs).includes(adm.eti_user));
  const csrf = await authenticate(req(adm, "POST", "https://evil.example"), env, clock); assert.equal(csrf.scopes.size, 0); assert.ok(csrf.rejected.includes("user:csrf_origin_mismatch"));
  const junk = await authenticate(req({ eti_user: "u1.notreal" }), env, clock); assert.equal(junk.scopes.size, 0); assert.ok(junk.rejected.includes("user:invalid_session"));
  const noDb = await authenticate(req(adm), { ETI_EXECUTION_LOG: memKV() }, clock); assert.equal(noDb.scopes.size, 0);
});

// ---- encrypted backup ----
test("backup: encrypted export, restore into an empty database only, tamper and wrong key refused", async () => {
  const env = mkEnv(); await bootstrap(env);
  await env.ETI_PORTFOLIO_DB.prepare("INSERT INTO pf_events (env, id, at, body) VALUES (?, ?, ?, ?)").bind("internal_paper", "e0i", 1, '{"kind":"init"}').run().catch(async () => { const { ensureSchema } = await import("./portfolio/store.ts"); await ensureSchema(env.ETI_PORTFOLIO_DB); await env.ETI_PORTFOLIO_DB.prepare("INSERT INTO pf_events (env, id, at, body) VALUES (?, ?, ?, ?)").bind("internal_paper", "e0i", 1, '{"kind":"init"}').run(); });
  const { sealed, summary } = await exportBackup(env.ETI_PORTFOLIO_DB, [KEY], clock);
  assert.equal(summary.counts.id_users, 1); assert.equal(summary.counts.pf_events, 1); assert.ok(!sealed.includes("boss@example.com") && !sealed.includes("pbkdf2"));
  const fresh = sqliteD1(); const r = await restoreBackup(fresh, [KEY], sealed); assert.equal(r.ok, true);
  assert.equal((await fresh.prepare("SELECT COUNT(*) AS n FROM id_users").first<any>()).n, 1); assert.equal((await new IdentityStore(fresh).init().then(s => s.verifyAudit())).ok, true);
  const again = await restoreBackup(fresh, [KEY], sealed); assert.equal((again as any).error, "target_not_empty");
  assert.equal(((await restoreBackup(sqliteD1(), ["w".repeat(40)], sealed)) as any).error, "cannot_open");
  const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA"); assert.equal(((await restoreBackup(sqliteD1(), [KEY], tampered)) as any).error, "cannot_open");
  const rotated = await restoreBackup(sqliteD1(), ["n".repeat(40), KEY], sealed); assert.equal(rotated.ok, true); // previous key still opens old backups
});
