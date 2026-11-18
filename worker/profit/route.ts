/**
 * /profit dashboard and /api/profit/*. Read access needs a treasury-ledger reader (operator, executive, finance or accountant);
 * running a cycle needs an operator or an allocator with MFA. The engine itself never moves funds (see engine.ts).
 *
 *   GET  /api/profit/status?environment=        realized vs pending vs excluded, protection, recommendation
 *   GET  /api/profit/report?environment=&period=YYYY-Qn|YYYY-MM|all&format=json|md|csv
 *   GET  /api/profit/forecast?environment=&months=
 *   POST /api/profit/run                        {"environment":"simulated"}: recognise and allocate now (simulated books only)
 */
import { authenticate, isOperator, rateLimit } from "../auth/session.ts";
import { treasuryInternals as TI } from "../treasury/api.ts";
import * as T from "../treasury/model.ts";
import { profitPage } from "./page.ts";
import { expenseForecast, financialReport, profitState, reportCsv, reportMarkdown, runProfitCycle } from "./engine.ts";

interface App<E> { fetch(request: Request, env: E, ctx?: any): Promise<Response> | Response }
const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: H });

export function withProfit<E extends Record<string, any>>(base: App<E>): App<E> {
  return { async fetch(request, env, ctx) {
    const url = new URL(request.url), path = url.pathname.replace(/\/+$/, "") || "/";
    if (request.method === "GET" && path === "/profit") return new Response(profitPage(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "same-origin" } });
    if (path !== "/api/profit" && !path.startsWith("/api/profit/")) return base.fetch(request, env, ctx);
    try {
      const now = Date.now(), auth = await authenticate(request, env as any, now), operator = isOperator(auth);
      if (!operator && !auth.user) return json({ error: "unauthorized", message: "Sign in with an ETI account." }, 401);
      const db = env.ETI_PORTFOLIO_DB; if (!db) return json({ error: "profit_storage_not_configured", message: "Bind the ETI_PORTFOLIO_DB D1 database." }, 503);
      if (!auth.master) { const rl = await rateLimit(env as any, "pf:" + (auth.user ? auth.user.uid : "op"), 120, 600, now); if (!rl.ok) return json({ error: "rate_limited" }, 429); }
      await TI.ensureSchema(db);
      const actor = await TI.loadActor(db, auth, operator);
      if (!T.canReadLedger(actor)) return json({ error: "forbidden", message: "Profit management is visible to the operator and to executive, finance and accounting roles." }, 403);
      const sub = path.slice("/api/profit".length) || "/", q = url.searchParams, environment = q.get("environment") ?? (request.method === "POST" ? undefined : "simulated");
      const parseEnv = (v: unknown): T.Environment | null => (v === "actual" || v === "simulated" ? v : null);
      if (request.method === "GET" && sub === "/status") { const e = parseEnv(environment); if (!e) return json({ error: "environment_required", allowed: T.ENVIRONMENTS }, 400); return json(await profitState(env, e, now)); }
      if (request.method === "GET" && sub === "/forecast") { const e = parseEnv(environment); if (!e) return json({ error: "environment_required", allowed: T.ENVIRONMENTS }, 400); return json(await expenseForecast(env, e, Number(q.get("months") ?? 3) || 3, now)); }
      if (request.method === "GET" && sub === "/report") {
        const e = parseEnv(environment); if (!e) return json({ error: "environment_required", allowed: T.ENVIRONMENTS }, 400);
        const period = q.get("period") ?? TI.quarterOf(now), fmt = q.get("format") ?? "json";
        let r; try { r = await financialReport(env, e, period, now); } catch (x: any) { if (x?.message === "invalid_period") return json({ error: "invalid_period", message: "Use YYYY-Qn, YYYY-MM or all." }, 400); throw x; }
        if (fmt === "md") return new Response(reportMarkdown(r), { headers: { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
        if (fmt === "csv") return new Response(reportCsv(r), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="eti-${e}-${period}.csv"`, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
        if (fmt !== "json") return json({ error: "invalid_format", allowed: ["json", "md", "csv"] }, 400);
        return json(r);
      }
      if (request.method === "POST" && sub === "/run") {
        if (!operator && !T.canAllocate(actor)) return json({ error: "forbidden", message: "Running the profit cycle needs the operator or an MFA-verified executive/finance approver." }, 403);
        let body: any = {}; try { const t = await request.text(); if (t) body = JSON.parse(t); } catch { return json({ error: "invalid_json" }, 400); }
        const e = parseEnv(body.environment ?? "simulated"); if (!e) return json({ error: "environment_required" }, 400);
        if (e === "actual") return json({ error: "actual_books_are_never_automatic", message: "Real-funds profit is recorded through /api/treasury/profit-batches with three-person approval. See /api/profit/status for what is eligible." }, 409);
        return json(await runProfitCycle(env, e, now, { force: true }));
      }
      return json({ error: "not_found" }, 404);
    } catch (e) { console.error("profit api", e instanceof Error ? e.message : e); return json({ error: "internal_error" }, 500); }
  } };
}
