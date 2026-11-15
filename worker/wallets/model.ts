/**
 * Corporate wallet model: five purpose-separated wallets, per-purpose policy floors, amount arithmetic in integers, address checks, canonical
 * action digests. Nothing here holds a secret: wallets are identified by purpose and (public) addresses, keys live in the custodian (HSM, MPC,
 * cloud KMS or exchange), and approvals come from the signers' own hardware authenticators.
 */
import { sha256Hex } from "./bytes.ts";

export const PURPOSES = ["trading", "treasury", "opex", "emergency", "long_term"] as const;
export type Purpose = typeof PURPOSES[number];
export const PURPOSE_LABEL: Record<Purpose, string> = { trading: "Trading", treasury: "Corporate treasury", opex: "Operational expenses", emergency: "Emergency reserves", long_term: "Long-term investments" };
export const isPurpose = (v: unknown): v is Purpose => typeof v === "string" && (PURPOSES as readonly string[]).includes(v);

export const ROLE_RANK: Record<string, number> = { viewer: 0, analyst: 1, paper_trader: 2, trader: 3, admin: 4 };
export type Custody = { kind: "ledger" } | { kind: "external_signer"; ref: string; chains: string[] } | { kind: "binance"; ref: string; chains: string[] };
export interface TierRule { upTo: string | null; approvals: number }
export interface AssetPolicy { decimals: number; perTx: string; daily: string; tiers: TierRule[] }
export interface Policy {
  requestRole: "trader" | "admin"; timelockSec: number; addressCooldownSec: number; actionTtlSec: number;
  inboundFrom: Purpose[] | "any"; assets: Record<string, AssetPolicy>;
}
export interface DepositAddress { chain: string; address: string; label: string }
export interface Wallet { id: Purpose; label: string; custody: Custody; policy: Policy; depositAddresses: DepositAddress[] }

/** Lowest security each purpose may be configured to. Raising is always allowed; lowering below the floor is rejected everywhere. */
export const FLOORS: Record<Purpose, { minApprovals: number; minTimelockSec: number; minCooldownSec: number }> = {
  trading: { minApprovals: 1, minTimelockSec: 0, minCooldownSec: 3600 },
  opex: { minApprovals: 1, minTimelockSec: 0, minCooldownSec: 3600 },
  treasury: { minApprovals: 2, minTimelockSec: 3600, minCooldownSec: 86_400 },
  emergency: { minApprovals: 2, minTimelockSec: 86_400, minCooldownSec: 86_400 },
  long_term: { minApprovals: 2, minTimelockSec: 86_400, minCooldownSec: 86_400 },
};
const usdt = (perTx: string, daily: string, tiers: TierRule[]): Record<string, AssetPolicy> => ({ USDT: { decimals: 8, perTx, daily, tiers } });
export function defaultPolicy(p: Purpose): Policy {
  const f = FLOORS[p], base = { timelockSec: f.minTimelockSec, addressCooldownSec: f.minCooldownSec, actionTtlSec: 3 * 86_400 };
  switch (p) {
    case "trading": return { requestRole: "trader", ...base, inboundFrom: ["treasury"], assets: usdt("5000", "20000", [{ upTo: "1000", approvals: 1 }, { upTo: null, approvals: 2 }]) };
    case "opex": return { requestRole: "trader", ...base, inboundFrom: ["treasury"], assets: usdt("2000", "5000", [{ upTo: "500", approvals: 1 }, { upTo: null, approvals: 2 }]) };
    case "treasury": return { requestRole: "admin", ...base, inboundFrom: "any", assets: usdt("25000", "50000", [{ upTo: null, approvals: 2 }]) };
    case "emergency": return { requestRole: "admin", ...base, inboundFrom: ["treasury"], assets: usdt("100000", "100000", [{ upTo: null, approvals: 2 }]) };
    case "long_term": return { requestRole: "admin", ...base, inboundFrom: ["treasury"], assets: usdt("50000", "50000", [{ upTo: null, approvals: 2 }]) };
  }
}
export const defaultWallet = (p: Purpose): Wallet => ({ id: p, label: PURPOSE_LABEL[p], custody: { kind: "ledger" }, policy: defaultPolicy(p), depositAddresses: [] });

// ---- amounts ----
export function parseAmount(s: unknown, decimals: number): bigint | null {
  if (typeof s !== "string" || !/^\d{1,18}(\.\d{1,18})?$/.test(s)) return null;
  const [i, f = ""] = s.split("."); if (f.length > decimals) return null;
  const v = BigInt(i + f.padEnd(decimals, "0")); return v > 0n ? v : null;
}
export function fmtAmount(units: bigint, decimals: number): string {
  const neg = units < 0n, u = (neg ? -units : units).toString().padStart(decimals + 1, "0"), i = u.slice(0, u.length - decimals), f = decimals ? u.slice(-decimals).replace(/0+$/, "") : "";
  return (neg ? "-" : "") + i + (f ? "." + f : "");
}
export const normAmount = (s: string, decimals: number) => { const u = parseAmount(s, decimals); return u === null ? null : fmtAmount(u, decimals); };

