import test from "node:test";
import assert from "node:assert/strict";
import { handleAuth } from "./auth/routes.ts";
import { handleExecution } from "./execution.ts";
import { handlePaper } from "./algo/paper-api.ts";
import { POLICY, authenticate, issueSession, loadRing, verifyToken } from "./auth/session.ts";

const ORIGIN = "https://eti.test", T0 = 1_800_000_000_000;
class MemKV { m = new Map<string, string>();
  async get(k: string) { return this.m.get(k) ?? null; } async put(k: string, v: string) { this.m.set(k, v); } async delete(k: string) { this.m.delete(k); }
  async list({ prefix, limit = 1000 }: { prefix: string; limit?: number }) { return { keys: [...this.m.keys()].filter(k => k.startsWith(prefix)).sort().slice(0, limit).map(name => ({ name })) }; } }
const SECRETS = { ALPACA_API_KEY: "AKTESTKEY123456", ALPACA_SECRET_KEY: "alpaca-secret-value-xyz", BINANCE_API_KEY: "binance-key-abcdef", BINANCE_SECRET_KEY: "binance-secret-value-uvw" };
const mkEnv = (extra: Record<string, unknown> = {}) => ({ ETI_EXECUTION_LOG: new MemKV(), ETI_READINESS_GATE: "off", ETI_EXECUTION_TOKEN: "master-token-value-0123456789", ...extra }) as any;
let clock = T0; const deps = () => ({ now: () => clock, fetchImpl: brokerFetch as any });
let alpacaStatus = 200, binanceStatus = 200, brokerCalls: string[] = [];
async function brokerFetch(u: any, init?: any): Promise<Response> {
  const url = String(u); brokerCalls.push(init?.method ? init.method + " " + url : "GET " + url);
  const j = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
  if (url.includes("paper-api.alpaca.markets")) return alpacaStatus === 200 ? j(url.endsWith("/orders") ? { id: "alp-1" } : { status: "ACTIVE" }) : j({ message: "forbidden" }, alpacaStatus);
  if (url.includes("testnet.binance.vision")) return binanceStatus === 200 ? j(url.includes("/order") ? { orderId: 77 } : { balances: [] }) : j({ code: -2015, msg: "Invalid API-key" }, binanceStatus === 401 ? 401 : 400);
  return j({}, 404);
}
const jar = (res: Response) => { const o: Record<string, string> = {}; for (const c of (res.headers as any).getSetCookie?.() ?? []) { const [kv] = c.split(";"); const i = kv.indexOf("="); o[kv.slice(0, i)] = kv.slice(i + 1); } return o; };
const cookieHeader = (c: Record<string, string>) => Object.entries(c).filter(([, v]) => v).map(([k, v]) => k + "=" + v).join("; ");
const hdr = (cookies: Record<string, string> = {}, extra: Record<string, string> = {}) => ({ origin: ORIGIN, "content-type": "application/json", ...(Object.keys(cookies).length ? { cookie: cookieHeader(cookies) } : {}), ...extra });
const post = (path: string, body: unknown, headers: Record<string, string>) => new Request(ORIGIN + path, { method: "POST", headers, body: JSON.stringify(body) });
const session = async (env: any, environment: string, cookies: Record<string, string> = {}) => { const r = await handleAuth(post("/api/auth/session", { environment }, hdr(cookies)), env, deps()); return { r, body: await r.json() as any, cookies: { ...cookies, ...jar(r) } }; };
const order = (over: Record<string, unknown> = {}, id = "eti" + Math.random().toString(36).slice(2, 12) + "abcd") => ({ broker: "eti_paper", symbol: "BTCUSDT", side: "buy", type: "market", quantity: 0.01, clientOrderId: id, riskConfirmed: true, executionSource: { actorType: "manual_user", actorId: "tester", sourceName: "test" }, ...over });
const exec = async (env: any, body: unknown, headers: Record<string, string>, path = "/api/orders") => { const r = await handleExecution(post(path, body, headers), env, { now: () => clock, fetchImpl: brokerFetch as any, priceOf: async () => 50_000 }); return { r, body: await r.json() as any }; };
const reset = () => { clock = T0; alpacaStatus = 200; binanceStatus = 200; brokerCalls = []; };

