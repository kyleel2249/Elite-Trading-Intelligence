/** Minimal read-only JSON-RPC client. RPC URLs often embed API keys, so they never appear in errors or responses. */
export class RpcError extends Error {}
export async function rpc(url: string, method: string, params: unknown[] = [], timeoutMs = 8000, fetcher: typeof fetch = fetch, headers: Record<string, string> = {}): Promise<any> {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetcher(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctl.signal });
    if (!r.ok) throw new RpcError("RPC HTTP " + r.status);
    const j: any = await r.json().catch(() => null);
    if (!j || typeof j !== "object") throw new RpcError("RPC returned a malformed response");
    if (j.error) throw new RpcError(String(j.error.message || "rpc error").slice(0, 160));
    return j.result;
  } catch (e) {
    if (e instanceof RpcError) throw e;
    throw new RpcError(e && (e as any).name === "AbortError" ? "RPC timeout" : "RPC transport failure");
  } finally { clearTimeout(t); }
}
export const hexToBigInt = (h: unknown): bigint => { if (typeof h !== "string" || !/^0x[0-9a-fA-F]+$/.test(h)) throw new RpcError("RPC returned a non-hex quantity"); return BigInt(h); };
/** Exact decimal string for a wei amount (18 decimals), trailing zeros trimmed. No floating point. */
export function fmtUnits(v: bigint, decimals = 18): string {
  const neg = v < 0n, a = neg ? -v : v, base = 10n ** BigInt(decimals), whole = a / base, frac = (a % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + whole.toString() + (frac ? "." + frac : "");
}