// ---- policy validation ----
export function validatePolicy(purpose: Purpose, p: unknown): { ok: true; policy: Policy } | { ok: false; errors: string[] } {
  const e: string[] = [], f = FLOORS[purpose], x = p as any;
  if (!x || typeof x !== "object") return { ok: false, errors: ["policy must be an object"] };
  if (x.requestRole !== "trader" && x.requestRole !== "admin") e.push("requestRole must be trader or admin");
  if (purpose !== "trading" && purpose !== "opex" && x.requestRole !== "admin") e.push("this wallet may only be requested by an admin");
  const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
  if (!int(x.timelockSec, f.minTimelockSec, 90 * 86_400)) e.push(`timelockSec must be at least ${f.minTimelockSec}`);
  if (!int(x.addressCooldownSec, f.minCooldownSec, 90 * 86_400)) e.push(`addressCooldownSec must be at least ${f.minCooldownSec}`);
  if (!int(x.actionTtlSec, 3600, 30 * 86_400)) e.push("actionTtlSec must be between 3600 and 2592000");
  if (x.inboundFrom !== "any" && !(Array.isArray(x.inboundFrom) && x.inboundFrom.every(isPurpose))) e.push("inboundFrom must be 'any' or a list of wallet purposes");
  if (!x.assets || typeof x.assets !== "object" || Array.isArray(x.assets)) e.push("assets must be an object");
  else for (const [sym, a] of Object.entries<any>(x.assets)) {
    if (!/^[A-Z0-9]{2,12}$/.test(sym)) { e.push(`bad asset symbol ${sym}`); continue; }
    if (!int(a?.decimals, 0, 18)) { e.push(`${sym}: decimals must be 0..18`); continue; }
    const per = parseAmount(a.perTx, a.decimals), day = parseAmount(a.daily, a.decimals);
    if (per === null) e.push(`${sym}: perTx must be a positive decimal`); if (day === null) e.push(`${sym}: daily must be a positive decimal`);
    if (per !== null && day !== null && per > day) e.push(`${sym}: perTx cannot exceed daily`);
    if (!Array.isArray(a.tiers) || !a.tiers.length || a.tiers.length > 5) { e.push(`${sym}: 1 to 5 approval tiers required`); continue; }
    let prev = 0n;
    a.tiers.forEach((t: any, i: number) => {
      if (!int(t?.approvals, f.minApprovals, 8)) e.push(`${sym}: tier ${i + 1} needs at least ${f.minApprovals} approvals`);
      if (i < a.tiers.length - 1) { const u = parseAmount(t.upTo, a.decimals); if (u === null || u <= prev) e.push(`${sym}: tier ${i + 1} upTo must increase`); else prev = u; if (i > 0 && a.tiers[i - 1].approvals > t.approvals) e.push(`${sym}: approvals must not decrease with size`); }
      else { if (t.upTo !== null) e.push(`${sym}: last tier must have upTo null`); if (i > 0 && a.tiers[i - 1].approvals > t.approvals) e.push(`${sym}: approvals must not decrease with size`); }
    });
  }
  if (e.length) return { ok: false, errors: e };
  const assets: Record<string, AssetPolicy> = {};
  for (const [sym, a] of Object.entries<any>(x.assets)) assets[sym] = { decimals: a.decimals, perTx: normAmount(a.perTx, a.decimals)!, daily: normAmount(a.daily, a.decimals)!, tiers: a.tiers.map((t: any, i: number) => ({ upTo: i === a.tiers.length - 1 ? null : normAmount(t.upTo, a.decimals), approvals: t.approvals })) };
  return { ok: true, policy: { requestRole: x.requestRole, timelockSec: x.timelockSec, addressCooldownSec: x.addressCooldownSec, actionTtlSec: x.actionTtlSec, inboundFrom: x.inboundFrom === "any" ? "any" : [...new Set<Purpose>(x.inboundFrom)], assets } };
}
export function approvalsFor(policy: Policy, asset: string, units: bigint): number | null {
  const a = policy.assets[asset]; if (!a) return null;
  for (const t of a.tiers) if (t.upTo === null || units <= (parseAmount(t.upTo, a.decimals) as bigint)) return t.approvals;
  return a.tiers[a.tiers.length - 1].approvals;
}

// ---- custody ----
export const CHAINS = { ethereum: "evm", bsc: "evm", polygon: "evm", arbitrum: "evm", tron: "tron", bitcoin: "btc", solana: "sol" } as const;
export type Chain = keyof typeof CHAINS;
export const isChain = (v: unknown): v is Chain => typeof v === "string" && v in CHAINS;
const ADDR: Record<string, RegExp> = { evm: /^0x[0-9a-fA-F]{40}$/, tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/, btc: /^(bc1[02-9ac-hj-np-z]{11,87}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/, sol: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/ };
/** Format check only (no EIP-55 / base58 checksum verification): the custodian re-validates, and the whitelist cooldown plus quorum is the real control. */
export const addressOk = (chain: string, address: unknown) => isChain(chain) && typeof address === "string" && ADDR[CHAINS[chain]].test(address);
export function validateCustody(c: any): Custody | null {
  if (!c || typeof c !== "object") return null;
  if (c.kind === "ledger") return { kind: "ledger" };
  if ((c.kind === "external_signer" || c.kind === "binance") && typeof c.ref === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(c.ref) && Array.isArray(c.chains) && c.chains.length && c.chains.every(isChain)) return { kind: c.kind, ref: c.ref, chains: [...new Set<string>(c.chains)] } as Custody;
  return null;
}

// ---- canonical digest ----
export function canon(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
  return "{" + Object.keys(v as object).filter((k) => (v as any)[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canon((v as any)[k])).join(",") + "}";
}
export interface ActionCore { v: 1; id: string; kind: string; walletId: string | null; payload: any; requestedBy: string; createdAt: number; expiresAt: number; threshold: number; timelockSec: number }
export const digestOf = (core: ActionCore) => sha256Hex(canon(core));
export const newActionId = () => "act_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
