/**
 * Wallet service: every command that changes wallet state. Pure over an event store, so it is tested with an in-memory store and real WebAuthn assertions.
 * Rules (enforced here, not in the UI):
 *  - Nothing here can hold or reveal a private key. Withdrawals execute only through a custodian (custody.ts) or, for ledger wallets, as book transfers.
 *  - Before sealing, an administrator configures wallets directly. After sealing, EVERY change (signers, policy, whitelist, unfreeze, recovery key) is a multi-signature action.
 *  - Approvals are WebAuthn assertions (user-verified, hardware key) over the SHA-256 digest of the exact action; the requester can never approve their own action.
 *  - Limits, whitelist, quorum and freeze are re-checked at execution, and an execution is claimed atomically exactly once.
 */
import { b64u, fromHex } from "./bytes.ts";
import { sendExternal, executionEnabled, type CustodyEnv } from "./custody.ts";
import { FLOORS, PURPOSES, ROLE_RANK, addressOk, approvalsFor, canon, digestOf, fmtAmount, isChain, isPurpose, newActionId, parseAmount, validateCustody, validatePolicy, type ActionCore, type Purpose } from "./model.ts";
import { EXEC_WINDOW_SEC, MAX_ATTEMPTS, activeSigners, committedUnits, eligibleSigners, fold, govThreshold, progress, validApprovals, type Action, type Assertion, type WEvent, type WalletState } from "./state.ts";
import { verifyAssertion, verifyRegistration, type Expected } from "./webauthn.ts";
import { openStore, type PortfolioStore } from "../portfolio/store.ts";

export interface Actor { uid: string; role: string; mfa: boolean; master?: boolean; email?: string }
export interface Rp { rpId: string; origins: string[] }
export interface WalletEnv extends CustodyEnv { ETI_PORTFOLIO_DB?: unknown; ETI_EXECUTION_LOG?: unknown; ETI_WALLET_RP_ID?: string; ETI_WALLET_ORIGINS?: string; ETI_WALLET_ALLOW_SYNCED_PASSKEYS?: string; ETI_WALLET_AAGUIDS?: string; ETI_WALLET_GOV_TIMELOCK_SEC?: string }
export type R<T = {}> = ({ ok: true } & T) | { ok: false; status: number; error: string; message?: string };
const bad = (status: number, error: string, message?: string): R<never> => ({ ok: false, status, error, message });
export const GOVERNANCE_KINDS = ["signer_add", "signer_remove", "policy_change", "address_add", "address_remove", "unfreeze", "record_deposit", "recovery_rotate"] as const;
export const ACTION_KINDS = ["withdraw", ...GOVERNANCE_KINDS];
const MAX_OPEN_PER_WALLET = 100, MIN_SIGNERS = 3;

export function rpFor(env: WalletEnv, url: URL): Rp {
  const origins = env.ETI_WALLET_ORIGINS ? env.ETI_WALLET_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean) : [url.origin];
  return { rpId: env.ETI_WALLET_RP_ID || url.hostname, origins };
}
export const walletStore = (env: WalletEnv): PortfolioStore | null => openStore(env as any, "wallets" as any);

export class WalletService {
  S!: WalletState; env: WalletEnv; st: PortfolioStore; rp: Rp; fetchImpl: typeof fetch;
  constructor(env: WalletEnv, st: PortfolioStore, rp: Rp, fetchImpl: typeof fetch = fetch) { this.env = env; this.st = st; this.rp = rp; this.fetchImpl = fetchImpl; }
  async load(): Promise<WalletState> {
    const r = await this.st.events(); if (r.truncated) throw new Error("wallet event log is truncated: refusing to operate on partial state");
    return this.S = fold(r.events as unknown as WEvent[]);
  }
  private at(now: number) { return Math.max(now, this.S.lastEventAt + 1); }
  private async put(e: Omit<WEvent, "at"> & { at?: number }, now: number, idem = true): Promise<boolean> {
    const ev = { ...e, at: e.at ?? this.at(now) } as WEvent; const ok = await this.st.append(ev as any, { idempotent: idem });
    if (ok) await this.load(); return ok;
  }
  private rid = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  private expected(challenge: string): Expected { return { challenge, origins: this.rp.origins, rpId: this.rp.rpId }; }
  private govTimelock() { const v = Number(this.env.ETI_WALLET_GOV_TIMELOCK_SEC); return Number.isInteger(v) && v >= 0 && v <= 30 * 86_400 ? v : 86_400; }
  private needUser(a: Actor): R<never> | null { return a.master || !a.uid ? bad(403, "user_session_required", "Wallet changes need a signed-in user, not the master token.") : !a.mfa ? bad(403, "mfa_required", "Complete multi-factor sign-in first.") : null; }

  async ensureInit(now: number) { await this.load(); if (!this.S.initialised) await this.put({ id: "init", t: "init" }, now); return this.S; }