test("provisioning: a random key ring is generated server-side, kept in KV, and never returned", async () => {
  reset(); const a = mkEnv(), b = mkEnv();
  const ra = (await loadRing(a, T0)).ring, rb = (await loadRing(b, T0)).ring;
  assert.equal(ra.current.v, 1); assert.notEqual(ra.current.key, rb.current.key, "independent random keys");
  assert.equal(Buffer.from(ra.current.key, "base64url").length, 32);
  assert.equal((await loadRing(a, T0 + 1000)).ring.current.key, ra.current.key, "stable until rotation");
  const s = await session(a, "paper"); const all = JSON.stringify(s.body) + JSON.stringify([...s.r.headers].filter(([k]) => k !== "set-cookie"));
  assert.ok(!all.includes(ra.current.key) && !all.includes(s.cookies.eti_paper), "no key or token in response bodies/headers");
});

test("provisioning: a Cloudflare secret takes precedence and nothing is written to KV", async () => {
  reset(); const env = mkEnv({ ETI_SESSION_SECRET: "s".repeat(40) });
  const s = await session(env, "paper"); assert.equal(s.r.status, 201);
  assert.equal(await env.ETI_EXECUTION_LOG.get("auth:keyring"), null);
  const st = await (await handleAuth(new Request(ORIGIN + "/api/auth/status"), env, deps())).json() as any; assert.equal(st.signingKey.source, "secret");
  assert.ok(!JSON.stringify(st).includes("s".repeat(40)));
});

