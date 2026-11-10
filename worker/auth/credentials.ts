/**
 * Exchange credential discovery and validation. Credentials are only ever READ from Worker secrets. They are never
 * generated, defaulted, substituted, echoed or logged; this module reports a status word and nothing more.
 */
import type { KV } from "./session.ts";
export type Broker = "alpaca" | "binance";
export type CredStatus = "missing" | "valid" | "invalid" | "unreachable";
export interface CredEnv { ALPACA_API_KEY?: string; ALPACA_SECRET_KEY?: string; BINANCE_API_KEY?: string; BINANCE_SECRET_KEY?: string; ETI_EXECUTION_LOG?: KV | any }
export interface CredReport { broker: Broker; environment: "alpaca_paper" | "binance_testnet"; status: CredStatus; checkedAt: number | null; cached: boolean }
const TTL_MS = 10 * 60_000;
export const configured = (env: CredEnv, b: Broker) => b === "alpaca" ? !!(env.ALPACA_API_KEY && env.ALPACA_SECRET_KEY) : !!(env.BINANCE_API_KEY && env.BINANCE_SECRET_KEY);
const label = (b: Broker) => b === "alpaca" ? "alpaca_paper" : "binance_testnet" as const;
async function hex(secret: string, q: string) { const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(q)))].map(x => x.toString(16).padStart(2, "0")).join(""); }
/** Calls a harmless authenticated read endpoint of the paper/testnet service. 401/403 (or Binance -2014/-2015) means the credentials are wrong. */
export async function probe(env: CredEnv, b: Broker, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<CredStatus> {
  if (!configured(env, b)) return "missing";
  try {
    if (b === "alpaca") {
      const r = await fetchImpl("https://paper-api.alpaca.markets/v2/account", { headers: { "APCA-API-KEY-ID": env.ALPACA_API_KEY!, "APCA-API-SECRET-KEY": env.ALPACA_SECRET_KEY! }, signal: AbortSignal.timeout(6000) });
      return r.ok ? "valid" : r.status === 401 || r.status === 403 ? "invalid" : "unreachable";
    }
    const q = new URLSearchParams({ timestamp: String(now), recvWindow: "5000" }); q.set("signature", await hex(env.BINANCE_SECRET_KEY!, q.toString()));
    const r = await fetchImpl("https://testnet.binance.vision/api/v3/account?" + q, { headers: { "X-MBX-APIKEY": env.BINANCE_API_KEY! }, signal: AbortSignal.timeout(6000) });
    if (r.ok) return "valid";
    const body: any = await r.json().catch(() => ({}));
    return r.status === 401 || [-2014, -2015, -1022].includes(Number(body?.code)) ? "invalid" : "unreachable";
  } catch { return "unreachable"; }
}
const key = (b: Broker) => "auth:cred:" + b;
export async function credentialReport(env: CredEnv, b: Broker, opts: { validate?: boolean; fetchImpl?: typeof fetch; now?: number } = {}): Promise<CredReport> {
  const now = opts.now ?? Date.now(), kv = env.ETI_EXECUTION_LOG as KV | undefined;
  if (!configured(env, b)) return { broker: b, environment: label(b), status: "missing", checkedAt: null, cached: false };
  let cached: { status: CredStatus; checkedAt: number } | null = null;
  try { cached = JSON.parse((await kv?.get(key(b))) || "null"); } catch { cached = null; }
  if (cached && now - cached.checkedAt < TTL_MS && cached.status !== "unreachable") return { broker: b, environment: label(b), status: cached.status, checkedAt: cached.checkedAt, cached: true };
  if (!opts.validate) return { broker: b, environment: label(b), status: cached?.status ?? "unreachable", checkedAt: cached?.checkedAt ?? null, cached: !!cached };
  const status = await probe(env, b, opts.fetchImpl, now);
  try { await kv?.put(key(b), JSON.stringify({ status, checkedAt: now }), { expirationTtl: 3600 }); } catch { /* cache is best effort */ }
  return { broker: b, environment: label(b), status, checkedAt: now, cached: false };
}
/** Record a rejection seen on a real order so the next requests fall back without another probe. */
export async function markInvalid(env: CredEnv, b: Broker, now = Date.now()) { try { await (env.ETI_EXECUTION_LOG as KV)?.put(key(b), JSON.stringify({ status: "invalid", checkedAt: now }), { expirationTtl: 3600 }); } catch { /* best effort */ } }
export const usable = (s: CredStatus) => s === "valid" || s === "unreachable";
