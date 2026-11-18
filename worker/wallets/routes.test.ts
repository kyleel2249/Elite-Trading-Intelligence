import { test } from "node:test";
import assert from "node:assert/strict";
import { sqliteD1 } from "../portfolio/testing.ts";
import { handleIdentity } from "../identity/routes.ts";
import { handleWallets } from "./routes.ts";
import { totpCode } from "../identity/totp.ts";
import { SoftKey } from "./softkey.ts";
import { newRecoverySet, openBackup } from "./vault.ts";
import { defaultPolicy } from "./model.ts";

const ORIGIN = "https://eti.test", KEY = "k".repeat(40), PW = "Correct-Horse-Battery-9", MASTER = "master-token-0123456789abcdef0123456789";
let clock = Date.UTC(2026, 10, 11, 9, 0, 0);
const mkEnv = () => ({ ETI_PORTFOLIO_DB: sqliteD1(), ETI_IDENTITY_KEY: KEY, ETI_EXECUTION_TOKEN: MASTER, ETI_WALLET_GOV_TIMELOCK_SEC: "0" } as any);
type Jar = Record<string, string>;
async function http(fn: any, env: any, path: string, o: { body?: unknown; cookies?: Jar; master?: boolean; method?: string; origin?: string } = {}) {
  const headers: any = { "content-type": "application/json", origin: o.origin ?? ORIGIN };
  if (o.cookies && Object.keys(o.cookies).length) headers.cookie = Object.entries(o.cookies).map(([k, v]) => k + "=" + v).join("; ");
  if (o.master) headers.authorization = "Bearer " + MASTER;
  const r = await fn(new Request(ORIGIN + path, { method: o.method ?? (o.body !== undefined ? "POST" : "GET"), headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined }), env, { now: () => clock });
  const sc = r.headers.get("set-cookie"); if (sc && o.cookies) { const [kv] = sc.split(";"), i = kv.indexOf("="); o.cookies[kv.slice(0, i)] = kv.slice(i + 1); }
  const text = await r.text(); let b: any = null; try { b = JSON.parse(text); } catch { /* file or html */ }
  return { r, b, text };
}
const id = (env: any, p: string, o: any = {}) => http(handleIdentity, env, p, o), wal = (env: any, p: string, o: any = {}) => http(handleWallets, env, "/api/wallets/" + p, o);
const secrets: Record<string, string> = {};
async function relogin(env: any, email: string, p: { cookies: Jar }) { for (const k of Object.keys(p.cookies)) delete p.cookies[k]; const r = await id(env, "/api/identity/login", { body: { email, password: PW, code: await totpCode(secrets[email], clock) }, cookies: p.cookies }); assert.equal(r.r.status, 200, r.text); }
async function userWithMfa(env: any, email: string, role: string, admin?: Jar): Promise<{ cookies: Jar; uid: string }> {
  if (admin) assert.equal((await id(env, "/api/identity/users", { body: { email, password: PW, role }, cookies: admin })).r.status, 201);
  else assert.equal((await id(env, "/api/identity/bootstrap", { master: true, body: { email, password: PW } })).r.status, 201);
  const cookies: Jar = {}; await id(env, "/api/identity/login", { body: { email, password: PW }, cookies });
  const e = await id(env, "/api/identity/mfa/enroll", { body: {}, cookies }); secrets[email] = e.b.secret; await id(env, "/api/identity/mfa/confirm", { body: { code: await totpCode(e.b.secret, clock) }, cookies });
  const me = await id(env, "/api/identity/me", { cookies }); assert.equal(me.b.user.mfa, true); return { cookies, uid: me.b.user.id };
}
async function world() {
  const env = mkEnv(); clock += 3_600_000; const boss = await userWithMfa(env, "boss@example.com", "admin"); const people: Record<string, { cookies: Jar; uid: string; key: SoftKey }> = {};
  for (const n of ["alice", "bob", "carol"]) { const u = await userWithMfa(env, n + "@example.com", "admin", boss.cookies); people[n] = { ...u, key: await SoftKey.create() }; }
  return { env, boss, people };
}
async function setup(w: Awaited<ReturnType<typeof world>>) {
  const { env, boss, people } = w, rec = await newRecoverySet(2, 3);
  for (const [n, p] of Object.entries(people)) {
    assert.equal((await wal(env, "signers/designate", { body: { uid: p.uid, label: n, wallets: ["trading", "treasury", "opex", "emergency", "long_term"] }, cookies: boss.cookies })).r.status, 200);
    const o = await wal(env, "enroll/options", { body: {}, cookies: p.cookies }); assert.equal(o.r.status, 200, o.text);
    const reg = await p.key.register(o.b.publicKey.challenge, ORIGIN, "eti.test"); const v = await wal(env, "enroll/verify", { body: { challengeId: o.b.challengeId, ...reg }, cookies: p.cookies }); assert.equal(v.r.status, 200, v.text);
  }
  assert.equal((await wal(env, "seal", { body: {}, cookies: boss.cookies })).b.error, "not_ready_to_seal"); // no recovery key yet
  assert.equal((await wal(env, "recovery/register", { body: { publicKey: rec.publicKey, k: 2, n: 3, setId: rec.setId }, cookies: boss.cookies })).r.status, 200);
  const s = await wal(env, "seal", { body: {}, cookies: boss.cookies }); assert.equal(s.r.status, 200, s.text); return rec;
}
async function approveVia(env: any, p: { cookies: Jar; key: SoftKey }, actionId: string) {
  const o = await wal(env, `actions/${actionId}/approve-options`, { body: {}, cookies: p.cookies }); assert.equal(o.r.status, 200, o.text);
  const as = await p.key.assert(o.b.publicKey.challenge, ORIGIN, "eti.test"); return wal(env, `actions/${actionId}/approve`, { body: { challengeId: o.b.challengeId, ...as }, cookies: p.cookies });
}

