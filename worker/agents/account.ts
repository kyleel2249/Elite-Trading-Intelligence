/** Account state from the Binance Spot Testnet (read-only signed GET). Fills equity/available/position so callers need not supply them. */
import type { ExecutionEnv } from "../execution.ts";
import type { AccountState } from "./types.ts";

async function hmac(secret: string, query: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(query)))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Equity counts only the USDT balance plus the traded base asset at lastPrice; other testnet assets are ignored. PnL/drawdown are not derivable and stay unknown. */
export async function loadBinanceTestnetAccount(env: ExecutionEnv, symbol: string, lastPrice: number): Promise<{ account?: AccountState; error?: string }> {
  if (!env.BINANCE_API_KEY || !env.BINANCE_SECRET_KEY) return { error: "binance_testnet_not_configured" };
  if (!symbol.endsWith("USDT")) return { error: "only_usdt_quote_supported" };
  const base = symbol.slice(0, -4);
  try {
    const q = new URLSearchParams({ timestamp: String(Date.now()), recvWindow: "5000" });
    q.set("signature", await hmac(env.BINANCE_SECRET_KEY, q.toString()));
    const res = await fetch("https://testnet.binance.vision/api/v3/account?" + q.toString(), { headers: { "X-MBX-APIKEY": env.BINANCE_API_KEY }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return { error: "account_http_" + res.status };
    const bal: { asset: string; free: string; locked: string }[] = ((await res.json()) as any).balances ?? [];
    const get = (a: string) => bal.find((b) => b.asset === a), num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const usdt = get("USDT"), b = get(base);
    const free = num(usdt?.free), baseFree = num(b?.free), baseTotal = baseFree + num(b?.locked);
    return { account: { equityUsd: free + num(usdt?.locked) + baseTotal * lastPrice, availableUsd: free, positionQuantity: baseFree } };
  } catch { return { error: "account_unreachable" }; }
}
