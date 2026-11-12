import { test } from "node:test";
import assert from "node:assert/strict";
import app from "./main.ts";
import { sqliteD1 } from "./portfolio/testing.ts";
import { addNonces, buildCsp, harden, nonceValue } from "./security/headers.ts";
import { PROVIDERS, CATEGORIES, applyProbe, probeProvider, probeAll, report, stateOf, emptyHealth } from "./providers/registry.ts";
import { handleProviders } from "./providers/routes.ts";
import { handleBackup } from "./backup/routes.ts";
import { handleIdentity } from "./identity/routes.ts";
import { ACCOUNT_HTML } from "./identity/ui.ts";
import { PROVIDERS_HTML } from "./providers/ui.ts";
import { totpCode } from "./identity/totp.ts";

const O = "https://eti.test", KEY = "k".repeat(40), MASTER = "master-token-0123456789abcdef0123456789";
const memKV = () => { const m = new Map<string, string>(); return { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); } }; };

test("nonce CSP: every inline script/style is nonced, policy is strict, existing CSP is kept", async () => {
  const html = '<html><head><style>a{}</style><style nonce="x">b{}</style></head><body><script>1</script><script src="/a.js"></script><script type="application/json">{}</script></body></html>';
  const out = await harden(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })), body = await out.text(), csp = out.headers.get("content-security-policy")!;
  const n = /'nonce-([\w-]+)'/.exec(csp)![1]; assert.equal((body.match(new RegExp('nonce="' + n + '"', "g")) || []).length, 4); assert.ok(body.includes('<style nonce="x">'));
  assert.match(csp, /default-src 'self'/); assert.match(csp, /object-src 'none'/); assert.match(csp, /frame-ancestors 'none'/); assert.ok(!/script-src[^;]*unsafe-inline/.test(csp)); assert.ok(!/script-src[^;]*unsafe-eval/.test(csp));
  assert.equal(out.headers.get("x-frame-options"), "DENY"); assert.equal(out.headers.get("x-content-type-options"), "nosniff"); assert.match(out.headers.get("strict-transport-security")!, /max-age=\d+/);
  const own = await harden(new Response("<script>1</script>", { headers: { "content-type": "text/html", "content-security-policy": "default-src 'none'" } })); assert.equal(own.headers.get("content-security-policy"), "default-src 'none'"); assert.equal(await own.text(), "<script>1</script>");
  assert.notEqual(nonceValue(), nonceValue());
});
test("headers: JSON responses are hardened but not rewritten; WebSocket upgrades pass through; extra connect origins are validated", async () => {
  const j = await harden(new Response('{"a":1}', { headers: { "content-type": "application/json" } })); assert.equal(await j.text(), '{"a":1}'); assert.equal(j.headers.get("referrer-policy"), "no-referrer"); assert.equal(j.headers.get("content-security-policy"), null);
  const ws: any = new Response(null, { status: 200 }); Object.defineProperty(ws, "webSocket", { value: {} }); assert.equal(await harden(ws), ws);
  const csp = buildCsp("n", { ETI_CSP_CONNECT: "https://feed.example.com wss://x.example.com:8443 javascript:alert(1) *  http://bad host" }); assert.ok(csp.includes("https://feed.example.com") && csp.includes("wss://x.example.com:8443")); assert.ok(!csp.includes("javascript:") && !csp.includes(" * "));
  assert.equal(addNonces("<scripty>", "n"), "<scripty>");
});
test("every served HTML page gets a CSP whose nonces cover all inline code; no inline event handlers exist", async () => {
  const env: any = { ETI_EXECUTION_LOG: memKV(), ETI_PORTFOLIO_DB: sqliteD1(), ETI_IDENTITY_KEY: KEY };
  for (const path of ["/", "/account", "/providers", "/command", "/daily", "/agents", "/agents/futures", "/alpha"]) {
    const r = await app.fetch(new Request(O + path), env); if (!/text\/html/.test(r.headers.get("content-type") || "")) continue;
    const csp = r.headers.get("content-security-policy")!, body = await r.text(); assert.ok(csp, path + " has CSP");
    assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(body), path + " has inline handlers");
    if (/'nonce-/.test(csp)) { const n = /'nonce-([\w-]+)'/.exec(csp)![1]; for (const m of body.matchAll(/<(script|style)(\s[^>]*)?>/gi)) assert.ok((m[2] || "").includes('nonce="' + n + '"'), path + " un-nonced " + m[0]); }
  }
});
test("account and providers pages: scripts parse and use no innerHTML", () => {
  for (const html of [ACCOUNT_HTML, PROVIDERS_HTML]) { const js = /<script>([\s\S]*)<\/script>/.exec(html)![1]; assert.doesNotThrow(() => new Function(js)); assert.ok(!/innerHTML|outerHTML|document\.write|eval\(/.test(js)); }
});
test("end-to-end through main.ts: /api/identity/status, secure headers on API errors", async () => {
  const r = await app.fetch(new Request(O + "/api/identity/status"), { ETI_EXECUTION_LOG: memKV() } as any); const b: any = await r.json();
  assert.equal(b.available, false); assert.equal(r.headers.get("x-content-type-options"), "nosniff"); assert.ok(b.roles.length === 5);
});

// ---- providers ----
const FULL = { ALPACA_API_KEY: "ak", ALPACA_SECRET_KEY: "as", ETHERSCAN_API_KEY: "ek", SEC_USER_AGENT: "ETI test@example.com", FRED_API_KEY: "fk", ETI_EVENT_FEED_URL: "https://feed.example.com/events" };
test("registry: no provider claims everything; capabilities, credentials and limits are declared", () => {
  assert.ok(PROVIDERS.length >= 10); const ids = new Set(PROVIDERS.map(p => p.id)); assert.equal(ids.size, PROVIDERS.length);
  for (const p of PROVIDERS) { assert.ok(Object.keys(p.capabilities).length >= 1 && p.limits.length > 10, p.id); assert.ok(Object.keys(p.capabilities).length < CATEGORIES.length - 2, p.id + " claims too much"); }
  assert.ok(!PROVIDERS.some(p => p.capabilities.order_book && p.id === "coingecko"));
  assert.equal(PROVIDERS.filter(p => p.capabilities.exchange_execution).length, 1);
});
test("status: unconfigured providers are never probed; freshness, staleness and failures are explicit", async () => {
  const calls: string[] = [], f: any = async (u: string) => { calls.push(u); return new Response("{}", { status: 200 }); };
  let t = 1_000_000; const kv = memKV(), env: any = { ETI_EXECUTION_LOG: kv };
  const h = await probeAll(env, kv, f, () => (t += 5));
  assert.ok(calls.length >= 4 && !calls.some(u => /alpaca|etherscan|stlouisfed|sec\.gov/.test(u)), "keyed providers skipped without keys");
  const rep = report(env, h, t); const alp = rep.providers.find(p => p.id === "alpaca")!; assert.equal(alp.state, "unconfigured"); assert.deepEqual(alp.missing, ["ALPACA_API_KEY", "ALPACA_SECRET_KEY"]);
  assert.equal(rep.providers.find(p => p.id === "binance_spot")!.state, "ok"); assert.equal(rep.coverage.order_book.status, "covered"); assert.equal(rep.coverage.news.status, "uncovered"); assert.equal(rep.coverage.onchain.status, "uncovered"); assert.equal(rep.coverage.broker_execution.status, "uncovered");
  const bin = PROVIDERS.find(p => p.id === "binance_spot")!; assert.equal(stateOf(bin, env, h.binance_spot, t + bin.staleAfterSec * 1000 + 1), "stale"); assert.equal(stateOf(bin, env, undefined, t), "unknown");
  let hh = applyProbe(emptyHealth(), { at: 10, ok: true, latencyMs: 20, httpStatus: 200, error: null }); hh = applyProbe(hh, { at: 20, ok: false, latencyMs: null, httpStatus: 503, error: "http_503" });
  assert.equal(stateOf(bin, env, hh, 30), "degraded"); hh = applyProbe(hh, { at: 30, ok: false, latencyMs: null, httpStatus: 503, error: "http_503" }); assert.equal(stateOf(bin, env, hh, 40), "down");
  assert.equal(stateOf(bin, env, applyProbe(emptyHealth(), { at: 10, ok: true, latencyMs: 4000, httpStatus: 200, error: null }), 20), "degraded");
});
test("probe: with keys it probes keyed providers, maps failures to safe codes, never leaks a credential", async () => {
  const seen: string[] = []; const f: any = async (u: string, init: any) => { seen.push(u); if (/stlouisfed/.test(u)) return new Response("no", { status: 403 }); if (/etherscan/.test(u)) throw Object.assign(new Error("boom"), { name: "AbortError" }); if (/bybit/.test(u)) return new Response("x", { status: 429 }); return new Response("{}", { status: 200 }); };
  const kv = memKV(); const h = await probeAll({ ...FULL, ETI_EXECUTION_LOG: kv } as any, kv, f, Date.now); const rep = report({ ...FULL } as any, h, Date.now());
  const st = (id: string) => rep.providers.find(p => p.id === id)!; assert.equal(st("fred").freshness.lastError, "auth_rejected"); assert.equal(st("etherscan").freshness.lastError, "timeout"); assert.equal(st("bybit").freshness.lastError, "rate_limited"); assert.equal(st("alpaca").freshness.lastError, null);
  const json = JSON.stringify(rep); for (const s of ["fk", "ek", "as", "ak"]) assert.ok(!new RegExp("\\b" + s + "\\b").test(json.replace(/"[A-Z_]+_KEY"/g, "")), "no credential in report: " + s);
  assert.ok(seen.some(u => /api_key=fk/.test(u))); assert.equal((await probeProvider(PROVIDERS.find(p => p.id === "event_feed")!, { ETI_EVENT_FEED_URL: "http://insecure.example" }, f, Date.now)), null); // plain http feeds are never contacted
  assert.ok(JSON.parse((await kv.get("providers:health"))!).fred.consecutiveFailures === 1);
});
test("providers API: status is readable, probing needs a session and is rate limited", async () => {
  const kv = memKV(), env: any = { ETI_EXECUTION_LOG: kv, ETI_EXECUTION_TOKEN: MASTER }, fetchImpl: any = async () => new Response("{}", { status: 200 });
  const s = await handleProviders(new Request(O + "/api/providers/status"), env); assert.equal(s.status, 200); assert.ok(((await s.json()) as any).providers.length >= 10);
  assert.equal((await handleProviders(new Request(O + "/api/providers/probe", { method: "POST", headers: { origin: O } }), env, { fetchImpl })).status, 401);
  assert.equal((await handleProviders(new Request(O + "/api/providers/probe", { method: "POST", headers: { origin: "https://evil.example" } }), env, { fetchImpl })).status, 403);
  const ok = await handleProviders(new Request(O + "/api/providers/probe", { method: "POST", headers: { authorization: "Bearer " + MASTER } }), env, { fetchImpl }); assert.equal(ok.status, 200); assert.equal(((await ok.json()) as any).providers.find((p: any) => p.id === "binance_spot").state, "ok");
  let last = 200; for (let i = 0; i < 8; i++) last = (await handleProviders(new Request(O + "/api/providers/probe", { method: "POST", headers: { authorization: "Bearer " + MASTER } }), env, { fetchImpl })).status; assert.equal(last, 429);
});

// ---- backup routes ----
test("backup API: operators only; export is encrypted and audited; restore refuses a populated database", async () => {
  const env: any = { ETI_PORTFOLIO_DB: sqliteD1(), ETI_IDENTITY_KEY: KEY, ETI_EXECUTION_LOG: memKV(), ETI_EXECUTION_TOKEN: MASTER }; const now = Date.UTC(2026, 10, 11, 9);
  const id = (path: string, body?: any, headers: any = {}) => handleIdentity(new Request(O + path, { method: body ? "POST" : "GET", headers: { origin: O, "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined }), env, { now: () => now });
  await id("/api/identity/bootstrap", { email: "boss@example.com", password: "Correct-Horse-Battery-9" }, { authorization: "Bearer " + MASTER });
  const login = await id("/api/identity/login", { email: "boss@example.com", password: "Correct-Horse-Battery-9" }); const c1 = login.headers.get("set-cookie")!.split(";")[0];
  const B0 = (cookie: string) => handleBackup(new Request(O + "/api/backup/export", { headers: { origin: O, cookie } }), env, { now: () => now });
  assert.equal((await B0(c1)).status, 403); // limited (pre-MFA) admin session cannot export
  const en: any = await (await id("/api/identity/mfa/enroll", {}, { cookie: c1 })).json(), cf = await id("/api/identity/mfa/confirm", { code: await totpCode(en.secret, now) }, { cookie: c1 }); const c2 = cf.headers.get("set-cookie")!.split(";")[0];
  const B = (path: string, init: any = {}) => handleBackup(new Request(O + path, { headers: { origin: O, ...(init.headers || {}) }, method: init.method, body: init.body }), env, { now: () => now });
  assert.equal((await B("/api/backup/export")).status, 401);
  assert.equal((await B("/api/backup/export", { headers: { cookie: c1 } })).status, 401); // the pre-MFA session was replaced at enrolment
  const ex = await B("/api/backup/export", { headers: { cookie: c2 } }); assert.equal(ex.status, 200); const file = await ex.text(); assert.ok(file.startsWith("v1.") && !file.includes("boss@example.com")); assert.match(ex.headers.get("content-disposition")!, /\.etibak/);
  const rs = await B("/api/backup/restore", { method: "POST", headers: { authorization: "Bearer " + MASTER }, body: file }); assert.equal(rs.status, 409); assert.equal(((await rs.json()) as any).error, "target_not_empty");
  const junk = await B("/api/backup/restore", { method: "POST", headers: { authorization: "Bearer " + MASTER }, body: "v1.a.b.c" }); assert.equal(junk.status, 400);
  const rows: any = await (await id("/api/identity/audit?limit=20", undefined, { cookie: c2 })).json(); const acts = rows.rows.map((r: any) => r.action); assert.ok(acts.includes("backup_exported") && acts.includes("backup_restore_refused"));
  const target: any = { ...env, ETI_PORTFOLIO_DB: sqliteD1() }; const rr = await handleBackup(new Request(O + "/api/backup/restore", { method: "POST", headers: { authorization: "Bearer " + MASTER }, body: file }), target, { now: () => now }); assert.equal(rr.status, 200); assert.equal(((await rr.json()) as any).restored.id_users, 1);
});
