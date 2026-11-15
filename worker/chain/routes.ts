/**
 * Wallet dashboard (/wallet) and its read-only chain API (/api/chain-view/*). Everything is fetched live from the node over JSON-RPC;
 * the chain id the node reports must match the network, otherwise the result is refused (a mis-pointed RPC is never shown as real).
 * No keys, no signing and no transactions here. The custodial wallet itself lives in the Python backend (/api/chain, proxied via BACKEND_URL).
 */
import { CHAIN_NETS, netByKey, rpcUrlFor, type ChainNet } from "./networks.ts";
import { rpc, hexToBigInt, fmtUnits, RpcError } from "./rpc.ts";
import { walletPage } from "./page.ts";

interface App<E> { fetch(request: Request, env: E, ctx?: any): Promise<Response> | Response }
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
const ADDR = /^0x[0-9a-fA-F]{40}$/;

export interface ChainStatus { network: string; label: string; chainId: number; native: string; mainnet: boolean; explorer: string; configured: boolean; connected: boolean;
  block?: number; gasPriceGwei?: number; balance?: string; balanceWei?: string; address?: string; error?: string; note?: string; checkedAt: string }

export async function networkStatus(net: ChainNet, env: Record<string, any>, address?: string, fetcher: typeof fetch = fetch): Promise<ChainStatus> {
  const out: ChainStatus = { network: net.key, label: net.label, chainId: net.chainId, native: net.native, mainnet: net.mainnet, explorer: net.explorer,
    configured: false, connected: false, checkedAt: new Date().toISOString() };
  const url = rpcUrlFor(net, env);
  if (!url) { out.note = "Set CHAIN_RPC_" + net.key.toUpperCase().replace(/-/g, "_") + " to connect this network."; return out; }
  out.configured = true;
  try {
    const reported = Number(hexToBigInt(await rpc(url, "eth_chainId", [], 8000, fetcher)));
    if (reported !== net.chainId) { out.error = "Node reports chain id " + reported + ", expected " + net.chainId + ": refusing to show data from the wrong network."; return out; }
    const [block, gas] = await Promise.all([rpc(url, "eth_blockNumber", [], 8000, fetcher), rpc(url, "eth_gasPrice", [], 8000, fetcher)]);
    out.connected = true; out.block = Number(hexToBigInt(block)); out.gasPriceGwei = Number(hexToBigInt(gas)) / 1e9;
    if (address) {
      const wei = hexToBigInt(await rpc(url, "eth_getBalance", [address, "latest"], 8000, fetcher));
      out.address = address; out.balanceWei = wei.toString(); out.balance = fmtUnits(wei);
    }
  } catch (e) { out.connected = false; out.error = e instanceof RpcError ? e.message : "chain query failed"; }
  return out;
}

export function withChainView<E extends Record<string, any>>(base: App<E>): App<E> {
  return { async fetch(request, env, ctx) {
    const u = new URL(request.url), path = u.pathname.replace(/\/+$/, "");
    if (request.method === "GET" && path === "/wallet/chain")
      return new Response(walletPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" } });
    if (path === "/api/chain-view/networks" && request.method === "GET") {
      const e = (env || {}) as Record<string, any>;
      return json({ networks: CHAIN_NETS.map(n => ({ key: n.key, label: n.label, chainId: n.chainId, native: n.native, mainnet: n.mainnet, explorer: n.explorer, configured: !!rpcUrlFor(n, e) })), readOnly: true });
    }
    if (path === "/api/chain-view/native" && request.method === "GET") {
      const e = (env || {}) as Record<string, any>, key = u.searchParams.get("network") || "", address = u.searchParams.get("address") || undefined;
      if (address && !ADDR.test(address)) return json({ error: "invalid_address", message: "Address must be 0x followed by 40 hex characters." }, 422);
      if (key === "all") return json({ statuses: await Promise.all(CHAIN_NETS.map(n => networkStatus(n, e, address))) });
      const net = netByKey(key);
      if (!net) return json({ error: "unknown_network", message: "Supported: " + CHAIN_NETS.map(n => n.key).join(", ") }, 422);
      return json(await networkStatus(net, e, address));
    }
    return base.fetch(request, env, ctx);
  } };
}
