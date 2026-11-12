/** GET /api/backup/export (encrypted file), POST /api/backup/restore (body = the sealed file, into an empty database). Operator only: master token or an administrator signed in with MFA. Every use is written to the audit chain. */
import { authenticate, isOperator, rateLimit, refOf, sameOrigin } from "../auth/session.ts";
import { identityKeys, identityUnavailable, openCtx } from "../identity/service.ts";
import { exportBackup, restoreBackup } from "./backup.ts";

const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const reply = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: H });
export async function handleBackup(req: Request, env: any, deps: { now?: () => number } = {}): Promise<Response> {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, ""), now = (deps.now ?? Date.now)();
  if (path !== "/api/backup/export" && path !== "/api/backup/restore") return reply({ error: "not_found" }, 404);
  if (req.method !== (path.endsWith("export") ? "GET" : "POST")) return reply({ error: "method_not_allowed" }, 405);
  if (!req.headers.get("authorization") && !sameOrigin(req) && req.method !== "GET") return reply({ error: "csrf_origin_mismatch" }, 403);
  const why = identityUnavailable(env); if (why) return reply(why, 503);
  const a = await authenticate(req, env, now); if (!isOperator(a)) return reply({ error: "operator_required", message: "Needs the master token or an administrator signed in with MFA." }, a.user || a.master ? 403 : 401);
  const rl = await rateLimit(env, "backup", 10, 600, now); if (!rl.ok) return reply({ error: "rate_limited" }, 429);
  const ctx = (await openCtx(env, now, await refOf(req.headers.get("cf-connecting-ip") || "unknown")))!, actor = a.master ? "master_token" : a.user!.uid, keys = identityKeys(env);
  if (path.endsWith("export")) {
    const { sealed, summary } = await exportBackup(env.ETI_PORTFOLIO_DB, keys, now);
    await ctx.store.audit(now, actor, "backup_exported", null, summary.counts, ctx.ipRef);
    return new Response(sealed, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "content-disposition": `attachment; filename="eti-backup-${new Date(now).toISOString().slice(0, 10)}.etibak"`, "x-eti-backup-counts": JSON.stringify(summary.counts) } });
  }
  const text = await req.text(); if (text.length > 20_000_000) return reply({ error: "too_large" }, 413);
  const r = await restoreBackup(env.ETI_PORTFOLIO_DB, keys, text);
  if (r.ok) await ctx.store.audit(now, actor, "backup_restored", null, r.restored, ctx.ipRef); else await ctx.store.audit(now, actor, "backup_restore_refused", null, { error: r.error }, ctx.ipRef);
  return r.ok ? reply(r) : reply(r, r.error === "target_not_empty" ? 409 : 400);
}
export function withBackup(inner: { fetch(req: Request, env: any, ctx?: any): Promise<Response> | Response }) {
  return { ...inner, fetch: (req: Request, env: any, ctx?: any) => new URL(req.url).pathname.startsWith("/api/backup/") ? handleBackup(req, env) : inner.fetch(req, env, ctx) };
}