test("internal paper session starts automatically: HttpOnly Secure SameSite=Strict cookie, token never in the body", async () => {
  reset(); const env = mkEnv(); const { r, body, cookies } = await session(env, "paper");
  assert.equal(r.status, 201); assert.equal(body.environment, "paper"); assert.equal(body.fallback, null);
  const raw = (r.headers as any).getSetCookie()[0]; assert.match(raw, /HttpOnly/); assert.match(raw, /Secure/); assert.match(raw, /SameSite=Strict/); assert.match(raw, /Path=\//);
  assert.ok(cookies.eti_paper.startsWith("eti1.")); assert.ok(!JSON.stringify(body).includes(cookies.eti_paper));
  assert.ok(body.expiresAt > T0 && body.refreshAfter < body.expiresAt);
  const f = await exec(env, order(), hdr(cookies)); assert.equal(f.r.status, 201, JSON.stringify(f.body)); assert.equal(f.body.mode, "internal_paper"); assert.equal(f.body.exchangeOrderPlaced, false); assert.equal(f.body.simulated, true);
  assert.deepEqual(brokerCalls, [], "no exchange contacted in internal paper mode");
});

test("sessions are only issued to same-origin requests; live can never be issued", async () => {
  reset(); const env = mkEnv();
  const cross = await handleAuth(post("/api/auth/session", { environment: "paper" }, { origin: "https://evil.example", "content-type": "application/json" }), env, deps()); assert.equal(cross.status, 403);
  const none = await handleAuth(post("/api/auth/session", { environment: "paper" }, { "content-type": "application/json" }), env, deps()); assert.equal(none.status, 403);
  const live = await session(env, "live"); assert.equal(live.r.status, 403); assert.equal(live.body.error, "live_trading_disabled_by_design"); assert.deepEqual(live.cookies, {});
  assert.equal((await session(env, "bogus")).r.status, 400);
});

test("every order is authenticated server-side: no cookie, tampered, wrong-origin and garbage tokens are rejected", async () => {
  reset(); const env = mkEnv(); const { cookies } = await session(env, "paper"), tok = cookies.eti_paper;
  assert.equal((await exec(env, order(), hdr())).r.status, 401);
  const parts = tok.split("."); parts[6] = parts[6].slice(0, -2) + (parts[6].endsWith("AA") ? "BB" : "AA");
  assert.equal((await exec(env, order(), hdr({ eti_paper: parts.join(".") }))).r.status, 401, "bad signature");
  parts[3] = "x".repeat(24); assert.equal((await exec(env, order(), hdr({ eti_paper: tok.split(".").slice(0, 3).concat("x".repeat(24), ...tok.split(".").slice(4)).join(".") }))).r.status, 401, "unknown session id");
  assert.equal((await exec(env, order(), hdr({ eti_paper: "garbage" }))).r.status, 401);
  assert.equal((await exec(env, order(), { ...hdr(cookies), origin: "https://evil.example" })).r.status, 401, "CSRF: cookie from another origin does not authenticate a write");
  assert.equal((await exec(env, order(), hdr({}, { authorization: "Bearer wrong" }))).r.status, 401);
  assert.equal((await exec(env, order(), hdr({}, { authorization: "Bearer " + env.ETI_EXECUTION_TOKEN }))).r.status, 201, "master token still works");
});

test("server-side validation still applies to authenticated orders", async () => {
  reset(); const env = mkEnv(); const { cookies } = await session(env, "paper"), h = hdr(cookies);
  for (const bad of [{ side: "hold" }, { quantity: -1 }, { quantity: "1" }, { symbol: "bad symbol!" }, { riskConfirmed: false }, { clientOrderId: "short" }, { executionSource: undefined }, { type: "limit" }, { type: "market", limitPrice: 5 }])
    assert.ok([400].includes((await exec(env, order(bad as any), h)).r.status), JSON.stringify(bad));
  assert.equal((await exec(env, order({ quantity: 1000 }), h)).r.status, 403, "max quantity");
  assert.equal((await exec(env, order({ type: "limit", limitPrice: 40_000 }), h)).r.status, 422, "resting limit not simulated");
  const ok = await exec(env, order({ type: "limit", limitPrice: 60_000 }), h); assert.equal(ok.r.status, 201); assert.ok(ok.body.fill.price <= 60_000);
  const id = "dup" + "a".repeat(12); assert.equal((await exec(env, order({}, id), h)).r.status, 201); assert.equal((await exec(env, order({}, id), h)).r.status, 409);
  assert.equal((await handleExecution(post("/api/orders", order(), h), { ...env, ETI_KILL_SWITCH: "true" }, { now: () => clock })).status, 423);
  assert.equal((await handleExecution(post("/api/orders", order(), h), env, { now: () => clock, priceOf: async () => null })).status, 503, "no price: refuse, do not invent one");
});

test("expiry: a token stops working at its expiry and the cookie lifetime matches", async () => {
  reset(); const env = mkEnv(); const { cookies } = await session(env, "paper");
  clock = T0 + POLICY.paper.ttlSec * 1000 - 1000; assert.equal((await exec(env, order(), hdr(cookies))).r.status, 201);
  clock = T0 + POLICY.paper.ttlSec * 1000 + 1000; assert.equal((await exec(env, order(), hdr(cookies))).r.status, 401);
  const v = await verifyToken(env, cookies.eti_paper, "paper", clock); assert.deepEqual(v, { ok: false, reason: "expired" });
});

test("refresh issues a new token, revokes the old one, and stops at the absolute lifetime", async () => {
  reset(); const env = mkEnv(); let { cookies } = await session(env, "paper"); const first = cookies.eti_paper;
  clock = T0 + 10 * 60_000;
  const rr = await handleAuth(post("/api/auth/refresh", { environment: "paper" }, hdr(cookies)), env, deps()); assert.equal(rr.status, 200);
  const next = jar(rr).eti_paper; assert.ok(next && next !== first); const rb = await rr.json() as any; assert.ok(!JSON.stringify(rb).includes(next));
  assert.equal((await exec(env, order(), hdr({ eti_paper: first }))).r.status, 401, "old token revoked");
  assert.equal((await exec(env, order(), hdr({ eti_paper: next }))).r.status, 201);
  // walk the chain to the absolute limit
  let cur = next; for (let t = clock; t < T0 + POLICY.paper.absoluteSec * 1000 - 60_000; t += 20 * 60_000) { clock = t + 20 * 60_000; const r = await handleAuth(post("/api/auth/refresh", { environment: "paper" }, hdr({ eti_paper: cur })), env, deps()); if (r.status !== 200) break; cur = jar(r).eti_paper; }
  clock = T0 + POLICY.paper.absoluteSec * 1000 - 10_000; const last = await handleAuth(post("/api/auth/refresh", { environment: "paper" }, hdr({ eti_paper: cur })), env, deps());
  assert.equal(last.status, 401, "no refresh past the absolute lifetime");
  assert.equal((await handleAuth(post("/api/auth/refresh", { environment: "paper" }, hdr()), env, deps())).status, 401, "no session");
});

test("revocation: own session, epoch revoke-all by master, and master-only authority", async () => {
  reset(); const env = mkEnv(); const a = await session(env, "paper"), b = await session(env, "paper");
  const rv = await handleAuth(post("/api/auth/revoke", { environment: "paper" }, hdr(a.cookies)), env, deps()); assert.equal(rv.status, 200);
  assert.equal((await exec(env, order(), hdr(a.cookies))).r.status, 401); assert.equal((await exec(env, order(), hdr(b.cookies))).r.status, 201, "other sessions unaffected");
  assert.equal((await handleAuth(post("/api/auth/revoke", { environment: "all" }, hdr(b.cookies)), env, deps())).status, 400, "a session cannot revoke all");
  const all = await handleAuth(post("/api/auth/revoke", { environment: "all" }, hdr({}, { authorization: "Bearer " + env.ETI_EXECUTION_TOKEN })), env, deps()); assert.equal(all.status, 200);
  assert.equal((await exec(env, order(), hdr(b.cookies))).r.status, 401, "epoch bump invalidated every session");
  const fresh = await session(env, "paper"); assert.equal((await exec(env, order(), hdr(fresh.cookies))).r.status, 201, "new sessions work after revoke-all");
});

test("rotation: new key signs new tokens, old tokens survive until expiry, retired keys stop validating; secret-held keys rotate by replacing the secret", async () => {
  reset(); const env = mkEnv(); const a = await session(env, "paper");
  const rot = await handleAuth(post("/api/auth/rotate", {}, hdr({}, { authorization: "Bearer " + env.ETI_EXECUTION_TOKEN })), env, deps()); assert.equal(rot.status, 200); assert.equal((await rot.json() as any).signingKey.version, 2);
  assert.equal((await handleAuth(post("/api/auth/rotate", {}, hdr(a.cookies)), env, deps())).status, 401, "sessions cannot rotate keys");
  assert.equal((await exec(env, order(), hdr(a.cookies))).r.status, 201, "token from the previous key still valid");
  const b = await session(env, "paper"); assert.equal((await exec(env, order(), hdr(b.cookies))).r.status, 201);
  // age the key ring past retirement: the old key is dropped and its tokens die with it
  const ring = JSON.parse(await env.ETI_EXECUTION_LOG.get("auth:keyring")); ring.previous[0].retireAt = T0 - 1; await env.ETI_EXECUTION_LOG.put("auth:keyring", JSON.stringify(ring));
  assert.equal((await exec(env, order(), hdr(a.cookies))).r.status, 401, "retired key no longer validates");
  assert.equal((await exec(env, order(), hdr(b.cookies))).r.status, 201);
  // automatic rotation by age
  const old = JSON.parse(await env.ETI_EXECUTION_LOG.get("auth:keyring")); old.current.createdAt = T0 - 8 * 86400_000; await env.ETI_EXECUTION_LOG.put("auth:keyring", JSON.stringify(old));
  assert.equal((await loadRing(env, T0)).ring.current.v, 3, "key older than ETI_KEY_ROTATION_DAYS rotates by itself");
  // secret mode
  const se = mkEnv({ ETI_SESSION_SECRET: "k".repeat(40) }); const sc = await session(se, "paper");
  assert.equal((await handleAuth(post("/api/auth/rotate", {}, hdr({}, { authorization: "Bearer " + se.ETI_EXECUTION_TOKEN })), se, deps())).status, 409);
  const se2 = { ...se, ETI_SESSION_SECRET: "n".repeat(40), ETI_SESSION_SECRET_PREVIOUS: "k".repeat(40) };
  assert.equal((await exec(se2, order(), hdr(sc.cookies))).r.status, 201, "previous secret keeps sessions alive during the changeover");
  assert.equal((await exec({ ...se, ETI_SESSION_SECRET: "n".repeat(40) }, order(), hdr(sc.cookies))).r.status, 401, "dropping the previous secret invalidates them");
});

test("environment isolation: scopes, cookies, records and live are separate", async () => {
  reset(); const env = mkEnv(SECRETS); const paper = await session(env, "paper"); const both = await session(env, "testnet", paper.cookies);
  assert.equal(both.body.environment, "testnet"); assert.ok(both.cookies.eti_paper && both.cookies.eti_testnet && both.cookies.eti_paper !== both.cookies.eti_testnet);
  assert.equal((await exec(env, order({ broker: "alpaca" }), hdr(paper.cookies))).r.status, 403, "paper session cannot reach exchange testnet");
  const onlyTestnet = { eti_testnet: both.cookies.eti_testnet };
  const wrong = await exec(env, order(), hdr(onlyTestnet)); assert.equal(wrong.r.status, 403); assert.equal(wrong.body.required_session, "paper");
  assert.equal((await exec(env, order({ broker: "alpaca" }), hdr(onlyTestnet))).r.status, 201);
  assert.equal((await exec(env, order({ broker: "alpaca" }), hdr({ eti_testnet: paper.cookies.eti_paper }))).r.status, 401, "a paper token placed in the testnet cookie is useless");
  assert.equal((await exec(env, order(), hdr({ eti_paper: both.cookies.eti_testnet }))).r.status, 401, "and the reverse");
  await exec(env, order(), hdr(paper.cookies));
  const h = async (c: Record<string, string>) => (await (await handleExecution(new Request(ORIGIN + "/api/execution/history", { headers: hdr(c) }), env, { now: () => clock })).json() as any);
  const hp = await h(paper.cookies), ht = await h(onlyTestnet), hm = await (await handleExecution(new Request(ORIGIN + "/api/execution/history", { headers: { authorization: "Bearer " + env.ETI_EXECUTION_TOKEN } }), env, { now: () => clock })).json() as any;
  assert.ok(hp.records.length >= 1 && hp.records.every((r: any) => r.environment === "internal_paper")); assert.ok(ht.records.length >= 1 && ht.records.every((r: any) => r.environment === "exchange_testnet"));
  assert.ok(hm.records.length >= hp.records.length + ht.records.length);
  assert.equal((await handleExecution(new Request(ORIGIN + "/api/execution/history"), env, { now: () => clock })).status, 401);
  assert.equal((await handleExecution(new Request(ORIGIN + "/api/execution/history?environment=internal_paper", { headers: hdr(onlyTestnet) }), env, { now: () => clock })).status, 200);
  const stray = await (await handleExecution(new Request(ORIGIN + "/api/execution/history?environment=internal_paper", { headers: hdr(onlyTestnet) }), env, { now: () => clock })).json() as any; assert.ok(stray.records.every((r: any) => r.environment === "exchange_testnet"), "a session cannot read another environment's records");
  const dual = await (await handleExecution(new Request(ORIGIN + "/api/execution/history?environment=exchange_testnet", { headers: hdr(both.cookies) }), env, { now: () => clock })).json() as any;
  assert.ok(dual.records.length >= 1 && dual.records.every((r: any) => r.environment === "exchange_testnet"), "a two-environment session can still ask for one environment");
  const ap = await handlePaper(new Request(ORIGIN + "/api/paper/status", { headers: hdr(onlyTestnet) }), env, deps()); assert.equal(ap.status, 403, "testnet session cannot use the internal paper API");
  assert.equal((await handlePaper(new Request(ORIGIN + "/api/paper/status", { headers: hdr(paper.cookies) }), env, deps())).status, 200);
});

test("live trading stays disabled: no session reaches it, and the master path still needs its own gates", async () => {
  reset(); const env = mkEnv({ ...SECRETS, ETI_LIVE_TRADING_ENABLED: "true", ETI_LIVE_ACTIVATION_TOKEN: "activation-secret-0123456789" }); const s = await session(env, "paper");
  const live = order({ broker: "alpaca", type: "limit", limitPrice: 10, liveConfirmed: true });
  assert.equal((await exec(env, live, hdr(s.cookies, { "x-eti-live-authorization": "activation-secret-0123456789" }), "/api/orders/live")).r.status, 403, "session + correct activation secret still refused");
  const off = mkEnv(SECRETS), m = hdr({}, { authorization: "Bearer " + off.ETI_EXECUTION_TOKEN, "x-eti-live-authorization": "x" });
  assert.equal((await exec(off, live, m, "/api/orders/live")).r.status, 423, "live switch off");
  const noGate = await exec({ ...env, ETI_LIVE_MAX_NOTIONAL_USD: "100", ETI_LIVE_MAX_ORDER_QUANTITY: "1" }, live, hdr({}, { authorization: "Bearer " + env.ETI_EXECUTION_TOKEN, "x-eti-live-authorization": "wrong-secret-0123456789012" }), "/api/orders/live"); assert.equal(noGate.r.status, 423, "wrong activation secret");
  assert.ok(!brokerCalls.some(c => c.includes("api.alpaca.markets") || c.includes("api.binance.com")), "no live endpoint contacted");
  assert.equal((await exec(env, order({ broker: "eti_paper", liveConfirmed: true }), hdr({}, { authorization: "Bearer " + env.ETI_EXECUTION_TOKEN, "x-eti-live-authorization": "activation-secret-0123456789" }), "/api/orders/live")).r.status, 400, "internal paper is not a live broker");
  for (const p of ["/api/withdraw", "/api/withdrawals", "/api/transfer", "/api/orders/withdraw", "/api/auth/withdraw"]) { const r = p.startsWith("/api/auth") ? await handleAuth(post(p, {}, hdr(s.cookies)), env, deps()) : await handleExecution(post(p, {}, hdr(s.cookies)), env, { now: () => clock }); assert.equal(r.status, 404, p); }
  const st = await (await handleAuth(new Request(ORIGIN + "/api/auth/status"), env, deps())).json() as any; assert.equal(st.environments.live.sessionsIssued, false); assert.equal(st.withdrawalsAndTransfers, "not implemented");
});

test("exchange testnet: authenticates automatically when valid credentials are configured, and says so", async () => {
  reset(); const env = mkEnv(SECRETS); const t = await session(env, "testnet");
  assert.equal(t.r.status, 201); assert.equal(t.body.environment, "testnet"); assert.equal(t.body.fallback, null);
  assert.ok(brokerCalls.some(c => c.includes("/v2/account")) && brokerCalls.some(c => c.includes("/api/v3/account")), "credentials were validated against the testnet services");
  const a = await exec(env, order({ broker: "alpaca" }), hdr(t.cookies)); assert.equal(a.r.status, 201); assert.equal(a.body.mode, "paper"); assert.equal(a.body.live_trading, false);
  const b = await exec(env, order({ broker: "binance" }), hdr(t.cookies)); assert.equal(b.r.status, 201); assert.equal(b.body.mode, "testnet");
  assert.ok(brokerCalls.some(c => c.startsWith("POST https://testnet.binance.vision/api/v3/order")));
  const sent = brokerCalls.filter(c => c.startsWith("POST")); assert.ok(sent.every(c => !c.includes("api.binance.com") && !c.includes("//api.alpaca.markets")));
});

test("missing exchange credentials fall back to INTERNAL PAPER with a notice; nothing is fabricated", async () => {
  reset(); const env = mkEnv(); const t = await session(env, "testnet");
  assert.equal(t.r.status, 201); assert.equal(t.body.environment, "paper"); assert.equal(t.body.requested, "testnet"); assert.equal(t.body.fallback.reason, "exchange_credentials_missing"); assert.match(t.body.notices[0], /INTERNAL PAPER/); assert.ok(!t.cookies.eti_testnet);
  const f = await exec(env, order({ broker: "binance" }), hdr(t.cookies)); assert.equal(f.r.status, 403, "the fallback session is a paper session and cannot reach the exchange path");
  // a browser holding a testnet session still gets a visible fallback if credentials disappear afterwards
  const good = mkEnv(SECRETS); const gs = await session(good, "testnet"); const gone = { ...good, ALPACA_API_KEY: undefined, ALPACA_SECRET_KEY: undefined, BINANCE_API_KEY: undefined, BINANCE_SECRET_KEY: undefined };
  const fb = await exec(gone, order({ broker: "alpaca" }), hdr(gs.cookies)); assert.equal(fb.r.status, 201);
  assert.equal(fb.body.mode, "internal_paper"); assert.equal(fb.body.exchangeOrderPlaced, false); assert.equal(fb.body.fallback.reason, "exchange_credentials_missing"); assert.match(fb.body.notice, /No exchange testnet order was placed/);
  assert.ok(!brokerCalls.some(c => c.startsWith("POST")), "no exchange order was sent");
  const rec = JSON.parse([...good.ETI_EXECUTION_LOG.m.entries()].find(([k]) => k.startsWith("exec:paper:rec:"))![1]); assert.equal(rec.environment, "internal_paper"); assert.equal(rec.exchangeOrderPlaced, false);
});

test("invalid exchange credentials fall back, are remembered, and are never reported as executed", async () => {
  reset(); alpacaStatus = 401; binanceStatus = 401; const env = mkEnv(SECRETS); const t = await session(env, "testnet");
  assert.equal(t.body.environment, "paper"); assert.equal(t.body.fallback.reason, "exchange_credentials_invalid");
  // credentials turn bad only after a testnet session exists: the order-time rejection triggers the fallback
  reset(); const env2 = mkEnv(SECRETS); const ok = await session(env2, "testnet"); assert.equal(ok.body.environment, "testnet");
  env2.ETI_EXECUTION_LOG.m.delete("auth:cred:alpaca"); alpacaStatus = 403; brokerCalls = [];
  const fb = await exec(env2, order({ broker: "alpaca" }), hdr(ok.cookies)); assert.equal(fb.r.status, 201); assert.equal(fb.body.mode, "internal_paper"); assert.equal(fb.body.fallback.reason, "exchange_credentials_invalid"); assert.equal(fb.body.exchangeOrderPlaced, false);
  assert.ok(!brokerCalls.some(c => c.startsWith("POST") && c.includes("/orders")), "no order was submitted with rejected credentials");
  const st = await (await handleAuth(new Request(ORIGIN + "/api/auth/status", { headers: hdr(ok.cookies) }), env2, deps())).json() as any; assert.equal(st.environments.exchange_testnet.brokers.alpaca.status, "invalid");
  assert.equal(st.environments.exchange_testnet.brokers.binance.status, "valid");
});

test("API clients with the master token keep strict behaviour unless they opt in to fallback", async () => {
  reset(); const env = mkEnv(); const m = hdr({}, { authorization: "Bearer " + env.ETI_EXECUTION_TOKEN });
  const strict = await exec(env, order({ broker: "binance" }), m); assert.equal(strict.r.status, 503); assert.equal(strict.body.error, "broker_not_configured");
  const opt = await exec(env, order({ broker: "binance", fallbackToPaper: true }), m); assert.equal(opt.r.status, 201); assert.equal(opt.body.mode, "internal_paper");
});

test("secrets, tokens and keys never appear in responses, status or stored records", async () => {
  reset(); const env = mkEnv({ ...SECRETS, ETI_SESSION_SECRET: undefined }); const t = await session(env, "testnet"), p = await session(env, "paper", t.cookies);
  const out: string[] = [JSON.stringify(t.body), JSON.stringify(p.body)];
  for (const [b, c] of [["alpaca", t.cookies], ["binance", t.cookies]] as const) out.push(JSON.stringify((await exec(env, order({ broker: b }), hdr(c))).body));
  out.push(JSON.stringify((await exec(env, order(), hdr(p.cookies))).body));
  out.push(JSON.stringify(await (await handleAuth(new Request(ORIGIN + "/api/auth/status?validate=1", { headers: hdr(p.cookies) }), env, deps())).json()));
  out.push(JSON.stringify(await (await handleExecution(new Request(ORIGIN + "/api/execution/status"), env)).json()));
  out.push(JSON.stringify(await (await handleExecution(new Request(ORIGIN + "/api/execution/history", { headers: hdr({}, { authorization: "Bearer " + env.ETI_EXECUTION_TOKEN }) }), env, { now: () => clock })).json()));
  const records = [...env.ETI_EXECUTION_LOG.m.entries()].filter(([k]) => !k.startsWith("auth:keyring")).map(([, v]) => v);
  const ring = JSON.parse(env.ETI_EXECUTION_LOG.m.get("auth:keyring")); const sensitive = [...Object.values(SECRETS), env.ETI_EXECUTION_TOKEN, t.cookies.eti_testnet, p.cookies.eti_paper, ring.current.key];
  for (const s of sensitive) { assert.ok(s, "fixture"); for (const o of [...out, ...records]) assert.ok(!o.includes(s), "leak of " + s.slice(0, 6) + "…"); }
  const sidOf = (tok: string) => tok.split(".")[3]; for (const o of out) assert.ok(!o.includes(sidOf(t.cookies.eti_testnet)), "raw session id is not exposed");
  const audit = JSON.parse(records.find(r => r.includes('"environment":"internal_paper"'))!); assert.match(audit.auth.sessionRef, /^[0-9a-f]{12}$/); assert.equal(audit.auth.kind, "session");
});

test("the dashboard script contains no secret handling: cookie-based, no token storage, no inputs in internal paper mode", async () => {
  const { default: app } = await import("./index.ts"); const html = await (await (app as any).fetch(new Request(ORIGIN + "/"), mkEnv())).text();
  const script = html.slice(html.indexOf("<script>"));
  assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(script.replace(/sessionStorage\.getItem\('alpha_/g, "")), "no browser storage of credentials");
  assert.ok(!html.includes("ETI_SESSION_SECRET") && !html.includes("BINANCE_SECRET_KEY") && !html.includes(SECRETS.ALPACA_SECRET_KEY));
  assert.ok(html.includes("/api/auth/session") && html.includes("/api/auth/refresh") && html.includes('credentials:\'same-origin\''));
  assert.ok(html.includes('id="authBanner"') && html.includes('value="eti_paper"'));
});

test("status reports environments without secrets and honours ETI_AUTO_SESSIONS", async () => {
  reset(); const env = mkEnv(SECRETS); const st = await (await handleAuth(new Request(ORIGIN + "/api/auth/status"), env, deps())).json() as any;
  assert.equal(st.autoSessions, "paper_testnet"); assert.equal(st.environments.internal_paper.authentication, "automatic_session"); assert.equal(st.environments.live.status, "disabled");
  assert.equal(st.environments.exchange_testnet.brokers.alpaca.status, "unverified", "no validation call unless a session asks for one");
  const off = mkEnv({ ETI_AUTO_SESSIONS: "off" }); assert.equal((await session(off, "paper")).r.status, 403);
  const pOnly = mkEnv({ ...SECRETS, ETI_AUTO_SESSIONS: "paper" }); const s = await session(pOnly, "testnet"); assert.equal(s.body.environment, "paper"); assert.equal(s.body.fallback.reason, "testnet_sessions_disabled_by_ETI_AUTO_SESSIONS");
  const nokv = { ETI_EXECUTION_TOKEN: "x".repeat(30) } as any; assert.equal((await handleAuth(new Request(ORIGIN + "/api/auth/status"), nokv, deps())).status, 503);
});

test("session issuance and per-session order flow are rate limited", async () => {
  reset(); const env = mkEnv(); let last = 0; for (let i = 0; i < 31; i++) last = (await session(env, "paper")).r.status; assert.equal(last, 429);
  const env2 = mkEnv(); const s = await session(env2, "paper"); let status = 0; for (let i = 0; i < 61; i++) status = (await exec(env2, order(), hdr(s.cookies))).r.status; assert.equal(status, 429);
});

test("authenticate() recognises master and sessions independently", async () => {
  reset(); const env = mkEnv(); const i = await issueSession(env, "paper", "ref", T0);
  const a = await authenticate(new Request(ORIGIN + "/x", { headers: { authorization: "Bearer " + i.token } }), env, T0); assert.deepEqual([...a.scopes], ["paper"]); assert.equal(a.master, false);
  const m = await authenticate(new Request(ORIGIN + "/x", { headers: { authorization: "Bearer " + env.ETI_EXECUTION_TOKEN } }), env, T0); assert.equal(m.master, true); assert.equal(m.scopes.size, 0);
  assert.equal((await authenticate(new Request(ORIGIN + "/x"), env, T0)).master, false);
});

test("provisioning script generates strong secrets, never prints them, never handles exchange keys", async () => {
  const { spawnSync } = await import("node:child_process"); const { generate, plan } = await import("../scripts/provision-secrets.mjs");
  const a = generate(), b = generate(); assert.notEqual(a, b); assert.ok(Buffer.from(a, "base64url").length >= 32);
  assert.deepEqual(plan(["--session-secret", "--execution-token", "--alpaca-api-key"]), ["ETI_SESSION_SECRET", "ETI_EXECUTION_TOKEN"]);
  const r = spawnSync("node", ["scripts/provision-secrets.mjs", "--session-secret", "--execution-token", "--dry-run"], { encoding: "utf8", cwd: new URL("..", import.meta.url).pathname });
  assert.equal(r.status, 0); assert.match(r.stdout, /would set ETI_SESSION_SECRET/); assert.ok(!/[A-Za-z0-9_-]{43,}/.test(r.stdout), "no secret value printed");
});
