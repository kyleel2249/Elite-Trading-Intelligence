/**
 * /api/journal/*: ETI AUTONOMOUS TRADE JOURNAL.
 * The journal is append-only: there is no update or delete route, and PUT/PATCH/DELETE answer 405 journal_is_append_only.
 *   GET  /api/journal/summary                      stats + verification headline + insights
 *   GET  /api/journal/entries?trade=&kind=&symbol=&from=&to=&limit=&before=   raw entries (newest first)
 *   GET  /api/journal/trades?status=&symbol=&strategy=&result=&environment=&origin=&from=&to=
 *   GET  /api/journal/trades/<tradeId>             one trade with its complete timeline
 *   GET  /api/journal/stats | /insights | /verify
 *   GET  /api/journal/export?format=csv|json       complete export (all entries, or trades with format=csv&view=trades)
 *   POST /api/journal/sync                         backfill anything a hook missed + evaluate due predictions
 *   POST /api/journal/manual | /note | /analysis   user-recorded entries (corrections are new notes with `corrects`)
 */
import { authenticate, rateLimit } from "../auth/session.ts";
import { openJournal, verifyChain, type JournalEnv, type JournalEntry } from "./store.ts";
import { buildTrades, computeStats, deriveInsights, type TradeRecord } from "./analytics.ts";
import { fromAnalysis, fromManual, fromNote, validateManual, KINDS } from "./record.ts";
import { syncJournal } from "./sync.ts";