  // ---------------- setup phase (before sealing) ----------------
  async configure(a: Actor, p: { walletId: string; policy?: unknown; custody?: unknown; depositAddresses?: unknown }, now: number): Promise<R> {
    const n = this.needUser(a); if (n) return n; if (a.role !== "admin") return bad(403, "admin_required");
    await this.ensureInit(now); if (this.S.sealed) return bad(409, "sealed", "Wallets are sealed. Propose a policy_change action instead.");
    if (!isPurpose(p.walletId)) return bad(400, "unknown_wallet"); const ev: any = { id: "ps-" + this.rid(), t: "policy_set", walletId: p.walletId, by: a.uid };
    if (p.policy !== undefined) { const v = validatePolicy(p.walletId, p.policy); if (!v.ok) return bad(422, "policy_invalid", v.errors.join("; ")); ev.policy = v.policy; }
    if (p.custody !== undefined) { const c = validateCustody(p.custody); if (!c) return bad(422, "custody_invalid", "kind must be ledger, external_signer or binance (with ref and chains)"); ev.custody = c; }
    if (p.depositAddresses !== undefined) { const d = this.checkDeposits(p.depositAddresses); if (typeof d === "string") return bad(422, "deposit_addresses_invalid", d); ev.depositAddresses = d; }
    if (ev.policy === undefined && ev.custody === undefined && ev.depositAddresses === undefined) return bad(400, "nothing_to_change");
    await this.put(ev, now, false); return { ok: true };
  }
  private checkDeposits(v: unknown): string | { chain: string; address: string; label: string }[] {
    if (!Array.isArray(v) || v.length > 20) return "depositAddresses must be a list of at most 20";
    const out: { chain: string; address: string; label: string }[] = [];
    for (const d of v as any[]) { if (!isChain(d?.chain) || !addressOk(d.chain, d.address)) return "invalid deposit address for " + String(d?.chain); out.push({ chain: d.chain, address: d.address, label: String(d.label ?? "").slice(0, 60) }); }
    return out;
  }
  async designate(a: Actor, p: { uid: string; label: string; wallets: unknown }, now: number): Promise<R<{ signerId: string }>> {
    const n = this.needUser(a); if (n) return n; if (a.role !== "admin") return bad(403, "admin_required");
    await this.ensureInit(now); if (this.S.sealed) return bad(409, "sealed", "Wallets are sealed. Propose a signer_add action instead.");
    const e = this.checkSigner(p); if (typeof e === "string") return bad(422, "signer_invalid", e);
    const signerId = "sg_" + this.rid(); await this.put({ id: "sd-" + signerId, t: "signer_designated", signerId, uid: e.uid, label: e.label, wallets: e.wallets }, now, false); return { ok: true, signerId };
  }
  private checkSigner(p: { uid: string; label: string; wallets: unknown }): string | { uid: string; label: string; wallets: Purpose[] } {
    if (typeof p.uid !== "string" || !/^[A-Za-z0-9_.:-]{3,80}$/.test(p.uid)) return "uid is required";
    if (this.S.signers && Object.values(this.S.signers).some((s) => s.uid === p.uid && s.status !== "removed")) return "that user is already a signer";
    if (!Array.isArray(p.wallets) || !p.wallets.length || !p.wallets.every(isPurpose)) return "wallets must be a non-empty list of wallet purposes";
    const label = String(p.label ?? "").trim().slice(0, 60); if (!label) return "label is required";
    return { uid: p.uid, label, wallets: [...new Set<Purpose>(p.wallets)] };
  }
  async setRecovery(a: Actor, r: { publicKey: any; k: number; n: number; setId: string }, now: number): Promise<R> {
    const n = this.needUser(a); if (n) return n; if (a.role !== "admin") return bad(403, "admin_required");
    await this.ensureInit(now); if (this.S.sealed) return bad(409, "sealed", "Use a recovery_rotate action.");
    const c = this.checkRecovery(r); if (c) return bad(422, "recovery_invalid", c);
    await this.put({ id: "rc-" + this.rid(), t: "recovery_set", publicKey: r.publicKey, k: r.k, n: r.n, setId: r.setId }, now, false); return { ok: true };
  }
  private checkRecovery(r: any): string | null {
    if (!r || r.publicKey?.kty !== "EC" || r.publicKey?.crv !== "P-256" || typeof r.publicKey.x !== "string" || typeof r.publicKey.y !== "string" || "d" in r.publicKey) return "publicKey must be a public P-256 JWK";
    if (!Number.isInteger(r.k) || !Number.isInteger(r.n) || r.k < 2 || r.n < r.k || r.n > 16) return "k and n must satisfy 2 <= k <= n <= 16";
    if (typeof r.setId !== "string" || !/^[a-f0-9]{8,32}$/.test(r.setId)) return "bad setId"; return null;
  }
  async seal(a: Actor, now: number): Promise<R> {
    const n = this.needUser(a); if (n) return n; if (a.role !== "admin") return bad(403, "admin_required");
    await this.ensureInit(now); if (this.S.sealed) return { ok: true };
    const S = this.S, problems: string[] = [], sg = activeSigners(S);
    if (sg.length < MIN_SIGNERS) problems.push(`at least ${MIN_SIGNERS} active signers with enrolled hardware keys are required (have ${sg.length})`);
    if (new Set(sg.map((s) => s.uid)).size !== sg.length) problems.push("signers must be distinct users");
    if (!S.recovery) problems.push("a recovery key ceremony must be completed first");
    for (const w of PURPOSES) {
      const v = validatePolicy(w, S.wallets[w].policy); if (!v.ok) problems.push(`${w}: ${v.errors.join("; ")}`);
      const need = Math.max(...Object.values(S.wallets[w].policy.assets).flatMap((x) => x.tiers.map((t) => t.approvals)), FLOORS[w].minApprovals), have = sg.filter((s) => s.wallets.includes(w)).length;
      if (have < need + 1) problems.push(`${w}: needs at least ${need + 1} signers scoped to it (${need} approvals plus the requester); has ${have}`);
    }
    if (problems.length) return bad(422, "not_ready_to_seal", problems.join(" | "));
    await this.put({ id: "sealed", t: "sealed", by: a.uid }, now); return { ok: true };
  }

