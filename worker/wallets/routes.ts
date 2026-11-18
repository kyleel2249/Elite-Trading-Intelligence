/**
 * /api/wallets/*  and the /wallets page. Auth is a real user session with MFA (the master token may only read and freeze).
 *   GET  state                         wallets, signers, whitelist, actions (viewer role trader+ or master)
 *   POST configure | signers/designate | recovery/register | seal            setup, administrators, before sealing only
 *   POST enroll/options | enroll/verify                                      a designated signer registers a hardware key (WebAuthn)
 *   POST actions {kind,walletId,input}                                       propose a withdrawal or governance change
 *   POST actions/<id>/approve-options | approve | cancel | execute | resolve
 *   POST freeze                                                              any signer, any administrator or the master token
 *   GET  backup                                                              encrypted backup file (operator only)
 *   POST recovery/restore                                                    bundle from scripts/wallet-recover.mjs into an EMPTY wallet store (operator only)
 * Every request body is scanned: anything that looks like a seed phrase, private key or passphrase is refused with 422 and is never echoed, stored or logged.
 */
import { authenticate, isOperator, rateLimit, refOf, sameOrigin } from "../auth/session.ts";
import { identityKeys, identityUnavailable, openCtx } from "../identity/service.ts";
import { storageConfigured } from "../portfolio/store.ts";
import { findSecret, redact } from "./redact.ts";
import { WalletService, rpFor, walletStore, type Actor, type WalletEnv } from "./service.ts";
import { checkRestoreBundle, sealBackup } from "./vault.ts";
import { WALLETS_HTML } from "./ui.ts";
import { ROLE_RANK } from "./model.ts";

const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: H });
const fail = (r: { status: number; error: string; message?: string }) => reply({ error: r.error, message: r.message }, r.status);
const MAX_BODY = 200_000;

