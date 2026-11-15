import test from "node:test";
import assert from "node:assert/strict";
import { networkStatus, withChainView } from "./routes.ts";
import { fmtUnits, hexToBigInt, rpc } from "./rpc.ts";
import { CHAIN_NETS, netByKey, rpcUrlFor } from "./networks.ts";
import { walletPage } from "./page.ts";

const SEPOLIA = netByKey("sepolia")!;
const ADDR = "0x" + "ab".repeat(20);
/** Fake JSON-RPC node: answers from a method table and records calls. */
const node = (answers: Record<string, any>, calls: string[] = []) => (async (_u: any, init: any) => {
  const b = JSON.parse(init.body); calls.push(b.method);
  const a = answers[b.method];
  if (a instanceof Error) throw a;
  return new Response(JSON.stringify(a && a.error ? { jsonrpc: "2.0", id: 1, error: a.error } : { jsonrpc: "2.0", id: 1, result: a }), { status: 200 });
}) as unknown as typeof fetch;

test("fmtUnits is exact (no floating point) and trims zeros", () => {
  assert.equal(fmtUnits(0n), "0"); assert.equal(fmtUnits(10n ** 18n), "1"); assert.equal(fmtUnits(1n), "0.000000000000000001");
  assert.equal(fmtUnits(123456789012345678901n), "123.456789012345678901"); assert.equal(fmtUnits(-(15n * 10n ** 17n)), "-1.5");
});
test("hexToBigInt rejects non-hex node output", () => { assert.equal(hexToBigInt("0x10"), 16n); assert.throws(() => hexToBigInt("10")); assert.throws(() => hexToBigInt(null)); });
test("networks mirror the backend: 8 networks, unique ids, native coins", () => {
  assert.equal(CHAIN_NETS.length, 8); assert.equal(new Set(CHAIN_NETS.map(n => n.chainId)).size, 8);
  assert.deepEqual(CHAIN_NETS.filter(n => n.native === "BNB").map(n => n.key).sort(), ["bsc", "bsc-testnet"]);
  assert.equal(CHAIN_NETS.filter(n => !n.mainnet).length, 4);
});
test("rpcUrlFor: env override wins, credentials and non-http schemes are rejected, unset networks stay unconfigured", () => {
  assert.equal(rpcUrlFor(SEPOLIA, {}), "https://ethereum-sepolia-rpc.publicnode.com/");
  assert.equal(rpcUrlFor(SEPOLIA, { CHAIN_RPC_SEPOLIA: "https://rpc.example/key" }), "https://rpc.example/key");
  assert.equal(rpcUrlFor(SEPOLIA, { CHAIN_RPC_SEPOLIA: "https://u:p@rpc.example" }), undefined);
  assert.equal(rpcUrlFor(SEPOLIA, { CHAIN_RPC_SEPOLIA: "file:///etc/passwd" }), undefined);
  assert.equal(rpcUrlFor(netByKey("base")!, {}), undefined);
  assert.equal(rpcUrlFor(netByKey("base-sepolia")!, { CHAIN_RPC_BASE_SEPOLIA: "https://b.example" }), "https://b.example/");
});
test("networkStatus: connected node returns block, gas and the exact native balance", async () => {
  const calls: string[] = [];
  const s = await networkStatus(SEPOLIA, {}, ADDR, node({ eth_chainId: "0xaa36a7", eth_blockNumber: "0x10", eth_gasPrice: "0x77359400", eth_getBalance: "0xde0b6b3a7640000" }, calls));
  assert.equal(s.connected, true); assert.equal(s.block, 16); assert.equal(s.gasPriceGwei, 2); assert.equal(s.balance, "1"); assert.equal(s.native, "ETH"); assert.equal(s.address, ADDR);
  assert.ok(calls.includes("eth_getBalance"));
});
test("networkStatus: no address means no balance call; a wrong chain id is refused", async () => {
  const calls: string[] = [];
  const ok = await networkStatus(SEPOLIA, {}, undefined, node({ eth_chainId: "0xaa36a7", eth_blockNumber: "0x1", eth_gasPrice: "0x1" }, calls));
  assert.equal(ok.balance, undefined); assert.ok(!calls.includes("eth_getBalance"));
  const bad = await networkStatus(SEPOLIA, {}, ADDR, node({ eth_chainId: "0x1", eth_blockNumber: "0x1", eth_gasPrice: "0x1", eth_getBalance: "0x5" }));
  assert.equal(bad.connected, false); assert.equal(bad.balance, undefined); assert.match(bad.error!, /wrong network/);
});
test("networkStatus: node failures are reported without leaking the RPC URL", async () => {
  const s = await networkStatus(SEPOLIA, { CHAIN_RPC_SEPOLIA: "https://rpc.example/SECRETKEY" }, ADDR, node({ eth_chainId: new Error("boom https://rpc.example/SECRETKEY") }));
  assert.equal(s.connected, false); assert.ok(!JSON.stringify(s).includes("SECRETKEY")); assert.match(s.error!, /transport/);
  const e = await networkStatus(SEPOLIA, {}, ADDR, node({ eth_chainId: { error: { message: "rate limited" } } }));
  assert.match(e.error!, /rate limited/);
  const u = await networkStatus(netByKey("polygon")!, {}, ADDR);
  assert.equal(u.configured, false); assert.match(u.note!, /CHAIN_RPC_POLYGON/); assert.equal(u.balance, undefined);
});
test("rpc times out instead of hanging", async () => {
  const hang = (async (_u: any, init: any) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" }))))) as unknown as typeof fetch;
  await assert.rejects(rpc("https://x.example", "eth_chainId", [], 20, hang), /timeout/);
});
test("routes: dashboard page, networks list and input validation", async () => {
  const app = withChainView({ fetch: () => new Response("base", { status: 404 }) });
  const page = await app.fetch(new Request("https://x.test/wallet/chain"), {});
  assert.equal(page.status, 200); const html = await page.text();
  assert.match(html, /On-chain wallet|ETI.*Wallet/); assert.doesNotMatch(html, /<script[^>]+src=/); assert.doesNotMatch(html, /innerHTML/);
  assert.match(html, /\/api\/chain-view\/native/); assert.match(html, /\/api\/chain\/status/);
  assert.equal(walletPage().includes("eti-motion"), true);
  const nets = await (await app.fetch(new Request("https://x.test/api/chain-view/networks"), {})).json() as any;
  assert.equal(nets.networks.length, 8); assert.equal(nets.networks.find((n: any) => n.key === "sepolia").configured, true); assert.equal(nets.networks.find((n: any) => n.key === "ethereum").configured, false);
  assert.equal((await app.fetch(new Request("https://x.test/api/chain-view/native?network=sepolia&address=0x123"), {})).status, 422);
  assert.equal((await app.fetch(new Request("https://x.test/api/chain-view/native?network=nope"), {})).status, 422);
  assert.equal((await app.fetch(new Request("https://x.test/api/chain/status"), {})).status, 404); // delegated (backend proxy) untouched
  assert.equal((await app.fetch(new Request("https://x.test/api/chain-view/native", { method: "POST" }), {})).status, 404);
});
test("the full application serves the page with a nonce CSP and the paper wallet links to it", async () => {
  const { default: app } = await import("../main.ts");
  const r = await app.fetch(new Request("https://x.test/wallet/chain"), {} as any), csp = r.headers.get("content-security-policy") || "";
  assert.equal(r.status, 200); assert.match(csp, /script-src 'self' 'nonce-/); assert.match(await r.text(), /<script nonce=/);
  const w = await (await app.fetch(new Request("https://x.test/wallet"), {} as any)).text();
  assert.match(w, /href="\/wallet\/chain"/);
});