  // ---------------- signer enrolment ----------------
  private async challenge(kind: string, uid: string, extra: Record<string, unknown>, now: number) {
    const id = this.rid() + this.rid(), challenge = (extra.challenge as string) ?? b64u(crypto.getRandomValues(new Uint8Array(32)));
    await this.st.kvPut("wch:" + id, { kind, uid, ...extra, challenge, at: now }, 300); return { id, challenge };
  }
  private async takeChallenge(id: unknown, kind: string, uid: string, now: number): Promise<any | null> {
    if (typeof id !== "string" || !/^[a-f0-9]{32}$/.test(id)) return null;
    const c: any = await this.st.kvGet("wch:" + id, null); if (!c || c.kind !== kind || c.uid !== uid || c.used || now - c.at > 300_000) return null;
    await this.st.kvPut("wch:" + id, { ...c, used: true }, 60); return c;
  }
  async enrollOptions(a: Actor, now: number): Promise<R<{ challengeId: string; publicKey: any }>> {
    const n = this.needUser(a); if (n) return n; await this.load();
    const s = Object.values(this.S.signers).find((x) => x.uid === a.uid && x.status === "invited"); if (!s) return bad(404, "no_pending_designation", "You have not been designated as a signer, or you are already enrolled.");
    if (ROLE_RANK[a.role] < ROLE_RANK.trader) return bad(403, "role_too_low", "Signers must be trader or admin accounts.");
    const { id, challenge } = await this.challenge("enroll", a.uid, { signerId: s.id }, now);
    return { ok: true, challengeId: id, publicKey: { challenge, rp: { id: this.rp.rpId, name: "ETI wallets" }, user: { id: b64u(new TextEncoder().encode(a.uid)), name: a.email || a.uid, displayName: s.label }, pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { userVerification: "required", residentKey: "discouraged" }, attestation: "none", timeout: 120000 } };
  }
  async enrollVerify(a: Actor, p: { challengeId: string; clientDataJSON: string; attestationObject: string }, now: number): Promise<R<{ credentialId: string; aaguid: string }>> {
    const n = this.needUser(a); if (n) return n; await this.load();
    const c = await this.takeChallenge(p.challengeId, "enroll", a.uid, now); if (!c) return bad(400, "challenge_invalid", "The enrolment challenge expired or was already used.");
    const s = this.S.signers[c.signerId]; if (!s || s.status !== "invited" || s.uid !== a.uid) return bad(409, "signer_state_changed");
    const aaguids = (this.env.ETI_WALLET_AAGUIDS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    const r = await verifyRegistration(p, this.expected(c.challenge), { allowSynced: this.env.ETI_WALLET_ALLOW_SYNCED_PASSKEYS === "true", aaguids: aaguids.length ? aaguids : undefined });
    if (!r.ok) return bad(422, "registration_rejected", r.reason);
    if (Object.values(this.S.signers).some((x) => x.credentials.some((k) => k.id === r.credentialId))) return bad(409, "credential_in_use");
    await this.put({ id: "ce-" + r.credentialId.slice(0, 40), t: "credential_added", signerId: s.id, credential: { id: r.credentialId, publicKey: r.publicKey, signCount: r.signCount, aaguid: r.aaguid, addedAt: now } }, now);
    return { ok: true, credentialId: r.credentialId, aaguid: r.aaguid };
  }

  // ---------------- actions ----------------
  private requiredFor(w: Purpose, asset: string, units: bigint) { const p = this.S.wallets[w].policy; return Math.max(approvalsFor(p, asset, units) ?? 99, FLOORS[w].minApprovals); }
  /** Rule check shared by creation and execution. Returns an error string, or null. */
  private checkWithdraw(core: ActionCore, now: number, exceptId?: string): string | null {
    const S = this.S, w = S.wallets[core.walletId as Purpose], p = core.payload; if (!w) return "unknown wallet";
    const ap = w.policy.assets[p.asset]; if (!ap) return `${p.asset} is not allowed for this wallet`;
    const units = parseAmount(p.amount, ap.decimals); if (units === null || units.toString() !== p.units) return "amount does not match units";
    if (units > (parseAmount(ap.perTx, ap.decimals) as bigint)) return `above the per-transaction limit of ${ap.perTx} ${p.asset}`;
    if (committedUnits(S, w.id, p.asset, now, exceptId) + units > (parseAmount(ap.daily, ap.decimals) as bigint)) return `would exceed the 24-hour limit of ${ap.daily} ${p.asset} (queued requests count)`;
    const d = p.destination;
    if (d?.type === "internal") {
      const dst = S.wallets[d.walletId as Purpose]; if (!dst || d.walletId === w.id) return "invalid destination wallet";
      if (w.custody.kind !== "ledger" || dst.custody.kind !== "ledger") return "internal transfers are only between ledger wallets; use an external withdrawal for custodial wallets";
      if (dst.policy.inboundFrom !== "any" && !dst.policy.inboundFrom.includes(w.id)) return `${dst.label} does not accept transfers from ${w.label}`;
      if (!dst.policy.assets[p.asset]) return `${p.asset} is not allowed for ${dst.label}`;
      let out = 0n; for (const x of Object.values(S.actions)) if (x.id !== exceptId && x.core.kind === "withdraw" && x.core.walletId === w.id && x.core.payload.destination?.type === "internal" && x.core.payload.asset === p.asset && ["pending", "timelocked", "ready", "executing", "unknown"].includes(progress(S, x, now).status)) out += BigInt(x.core.payload.units);
      if ((S.balances[w.id][p.asset] ?? 0n) < out + units) return "insufficient ledger balance (after queued transfers)";
      return null;
    }
    if (d?.type === "external") {
      if (w.custody.kind === "ledger") return "this wallet has ledger custody and cannot send externally; configure a custodian first";
      if (!isChain(d.chain) || !w.custody.chains.includes(d.chain)) return "chain is not enabled for this wallet's custody";
      if (!addressOk(d.chain, d.address)) return "invalid destination address";
      const e = S.addresses[d.entryId]; if (!e || e.removed || e.address !== d.address || e.chain !== d.chain || (e.walletId !== "*" && e.walletId !== w.id)) return "destination is not on the whitelist";
      if (now < e.activeAt) return `whitelist entry is in its cooldown until ${new Date(e.activeAt).toISOString()}`;
      return null;
    }
    return "destination must be internal or external";
  }
  async createAction(a: Actor, kind: string, walletId: string | null, input: any, now: number): Promise<R<{ actionId: string; digest: string }>> {
    const n = this.needUser(a); if (n) return n; await this.ensureInit(now); const S = this.S;
    if (!S.sealed) return bad(409, "not_sealed", "Finish setup and seal the wallets before creating actions.");
    if (!ACTION_KINDS.includes(kind)) return bad(400, "unknown_action_kind");
    if (S.frozen && kind !== "unfreeze") return bad(423, "frozen", "All wallet actions are frozen. Only an unfreeze action may be proposed.");
    const open = Object.values(S.actions).filter((x) => ["pending", "timelocked", "ready", "executing", "unknown"].includes(progress(S, x, now).status)).length; if (open >= MAX_OPEN_PER_WALLET * 5) return bad(429, "too_many_open_actions");
    let payload: any = {}, w: Purpose | null = null, threshold = 2, timelockSec = this.govTimelock(), ttlSec = 3 * 86_400;
    const gov = () => { if (a.role !== "admin") return bad(403, "admin_required", "Governance actions are proposed by administrators."); return null; };
    if (kind === "withdraw") {
      if (!isPurpose(walletId)) return bad(400, "unknown_wallet"); w = walletId; const wl = S.wallets[w], pol = wl.policy;
      if (ROLE_RANK[a.role] < ROLE_RANK[pol.requestRole]) return bad(403, "role_too_low", `${wl.label} withdrawals are requested by ${pol.requestRole} accounts or above.`);
      const asset = String(input?.asset ?? "").toUpperCase(), ap = pol.assets[asset]; if (!ap) return bad(422, "asset_not_allowed", `${asset} is not enabled for ${wl.label}.`);
      const units = parseAmount(input?.amount, ap.decimals); if (units === null) return bad(422, "amount_invalid", `Amount must be a positive decimal with at most ${ap.decimals} places.`);
      const d = input?.destination; let destination: any;
      if (d?.type === "internal") destination = { type: "internal", walletId: String(d.walletId) };
      else if (d?.type === "external") destination = { type: "external", chain: String(d.chain), address: String(d.address), entryId: String(d.entryId) };
      else return bad(422, "destination_invalid");
      payload = { asset, amount: fmtAmount(units, ap.decimals), units: units.toString(), destination, memo: String(input?.memo ?? "").slice(0, 140) };
      threshold = this.requiredFor(w, asset, units); timelockSec = pol.timelockSec; ttlSec = pol.actionTtlSec;
    } else {
      const g = gov(); if (g) return g;
      switch (kind) {
        case "signer_add": { const e = this.checkSigner(input ?? {}); if (typeof e === "string") return bad(422, "signer_invalid", e); payload = e; break; }
        case "signer_remove": { const s = S.signers[String(input?.signerId)]; if (!s || s.status === "removed") return bad(422, "signer_unknown"); if (activeSigners(S).filter((x) => x.id !== s.id).length < MIN_SIGNERS && s.status === "active") return bad(422, "too_few_signers", `Removing this signer would leave fewer than ${MIN_SIGNERS} active signers. Add a replacement first.`); payload = { signerId: s.id, uid: s.uid, reason: String(input?.reason ?? "").slice(0, 140) }; break; }
        case "policy_change": {
          if (!isPurpose(walletId)) return bad(400, "unknown_wallet"); w = walletId; const pc: any = {};
          if (input?.policy !== undefined) { const v = validatePolicy(w, input.policy); if (!v.ok) return bad(422, "policy_invalid", v.errors.join("; ")); pc.policy = v.policy; }
          if (input?.custody !== undefined) { const c = validateCustody(input.custody); if (!c) return bad(422, "custody_invalid"); if (Object.values(S.balances[w]).some((x) => x > 0n)) return bad(422, "balance_present", "Move the ledger balance out before changing custody."); pc.custody = c; }
          if (input?.depositAddresses !== undefined) { const d = this.checkDeposits(input.depositAddresses); if (typeof d === "string") return bad(422, "deposit_addresses_invalid", d); pc.depositAddresses = d; }
          if (!Object.keys(pc).length) return bad(400, "nothing_to_change"); payload = pc; break;
        }
        case "address_add": {
          const target = input?.walletId === "*" ? "*" : input?.walletId; if (target !== "*" && !isPurpose(target)) return bad(422, "unknown_wallet"); w = target === "*" ? null : target;
          if (!isChain(input?.chain) || !addressOk(input.chain, input.address)) return bad(422, "address_invalid"); const label = String(input?.label ?? "").trim().slice(0, 60); if (!label) return bad(422, "label_required");
          payload = { walletId: target, chain: input.chain, address: input.address, label, entryId: "ad_" + this.rid() }; break;
        }
        case "address_remove": { const e = S.addresses[String(input?.entryId)]; if (!e || e.removed) return bad(422, "entry_unknown"); w = e.walletId === "*" ? null : e.walletId; payload = { entryId: e.id, address: e.address }; break; }
        case "unfreeze": { if (!S.frozen) return bad(409, "not_frozen"); payload = { reason: String(input?.reason ?? "").slice(0, 140) }; timelockSec = 0; break; }
        case "record_deposit": {
          if (!isPurpose(walletId)) return bad(400, "unknown_wallet"); w = walletId; if (S.wallets[w].custody.kind !== "ledger") return bad(422, "not_ledger_wallet", "Deposits are recorded only for ledger wallets; custodial balances live with the custodian.");
          const asset = String(input?.asset ?? "").toUpperCase(), ap = S.wallets[w].policy.assets[asset]; if (!ap) return bad(422, "asset_not_allowed"); const units = parseAmount(input?.amount, ap.decimals); if (units === null) return bad(422, "amount_invalid");
          const txRef = String(input?.txRef ?? "").trim(); if (!/^[A-Za-z0-9:._-]{6,120}$/.test(txRef)) return bad(422, "txref_required", "Provide the on-chain or exchange transaction reference.");
          if (Object.values(S.actions).some((x) => x.core.kind === "record_deposit" && x.core.payload.txRef === txRef && !x.cancelled)) return bad(409, "duplicate_deposit");
          payload = { asset, amount: fmtAmount(units, ap.decimals), units: units.toString(), txRef, note: String(input?.note ?? "").slice(0, 140) }; timelockSec = 0; break;
        }
        case "recovery_rotate": { const c = this.checkRecovery(input); if (c) return bad(422, "recovery_invalid", c); payload = { publicKey: input.publicKey, k: input.k, n: input.n, setId: input.setId }; break; }
      }
      threshold = govThreshold(S);
    }
    const core: ActionCore = { v: 1, id: newActionId(), kind, walletId: w, payload, requestedBy: a.uid, createdAt: now, expiresAt: now + ttlSec * 1000, threshold, timelockSec };
    if (kind === "withdraw") { const err = this.checkWithdraw(core, now); if (err) return bad(422, "rule_violation", err); }
    const el = eligibleSigners(S, core).length; if (el < threshold) return bad(422, "not_enough_signers", `This needs ${threshold} approvals but only ${el} eligible signers exist (the requester cannot approve).`);
    const digest = await digestOf(core); await this.put({ id: "ac-" + core.id, t: "action_created", actionId: core.id, core, digest }, now); return { ok: true, actionId: core.id, digest };
  }
  private async approverFor(a: Actor, actionId: string) {
    const act = this.S.actions[actionId]; if (!act) return { err: bad(404, "action_not_found") } as const;
    const s = Object.values(this.S.signers).find((x) => x.uid === a.uid && x.status === "active"); if (!s) return { err: bad(403, "not_a_signer") } as const;
    if (!eligibleSigners(this.S, act.core).some((x) => x.id === s.id)) return { err: bad(403, "not_eligible", "You cannot approve your own request, and signers are scoped to specific wallets.") } as const;
    return { act, s } as const;
  }
  async approveOptions(a: Actor, actionId: string, now: number): Promise<R<{ challengeId: string; publicKey: any; core: ActionCore; digest: string }>> {
    const n = this.needUser(a); if (n) return n; await this.load(); const r = await this.approverFor(a, actionId); if ("err" in r) return r.err;
    const { act, s } = r, st = progress(this.S, act, now).status; if (!["pending", "timelocked", "ready"].includes(st)) return bad(409, "not_approvable", `Action is ${st}.`);
    if (await digestOf(act.core) !== act.digest) return bad(500, "digest_mismatch");
    if (act.approvals.some((x) => x.signerId === s.id)) return bad(409, "already_approved");
    const challenge = b64u(fromHex(act.digest)), { id } = await this.challenge("approve", a.uid, { actionId, challenge }, now);
    return { ok: true, challengeId: id, core: act.core, digest: act.digest, publicKey: { challenge, rpId: this.rp.rpId, allowCredentials: s.credentials.map((c) => ({ type: "public-key", id: c.id })), userVerification: "required", timeout: 120000 } };
  }
  async approve(a: Actor, actionId: string, p: { challengeId: string; credentialId: string } & Assertion, now: number): Promise<R<{ approvals: number; threshold: number }>> {
    const n = this.needUser(a); if (n) return n; await this.load(); const r = await this.approverFor(a, actionId); if ("err" in r) return r.err; const { act, s } = r;
    const c = await this.takeChallenge(p.challengeId, "approve", a.uid, now); if (!c || c.actionId !== actionId) return bad(400, "challenge_invalid", "The approval challenge expired or was already used.");
    const st = progress(this.S, act, now).status; if (!["pending", "timelocked", "ready"].includes(st)) return bad(409, "not_approvable", `Action is ${st}.`);
    if (act.approvals.some((x) => x.signerId === s.id)) return bad(409, "already_approved");
    const cred = s.credentials.find((x) => x.id === p.credentialId); if (!cred) return bad(403, "unknown_credential");
    const v = await verifyAssertion(p, this.expected(b64u(fromHex(act.digest))), cred); if (!v.ok) return bad(403, "assertion_rejected", v.reason);
    await this.put({ id: `ap-${actionId}-${s.id}`, t: "approval", actionId, signerId: s.id, uid: a.uid, credentialId: cred.id, assertion: { clientDataJSON: p.clientDataJSON, authenticatorData: p.authenticatorData, signature: p.signature }, signCount: v.signCount }, now);
    const pr = progress(this.S, this.S.actions[actionId], now); return { ok: true, approvals: pr.approvals, threshold: pr.threshold };
  }
  async cancel(a: Actor, actionId: string, reason: string, now: number): Promise<R> {
    await this.load(); const act = this.S.actions[actionId]; if (!act) return bad(404, "action_not_found");
    const st = progress(this.S, act, now).status; if (["executed", "executing", "cancelled", "failed"].includes(st)) return bad(409, "not_cancellable", `Action is ${st}.`);
    const sg = Object.values(this.S.signers).find((x) => x.uid === a.uid && x.status === "active");
    if (a.master || !a.uid) return bad(403, "user_session_required"); if (!a.mfa) return bad(403, "mfa_required");
    if (!(a.uid === act.core.requestedBy || sg || a.role === "admin")) return bad(403, "not_permitted");
    await this.put({ id: "cx-" + actionId, t: "action_cancelled", actionId, by: a.uid, reason: String(reason ?? "").slice(0, 140) }, now); return { ok: true };
  }
  /** Any signer, administrator, or the master token can freeze instantly. Unfreezing needs a multi-signature action. */
  async freeze(a: Actor, reason: string, now: number): Promise<R> {
    await this.ensureInit(now); if (this.S.frozen) return { ok: true };
    const sg = Object.values(this.S.signers).some((x) => x.uid === a.uid && x.status === "active"); if (!(a.master || a.role === "admin" || sg)) return bad(403, "not_permitted");
    if (!a.master && !a.mfa) return bad(403, "mfa_required");
    await this.put({ id: "fz-" + this.rid(), t: "frozen", by: a.master ? "master" : a.uid, reason: String(reason || "manual freeze").slice(0, 140) }, now, false); return { ok: true };
  }

  // ---------------- execution ----------------
  private async effects(act: Action, now: number): Promise<string | null> {
    const c = act.core, p = c.payload, S = this.S;
    switch (c.kind) {
      case "signer_add": { const e = this.checkSigner(p); if (typeof e === "string") return e; await this.put({ id: "sd-" + act.id, t: "signer_designated", signerId: "sg_" + act.id.slice(4, 20), uid: e.uid, label: e.label, wallets: e.wallets }, now); return null; }
      case "signer_remove": { const s = S.signers[p.signerId]; if (s && s.status === "active" && activeSigners(S).length - 1 < MIN_SIGNERS) return "would leave too few signers"; await this.put({ id: "sr-" + act.id, t: "signer_removed", signerId: p.signerId }, now); return null; }
      case "policy_change": { if (p.policy) { const v = validatePolicy(c.walletId as Purpose, p.policy); if (!v.ok) return v.errors.join("; "); } await this.put({ id: "ps-" + act.id, t: "policy_set", walletId: c.walletId, policy: p.policy, custody: p.custody, depositAddresses: p.depositAddresses }, now); return null; }
      case "address_add": { const cd = p.walletId === "*" ? Math.max(...PURPOSES.map((x) => S.wallets[x].policy.addressCooldownSec)) : S.wallets[p.walletId as Purpose].policy.addressCooldownSec; await this.put({ id: "aa-" + act.id, t: "address_added", entryId: p.entryId, walletId: p.walletId, chain: p.chain, address: p.address, label: p.label, activeAt: now + cd * 1000 }, now); return null; }
      case "address_remove": await this.put({ id: "ar-" + act.id, t: "address_removed", entryId: p.entryId }, now); return null;
      case "unfreeze": await this.put({ id: "uf-" + act.id, t: "unfrozen", by: "quorum" }, now); return null;
      case "recovery_rotate": await this.put({ id: "rr-" + act.id, t: "recovery_set", publicKey: p.publicKey, k: p.k, n: p.n, setId: p.setId }, now); return null;
      case "record_deposit": return null; // applied by the fold when the action result is recorded
    }
    return "unknown action kind";
  }
  async execute(a: Actor, actionId: string, now: number): Promise<R<{ status: string; ref?: string }>> {
    const n = this.needUser(a); if (n) return n; await this.load(); const S = this.S, act = S.actions[actionId]; if (!act) return bad(404, "action_not_found");
    if (!S.sealed) return bad(409, "not_sealed"); if (S.frozen && act.core.kind !== "unfreeze") return bad(423, "frozen");
    const sg = Object.values(S.signers).some((x) => x.uid === a.uid && x.status === "active"); if (!(a.role === "admin" || sg || a.uid === act.core.requestedBy)) return bad(403, "not_permitted");
    const pr = progress(S, act, now); if (pr.status !== "ready") return bad(409, "not_ready", `Action is ${pr.status}${pr.executableAt && pr.status === "timelocked" ? " until " + new Date(pr.executableAt).toISOString() : ""}.`);
    if (act.claims >= MAX_ATTEMPTS) { await this.put({ id: `rs-${actionId}-max`, t: "action_result", actionId, state: "failed", error: "attempt limit reached", by: a.uid }, now); return bad(409, "attempts_exhausted"); }
    // Defence in depth: re-verify every counted approval against its credential and the exact digest, and re-check current rules.
    const valid = validApprovals(S, act), digest = await digestOf(act.core); if (digest !== act.digest) return bad(500, "digest_mismatch");
    let good = 0; for (const ap of valid) { const s = S.signers[ap.signerId], cred = s?.credentials.find((x) => x.id === ap.credentialId); if (!cred) continue; const v = await verifyAssertion(ap.assertion, this.expected(b64u(fromHex(digest))), { publicKey: cred.publicKey, signCount: 0 }); if (v.ok) good++; }
    if (good < act.core.threshold) return bad(409, "approvals_invalid", "Counted approvals did not re-verify.");
    if (act.core.kind === "withdraw") {
      const pol = S.wallets[act.core.walletId as Purpose].policy, need = this.requiredFor(act.core.walletId as Purpose, act.core.payload.asset, BigInt(act.core.payload.units));
      if (need > act.core.threshold) return bad(409, "policy_tightened", "The wallet policy now requires more approvals than this action collected. Cancel it and request again.");
      if (act.core.timelockSec < pol.timelockSec) return bad(409, "policy_tightened", "The wallet timelock was lengthened after this request. Cancel it and request again.");
      const err = this.checkWithdraw(act.core, now, act.id); if (err) return bad(422, "rule_violation", err);
      if (act.core.payload.destination.type === "external" && this.st.kind !== "d1") return bad(409, "d1_required", "External execution needs the D1 database: the exactly-once claim relies on its atomic primary-key insert, which KV cannot guarantee.");
      if (act.core.payload.destination.type === "external" && !executionEnabled(this.env)) return bad(409, "execution_disabled", "External execution is switched off (ETI_WALLET_EXECUTION is not 'enabled'). The action stays approved and can be executed once it is enabled.");
    }
    const attempt = act.claims + 1; if (!(await this.put({ id: `cl-${actionId}-${attempt}`, t: "action_claimed", actionId, attempt, by: a.uid }, now))) return bad(409, "already_claimed");
    const finish = async (state: "executed" | "failed" | "unknown" | "retry", ref?: string, error?: string) => { await this.put({ id: `rs-${actionId}-${attempt}`, t: "action_result", actionId, state, ref, error, by: a.uid }, now); return { ok: true as const, status: state, ref }; };
    if (act.core.kind !== "withdraw") { const err = await this.effects(this.S.actions[actionId], now); return err ? finish("failed", undefined, err) : finish("executed"); }
    const p = act.core.payload;
    if (p.destination.type === "internal") return finish("executed", "book:" + actionId);
    const w = S.wallets[act.core.walletId as Purpose], ap = w.policy.assets[p.asset];
    const o = await sendExternal(this.env, { actionId, walletId: w.id, custody: w.custody, chain: p.destination.chain, asset: p.asset, amount: p.amount, decimals: ap.decimals, units: p.units, address: p.destination.address, digest, canonical: canon(act.core), approvals: valid.map((x) => ({ signerId: x.signerId, credentialId: x.credentialId, assertion: x.assertion })) }, this.fetchImpl, now);
    if (o.outcome === "submitted") return finish("executed", o.ref);
    if (o.outcome === "unknown") return finish("unknown", undefined, o.error);
    return finish(attempt >= MAX_ATTEMPTS ? "failed" : "retry", undefined, o.error);
  }
  /** An action stuck in "unknown" (the custodian may or may not have sent it) is settled by an administrator after checking the custodian's records. */
  async resolve(a: Actor, actionId: string, outcome: string, ref: string, note: string, now: number): Promise<R> {
    const n = this.needUser(a); if (n) return n; if (a.role !== "admin") return bad(403, "admin_required"); await this.load();
    const act = this.S.actions[actionId]; if (!act) return bad(404, "action_not_found"); if (progress(this.S, act, now).status !== "unknown") return bad(409, "not_unknown");
    if (outcome !== "executed" && outcome !== "failed") return bad(400, "outcome_invalid"); if (outcome === "executed" && !/^[A-Za-z0-9:._-]{6,200}$/.test(ref || "")) return bad(422, "reference_required", "Provide the custodian's transaction reference.");
    if (outcome === "executed" && act.core.kind !== "withdraw") { const err = await this.effects(act, now); if (err) return bad(422, "effect_failed", err); }
    await this.put({ id: `rs-${actionId}-res`, t: "action_result", actionId, state: outcome, ref: ref || undefined, error: outcome === "failed" ? String(note || "resolved as not sent").slice(0, 140) : undefined, detail: { resolvedBy: a.uid, note: String(note ?? "").slice(0, 200) }, by: a.uid }, now); return { ok: true };
  }

  // ---------------- read model ----------------
  view(now: number, viewer?: Actor) {
    const S = this.S, me = viewer && !viewer.master ? Object.values(S.signers).find((x) => x.uid === viewer.uid && x.status !== "removed") : undefined;
    const open = ["pending", "timelocked", "ready", "executing", "unknown"];
    const actions = Object.values(S.actions).sort((x, y) => y.core.createdAt - x.core.createdAt).slice(0, 150).map((a) => {
      const pr = progress(S, a, now), approvedBy = validApprovals(S, a).map((x) => S.signers[x.signerId]?.label ?? x.signerId);
      return { id: a.id, kind: a.core.kind, walletId: a.core.walletId, core: a.core, digest: a.digest, status: pr.status, approvals: pr.approvals, threshold: pr.threshold, executableAt: pr.executableAt, expiresAt: pr.expiresAt, approvedBy, result: a.result ? { state: a.result.state, ref: a.result.ref, error: a.result.error, at: a.result.at } : null, cancelled: a.cancelled ?? null,
        canApprove: !!me && me.status === "active" && open.slice(0, 3).includes(pr.status) && eligibleSigners(S, a.core).some((x) => x.id === me.id) && !a.approvals.some((x) => x.signerId === me.id) };
    });
    return { now, initialised: S.initialised, sealed: S.sealed, frozen: S.frozen, executionEnabled: executionEnabled(this.env), governanceThreshold: govThreshold(S), govTimelockSec: this.govTimelock(),
      recovery: S.recovery ? { k: S.recovery.k, n: S.recovery.n, setId: S.recovery.setId, at: S.recovery.at } : null,
      wallets: PURPOSES.map((p) => { const w = S.wallets[p]; return { id: p, label: w.label, custody: w.custody, policy: w.policy, depositAddresses: w.depositAddresses, floors: FLOORS[p], balances: Object.fromEntries(Object.entries(S.balances[p]).map(([k, v]) => [k, fmtAmount(v, w.policy.assets[k]?.decimals ?? 8)])), signers: activeSigners(S).filter((x) => x.wallets.includes(p)).length, openActions: Object.values(S.actions).filter((a) => a.core.walletId === p && open.includes(progress(S, a, now).status)).length }; }),
      signers: Object.values(S.signers).map((s) => ({ id: s.id, uid: s.uid, label: s.label, wallets: s.wallets, status: s.status, credentials: s.credentials.map((c) => ({ id: c.id.slice(0, 12), aaguid: c.aaguid, addedAt: c.addedAt, signCount: c.signCount })) })),
      addresses: Object.values(S.addresses).filter((x) => !x.removed).map((x) => ({ ...x, active: now >= x.activeAt })), actions, me: me ? { signerId: me.id, status: me.status } : null, eventCount: S.eventCount };
  }
}
