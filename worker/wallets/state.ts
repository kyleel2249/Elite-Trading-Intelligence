/** Event-sourced wallet state. Every change is an appended event; the state below is a pure fold of them, so it can be audited and rebuilt from a backup. */
import type { Jwk } from "./webauthn.ts";
import { PURPOSES, defaultWallet, parseAmount, type ActionCore, type Custody, type DepositAddress, type Policy, type Purpose, type Wallet } from "./model.ts";

export interface Credential { id: string; publicKey: Jwk; signCount: number; aaguid: string; addedAt: number }
export interface Signer { id: string; uid: string; label: string; wallets: Purpose[]; credentials: Credential[]; status: "invited" | "active" | "removed"; designatedAt: number }
export interface AddressEntry { id: string; walletId: Purpose | "*"; chain: string; address: string; label: string; addedAt: number; activeAt: number; removed: boolean }
export interface Assertion { clientDataJSON: string; authenticatorData: string; signature: string }
export interface Approval { signerId: string; uid: string; credentialId: string; assertion: Assertion; signCount: number; at: number }
export interface ActionResult { state: "executed" | "failed" | "unknown" | "retry"; ref?: string; error?: string; detail?: unknown; at: number; by?: string }
export interface Action { id: string; core: ActionCore; digest: string; approvals: Approval[]; cancelled?: { by: string; at: number; reason: string }; claims: number; claimedAt?: number; result?: ActionResult }
export interface Recovery { publicKey: Jwk; k: number; n: number; setId: string; at: number }
export interface WalletState {
  initialised: boolean; sealed: boolean; frozen: { by: string; at: number; reason: string } | null; wallets: Record<Purpose, Wallet>; signers: Record<string, Signer>;
  addresses: Record<string, AddressEntry>; actions: Record<string, Action>; balances: Record<Purpose, Record<string, bigint>>; recovery: Recovery | null; lastEventAt: number; eventCount: number;
}
export interface WEvent { id: string; at: number; t: string; [k: string]: any }
export const EXEC_WINDOW_SEC = 86_400;
export const MAX_ATTEMPTS = 3;

export function emptyState(): WalletState {
  const wallets: any = {}, balances: any = {}; for (const p of PURPOSES) { wallets[p] = defaultWallet(p); balances[p] = {}; }
  return { initialised: false, sealed: false, frozen: null, wallets, signers: {}, addresses: {}, actions: {}, balances, recovery: null, lastEventAt: 0, eventCount: 0 };
}
const credit = (S: WalletState, w: Purpose, asset: string, units: bigint) => { S.balances[w][asset] = (S.balances[w][asset] ?? 0n) + units; };

export function fold(events: WEvent[]): WalletState {
  const S = emptyState(), seen = new Set<string>();
  for (const e of events) {
    if (seen.has(e.id)) continue; seen.add(e.id); S.lastEventAt = Math.max(S.lastEventAt, e.at); S.eventCount++;
    switch (e.t) {
      case "init": S.initialised = true; for (const p of PURPOSES) if (e.wallets?.[p]) S.wallets[p] = e.wallets[p]; break;
      case "policy_set": { const w = S.wallets[e.walletId as Purpose]; if (w) { if (e.policy) w.policy = e.policy as Policy; if (e.custody) w.custody = e.custody as Custody; if (e.depositAddresses) w.depositAddresses = e.depositAddresses as DepositAddress[]; } break; }
      case "signer_designated": S.signers[e.signerId] = { id: e.signerId, uid: e.uid, label: e.label, wallets: e.wallets, credentials: [], status: "invited", designatedAt: e.at }; break;
      case "credential_added": { const s = S.signers[e.signerId]; if (s && s.status !== "removed") { s.credentials.push(e.credential); s.status = "active"; } break; }
      case "signer_removed": { const s = S.signers[e.signerId]; if (s) s.status = "removed"; break; }
      case "sealed": S.sealed = true; break;
      case "frozen": S.frozen = { by: e.by, at: e.at, reason: e.reason }; break;
      case "unfrozen": S.frozen = null; break;
      case "recovery_set": S.recovery = { publicKey: e.publicKey, k: e.k, n: e.n, setId: e.setId, at: e.at }; break;
      case "address_added": S.addresses[e.entryId] = { id: e.entryId, walletId: e.walletId, chain: e.chain, address: e.address, label: e.label, addedAt: e.at, activeAt: e.activeAt, removed: false }; break;
      case "address_removed": { const a = S.addresses[e.entryId]; if (a) a.removed = true; break; }
      case "action_created": S.actions[e.actionId] = { id: e.actionId, core: e.core, digest: e.digest, approvals: [], claims: 0 }; break;
      case "approval": { const a = S.actions[e.actionId]; if (a && !a.approvals.some((x) => x.signerId === e.signerId)) a.approvals.push({ signerId: e.signerId, uid: e.uid, credentialId: e.credentialId, assertion: e.assertion, signCount: e.signCount, at: e.at }); const c = S.signers[e.signerId]?.credentials.find((x) => x.id === e.credentialId); if (c) c.signCount = Math.max(c.signCount, e.signCount); break; }
      case "action_cancelled": { const a = S.actions[e.actionId]; if (a && !a.cancelled) a.cancelled = { by: e.by, at: e.at, reason: e.reason }; break; }
      case "action_claimed": { const a = S.actions[e.actionId]; if (a) { a.claims = Math.max(a.claims, e.attempt); a.claimedAt = e.at; } break; }
      case "action_result": {
        const a = S.actions[e.actionId]; if (!a || a.result?.state === "executed") break;
        a.result = { state: e.state, ref: e.ref, error: e.error, detail: e.detail, at: e.at, by: e.by };
        if (e.state === "executed") applyLedgerEffect(S, a);
        break;
      }
    }
  }
  return S;
}