export type JournalApiEnv = JournalEnv & { [k: string]: any };
const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: H });
const cell = (v: unknown) => { let s = v === null || v === undefined ? "" : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const iso = (t: number | null) => (t === null ? "" : new Date(t).toISOString());

export function tradesCsv(trades: TradeRecord[]): string {
  const head = ["trade_id", "status", "origin", "environment", "symbol", "side", "strategy", "decision", "evidence_score", "entry_price", "exit_price", "quantity", "gross_pnl", "fees", "fees_known", "net_pnl", "r_multiple", "result", "first_event", "last_event", "reasons"];
  return [head.join(","), ...trades.map(t => [t.tradeId, t.status, t.origin, t.environment, t.symbol, t.side, t.strategy, t.decision, t.confidence, t.entryPrice, t.exitPrice, t.quantity, t.gross, t.fees, t.feesKnown, t.net, t.r, t.result, iso(t.firstAt), iso(t.lastAt), t.reasons.join(" | ")].map(cell).join(","))].join("\n");
}
export function filterTrades(trades: TradeRecord[], q: URLSearchParams): TradeRecord[] {
  const f = (k: string) => (q.get(k) || "").toLowerCase(), sym = (q.get("symbol") || "").toUpperCase(), from = Date.parse(q.get("from") || ""), to = Date.parse(q.get("to") || "");
  return trades.filter(t => (!f("status") || t.status === f("status")) && (!sym || (t.symbol || "").includes(sym)) && (!f("strategy") || (t.strategy || "").toLowerCase().includes(f("strategy"))) && (!f("result") || t.result === f("result"))
    && (!f("environment") || t.environment === f("environment")) && (!f("origin") || t.origin === f("origin")) && (!Number.isFinite(from) || t.lastAt >= from) && (!Number.isFinite(to) || t.firstAt <= to + 86_399_999));
}

export async function handleJournal(req: Request, env: JournalApiEnv, now = Date.now()): Promise<Response> {
  const url = new URL(req.url), path = url.pathname.replace(/\/+$/, ""), sub = path.replace("/api/journal", "") || "/";
  const auth = await authenticate(req, env as any, now);
  if (!auth.master && auth.scopes.size === 0) return reply({ error: "unauthorized", message: "No valid ETI session or execution token. Open the dashboard to start an automatic session." }, 401);
  if (["PUT", "PATCH", "DELETE"].includes(req.method)) return reply({ error: "journal_is_append_only", message: "Journal entries are never edited or deleted. To correct something, add a note that references the entry it corrects." }, 405);
  const st = openJournal(env);
  if (!st) return reply({ error: "journal_storage_not_configured", message: "Bind the ETI_PORTFOLIO_DB D1 database (recommended: permanent, strictly chained) or the ETI_EXECUTION_LOG KV namespace." }, 503);
  const actorId = auth.master ? "master" : "session:" + (auth.refs.paper || auth.refs.testnet || "unknown");
  if (!auth.master) { const rl = await rateLimit(env as any, "jr:" + actorId, 120, 600, now); if (!rl.ok) return reply({ error: "rate_limited" }, 429); }

  if (req.method === "POST") {
    let body: any; try { body = await req.json(); } catch { return reply({ error: "invalid_json" }, 400); }
    if (sub === "/sync") { const r = await syncJournal(env as any, now); return reply(r, r.ok ? 200 : 207); }
    if (sub === "/manual") {
      const v = validateManual(body); if (!v.ok) return reply({ error: v.error }, 400);
      const r = await st.append(await fromManual(v.v, actorId), now);
      return reply({ ok: true, created: r.created, entry: r.entry }, r.created ? 201 : 200);
    }
    if (sub === "/note") {
      const tradeId = typeof body?.tradeId === "string" ? body.tradeId.slice(0, 120) : "", text = typeof body?.text === "string" ? body.text.trim() : "";
      if (!tradeId || !text) return reply({ error: "tradeId_and_text_required" }, 400);
      if (body.corrects != null && !(await st.get(String(body.corrects)))) return reply({ error: "corrected_entry_not_found" }, 404);
      const r = await st.append(await fromNote(tradeId, text, actorId, { tags: Array.isArray(body.tags) ? body.tags : [], corrects: body.corrects ?? null, at: now }), now);
      return reply({ ok: true, created: r.created, entry: r.entry }, 201);
    }
    if (sub === "/analysis") {
      const symbol = typeof body?.symbol === "string" ? body.symbol : "", decision = typeof body?.decision === "string" ? body.decision.toUpperCase() : "";
      if (!/^[A-Za-z0-9._-]{2,24}$/.test(symbol) || !["BUY", "SELL", "NO_TRADE", "WATCH"].includes(decision)) return reply({ error: "invalid_symbol_or_decision" }, 400);
      const r = await st.append(await fromAnalysis({ symbol, decision, strategy: body.strategy, confidence: body.confidence, entryZone: body.entryZone, stop: body.stop, targets: body.targets, referencePrice: body.referencePrice, horizonMs: body.horizonMs, rationale: body.rationale, environment: body.environment ?? "manual", actor: actorId, at: now }), now);
      return reply({ ok: true, created: r.created, entry: r.entry }, 201);
    }
    return reply({ error: "not_found" }, 404);
  }
  if (req.method !== "GET") return reply({ error: "method_not_allowed" }, 405);

  const { entries, truncated } = await st.all(), q = url.searchParams;
  if (sub === "/entries") {
    const trade = q.get("trade"), kind = q.get("kind"), sym = (q.get("symbol") || "").toUpperCase(), from = Date.parse(q.get("from") || ""), to = Date.parse(q.get("to") || ""), before = Number(q.get("before")) || Infinity, limit = Math.min(500, Math.max(1, Number(q.get("limit")) || 100));
    if (kind && !(KINDS as readonly string[]).includes(kind)) return reply({ error: "invalid_kind", kinds: KINDS }, 400);
    const rows = entries.filter(e => (!trade || e.tradeId === trade) && (!kind || e.kind === kind) && (!sym || e.symbol === sym) && (!Number.isFinite(from) || e.at >= from) && (!Number.isFinite(to) || e.at <= to + 86_399_999) && e.seq < before).sort((a, b) => b.seq - a.seq);
    return reply({ total: rows.length, entries: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1].seq : null, truncated });
  }
  if (sub === "/trades") { const t = filterTrades(buildTrades(entries), q); return reply({ total: t.length, trades: t.slice(0, Math.min(1000, Number(q.get("limit")) || 300)).map(({ timeline, ...r }) => ({ ...r, events: timeline.length })), truncated }); }
  if (sub.startsWith("/trades/")) {
    const id = decodeURIComponent(sub.slice(8)), t = buildTrades(entries.filter(e => e.tradeId === id))[0];
    return t ? reply({ trade: t, entries: entries.filter(e => e.tradeId === id) }) : reply({ error: "trade_not_found" }, 404);
  }
  if (sub === "/stats") return reply({ ...computeStats(entries, now), truncated });
  if (sub === "/insights") return reply({ insights: deriveInsights(computeStats(entries, now)), note: "Rule-based suggestions for the human reviewer. They never change trading behaviour or any recorded entry." });
  if (sub === "/verify") return reply(await verifyChain(st));
  if (sub === "/summary") { const stats = computeStats(entries, now), v = await verifyChain(st); return reply({ stats, insights: deriveInsights(stats), verification: { ok: v.ok, entries: v.entries, head: v.head, storage: v.storage, note: v.note }, lastSync: await st.meta("lastSync", null), truncated }); }
  if (sub === "/export") {
    const fmt = q.get("format") || "json";
    if (fmt === "csv") { const body = q.get("view") === "entries" ? entriesCsv(entries) : tradesCsv(buildTrades(entries)); return new Response(body, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="eti-journal-${q.get("view") === "entries" ? "entries" : "trades"}.csv"`, "cache-control": "no-store" } }); }
    return new Response(JSON.stringify({ exportedAt: now, storage: st.kind, truncated, entries }), { headers: { ...H, "content-disposition": 'attachment; filename="eti-journal.json"' } });
  }
  return reply({ error: "not_found" }, 404);
}
function entriesCsv(entries: JournalEntry[]): string {
  return ["seq,id,at,recorded_at,kind,trade_id,symbol,environment,source,actor,corrects,hash,data", ...entries.map(e => [e.seq, e.id, iso(e.at), iso(e.recordedAt), e.kind, e.tradeId, e.symbol, e.environment, e.source, e.actor, e.corrects, e.hash, JSON.stringify(e.data)].map(cell).join(","))].join("\n");
}
