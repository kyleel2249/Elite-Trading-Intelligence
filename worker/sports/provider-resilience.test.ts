import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { withSports, oddsPapiGet, oddsPapiRetry, OddsPapiError, providerFailure } from "./route.ts";
import { withSportsGuard, resetSportsGuardCache } from "./guard.ts";

// Regression coverage for "HTTP 505 when scanning": the OddsPapi gateway can answer a scan call with 505 (or other
// 5xx). The client must retry boundedly, never leak the API key, and a single bad fixture must not fail the scan.

const KEY = "sk-test-DO-NOT-LEAK-123456";
const base = { fetch: () => new Response("base") };
const original = { fetch: globalThis.fetch, retry: { ...oddsPapiRetry } };
beforeEach(() => { Object.assign(oddsPapiRetry, { baseMs: 0, timeoutMs: 200, maxAttempts: 3 }); });
afterEach(() => { globalThis.fetch = original.fetch; Object.assign(oddsPapiRetry, original.retry); });

const html505 = () => new Response("<html><body>505 HTTP Version Not Supported</body></html>", { status: 505, headers: { "content-type": "text/html" } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a transient 505 is retried and the scan call then succeeds", async () => {
  let calls = 0;
  globalThis.fetch = (async () => (++calls < 3 ? html505() : json([{ fixtureId: "f1" }]))) as any;
  const out = await oddsPapiGet(KEY, "fixtures", { sportId: "10" });
  assert.equal(calls, 3);
  assert.deepEqual(out, [{ fixtureId: "f1" }]);
});

test("a persistent 505 stops after the attempt limit with a structured, key-free error", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return html505(); }) as any;
  await assert.rejects(() => oddsPapiGet(KEY, "fixtures", { sportId: "10" }), (e: any) => {
    assert.ok(e instanceof OddsPapiError);
    assert.equal(e.providerStatus, 505);
    assert.equal(e.retryable, true);
    assert.match(e.message, /^ODDSPAPI_INVALID_JSON: fixtures returned HTTP 505/);
    assert.equal(e.message.includes(KEY), false);
    return true;
  });
  assert.equal(calls, 3);
});

test("a JSON 505 is reported as ODDSPAPI_HTTP_ERROR and explained as a provider-side fault", async () => {
  globalThis.fetch = (async () => json({ message: "version" }, 505)) as any;
  const err = await oddsPapiGet(KEY, "odds", { fixtureId: "1" }).catch(e => e);
  const f = providerFailure(err);
  assert.match(err.message, /^ODDSPAPI_HTTP_ERROR: odds HTTP 505/);
  assert.equal(f.status, 502);
  assert.equal(f.provider_status, 505);
  assert.match(f.hint, /HTTP 505/);
  assert.match(f.hint, /provider side/);
});

test("client errors (bad key) are not retried", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return json({ message: "invalid api key" }, 401); }) as any;
  const err = await oddsPapiGet(KEY, "fixtures", {}).catch(e => e);
  assert.equal(calls, 1);
  assert.equal(err.retryable, false);
  assert.match(providerFailure(err).hint, /ODDSPAPI_API_KEY/);
});

test("a hung provider times out, is retried, and maps to 504", async () => {
  let calls = 0;
  globalThis.fetch = ((_url: string, init: any) => { calls++; return new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))); }) as any;
  oddsPapiRetry.timeoutMs = 20;
  const err = await oddsPapiGet(KEY, "fixtures", {}).catch(e => e);
  assert.equal(calls, 3);
  assert.equal(err.kind, "timeout");
  assert.equal(providerFailure(err).status, 504);
});

test("network failures never expose the request URL (it carries the API key)", async () => {
  globalThis.fetch = (async (url: string) => { throw new Error("connect failed for " + url); }) as any;
  const err = await oddsPapiGet(KEY, "fixtures", {}).catch(e => e);
  assert.equal(err.kind, "network");
  assert.equal(err.message.includes(KEY), false);
});

const future = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const fixture = (id: string) => ({ fixtureId: id, hasOdds: true, startTime: future(5), participant1Name: "Home " + id, participant2Name: "Away " + id, tournamentName: "Test League", categoryName: "Testland" });
const env = { ODDSPAPI_API_KEY: KEY } as any;
const scan = (limit = 3) => withSports(base as any).fetch(new Request("https://eti.test/api/sports/football/next?limit=" + limit), env);

test("scan keeps the fixtures that succeeded when one odds call keeps failing with 505", async () => {
  globalThis.fetch = (async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/fixtures")) return json([fixture("a"), fixture("b")]);
    return u.searchParams.get("fixtureId") === "b" ? html505() : json({ bookmakerOdds: {} });
  }) as any;
  const res = await scan(2);
  const body = await res.json() as any;
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-eti-partial"), "1");
  assert.equal(body.partial, true);
  assert.equal(body.fixture_count, 1);
  assert.equal(body.fixtures_requested, 2);
  assert.equal(body.provider_errors.length, 1);
  assert.equal(body.provider_errors[0].provider_status, 505);
  assert.equal(JSON.stringify(body).includes(KEY), false);
});

test("scan reports an accurate 502 with provider status and hint when the fixtures call keeps returning 505", async () => {
  globalThis.fetch = (async () => html505()) as any;
  const res = await scan();
  const body = await res.json() as any;
  assert.equal(res.status, 502);
  assert.equal(body.error, "global_football_scan_failed");
  assert.equal(body.provider_status, 505);
  assert.equal(body.retryable, true);
  assert.match(body.hint, /HTTP 505/);
  assert.equal(JSON.stringify(body).includes(KEY), false);
});

test("scan fails (not a misleading empty success) when every odds call fails, and stops after three consecutive failures", async () => {
  let oddsCalls = 0;
  globalThis.fetch = (async (url: string) => {
    if (new URL(url).pathname.endsWith("/fixtures")) return json([1, 2, 3, 4, 5].map(i => fixture("f" + i)));
    oddsCalls++; return html505();
  }) as any;
  const res = await scan(5);
  assert.equal(res.status, 502);
  assert.equal(oddsCalls, 9, "3 fixtures x 3 attempts, then the loop gives up instead of burning quota on the rest");
});

test("the guard never caches a partial scan, so a retry can fill the gaps", async () => {
  resetSportsGuardCache();
  let calls = 0;
  const partial = () => { calls++; return new Response(JSON.stringify({ partial: true }), { status: 200, headers: { "content-type": "application/json", "x-eti-partial": "1" } }); };
  const app = withSportsGuard({ fetch: partial } as any);
  const url = "https://eti.test/api/sports/football/next?limit=2";
  const g = { ETI_SPORTS_PAPER_TOKEN: "secret-token" } as any;
  const headers = { "x-eti-sports-token": "secret-token" };
  await app.fetch(new Request(url, { headers }), g);
  await app.fetch(new Request(url, { headers }), g);
  assert.equal(calls, 2);
});