/** Book-keeping for ledger-custody wallets: internal transfers and recorded deposits are the only things that move balances. */
function applyLedgerEffect(S: WalletState, a: Action) {
  const p = a.core.payload;
  if (a.core.kind === "record_deposit") credit(S, a.core.walletId as Purpose, p.asset, BigInt(p.units));
  else if (a.core.kind === "withdraw" && p.destination?.type === "internal") { credit(S, a.core.walletId as Purpose, p.asset, -BigInt(p.units)); credit(S, p.destination.walletId, p.asset, BigInt(p.units)); }
}

// ---- derived views ----
export const activeSigners = (S: WalletState) => Object.values(S.signers).filter((s) => s.status === "active");
export function eligibleSigners(S: WalletState, core: ActionCore): Signer[] {
  return activeSigners(S).filter((s) => s.uid !== core.requestedBy && (core.walletId === null || s.wallets.includes(core.walletId as Purpose)));
}
/** Approvals that still count: from signers that are active now, scoped to the wallet, not the requester, one per user. */
export function validApprovals(S: WalletState, a: Action): Approval[] {
  const ok = new Set(eligibleSigners(S, a.core).map((s) => s.id)), users = new Set<string>(), out: Approval[] = [];
  for (const ap of [...a.approvals].sort((x, y) => x.at - y.at)) { if (!ok.has(ap.signerId) || users.has(ap.uid)) continue; users.add(ap.uid); out.push(ap); }
  return out;
}
export type ActionStatus = "pending" | "timelocked" | "ready" | "executing" | "executed" | "failed" | "unknown" | "cancelled" | "expired";
export interface Progress { status: ActionStatus; approvals: number; threshold: number; quorumAt: number | null; executableAt: number | null; expiresAt: number }
export function progress(S: WalletState, a: Action, now: number): Progress {
  const v = validApprovals(S, a), t = a.core.threshold, quorumAt = v.length >= t ? v[t - 1].at : null, executableAt = quorumAt === null ? null : quorumAt + a.core.timelockSec * 1000;
  const base = { approvals: v.length, threshold: t, quorumAt, executableAt };
  const r = a.result;
  if (r?.state === "executed") return { ...base, status: "executed", expiresAt: a.core.expiresAt };
  if (r?.state === "unknown") return { ...base, status: "unknown", expiresAt: a.core.expiresAt };
  if (r?.state === "failed") return { ...base, status: "failed", expiresAt: a.core.expiresAt };
  if (a.cancelled) return { ...base, status: "cancelled", expiresAt: a.core.expiresAt };
  const expiresAt = executableAt === null ? a.core.expiresAt : executableAt + EXEC_WINDOW_SEC * 1000;
  if (a.claims > 0 && a.claimedAt !== undefined && (!r || r.at < a.claimedAt)) return { ...base, status: now - a.claimedAt < 120_000 ? "executing" : "unknown", expiresAt }; // a claim with no result after 2 minutes may have reached the custodian: never auto-retry
  if (executableAt === null) return { ...base, status: now > a.core.expiresAt ? "expired" : "pending", expiresAt };
  if (now > expiresAt) return { ...base, status: "expired", expiresAt };
  return { ...base, status: now < executableAt ? "timelocked" : "ready", expiresAt };
}
/** Sum of this wallet+asset withdrawals that are executed within 24h or still able to execute (so queued requests count against the daily limit). */
export function committedUnits(S: WalletState, walletId: Purpose, asset: string, now: number, exceptId?: string): bigint {
  let sum = 0n;
  for (const a of Object.values(S.actions)) {
    if (a.core.kind !== "withdraw" || a.core.walletId !== walletId || a.core.payload.asset !== asset || a.id === exceptId) continue;
    const st = progress(S, a, now).status, u = BigInt(a.core.payload.units);
    if (st === "executed") { if (now - (a.result?.at ?? 0) < 86_400_000) sum += u; } else if (["pending", "timelocked", "ready", "executing", "unknown"].includes(st)) sum += u;
  }
  return sum;
}
export const govThreshold = (S: WalletState) => Math.max(2, Math.floor(activeSigners(S).length / 2) + 1);
export const unitsOf = (asset: string, amount: string, decimals: number) => parseAmount(amount, decimals);
