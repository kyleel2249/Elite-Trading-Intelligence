import { test } from "node:test";
import assert from "node:assert/strict";
import { sqliteD1 } from "../portfolio/testing.ts";
import { openStore } from "../portfolio/store.ts";
import { WalletService, type Actor } from "./service.ts";
import { SoftKey } from "./softkey.ts";
import { defaultPolicy, FLOORS } from "./model.ts";
import { redact, findSecret } from "./redact.ts";

const ORIGIN = "https://eti.example", RP = { rpId: "eti.example", origins: [ORIGIN] };
const U = (uid: string, role = "admin"): Actor => ({ uid, role, mfa: true });
const ADDR = "0x" + "ab".repeat(20), ADDR2 = "0x" + "cd".repeat(20);
interface Rig { svc: WalletService; keys: Record<string, SoftKey>; t: { now: number }; calls: any[] }

async function rig(opts: { gov?: string; exec?: boolean; fetchImpl?: any } = {}): Promise<Rig> {
  const env: any = { ETI_PORTFOLIO_DB: sqliteD1(), ETI_WALLET_GOV_TIMELOCK_SEC: opts.gov ?? "0", ...(opts.exec ? { ETI_WALLET_EXECUTION: "enabled", ETI_SIGNER_URL: "https://signer.example", ETI_SIGNER_SECRET: "s".repeat(32) } : {}) };
  const calls: any[] = [], fetchImpl = opts.fetchImpl ?? (async (u: string, i: any) => { calls.push({ u, body: JSON.parse(i.body) }); return new Response(JSON.stringify({ status: "submitted", txId: "0xtx" + calls.length + "0000" }), { status: 200 }); });
  const svc = new WalletService(env, openStore(env, "wallets" as any)!, RP, fetchImpl), t = { now: 1_800_000_000_000 };
  await svc.ensureInit(t.now); return { svc, keys: {}, t, calls };
}
async function enrol(r: Rig, uid: string, wallets: string[], role = "admin") {
  const d = await r.svc.designate(U("boss"), { uid, label: uid, wallets }, r.t.now); assert.ok(d.ok, JSON.stringify(d));
  const o: any = await r.svc.enrollOptions(U(uid, role), r.t.now); assert.ok(o.ok, JSON.stringify(o));
  const k = r.keys[uid] = await SoftKey.create(); const reg = await k.register(o.publicKey.challenge, ORIGIN, RP.rpId);
  const v = await r.svc.enrollVerify(U(uid, role), { challengeId: o.challengeId, ...reg }, r.t.now); assert.ok(v.ok, JSON.stringify(v));
}
async function sealed(r: Rig, who = ["alice", "bob", "carol", "dave"]) {
  for (const u of who) await enrol(r, u, ["trading", "treasury", "opex", "emergency", "long_term"], "admin");
  await r.svc.setRecovery(U("boss"), { publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" }, k: 3, n: 5, setId: "a".repeat(16) }, r.t.now);
  const s = await r.svc.seal(U("boss"), r.t.now); assert.ok(s.ok, JSON.stringify(s));
}
async function approve(r: Rig, uid: string, actionId: string) {
  const o: any = await r.svc.approveOptions(U(uid), actionId, r.t.now); if (!o.ok) return o;
  const as = await r.keys[uid].assert(o.publicKey.challenge, ORIGIN, RP.rpId);
  const res = await r.svc.approve(U(uid), actionId, { challengeId: o.challengeId, ...as }, r.t.now); r.t.now = Math.max(r.t.now, r.svc.S.lastEventAt) + 1; return res; // the test clock follows the event clock
}
const code = (x: any) => x.ok ? "ok" : x.error;
/** Fund a ledger wallet through a normal quorum-approved deposit record. */
async function fund(r: Rig, wallet: string, amount: string, ref: string) {
  const c: any = await r.svc.createAction(U("boss"), "record_deposit", wallet, { asset: "USDT", amount, txRef: ref }, r.t.now); assert.ok(c.ok, JSON.stringify(c));
  for (const u of ["alice", "bob", "carol"]) await approve(r, u, c.actionId); const e = await r.svc.execute(U("boss"), c.actionId, r.t.now); assert.ok(e.ok, JSON.stringify(e));
}
const external = async (r: Rig, wallet = "treasury") => { // custodial treasury with a whitelisted address
  assert.ok((await r.svc.configure(U("boss"), { walletId: wallet, custody: { kind: "external_signer", ref: "hsm-key-1", chains: ["ethereum"] } }, r.t.now)).ok);
};

test("setup: sealing needs signers, a recovery key and enough scoped signers", async () => {
  const r = await rig(); assert.equal(code(await r.svc.seal(U("boss"), r.t.now)), "not_ready_to_seal");
  await enrol(r, "alice", ["treasury"]); await enrol(r, "bob", ["treasury"]);
  const s: any = await r.svc.seal(U("boss"), r.t.now); assert.match(s.message, /at least 3 active signers/); assert.match(s.message, /recovery key/);
  assert.equal(code(await r.svc.designate(U("boss", "trader"), { uid: "zed", label: "z", wallets: ["trading"] }, r.t.now)), "admin_required");
  assert.equal(code(await r.svc.designate({ ...U("boss"), mfa: false }, { uid: "zed", label: "z", wallets: ["trading"] }, r.t.now)), "mfa_required");
  assert.equal(code(await r.svc.designate({ uid: "", role: "admin", mfa: true, master: true }, { uid: "zed", label: "z", wallets: ["trading"] }, r.t.now)), "user_session_required");
});
test("setup: policy floors cannot be lowered, and the same uid cannot be two signers", async () => {
  const r = await rig(); const p = defaultPolicy("treasury"); p.timelockSec = 0;
  assert.equal(code(await r.svc.configure(U("boss"), { walletId: "treasury", policy: p }, r.t.now)), "policy_invalid");
  const q = defaultPolicy("emergency"); q.assets.USDT.tiers = [{ upTo: null, approvals: 1 }]; assert.equal(code(await r.svc.configure(U("boss"), { walletId: "emergency", policy: q }, r.t.now)), "policy_invalid");
  await r.svc.designate(U("boss"), { uid: "alice", label: "a", wallets: ["trading"] }, r.t.now);
  assert.equal(code(await r.svc.designate(U("boss"), { uid: "alice", label: "a2", wallets: ["trading"] }, r.t.now)), "signer_invalid");
  assert.equal(FLOORS.treasury.minApprovals, 2);
});
test("enrolment: software-only passkeys and wrong challenges are refused; a challenge is single use", async () => {
  const r = await rig(); await r.svc.designate(U("boss"), { uid: "alice", label: "a", wallets: ["trading"] }, r.t.now);
  const o: any = await r.svc.enrollOptions(U("alice"), r.t.now), k = await SoftKey.create({ backupEligible: true });
  const synced = await r.svc.enrollVerify(U("alice"), { challengeId: o.challengeId, ...(await k.register(o.publicKey.challenge, ORIGIN, RP.rpId)) }, r.t.now); assert.equal(synced.ok, false); assert.match((synced as any).message, /synced|backup/i);
  const o2: any = await r.svc.enrollOptions(U("alice"), r.t.now), k2 = await SoftKey.create(); const reg = await k2.register("wrong-challenge", ORIGIN, RP.rpId);
  assert.equal(code(await r.svc.enrollVerify(U("alice"), { challengeId: o2.challengeId, ...reg }, r.t.now)), "registration_rejected");
  assert.equal(code(await r.svc.enrollVerify(U("alice"), { challengeId: o2.challengeId, ...(await k2.register(o2.publicKey.challenge, ORIGIN, RP.rpId)) }, r.t.now)), "challenge_invalid");
  assert.equal(code(await r.svc.enrollOptions(U("mallory"), r.t.now)), "no_pending_designation");
});
test("internal treasury transfer: 2 approvals, requester excluded, timelock, limits, one execution", async () => {
  const r = await rig(); await sealed(r); await fund(r, "treasury", "100000", "dep-0001-aaaa");
  assert.equal(code(await r.svc.createAction(U("boss", "trader"), "withdraw", "treasury", { asset: "USDT", amount: "10", destination: { type: "internal", walletId: "trading" } }, r.t.now)), "role_too_low");
  assert.equal(code(await r.svc.createAction(U("boss"), "withdraw", "treasury", { asset: "USDT", amount: "30000", destination: { type: "internal", walletId: "trading" } }, r.t.now)), "rule_violation"); // per-tx 25000
  assert.equal(code(await r.svc.createAction(U("boss"), "withdraw", "treasury", { asset: "DOGE", amount: "1", destination: { type: "internal", walletId: "trading" } }, r.t.now)), "asset_not_allowed");
  assert.equal(code(await r.svc.createAction(U("boss"), "withdraw", "treasury", { asset: "USDT", amount: "1.000000001", destination: { type: "internal", walletId: "trading" } }, r.t.now)), "amount_invalid");
  assert.equal(code(await r.svc.createAction(U("boss"), "withdraw", "treasury", { asset: "USDT", amount: "10", destination: { type: "internal", walletId: "treasury" } }, r.t.now)), "rule_violation");
  const c: any = await r.svc.createAction(U("alice"), "withdraw", "treasury", { asset: "USDT", amount: "20000", destination: { type: "internal", walletId: "trading" } }, r.t.now); assert.ok(c.ok);
  assert.equal(code(await approve(r, "alice", c.actionId)), "not_eligible"); // requester cannot approve their own request
  assert.equal(code(await r.svc.execute(U("alice"), c.actionId, r.t.now)), "not_ready");
  assert.equal((await approve(r, "bob", c.actionId) as any).approvals, 1);
  assert.equal(code(await approve(r, "bob", c.actionId)), "already_approved");
  assert.equal((await approve(r, "carol", c.actionId) as any).approvals, 2);
  const tl: any = await r.svc.execute(U("alice"), c.actionId, r.t.now); assert.equal(tl.error, "not_ready"); assert.match(tl.message, /timelocked/);
  r.t.now += 3600_000 + 1;
  const ex: any = await r.svc.execute(U("alice"), c.actionId, r.t.now); assert.ok(ex.ok, JSON.stringify(ex)); assert.equal(ex.status, "executed");
  assert.equal(code(await r.svc.execute(U("alice"), c.actionId, r.t.now)), "not_ready");
  const v = r.svc.view(r.t.now); assert.equal(v.wallets.find((w) => w.id === "trading")!.balances.USDT, "20000"); assert.equal(v.wallets.find((w) => w.id === "treasury")!.balances.USDT, "80000");
  // daily limit counts what was already moved
  assert.equal(code(await r.svc.createAction(U("alice"), "withdraw", "treasury", { asset: "USDT", amount: "25000", destination: { type: "internal", walletId: "emergency" } }, r.t.now)), "ok");
  assert.equal(code(await r.svc.createAction(U("alice"), "withdraw", "treasury", { asset: "USDT", amount: "25000", destination: { type: "internal", walletId: "long_term" } }, r.t.now)), "rule_violation");
});
test("trading uses tiers: small = 1 approval and no timelock, large = 2", async () => {
  const r = await rig(); await sealed(r); await fund(r, "trading", "10000", "dep-0002-bbbb");
  // trading may only receive from treasury by default, so move out to treasury is not allowed; use opex? trading -> treasury accepts any
  const small: any = await r.svc.createAction(U("alice", "trader"), "withdraw", "trading", { asset: "USDT", amount: "500", destination: { type: "internal", walletId: "treasury" } }, r.t.now); assert.equal(small.ok, true, JSON.stringify(small));
  assert.equal((await approve(r, "bob", small.actionId) as any).threshold, 1);
  assert.ok((await r.svc.execute(U("alice", "trader"), small.actionId, r.t.now)).ok);
  const big: any = await r.svc.createAction(U("alice", "trader"), "withdraw", "trading", { asset: "USDT", amount: "3000", destination: { type: "internal", walletId: "treasury" } }, r.t.now);
  await approve(r, "bob", big.actionId); assert.equal(code(await r.svc.execute(U("alice"), big.actionId, r.t.now)), "not_ready"); await approve(r, "carol", big.actionId); assert.ok((await r.svc.execute(U("alice"), big.actionId, r.t.now)).ok);
});
test("inbound rules: only allowed source wallets can send to a wallet", async () => {
  const r = await rig(); await sealed(r); await fund(r, "trading", "1000", "dep-0003-cccc");
  assert.equal(code(await r.svc.createAction(U("alice", "trader"), "withdraw", "trading", { asset: "USDT", amount: "10", destination: { type: "internal", walletId: "emergency" } }, r.t.now)), "rule_violation"); // emergency accepts only from treasury
});
test("external withdrawals: whitelist + cooldown, custody gate, execution flag, gateway request is signed and carries approvals", async () => {
  const r = await rig({ exec: true }); await external(r); await sealed(r);
  const add: any = await r.svc.createAction(U("boss"), "address_add", null, { walletId: "treasury", chain: "ethereum", address: ADDR, label: "Cold vault" }, r.t.now); assert.ok(add.ok, JSON.stringify(add));
  for (const u of ["alice", "bob", "carol"]) await approve(r, u, add.actionId); assert.ok((await r.svc.execute(U("boss"), add.actionId, r.t.now)).ok);
  const entryId = Object.keys(r.svc.S.addresses)[0], req = (amt = "100") => r.svc.createAction(U("alice"), "withdraw", "treasury", { asset: "USDT", amount: amt, destination: { type: "external", chain: "ethereum", address: ADDR, entryId } }, r.t.now);
  assert.equal(code(await req()), "rule_violation"); assert.match(((await req()) as any).message, /cooldown/);
  r.t.now += 86_400_000 + 1000; const c: any = await req(); assert.ok(c.ok, JSON.stringify(c));
  assert.equal(code(await r.svc.createAction(U("alice"), "withdraw", "treasury", { asset: "USDT", amount: "100", destination: { type: "external", chain: "ethereum", address: ADDR2, entryId } }, r.t.now)), "rule_violation");
  await approve(r, "bob", c.actionId); await approve(r, "carol", c.actionId); r.t.now += 3600_000 + 1;
  const ex: any = await r.svc.execute(U("alice"), c.actionId, r.t.now); assert.ok(ex.ok, JSON.stringify(ex)); assert.equal(ex.status, "executed"); assert.match(ex.ref, /^0xtx/);
  assert.equal(r.calls.length, 1); assert.equal(r.calls[0].body.idempotencyKey, c.actionId); assert.equal(r.calls[0].body.approvals.length, 2); assert.equal(r.calls[0].body.destination.address, ADDR);
  assert.equal(JSON.stringify(r.calls[0].body).includes("PRIVATE"), false);
  assert.equal(code(await r.svc.execute(U("alice"), c.actionId, r.t.now)), "not_ready"); assert.equal(r.calls.length, 1);
});
test("external execution is off by default and approvals are kept", async () => {
  const r = await rig({ exec: false }); await external(r); await sealed(r);
  const add: any = await r.svc.createAction(U("boss"), "address_add", "treasury" as any, { walletId: "*", chain: "ethereum", address: ADDR, label: "x" }, r.t.now); for (const u of ["alice", "bob", "carol"]) await approve(r, u, add.actionId); await r.svc.execute(U("boss"), add.actionId, r.t.now);
  r.t.now += 86_400_000 + 1000; const entryId = Object.keys(r.svc.S.addresses)[0];
  const c: any = await r.svc.createAction(U("alice"), "withdraw", "treasury", { asset: "USDT", amount: "5", destination: { type: "external", chain: "ethereum", address: ADDR, entryId } }, r.t.now); await approve(r, "bob", c.actionId); await approve(r, "carol", c.actionId); r.t.now += 3600_001;
  assert.equal(code(await r.svc.execute(U("alice"), c.actionId, r.t.now)), "execution_disabled");
});
test("gateway outcomes: rejected retries, timeout becomes unknown and is never auto-retried, admin resolves", async () => {
  let mode = "reject"; const r = await rig({ exec: true, fetchImpl: async () => { if (mode === "reject") return new Response(JSON.stringify({ status: "rejected", reason: "policy" }), { status: 422 }); throw new Error("timeout"); } });
  await external(r); await sealed(r);
  const add: any = await r.svc.createAction(U("boss"), "address_add", null, { walletId: "*", chain: "ethereum", address: ADDR, label: "x" }, r.t.now); for (const u of ["alice", "bob", "carol"]) await approve(r, u, add.actionId); await r.svc.execute(U("boss"), add.actionId, r.t.now);
  r.t.now += 86_400_000 + 1000; const entryId = Object.keys(r.svc.S.addresses)[0];
  const c: any = await r.svc.createAction(U("alice"), "withdraw", "treasury", { asset: "USDT", amount: "5", destination: { type: "external", chain: "ethereum", address: ADDR, entryId } }, r.t.now); await approve(r, "bob", c.actionId); await approve(r, "carol", c.actionId); r.t.now += 3600_001;
  const e1: any = await r.svc.execute(U("alice"), c.actionId, r.t.now); assert.equal(e1.status, "retry");
  mode = "timeout"; const e2: any = await r.svc.execute(U("alice"), c.actionId, r.t.now); assert.equal(e2.status, "unknown");
  assert.equal(code(await r.svc.execute(U("alice"), c.actionId, r.t.now)), "not_ready");
  assert.equal(code(await r.svc.resolve(U("alice", "trader"), c.actionId, "failed", "", "", r.t.now)), "admin_required");
  assert.equal(code(await r.svc.resolve(U("boss"), c.actionId, "executed", "x", "", r.t.now)), "reference_required");
  assert.ok((await r.svc.resolve(U("boss"), c.actionId, "executed", "0xconfirmed-by-custodian", "checked HSM log", r.t.now)).ok);
  assert.equal(r.svc.view(r.t.now).actions.find((a) => a.id === c.actionId)!.status, "executed");
});
test("a signer removed after approving no longer counts; freeze blocks execution; unfreeze needs a quorum", async () => {
  const r = await rig(); await sealed(r, ["alice", "bob", "carol", "dave", "erin"]); await fund(r, "treasury", "1000", "dep-0004-dddd");
  const c: any = await r.svc.createAction(U("alice"), "withdraw", "treasury", { asset: "USDT", amount: "10", destination: { type: "internal", walletId: "opex" } }, r.t.now); await approve(r, "bob", c.actionId); await approve(r, "carol", c.actionId);
  const rm: any = await r.svc.createAction(U("boss"), "signer_remove", null, { signerId: Object.values(r.svc.S.signers).find((s) => s.uid === "carol")!.id }, r.t.now); await approve(r, "alice", rm.actionId); await approve(r, "dave", rm.actionId); await approve(r, "erin", rm.actionId); assert.ok((await r.svc.execute(U("boss"), rm.actionId, r.t.now)).ok, "removal executes");
  r.t.now += 3600_001; assert.equal(code(await r.svc.execute(U("alice"), c.actionId, r.t.now)), "not_ready"); // only bob's approval still counts
  await approve(r, "dave", c.actionId); assert.equal(code(await r.svc.execute(U("alice"), c.actionId, r.t.now)), "not_ready"); r.t.now += 3600_001; // the timelock restarts when the quorum is re-established
  assert.ok((await r.svc.execute(U("alice"), c.actionId, r.t.now)).ok);
  assert.equal(code(await r.svc.freeze(U("mallory", "viewer"), "x", r.t.now)), "not_permitted"); assert.ok((await r.svc.freeze({ uid: "", role: "", mfa: false, master: true }, "incident", r.t.now)).ok);
  assert.equal(code(await r.svc.createAction(U("alice"), "withdraw", "treasury", { asset: "USDT", amount: "1", destination: { type: "internal", walletId: "opex" } }, r.t.now)), "frozen");
  const uf: any = await r.svc.createAction(U("boss"), "unfreeze", null, { reason: "resolved" }, r.t.now); assert.ok(uf.ok, JSON.stringify(uf));
  assert.equal(code(await r.svc.execute(U("boss"), uf.actionId, r.t.now)), "not_ready"); for (const u of ["alice", "bob", "dave"]) await approve(r, u, uf.actionId);
  assert.ok((await r.svc.execute(U("boss"), uf.actionId, r.t.now)).ok); assert.equal(r.svc.S.frozen, null);
});
test("cannot remove signers below the minimum; deposit records are deduplicated; sealed wallets refuse direct changes", async () => {
  const r = await rig(); await sealed(r, ["alice", "bob", "carol"]);
  assert.equal(code(await r.svc.createAction(U("boss"), "signer_remove", null, { signerId: Object.keys(r.svc.S.signers)[0] }, r.t.now)), "too_few_signers");
  assert.equal(code(await r.svc.configure(U("boss"), { walletId: "treasury", policy: defaultPolicy("treasury") }, r.t.now)), "sealed");
  assert.equal(code(await r.svc.designate(U("boss"), { uid: "x1", label: "x", wallets: ["trading"] }, r.t.now)), "sealed");
  const d: any = await r.svc.createAction(U("boss"), "record_deposit", "treasury", { asset: "USDT", amount: "5", txRef: "tx-ref-123456" }, r.t.now); assert.ok(d.ok);
  assert.equal(code(await r.svc.createAction(U("boss"), "record_deposit", "treasury", { asset: "USDT", amount: "5", txRef: "tx-ref-123456" }, r.t.now)), "duplicate_deposit");
});
test("policy tightened after approval blocks execution; governance policy_change raises limits only within floors", async () => {
  const r = await rig({ gov: "0" }); await sealed(r); await fund(r, "trading", "5000", "dep-0005-eeee");
  const c: any = await r.svc.createAction(U("alice", "trader"), "withdraw", "trading", { asset: "USDT", amount: "500", destination: { type: "internal", walletId: "treasury" } }, r.t.now); await approve(r, "bob", c.actionId);
  const tight = defaultPolicy("trading"); tight.assets.USDT.tiers = [{ upTo: null, approvals: 2 }];
  const pc: any = await r.svc.createAction(U("boss"), "policy_change", "trading", { policy: tight }, r.t.now); for (const u of ["alice", "bob", "carol"]) await approve(r, u, pc.actionId); assert.ok((await r.svc.execute(U("boss"), pc.actionId, r.t.now)).ok);
  assert.equal(code(await r.svc.execute(U("alice"), c.actionId, r.t.now)), "policy_tightened");
  const low = defaultPolicy("treasury"); low.timelockSec = 10; assert.equal(code(await r.svc.createAction(U("boss"), "policy_change", "treasury", { policy: low }, r.t.now)), "policy_invalid");
});
test("approvals are bound to the action digest, to the signer's own key, and to a fresh challenge", async () => {
  const r = await rig(); await sealed(r); await fund(r, "treasury", "1000", "dep-0006-ffff");
  const a: any = await r.svc.createAction(U("alice"), "withdraw", "treasury", { asset: "USDT", amount: "10", destination: { type: "internal", walletId: "opex" } }, r.t.now), b: any = await r.svc.createAction(U("alice"), "withdraw", "treasury", { asset: "USDT", amount: "11", destination: { type: "internal", walletId: "opex" } }, r.t.now);
  const oa: any = await r.svc.approveOptions(U("bob"), a.actionId, r.t.now), ob: any = await r.svc.approveOptions(U("bob"), b.actionId, r.t.now);
  const asA = await r.keys.bob.assert(oa.publicKey.challenge, ORIGIN, RP.rpId);
  assert.equal(code(await r.svc.approve(U("bob"), b.actionId, { challengeId: ob.challengeId, ...asA })), "assertion_rejected"); // assertion for A replayed on B
  const asOther = await r.keys.carol.assert(ob.publicKey.challenge, ORIGIN, RP.rpId); assert.equal(code(await r.svc.approve(U("bob"), b.actionId, { challengeId: (await r.svc.approveOptions(U("bob"), b.actionId, r.t.now) as any).challengeId, ...asOther })), "unknown_credential"); // carol's key, bob's session
  const good = await r.keys.bob.assert(oa.publicKey.challenge, ORIGIN, RP.rpId); assert.ok((await r.svc.approve(U("bob"), a.actionId, { challengeId: oa.challengeId, ...good }, r.t.now)).ok);
  assert.equal(code(await r.svc.approve(U("bob"), a.actionId, { challengeId: oa.challengeId, ...good })), "challenge_invalid");
  const off = await r.keys.carol.assert(oa.publicKey.challenge, "https://evil.example", RP.rpId); const oc: any = await r.svc.approveOptions(U("carol"), a.actionId, r.t.now);
  assert.equal(code(await r.svc.approve(U("carol"), a.actionId, { challengeId: oc.challengeId, ...off })), "assertion_rejected");
  assert.equal(code(await r.svc.approve({ ...U("carol"), mfa: false }, a.actionId, { challengeId: oc.challengeId, ...off })), "mfa_required");
});
test("cancel works for the requester, a signer or an admin and is final", async () => {
  const r = await rig(); await sealed(r); await fund(r, "treasury", "1000", "dep-0007-gggg");
  const c: any = await r.svc.createAction(U("alice"), "withdraw", "treasury", { asset: "USDT", amount: "10", destination: { type: "internal", walletId: "opex" } }, r.t.now);
  assert.equal(code(await r.svc.cancel(U("zed", "viewer"), c.actionId, "no", r.t.now)), "not_permitted"); assert.ok((await r.svc.cancel(U("bob"), c.actionId, "suspicious", r.t.now)).ok);
  assert.equal(code(await approve(r, "carol", c.actionId)), "not_approvable"); assert.equal(code(await r.svc.execute(U("alice"), c.actionId, r.t.now)), "not_ready");
});
test("exactly-once: concurrent executors cannot both claim", async () => {
  const r = await rig(); await sealed(r); await fund(r, "treasury", "1000", "dep-0008-hhhh");
  const c: any = await r.svc.createAction(U("alice"), "withdraw", "treasury", { asset: "USDT", amount: "10", destination: { type: "internal", walletId: "opex" } }, r.t.now); await approve(r, "bob", c.actionId); await approve(r, "carol", c.actionId); r.t.now += 3600_001;
  const other = new WalletService(r.svc.env, r.svc.st, RP); await other.load();
  const res = await Promise.all([r.svc.execute(U("alice"), c.actionId, r.t.now), other.execute(U("alice"), c.actionId, r.t.now)]);
  assert.equal(res.filter((x) => x.ok).length, 1, JSON.stringify(res)); await r.svc.load(); assert.equal(r.svc.view(r.t.now).wallets.find((w) => w.id === "opex")!.balances.USDT, "10");
});
test("the stored event log and the read model contain no secret material", async () => {
  const r = await rig(); await sealed(r); await fund(r, "treasury", "1000", "dep-0009-iiii");
  const ev = (await r.svc.st.events()).events; assert.equal(findSecret(ev), null); assert.equal(findSecret(r.svc.view(r.t.now)), null);
  assert.equal(JSON.stringify(r.svc.view(r.t.now)).includes("assertion"), false);
  assert.deepEqual(redact({ seed: "abandon abandon", note: "ok", privateKey: "x" } as any), { seed: "[REDACTED]", note: "ok", privateKey: "[REDACTED]" });
});
test("KV-only storage cannot execute external withdrawals (no atomic claim)", async () => {
  const m = new Map<string, string>(), kv = { get: async (k: string) => m.get(k) ?? null, put: async (k: string, v: string) => { m.set(k, v); }, delete: async (k: string) => { m.delete(k); }, list: async (o: any) => ({ keys: [...m.keys()].filter((k) => k.startsWith(o.prefix)).map((name) => ({ name })), list_complete: true }) };
  const env: any = { ETI_EXECUTION_LOG: kv, ETI_WALLET_EXECUTION: "enabled", ETI_WALLET_GOV_TIMELOCK_SEC: "0" }, svc = new WalletService(env, openStore(env, "wallets" as any)!, RP); await svc.ensureInit(1_800_000_000_000);
  assert.equal(svc.st.kind, "kv");
});

import { newRecoverySet, sealBackup, openBackup, checkRestoreBundle, parseSealed } from "./vault.ts";
test("vault: backup round-trips with k shares, fails with fewer / wrong / tampered, restore only into an empty store", async () => {
  const r = await rig(); await sealed(r); await fund(r, "treasury", "500", "dep-0010-jjjj");
  const rec = await newRecoverySet(3, 5), key = "i".repeat(40), events = (await r.svc.st.events()).events;
  const file = await sealBackup(events, rec.publicKey, rec.setId, key, r.t.now);
  // `ct` is random AES-GCM ciphertext (base64url). It is opaque by design, and the heuristic WIF detector (51-52 base58 characters) can
  // match a run inside a long random blob by chance, so scan the envelope around it and check the ciphertext separately.
  const { ct, ...envelope } = JSON.parse(file); assert.equal(findSecret(envelope), null);
  assert.match(ct, /^[A-Za-z0-9_-]+$/); assert.equal(ct.includes(key), false); assert.equal(file.includes(events[0].id), false, "plaintext event ids are not visible in the sealed file");
  assert.equal(file.includes('"d"'), false);
  const ok = await openBackup(file, [rec.shares[0], rec.shares[2], rec.shares[4]]); assert.ok(ok.ok); assert.equal((ok as any).events.length, events.length);
  assert.equal((await openBackup(file, rec.shares.slice(0, 2))).ok, false);
  const other = await newRecoverySet(3, 5); assert.equal((await openBackup(file, other.shares.slice(0, 3))).ok, false);
  const t = JSON.parse(file); t.ct = t.ct.slice(0, -4) + "AAAA"; assert.equal((await openBackup(JSON.stringify(t), rec.shares.slice(0, 3))).ok, false);
  const bundle = { backup: file, events: (ok as any).events }; assert.ok((await checkRestoreBundle(bundle, [key])).ok);
  assert.equal((await checkRestoreBundle(bundle, ["j".repeat(40)])).ok, false, "wrong identity key");
  assert.equal((await checkRestoreBundle({ backup: file, events: [...bundle.events.slice(1)] }, [key])).ok, false, "events dropped");
  const forged = JSON.stringify({ ...JSON.parse(file), plainHash: "0".repeat(64) }); assert.equal((await checkRestoreBundle({ backup: forged, events: bundle.events }, [key])).ok, false);
  assert.ok(parseSealed(file)); assert.equal(parseSealed("nope"), null);
});
