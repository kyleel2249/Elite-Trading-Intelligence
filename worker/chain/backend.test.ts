import test from "node:test";
import assert from "node:assert/strict";
import { backendOrigin, backendStatus, forward, resetBackendCache, withChainBackend } from "./backend.ts";

const base = { fetch: async () => new Response("base") };
const mkFetch = (script: Array<Response | Error>, calls: Request[] = []) => (async (url: any, init?: any) => { calls.push(new Request(String(url), init)); const r = script.shift(); if (r instanceof Error) throw r; return r ?? new Response("{}", { status: 200 }); }) as typeof fetch;
const req = (p: string, init: RequestInit = {}) => new Request("https://eti.test" + p, init);
const OK = () => new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { "content-type": "application/json" } });

test("origin validation: unset, valid, and invalid forms", () => {
  assert.equal(backendOrigin({}), ""); assert.equal(backendOrigin({ BACKEND_URL: "https://eti.fly.dev" }), "https://eti.fly.dev");
  for (const bad of ["https://u:p@x.com", "https://x.com/path", "ftp://x.com", "x.com", "https://x.com/?q=1"]) assert.equal(backendOrigin({ BACKEND_URL: bad }), null, bad);
});

test("not configured and invalid configurations answer with precise errors", async () => {
  const app = withChainBackend(base, mkFetch([]));
  const a = await app.fetch(req("/api/chain/status"), {}); assert.equal(a.status, 503); assert.equal(((await a.json()) as any).error, "backend_not_configured");
  const b = await app.fetch(req("/api/chain/status"), { BACKEND_URL: "nope" }); assert.equal(b.status, 500); assert.equal(((await b.json()) as any).error, "backend_invalid");
});

test("forwards only /api/chain/*, passes auth, drops cookies, keeps the backend's status and body", async () => {
  const calls: Request[] = [], app = withChainBackend(base, mkFetch([new Response(JSON.stringify({ detail: "no" }), { status: 401, headers: { "content-type": "application/json" } })], calls));
  const r = await app.fetch(req("/api/chain/wallet?x=1", { headers: { authorization: "Bearer k", cookie: "secret=1" } }), { BACKEND_URL: "https://b.example" });
  assert.equal(r.status, 401); assert.deepEqual(await r.json(), { detail: "no" });
  assert.equal(calls[0].url, "https://b.example/api/chain/wallet?x=1"); assert.equal(calls[0].headers.get("authorization"), "Bearer k"); assert.equal(calls[0].headers.get("cookie"), null);
  assert.equal(await (await app.fetch(req("/api/other"), { BACKEND_URL: "https://b.example" })).text(), "base");
});

test("a GET is retried once after a 503 or network error; a POST never is", async () => {
  const calls: Request[] = [];
  let r = await forward(req("/api/chain/txs"), "https://b.example", mkFetch([new Response("x", { status: 503 }), OK()], calls)); assert.equal(r.status, 200); assert.equal(calls.length, 2);
  calls.length = 0; r = await forward(req("/api/chain/txs"), "https://b.example", mkFetch([new Error("down"), new Error("down")], calls)); assert.equal(r.status, 502); assert.equal(calls.length, 2);
  calls.length = 0; r = await forward(req("/api/chain/send", { method: "POST", body: "{}" }), "https://b.example", mkFetch([new Error("down"), OK()], calls)); assert.equal(r.status, 502); assert.equal(calls.length, 1, "no retry of a send");
});

test("a slow backend yields 504", async () => {
  const slow = ((_u: any, init: any) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("a"), { name: "AbortError" }))))) as typeof fetch;
  const t = setTimeout(() => {}, 0); clearTimeout(t);
  const orig = globalThis.setTimeout; (globalThis as any).setTimeout = (f: any) => orig(f, 1);
  try { const r = await forward(req("/api/chain/status", { method: "POST", body: "{}" }), "https://b.example", slow); assert.equal(r.status, 504); } finally { (globalThis as any).setTimeout = orig; }
});

test("the static network list is cached for a minute per credential", async () => {
  resetBackendCache(); const calls: Request[] = [], f = mkFetch([OK(), OK()], calls);
  await forward(req("/api/chain/networks", { headers: { "x-api-key": "a" } }), "https://b.example", f, 1000);
  const hit = await forward(req("/api/chain/networks", { headers: { "x-api-key": "a" } }), "https://b.example", f, 2000); assert.equal(hit.headers.get("x-eti-cache"), "hit"); assert.equal(calls.length, 1);
  await forward(req("/api/chain/networks", { headers: { "x-api-key": "b" } }), "https://b.example", f, 2000); assert.equal(calls.length, 2, "another key is not served from the first key's cache");
  await forward(req("/api/chain/networks", { headers: { "x-api-key": "a" } }), "https://b.example", f, 70_000); assert.equal(calls.length, 3, "expired");
});

test("connection check reports configured, reachable and latency without secrets", async () => {
  assert.equal((await backendStatus({}, mkFetch([]))).configured, false);
  const ok: any = await backendStatus({ BACKEND_URL: "https://b.example" }, mkFetch([new Response(JSON.stringify({ status: "ok" }), { status: 200 })]));
  assert.equal(ok.connected, true); assert.equal(ok.backend, "https://b.example"); assert.equal(typeof ok.latencyMs, "number");
  const down: any = await backendStatus({ BACKEND_URL: "https://b.example" }, mkFetch([new Error("x")])); assert.equal(down.connected, false); assert.equal(down.error, "backend_unreachable");
  const bad: any = await backendStatus({ BACKEND_URL: "https://b.example" }, mkFetch([new Response("{}", { status: 500 })])); assert.equal(bad.error, "backend_unhealthy");
  const route = await withChainBackend(base, mkFetch([OK()])).fetch(req("/api/chain-view/backend"), { BACKEND_URL: "https://b.example" }); assert.equal(route.status, 200);
});
