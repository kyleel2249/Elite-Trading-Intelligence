/**
 * Custody adapters. ETI never holds wallet private keys: external transfers are delegated to a custodian that does (an HSM / MPC / cloud-KMS
 * signing gateway, or an exchange withdrawal API). Execution is OFF unless ETI_WALLET_EXECUTION=enabled, so a fresh deployment can create, approve
 * and review everything without any ability to move funds.
 *
 * Signing gateway contract (POST {ETI_SIGNER_URL}/v1/transfers), authenticated with x-eti-timestamp and x-eti-signature = hex HMAC-SHA256(secret, timestamp + "." + body):
 *   request:  { idempotencyKey, walletRef, chain, asset, amount, decimals, units, destination: { address }, digest, canonical, approvals: [...] }
 *   response: { status: "submitted", txId } | { status: "rejected", reason }
 * The gateway SHOULD independently verify the approvals (they are WebAuthn assertions over `digest`) before signing; it must treat idempotencyKey as unique.
 * Outcomes: submitted; rejected (definite, nothing sent); unknown (timeout / 5xx / unreadable reply: the transfer may exist, so it is never retried automatically).
 */
import { toHex, te } from "./bytes.ts";
import type { Custody } from "./model.ts";

export interface TransferIntent { actionId: string; walletId: string; custody: Custody; chain: string; asset: string; amount: string; decimals: number; units: string; address: string; digest: string; canonical: string; approvals: unknown[] }
export type Outcome = { outcome: "submitted"; ref: string } | { outcome: "rejected"; error: string } | { outcome: "unknown"; error: string };
export interface CustodyEnv { ETI_WALLET_EXECUTION?: string; ETI_SIGNER_URL?: string; ETI_SIGNER_SECRET?: string; BINANCE_WITHDRAW_API_KEY?: string; BINANCE_WITHDRAW_SECRET_KEY?: string }
export const executionEnabled = (env: CustodyEnv) => env.ETI_WALLET_EXECUTION === "enabled";

async function hmacHex(secret: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", k, te.encode(msg))));
}
const NETWORK: Record<string, string> = { ethereum: "ETH", bsc: "BSC", tron: "TRX", bitcoin: "BTC", solana: "SOL", polygon: "MATIC", arbitrum: "ARBITRUM" };

export async function sendExternal(env: CustodyEnv, i: TransferIntent, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<Outcome> {
  if (i.custody.kind === "external_signer") {
    if (!env.ETI_SIGNER_URL || !env.ETI_SIGNER_SECRET || !/^https:\/\//.test(env.ETI_SIGNER_URL)) return { outcome: "rejected", error: "signer_gateway_not_configured" };
    const body = JSON.stringify({ idempotencyKey: i.actionId, walletRef: i.custody.ref, chain: i.chain, asset: i.asset, amount: i.amount, decimals: i.decimals, units: i.units, destination: { address: i.address }, digest: i.digest, canonical: i.canonical, approvals: i.approvals }), ts = String(now);
    try {
      const r = await fetchImpl(env.ETI_SIGNER_URL.replace(/\/+$/, "") + "/v1/transfers", { method: "POST", signal: AbortSignal.timeout(20_000), headers: { "content-type": "application/json", "x-eti-timestamp": ts, "x-eti-signature": await hmacHex(env.ETI_SIGNER_SECRET, ts + "." + body) }, body });
      const d: any = await r.json().catch(() => null);
      if (r.status >= 500 || !d) return { outcome: "unknown", error: `gateway_http_${r.status}` };
      if (r.ok && d.status === "submitted" && typeof d.txId === "string" && d.txId) return { outcome: "submitted", ref: d.txId.slice(0, 200) };
      if (r.status >= 400 && r.status < 500 || d.status === "rejected") return { outcome: "rejected", error: String(d.reason ?? d.error ?? "rejected").slice(0, 200) };
      return { outcome: "unknown", error: "gateway_reply_not_understood" };
    } catch (e) { return { outcome: "unknown", error: "gateway_unreachable:" + (e as Error).name }; }
  }
  if (i.custody.kind === "binance") {
    if (!env.BINANCE_WITHDRAW_API_KEY || !env.BINANCE_WITHDRAW_SECRET_KEY) return { outcome: "rejected", error: "binance_withdraw_keys_not_configured" };
    const network = NETWORK[i.chain]; if (!network) return { outcome: "rejected", error: "unsupported_chain" };
    const q = new URLSearchParams({ coin: i.asset, network, address: i.address, amount: i.amount, withdrawOrderId: i.actionId.slice(0, 60), timestamp: String(now), recvWindow: "5000" });
    q.set("signature", await hmacHex(env.BINANCE_WITHDRAW_SECRET_KEY, q.toString()));
    try {
      const r = await fetchImpl("https://api.binance.com/sapi/v1/capital/withdraw/apply", { method: "POST", signal: AbortSignal.timeout(20_000), headers: { "X-MBX-APIKEY": env.BINANCE_WITHDRAW_API_KEY, "content-type": "application/x-www-form-urlencoded" }, body: q.toString() });
      const d: any = await r.json().catch(() => null);
      if (r.ok && d && typeof d.id === "string") return { outcome: "submitted", ref: d.id };
      if (r.status >= 400 && r.status < 500 && d) return { outcome: "rejected", error: `binance_${d.code ?? r.status}: ${String(d.msg ?? "").slice(0, 150)}` };
      return { outcome: "unknown", error: `binance_http_${r.status}` };
    } catch (e) { return { outcome: "unknown", error: "binance_unreachable:" + (e as Error).name }; }
  }
  return { outcome: "rejected", error: "ledger_wallets_cannot_send_externally" };
}