test("API: access control, CSRF and secret refusal", async () => {
  const { env, boss, people } = await world();
  assert.equal((await wal(env, "state")).r.status, 401);
  assert.equal((await wal(env, "state", { master: true })).r.status, 200);
  assert.equal((await wal(env, "seal", { body: {}, cookies: boss.cookies, origin: "https://evil.example" })).r.status, 403);
  assert.equal((await wal(env, "seal", { body: {}, master: true })).b.error, "user_session_required");
  const hit = await wal(env, "configure", { body: { walletId: "treasury", custody: { kind: "external_signer", ref: "legal winner thank year wave sausage worth useful legal winner thank yellow", chains: ["ethereum"] } }, cookies: boss.cookies });
  assert.equal(hit.r.status, 422); assert.equal(hit.b.error, "secret_material_rejected"); assert.equal(hit.text.includes("sausage"), false);
  const pk = await wal(env, "signers/designate", { body: { uid: people.alice.uid, label: "0x" + "ab".repeat(32), wallets: ["treasury"] }, cookies: boss.cookies }); assert.equal(pk.b.error, "secret_material_rejected");
  const st = (await wal(env, "state", { cookies: boss.cookies })).b; assert.equal(st.sealed, false); assert.equal(st.signers.length, 0);
  const audit = await env.ETI_PORTFOLIO_DB.prepare("SELECT action, detail FROM id_audit WHERE action = 'wallet_secret_refused'").all(); assert.ok(audit.results.length >= 2); assert.equal(JSON.stringify(audit.results).includes("sausage"), false);
  assert.equal((await wal(env, "nope", { cookies: boss.cookies })).r.status, 404);
});
test("API end to end: setup, seal, quorum withdrawal, freeze, encrypted backup, restore", async () => {
  const w = await world(), { env, boss, people } = w, rec = await setup(w);
  assert.equal((await wal(env, "configure", { body: { walletId: "treasury", policy: defaultPolicy("treasury") }, cookies: boss.cookies })).b.error, "sealed");
  const dep = await wal(env, "actions", { body: { kind: "record_deposit", walletId: "treasury", input: { asset: "USDT", amount: "1000", txRef: "dep-api-0001" } }, cookies: boss.cookies }); assert.equal(dep.r.status, 200, dep.text);
  assert.equal((await wal(env, `actions/${dep.b.actionId}/execute`, { body: {}, cookies: people.alice.cookies })).b.error, "not_ready");
  for (const n of ["alice", "bob", "carol"]) { const a = await approveVia(env, people[n as "alice"], dep.b.actionId); assert.equal(a.r.status, 200, a.text); }
  clock += 1000; assert.equal((await wal(env, `actions/${dep.b.actionId}/execute`, { body: {}, cookies: people.alice.cookies })).r.status, 200);
  const tr = await wal(env, "actions", { body: { kind: "withdraw", walletId: "treasury", input: { asset: "USDT", amount: "250", destination: { type: "internal", walletId: "trading" } } }, cookies: people.alice.cookies }); assert.equal(tr.r.status, 200, tr.text);
  assert.equal((await wal(env, `actions/${tr.b.actionId}/approve-options`, { body: {}, cookies: people.alice.cookies })).b.error, "not_eligible"); // the requester cannot approve
  await approveVia(env, people.bob, tr.b.actionId); await approveVia(env, people.carol, tr.b.actionId); clock += 3_700_000; await relogin(env, "bob@example.com", people.bob);
  { const ex = await wal(env, `actions/${tr.b.actionId}/execute`, { body: {}, cookies: people.bob.cookies }); assert.equal(ex.r.status, 200, ex.text); }
  let st = (await wal(env, "state", { cookies: people.bob.cookies })).b; assert.equal(st.wallets.find((x: any) => x.id === "trading").balances.USDT, "250");
  const raw = JSON.stringify(st); assert.equal(/BEGIN|PRIVATE KEY|"d":/.test(raw), false);
  // freeze by master token, then nothing can be proposed
  assert.equal((await wal(env, "freeze", { body: { reason: "drill" }, master: true })).r.status, 200);
  await relogin(env, "alice@example.com", people.alice);
  assert.equal((await wal(env, "actions", { body: { kind: "withdraw", walletId: "treasury", input: { asset: "USDT", amount: "1", destination: { type: "internal", walletId: "opex" } } }, cookies: people.alice.cookies })).b.error, "frozen");
  // the backup is encrypted and operator only
  assert.equal((await wal(env, "backup", { cookies: people.alice.cookies })).r.status, 200, "admins are operators"); await relogin(env, "boss@example.com", boss); const bk = await wal(env, "backup", { cookies: boss.cookies }); assert.equal(bk.r.status, 200);
  assert.equal(bk.text.includes("treasury"), false); assert.equal(bk.text.includes("USDT"), false);
  const opened = await openBackup(bk.text, rec.shares.slice(0, 2)); assert.ok(opened.ok);
  // restore into a fresh deployment that shares the identity key
  const env2 = mkEnv(); clock += 1000; const boss2 = await userWithMfa(env2, "boss@example.com", "admin");
  assert.equal((await wal(env2, "recovery/restore", { body: { backup: bk.text, events: (opened as any).events }, cookies: boss2.cookies })).r.status, 200);
  const st2 = (await wal(env2, "state", { cookies: boss2.cookies })).b; assert.equal(st2.sealed, true); assert.equal(st2.wallets.find((x: any) => x.id === "trading").balances.USDT, "250"); assert.equal(st2.frozen.reason, "drill");
  assert.equal((await wal(env2, "recovery/restore", { body: { backup: bk.text, events: (opened as any).events }, cookies: boss2.cookies })).b.error, "target_not_empty");
  const tampered = (opened as any).events.slice(1); const env3 = mkEnv(); const boss3 = await userWithMfa(env3, "boss@example.com", "admin");
  assert.equal((await wal(env3, "recovery/restore", { body: { backup: bk.text, events: tampered }, cookies: boss3.cookies })).b.error, "restore_refused");
  // the audit chain still verifies after all of this
  const v = await id(env, "/api/identity/audit/verify", { cookies: boss.cookies }); assert.equal(v.b.ok, true);
});
test("API: the page is served and carries no inline secrets or storage use", async () => {
  const env = mkEnv(); const r = await handleWallets(new Request(ORIGIN + "/wallets"), env); const h = await r.text();
  assert.equal(r.status, 200); assert.match(h, /Corporate wallets/); assert.equal(/localStorage|sessionStorage|indexedDB/.test(h), false);
});