export async function handleWallets(req: Request, env: WalletEnv & Record<string, any>, deps: { now?: () => number; fetchImpl?: typeof fetch } = {}): Promise<Response> {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, ""), now = (deps.now ?? Date.now)();
  if (path === "/wallets") return new Response(WALLETS_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
  const sub = path.replace(/^\/api\/wallets\/?/, ""), post = req.method === "POST";
  if (req.method !== "GET" && !post) return reply({ error: "method_not_allowed" }, 405);
  if (post && !req.headers.get("authorization") && !sameOrigin(req)) return reply({ error: "csrf_origin_mismatch" }, 403);
  const why = identityUnavailable(env); if (why) return reply(why, 503);
  if (!storageConfigured(env)) return reply({ error: "storage_unavailable", message: "Bind the ETI_PORTFOLIO_DB D1 database." }, 503);
  const au = await authenticate(req, env, now), u = au.user;
  const actor: Actor | null = u && !u.limited ? { uid: u.uid, role: u.role, mfa: u.mfa, email: u.email } : au.master ? { uid: "", role: "", mfa: false, master: true } : null;
  if (!actor) return reply({ error: "unauthorized", message: "Sign in at /account (multi-factor sign-in is required)." }, 401);
  const rl = await rateLimit(env, "wallets" + (post ? "w" : "r"), post ? 60 : 240, 60, now); if (!rl.ok) return reply({ error: "rate_limited" }, 429);
  const st = walletStore(env)!, svc = new WalletService(env, st, rpFor(env, url), deps.fetchImpl ?? fetch);
  const ctx = (await openCtx(env, now, await refOf(req.headers.get("cf-connecting-ip") || "unknown")))!, who = actor.master ? "master_token" : actor.uid;
  const audit = (action: string, target: string | null, detail: unknown) => ctx.store.audit(now, who, "wallet_" + action, target, redact(detail), ctx.ipRef);

  if (!post) {
    if (sub === "state") {
      if (!actor.master && ROLE_RANK[actor.role] < ROLE_RANK.trader) return reply({ error: "forbidden", message: "Wallet details are visible to trader and admin accounts." }, 403);
      await svc.load(); return reply({ ...svc.view(now, actor), viewer: actor.master ? { master: true } : { uid: actor.uid, role: actor.role, email: actor.email } });
    }
    if (sub === "backup") {
      if (!isOperator(au)) return reply({ error: "operator_required" }, 403);
      const rl2 = await rateLimit(env, "walletbackup", 10, 600, now); if (!rl2.ok) return reply({ error: "rate_limited" }, 429);
      await svc.load(); const S = svc.S; if (!S.recovery) return reply({ error: "no_recovery_key", message: "Register a recovery public key first (see docs/WALLETS.md)." }, 409);
      const key = identityKeys(env)[0]; if (!key) return reply({ error: "identity_key_missing" }, 503);
      const events = (await st.events()).events, file = await sealBackup(events, S.recovery.publicKey, S.recovery.setId, key, now);
      await audit("backup_exported", null, { events: events.length, setId: S.recovery.setId });
      return new Response(file, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "content-disposition": `attachment; filename="eti-wallets-${new Date(now).toISOString().slice(0, 10)}.etibak"` } });
    }
    return reply({ error: "not_found" }, 404);
  }

  const raw = await req.text(); if (raw.length > MAX_BODY) return reply({ error: "too_large" }, 413);
  let body: any; try { body = raw ? JSON.parse(raw) : {}; } catch { return reply({ error: "bad_json" }, 400); }
  if (sub !== "recovery/restore") { const hit = findSecret(body); if (hit) { await audit("secret_refused", null, { path: hit.path, kind: hit.kind }); return reply({ error: "secret_material_rejected", message: "That looks like a seed phrase, private key or passphrase. ETI never accepts or stores these. Nothing was saved." }, 422); } }
  await svc.ensureInit(now);
  const done = async (r: { ok: boolean } & Record<string, any>, action: string, target: string | null, detail: unknown = {}) => { if (r.ok) { await audit(action, target, detail); return reply(r); } await audit(action + "_refused", target, { error: r.error }); return fail(r as any); };

  switch (sub) {
    case "configure": return done(await svc.configure(actor, body, now), "configure", body.walletId, { walletId: body.walletId, fields: ["policy", "custody", "depositAddresses"].filter((k) => body[k] !== undefined) });
    case "signers/designate": { const r = await svc.designate(actor, body, now); return done(r, "signer_designated", body.uid, { uid: body.uid, wallets: body.wallets }); }
    case "recovery/register": return done(await svc.setRecovery(actor, body, now), "recovery_registered", body.setId, { k: body.k, n: body.n, setId: body.setId });
    case "seal": return done(await svc.seal(actor, now), "sealed", null);
    case "enroll/options": { const r = await svc.enrollOptions(actor, now); return r.ok ? reply(r) : fail(r); }
    case "enroll/verify": return done(await svc.enrollVerify(actor, body, now), "signer_enrolled", actor.uid);
    case "actions": { const r = await svc.createAction(actor, String(body.kind), body.walletId ?? null, body.input ?? {}, now); return done(r, "action_created", (r as any).actionId ?? null, { kind: body.kind, walletId: body.walletId ?? null, input: body.input }); }
    case "freeze": return done(await svc.freeze(actor, String(body.reason ?? ""), now), "frozen", null, { reason: body.reason });
    case "recovery/restore": {
      if (!isOperator(au)) return reply({ error: "operator_required" }, 403);
      await svc.load(); if (svc.S.eventCount > 1 || svc.S.sealed) return reply({ error: "target_not_empty", message: "Restore only into an empty wallet store." }, 409);
      const c = await checkRestoreBundle(body, identityKeys(env)); if (!c.ok) { await audit("restore_refused", null, { error: c.error }); return reply({ error: "restore_refused", message: c.error }, 422); }
      let n = 0; for (const ev of c.events) if (await st.append(ev, { idempotent: true })) n++;
      await audit("restored", c.backup.setId, { events: n, backupAt: c.backup.createdAt }); return reply({ ok: true, restored: n });
    }
  }
  const m = /^actions\/(act_[a-f0-9]{20})\/(approve-options|approve|cancel|execute|resolve)$/.exec(sub);
  if (m) {
    const [, id, op] = m; await svc.load();
    if (op === "approve-options") { const r = await svc.approveOptions(actor, id, now); return r.ok ? reply(r) : fail(r); }
    if (op === "approve") return done(await svc.approve(actor, id, body, now), "approved", id);
    if (op === "cancel") return done(await svc.cancel(actor, id, String(body.reason ?? ""), now), "cancelled", id, { reason: body.reason });
    if (op === "execute") { const r = await svc.execute(actor, id, now); return done(r, "executed", id, { status: (r as any).status, ref: (r as any).ref }); }
    return done(await svc.resolve(actor, id, String(body.outcome), String(body.ref ?? ""), String(body.note ?? ""), now), "resolved", id, { outcome: body.outcome, ref: body.ref });
  }
  return reply({ error: "not_found" }, 404);
}
export function withWallets(inner: { fetch(req: Request, env: any, ctx?: any): Promise<Response> | Response }) {
  return { ...inner, fetch: (req: Request, env: any, ctx?: any) => { const p = new URL(req.url).pathname; return p === "/wallets" || p === "/wallets/" || p.startsWith("/api/wallets/") ? handleWallets(req, env) : inner.fetch(req, env, ctx); } };
}
