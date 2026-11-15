/**
 * /api/treasury/*: ETI corporate treasury on an immutable double-entry ledger.
 *
 * Environments: every call names `environment` = actual | simulated. Balances, ledgers, hash chains, policies and profit batches are kept
 * strictly apart; there is no operation that touches both. Company expenses can only be posted in `actual`.
 *
 *   GET  /accounts   /balances[?environment=&department=]   /ledger?environment=   /verify?environment=   /report?environment=
 *   GET  /policy?environment=   POST /policy   POST /policy/<id>/decision        (propose, then a different person approves)
 *   GET|POST /profit-batches    POST /profit-batches/<id>/settle | /reconcile | /reject
 *   GET  /allocations/plan?environment=     POST /allocations                  (spends the realized-profits pool per the active policy)
 *   POST /contributions   POST /department-funding   POST /expenses/<companyExpenseId>/post   POST /liabilities   POST /liabilities/settle
 *
 * Money enters Realized profits only when a profit batch has been recorded, settled and reconciled by three different people. Allocation can
 * only draw from that pool. Every state change is one D1 batch: the hash-chained ledger entry, its lines and the balance updates commit
 * together or not at all, and the database itself rejects negative bucket balances, forked chains and double posting.
 * This module records and controls money; it does not move funds or connect to a bank or exchange.
 */
import { authenticate, isOperator, rateLimit, sha256Hex, type Auth } from "../auth/session.ts";
import { canReadDept, parseCents, seesAll, validPeriod, periodOf as quarterOf, type Actor, type CompanyRole } from "../company/model.ts";
import { SCHEMA as COMPANY_SCHEMA } from "../company/schema.ts";
import * as T from "./model.ts";
import { SCHEMA, TRIGGERS } from "./schema.ts";

interface D1Stmt { bind(...v: unknown[]): D1Stmt; first<R = any>(): Promise<R | null>; all<R = any>(): Promise<{ results: R[] }>; run(): Promise<{ meta?: { changes?: number } }> }
interface D1 { prepare(sql: string): D1Stmt; batch(s: D1Stmt[]): Promise<Array<{ results?: any[]; meta?: { changes?: number } }>> }
export type TreasuryEnv = { ETI_PORTFOLIO_DB?: D1; [k: string]: any };

const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: H });
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const idOk = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);
class HttpError extends Error { status: number; body: Record<string, unknown>; constructor(status: number, error: string, extra: Record<string, unknown> = {}) { super(error); this.status = status; this.body = { error, ...extra }; } }
const deny = (error = "forbidden", status = 403, extra: Record<string, unknown> = {}) => new HttpError(status, error, extra);

let ready: Promise<void> | null = null;
let triggersPresent = false;
function ensureSchema(db: D1): Promise<void> {
  if (!ready) ready = (async () => {
    await db.batch([...COMPANY_SCHEMA, ...SCHEMA].map(s => db.prepare(s)));
    let ok = true;
    for (const t of TRIGGERS) { try { await db.prepare(t).run(); } catch { ok = false; } }
    triggersPresent = ok;
  })().catch(e => { ready = null; throw e; });
  return ready;
}

async function loadActor(db: D1, auth: Auth, operator: boolean): Promise<Actor> {
  const id = auth.user ? auth.user.uid : "master", email = (auth.user?.email || "").toLowerCase();
  const rows = auth.user ? (await db.prepare("SELECT department_id, role FROM company_members WHERE active = 1 AND (user_id = ? OR user_id = ?)").bind(id, email || id).all<{ department_id: string; role: CompanyRole }>()).results : [];
  return { id, email, operator, mfa: !!auth.user?.mfa && !auth.user.limited, memberships: rows.map(r => ({ department: r.department_id, role: r.role })) };
}

const envOf = (v: unknown): T.Environment => { if (v === "actual" || v === "simulated") return v; throw deny("environment_required", 400, { allowed: T.ENVIRONMENTS }); };

interface PostInput { id: string; env: T.Environment; kind: string; actor: string; reference: string | null; period: string | null; memo: string; lines: T.Line[]; pre?: Array<{ stmt: D1Stmt; mustChange?: boolean }>; after?: D1Stmt[]; failCode?: string }

function classify(e: unknown, failCode?: string): HttpError {
  const msg = String((e as Error)?.message ?? e);
  if (/balance_guard|balance_cents >= 0/.test(msg)) return deny("insufficient_funds", 409, { message: "The account would go below zero. Nothing was posted." });
  if (/policy_guard|policy_ok = 1/.test(msg)) return deny(failCode || "precondition_failed", 409);
  if (/loss_guard|unrecovered_loss_cents >= 0/.test(msg)) return deny("loss_recovery_exceeds_unrecovered_loss", 409);
  if (/UNIQUE/i.test(msg)) return deny("reference_already_used", 409, { message: "This reference or settlement is already recorded." });
  if (/immutable/i.test(msg)) return deny("ledger_is_immutable", 409);
  console.error("treasury write failed", msg.slice(0, 300));
  return deny("treasury_write_failed", 500);
}

/** Posts one balanced, hash-chained ledger entry atomically. Retries a few times if another writer advanced the chain first. */
async function postEntry(db: D1, now: number, p: PostInput): Promise<{ id: string; seq: number; hash: string }> {
  const bad = T.validateLines(p.lines); if (bad) throw deny(bad, 400);
  for (let attempt = 0; attempt < 4; attempt++) {
    const head = await db.prepare("SELECT seq, head_hash FROM treasury_chain WHERE environment = ?").bind(p.env).first<{ seq: number; head_hash: string }>();
    if (!head) throw deny("treasury_chain_missing", 500);
    const seq = head.seq + 1;
    const hash = await sha256Hex(T.canonicalEntry({ prev: head.head_hash, seq, environment: p.env, kind: p.kind, at: now, actor: p.actor, reference: p.reference, period: p.period, memo: p.memo, lines: p.lines }));
    const stmts: D1Stmt[] = [
      db.prepare("UPDATE treasury_chain SET seq = ?, head_hash = ? WHERE environment = ? AND seq = ? AND head_hash = ?").bind(seq, hash, p.env, head.seq, head.head_hash),
      db.prepare("INSERT INTO treasury_guard (chain_ok) SELECT 0 WHERE changes() = 0"),
    ];
    for (const x of p.pre ?? []) { stmts.push(x.stmt); if (x.mustChange) stmts.push(db.prepare("INSERT INTO treasury_guard (policy_ok) SELECT 0 WHERE changes() = 0")); }
    const deltas = new Map<string, { account: string; dept: string; delta: number }>();
    for (const l of p.lines) {
      const a = T.accountOf(l.account)!, key = l.account + "|" + l.department, d = T.signedDelta(a.type, l.debit, l.credit);
      deltas.set(key, { account: l.account, dept: l.department, delta: (deltas.get(key)?.delta ?? 0) + d });
    }
    for (const v of deltas.values()) stmts.push(db.prepare("INSERT OR IGNORE INTO treasury_balances (environment, account_code, department_id, allow_negative, balance_cents) VALUES (?, ?, ?, ?, 0)").bind(p.env, v.account, v.dept, T.nonNegative(T.accountOf(v.account)!.type) ? 0 : 1));
    stmts.push(db.prepare("INSERT INTO treasury_entries (id, environment, seq, kind, at, actor, reference, period, memo, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(p.id, p.env, seq, p.kind, now, p.actor, p.reference, p.period, p.memo, head.head_hash, hash));
    p.lines.forEach((l, i) => stmts.push(db.prepare("INSERT INTO treasury_lines (entry_id, line_no, account_code, department_id, debit_cents, credit_cents) VALUES (?, ?, ?, ?, ?, ?)").bind(p.id, i + 1, l.account, l.department, l.debit, l.credit)));
    for (const v of deltas.values()) stmts.push(db.prepare("UPDATE treasury_balances SET balance_cents = balance_cents + ? WHERE environment = ? AND account_code = ? AND department_id = ?").bind(v.delta, p.env, v.account, v.dept));
    stmts.push(...(p.after ?? []));
    try { await db.batch(stmts); return { id: p.id, seq, hash }; }
    catch (e) { if (/chain_guard|chain_ok = 1/.test(String((e as Error)?.message ?? e))) continue; throw classify(e, p.failCode); }
  }
  throw deny("ledger_busy_retry", 409);
}

async function readBalances(db: D1, env: T.Environment) {
  const rows = (await db.prepare("SELECT account_code, department_id, balance_cents FROM treasury_balances WHERE environment = ?").bind(env).all<any>()).results;
  const get = (code: string) => rows.find(r => r.account_code === code && r.department_id === "*")?.balance_cents ?? 0;
  const departments: Record<string, number> = {};
  for (const r of rows) if (r.account_code === "1600") departments[r.department_id] = r.balance_cents;
  const state = await db.prepare("SELECT unrecovered_loss_cents FROM treasury_state WHERE environment = ?").bind(env).first<any>();
  const b: T.Balances = { tradingCapital: get("1100"), realizedProfits: get("1200"), operatingFunds: get("1300"), emergencyReserve: get("1400"), longTermInvestments: get("1500"), departmentBudgets: Object.values(departments).reduce((s, v) => s + v, 0), liabilities: get("2100") };
  return { rows, b, departments, ownerCapital: get("3100"), tradingRevenue: get("4100"), operatingExpenses: get("5100"), tradingLosses: get("5200"), unrecoveredLoss: (state?.unrecovered_loss_cents ?? 0) as number };
}
const balanceView = (env: T.Environment, r: Awaited<ReturnType<typeof readBalances>>) => ({
  environment: env,
  funds: env === "actual" ? "actual funds" : "SIMULATED - not real money",
  buckets: { trading_capital: r.b.tradingCapital, realized_profits: r.b.realizedProfits, operating_funds: r.b.operatingFunds, emergency_reserve: r.b.emergencyReserve, long_term_investments: r.b.longTermInvestments, department_budgets_total: r.b.departmentBudgets, outstanding_liabilities: r.b.liabilities },
  department_budgets: r.departments,
  owner_capital: r.ownerCapital, trading_revenue: r.tradingRevenue, operating_expenses: r.operatingExpenses, trading_losses: r.tradingLosses,
  unrecovered_loss_cents: r.unrecoveredLoss,
  liquid_funds_cents: T.liquidFunds(r.b),
});
const policyOf = (r: any): T.Policy => ({ minTradingCapitalCents: r.min_trading_capital_cents, lossRecoveryBps: r.loss_recovery_bps, reserveTargetCents: r.reserve_target_cents, reserveBps: r.reserve_bps, liquidityMinCents: r.liquidity_min_cents, operatingBps: r.operating_bps, longTermBps: r.long_term_bps, reinvestBps: r.reinvest_bps });
const activePolicy = (db: D1, env: T.Environment) => db.prepare("SELECT * FROM treasury_policies WHERE environment = ? AND status = 'active'").bind(env).first<any>();
const guardIfNoChange = (db: D1) => db.prepare("INSERT INTO treasury_guard (policy_ok) SELECT 0 WHERE changes() = 0");
const changed = (r: { meta?: { changes?: number } } | undefined) => (r?.meta?.changes ?? 0) > 0;

async function verify(db: D1, env: T.Environment) {
  const entries = (await db.prepare("SELECT * FROM treasury_entries WHERE environment = ? ORDER BY seq LIMIT 20000").bind(env).all<any>()).results;
  const lines = (await db.prepare("SELECT l.* FROM treasury_lines l JOIN treasury_entries e ON e.id = l.entry_id WHERE e.environment = ? ORDER BY e.seq, l.line_no").bind(env).all<any>()).results;
  const byEntry = new Map<string, any[]>(); for (const l of lines) (byEntry.get(l.entry_id) ?? byEntry.set(l.entry_id, []).get(l.entry_id)!).push(l);
  const issues: string[] = [], computed = new Map<string, number>();
  let prev = "GENESIS";
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i], ls: T.Line[] = (byEntry.get(e.id) ?? []).map(l => ({ account: l.account_code, department: l.department_id, debit: l.debit_cents, credit: l.credit_cents }));
    if (e.seq !== i + 1) issues.push(`entry ${e.id}: sequence gap at ${i + 1}`);
    if (e.prev_hash !== prev) issues.push(`entry ${e.seq}: previous hash does not match`);
    const bad = T.validateLines(ls); if (bad) issues.push(`entry ${e.seq}: ${bad}`);
    const h = await sha256Hex(T.canonicalEntry({ prev: e.prev_hash, seq: e.seq, environment: env, kind: e.kind, at: e.at, actor: e.actor, reference: e.reference, period: e.period, memo: e.memo, lines: ls }));
    if (h !== e.hash) issues.push(`entry ${e.seq}: content does not match its hash`);
    prev = e.hash;
    for (const l of ls) { const a = T.accountOf(l.account); if (!a) continue; const k = l.account + "|" + l.department; computed.set(k, (computed.get(k) ?? 0) + T.signedDelta(a.type, l.debit, l.credit)); }
  }
  const chain = await db.prepare("SELECT seq, head_hash FROM treasury_chain WHERE environment = ?").bind(env).first<any>();
  if (chain && (chain.seq !== entries.length || chain.head_hash !== prev)) issues.push("chain head does not match the last entry");
  const stored = (await db.prepare("SELECT account_code, department_id, balance_cents FROM treasury_balances WHERE environment = ?").bind(env).all<any>()).results;
  const seen = new Set<string>();
  for (const r of stored) { const k = r.account_code + "|" + r.department_id; seen.add(k); if ((computed.get(k) ?? 0) !== r.balance_cents) issues.push(`balance ${k}: stored ${r.balance_cents}, ledger ${computed.get(k) ?? 0}`); }
  for (const [k, v] of computed) if (!seen.has(k) && v !== 0) issues.push(`balance ${k}: missing, ledger ${v}`);
  const trig = (await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'treasury_%'").first<any>())?.n ?? 0;
  return { ok: issues.length === 0, environment: env, entries: entries.length, head: prev, issues, immutability_triggers: trig >= TRIGGERS.length, triggers_found: trig, note: trig >= TRIGGERS.length ? undefined : "Database triggers are missing; immutability then rests on the application having no edit or delete route and on this hash chain." };
}

export async function handleTreasury(req: Request, env: TreasuryEnv, now = Date.now()): Promise<Response> {
  const url = new URL(req.url), sub = url.pathname.replace(/\/+$/, "").slice("/api/treasury".length) || "/";
  try { return await route(req, env, url, sub, now); }
  catch (e) {
    if (e instanceof HttpError) return reply(e.body, e.status);
    console.error("treasury api", e instanceof Error ? e.message : e);
    return reply({ error: "internal_error" }, 500);
  }
}

async function route(req: Request, env: TreasuryEnv, url: URL, sub: string, now: number): Promise<Response> {
  const auth = await authenticate(req, env as any, now), operator = isOperator(auth);
  if (!operator && !auth.user) throw deny("unauthorized", 401, { message: "Sign in with an ETI account." });
  const db = env.ETI_PORTFOLIO_DB;
  if (!db) throw deny("treasury_storage_not_configured", 503, { message: "Bind the ETI_PORTFOLIO_DB D1 database." });
  if (!auth.master) { const rl = await rateLimit(env as any, "tr:" + (auth.user ? auth.user.uid : "op"), 240, 600, now); if (!rl.ok) throw deny("rate_limited", 429); }
  try { await ensureSchema(db); } catch { throw deny("treasury_schema_unavailable", 503); }
  const actor = await loadActor(db, auth, operator), q = url.searchParams, method = req.method;
  const [res, id, act] = sub.split("/").filter(Boolean);
  if (!["GET", "POST"].includes(method)) throw deny("method_not_allowed", 405);
  let body: any = {};
  if (method === "POST") {
    const text = await req.text();
    if (text.length > 20_000) throw deny("payload_too_large", 413);
    try { body = text ? JSON.parse(text) : {}; } catch { throw deny("invalid_json", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
  }
  if (id !== undefined && !idOk(id)) throw deny("invalid_id", 400);
  const limitOf = () => Math.min(200, Math.max(1, Number(q.get("limit")) || 50));
  const needRead = () => { if (!T.canReadLedger(actor)) throw deny(); };
  const cents = (v: unknown, name = "amountCents") => { const c = parseCents(v); if (c === null) throw deny("invalid_" + name, 400); return c; };
  const ref = (v: unknown, prefix: string, requiredForActual: boolean, e: T.Environment) => { const r = str(v, 120); if (!r && requiredForActual && e === "actual") throw deny("reference_required", 400, { message: "Actual funds need an external reference (bank, exchange or custody record)." }); return r ? prefix + r : null; };
  const view = (e: any) => ({ id: e.id, seq: e.seq, hash: e.hash });

  if (res === "accounts" && method === "GET") return reply({ accounts: T.ACCOUNTS });

  if (res === "balances" && method === "GET") {
    const e = q.get("environment"), dept = q.get("department");
    if (!T.canReadLedger(actor)) {
      if (!dept) throw deny();
      const d = await db.prepare("SELECT id FROM company_departments WHERE id = ? OR code = ?").bind(dept, dept.toUpperCase()).first<any>();
      if (!d || !canReadDept(actor, d.id)) throw deny();
      const env2 = envOf(e), r = await readBalances(db, env2);
      return reply({ environment: env2, department: d.id, department_budget_cents: r.departments[d.id] ?? 0 });
    }
    if (e) { const env2 = envOf(e); return reply(balanceView(env2, await readBalances(db, env2))); }
    return reply({ actual: balanceView("actual", await readBalances(db, "actual")), simulated: balanceView("simulated", await readBalances(db, "simulated")), note: "The two environments are never added together." });
  }

  if (res === "ledger" && method === "GET") {
    needRead(); const e = envOf(q.get("environment")), before = Number(q.get("before")) || Infinity;
    const entries = (await db.prepare(`SELECT * FROM treasury_entries WHERE environment = ?${Number.isFinite(before) ? " AND seq < ?" : ""} ORDER BY seq DESC LIMIT ?`).bind(e, ...(Number.isFinite(before) ? [before] : []), limitOf()).all<any>()).results;
    const lines = entries.length ? (await db.prepare(`SELECT * FROM treasury_lines WHERE entry_id IN (${entries.map(() => "?").join(",")}) ORDER BY entry_id, line_no`).bind(...entries.map(x => x.id)).all<any>()).results : [];
    return reply({ environment: e, entries: entries.map(x => ({ ...x, lines: lines.filter(l => l.entry_id === x.id) })) });
  }

  if (res === "verify" && method === "GET") { needRead(); return reply(await verify(db, envOf(q.get("environment")))); }

  if (res === "report" && method === "GET") {
    needRead(); const e = envOf(q.get("environment")), r = await readBalances(db, e), pol = await activePolicy(db, e);
    const batches = (await db.prepare("SELECT status, COUNT(*) AS n, COALESCE(SUM(net_cents),0) AS net_cents FROM treasury_profit_batches WHERE environment = ? GROUP BY status").bind(e).all<any>()).results;
    const p = pol ? policyOf(pol) : null, liquid = T.liquidFunds(r.b);
    return reply({ ...balanceView(e, r), policy: pol ? { id: pol.id, version: pol.version, ...p } : null, profit_batches: batches,
      requirements: p ? { minimum_trading_capital: { required: p.minTradingCapitalCents, actual: r.b.tradingCapital, met: r.b.tradingCapital >= p.minTradingCapitalCents }, emergency_reserve: { target: p.reserveTargetCents, actual: r.b.emergencyReserve, met: r.b.emergencyReserve >= p.reserveTargetCents }, liquidity: { required: p.liquidityMinCents, actual: liquid, met: liquid >= p.liquidityMinCents }, loss_recovery: { unrecovered_loss_cents: r.unrecoveredLoss, share_bps: p.lossRecoveryBps } } : null,
      note: "Management records. Not audited financial statements." });
  }

  if (res === "policy") {
    if (!id && method === "GET") { needRead(); const e = envOf(q.get("environment")); return reply({ policies: (await db.prepare("SELECT * FROM treasury_policies WHERE environment = ? ORDER BY version DESC LIMIT 50").bind(e).all()).results }); }
    if (!id && method === "POST") {
      if (!T.canProposePolicy(actor)) throw deny(); const e = envOf(body.environment);
      const p: any = Object.fromEntries(T.POLICY_FIELDS.map(f => [f, body[f]])), bad = T.policyError(p); if (bad) throw deny(bad, 400, { fields: T.POLICY_FIELDS });
      const v = ((await db.prepare("SELECT COALESCE(MAX(version),0) AS v FROM treasury_policies WHERE environment = ?").bind(e).first<any>())?.v ?? 0) + 1, pid = crypto.randomUUID();
      await db.prepare("INSERT INTO treasury_policies (id, environment, version, status, min_trading_capital_cents, loss_recovery_bps, reserve_target_cents, reserve_bps, liquidity_min_cents, operating_bps, long_term_bps, reinvest_bps, proposed_by, proposed_at, note) VALUES (?, ?, ?, 'proposed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(pid, e, v, p.minTradingCapitalCents, p.lossRecoveryBps, p.reserveTargetCents, p.reserveBps, p.liquidityMinCents, p.operatingBps, p.longTermBps, p.reinvestBps, actor.id, now, str(body.note, 500)).run();
      return reply({ ok: true, policy: await db.prepare("SELECT * FROM treasury_policies WHERE id = ?").bind(pid).first() }, 201);
    }
    if (id && act === "decision" && method === "POST") {
      const row = await db.prepare("SELECT * FROM treasury_policies WHERE id = ?").bind(id).first<any>(); if (!row) throw deny("policy_not_found", 404);
      const decision = str(body.decision, 10), note = str(body.note, 500);
      if (!["approve", "reject"].includes(decision)) throw deny("invalid_decision", 400);
      if (decision === "reject" && !note) throw deny("rejection_note_required", 400);
      if (!T.canApprovePolicy(actor, row.proposed_by)) throw deny("not_authorized_to_decide", 403, { reason: !actor.mfa ? "mfa_required" : actor.id === row.proposed_by ? "cannot_decide_own_proposal" : "no_approval_authority" });
      const stmts = decision === "approve"
        ? [db.prepare("UPDATE treasury_policies SET status = 'superseded' WHERE environment = ? AND status = 'active'").bind(row.environment), db.prepare("UPDATE treasury_policies SET status = 'active', decided_by = ?, decided_at = ?, note = ? WHERE id = ? AND status = 'proposed' AND proposed_by <> ?").bind(actor.id, now, note || row.note, id, actor.id), guardIfNoChange(db)]
        : [db.prepare("UPDATE treasury_policies SET status = 'rejected', decided_by = ?, decided_at = ?, note = ? WHERE id = ? AND status = 'proposed' AND proposed_by <> ?").bind(actor.id, now, note, id, actor.id), guardIfNoChange(db)];
      try { await db.batch(stmts); } catch (e) { throw classify(e, "not_pending"); }
      return reply({ ok: true, policy: await db.prepare("SELECT * FROM treasury_policies WHERE id = ?").bind(id).first() });
    }
  }

  if (res === "profit-batches") {
    const one = async () => { const b = await db.prepare("SELECT * FROM treasury_profit_batches WHERE id = ?").bind(id).first<any>(); if (!b) throw deny("profit_batch_not_found", 404); return b; };
    if (!id && method === "GET") {
      needRead(); const e = envOf(q.get("environment")), status = q.get("status");
      return reply({ batches: (await db.prepare(`SELECT * FROM treasury_profit_batches WHERE environment = ?${status ? " AND status = ?" : ""} ORDER BY created_at DESC LIMIT ?`).bind(e, ...(status ? [status] : []), limitOf()).all()).results });
    }
    if (!id && method === "POST") {
      if (!T.canRecordBatch(actor)) throw deny(); const e = envOf(body.environment);
      const period = body.period ?? quarterOf(now), source = str(body.source, 120), gross = body.grossCents, fees = body.feesCents ?? 0;
      if (!validPeriod(period)) throw deny("invalid_period", 400, { expected: "YYYY-Qn" });
      if (!source) throw deny("source_required", 400);
      if (!Number.isSafeInteger(gross) || Math.abs(gross) > 1e12 || !Number.isSafeInteger(fees) || fees < 0 || fees > 1e12) throw deny("invalid_grossCents_or_feesCents", 400);
      const bid = crypto.randomUUID();
      await db.prepare("INSERT INTO treasury_profit_batches (id, environment, period, source, description, gross_cents, fees_cents, net_cents, status, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?, ?)").bind(bid, e, period, source, str(body.description, 500), gross, fees, gross - fees, actor.id, now).run();
      return reply({ ok: true, batch: await db.prepare("SELECT * FROM treasury_profit_batches WHERE id = ?").bind(bid).first() }, 201);
    }
    if (id && act === "settle" && method === "POST") {
      const b = await one(); if (!T.canSettleBatch(actor, b.recorded_by)) throw deny("not_authorized_to_settle", 403, { reason: !actor.mfa ? "mfa_required" : "independent_finance_approver_required" });
      const sref = str(body.settlementReference, 120); if (!sref) throw deny("settlementReference_required", 400, { message: "Cite the exchange, bank or custody record showing the funds have settled." });
      let r; try { r = await db.batch([db.prepare("UPDATE treasury_profit_batches SET status = 'settled', settled_by = ?, settled_at = ?, settlement_reference = ? WHERE id = ? AND status = 'recorded' AND recorded_by <> ?").bind(actor.id, now, sref, id, actor.id)]); } catch (e) { throw classify(e); }
      if (!changed(r[0])) throw deny("not_recorded_status", 409);
      return reply({ ok: true, batch: await one() });
    }
    if (id && act === "reconcile" && method === "POST") {
      const b = await one(); if (!T.canReconcileBatch(actor, b.recorded_by, b.settled_by)) throw deny("not_authorized_to_reconcile", 403, { reason: !actor.mfa ? "mfa_required" : "third_independent_person_required" });
      if (b.status !== "settled") throw deny("not_settled", 409, { status: b.status });
      const rref = str(body.reconciliationReference, 120); if (!rref) throw deny("reconciliationReference_required", 400, { message: "Cite the statement or record you reconciled against." });
      if (body.statementNetCents !== b.net_cents) throw deny("reconciliation_mismatch", 409, { message: "statementNetCents must equal the recorded net profit exactly. Fix the batch (reject and re-record) or the statement figure.", recordedNetCents: b.net_cents });
      const upd = (entry: string | null) => db.prepare("UPDATE treasury_profit_batches SET status = 'reconciled', reconciled_by = ?, reconciled_at = ?, reconciliation_reference = ?, entry_id = ? WHERE id = ? AND status = 'settled' AND recorded_by <> ? AND settled_by <> ?").bind(actor.id, now, rref, entry, id, actor.id, actor.id);
      if (b.net_cents === 0) { const r = await db.batch([upd(null)]); if (!changed(r[0])) throw deny("not_settled", 409); return reply({ ok: true, batch: await one(), entry: null, note: "Net profit was zero; nothing to recognise." }); }
      const eid = crypto.randomUUID(), loss = b.net_cents < 0 ? -b.net_cents : 0;
      const posted = await postEntry(db, now, { id: eid, env: b.environment, kind: loss ? "loss_recognition" : "profit_recognition", actor: actor.id, reference: "batch:" + id, period: b.period, memo: JSON.stringify({ batch: id, source: b.source, gross: b.gross_cents, fees: b.fees_cents, settlement: b.settlement_reference, reconciliation: rref }), lines: loss ? T.lossRecognitionLines(loss) : T.profitRecognitionLines(b.net_cents), pre: [{ stmt: upd(eid), mustChange: true }], after: loss ? [db.prepare("UPDATE treasury_state SET unrecovered_loss_cents = unrecovered_loss_cents + ? WHERE environment = ?").bind(loss, b.environment)] : [], failCode: "not_settled" });
      return reply({ ok: true, batch: await one(), entry: view(posted) });
    }
    if (id && act === "reject" && method === "POST") {
      if (!T.canRejectBatch(actor)) throw deny(); const note = str(body.note, 500); if (!note) throw deny("rejection_note_required", 400);
      const r = await db.batch([db.prepare("UPDATE treasury_profit_batches SET status = 'rejected', note = ? WHERE id = ? AND status IN ('recorded','settled')").bind(note, id)]);
      if (!changed(r[0])) throw deny("cannot_reject", 409);
      return reply({ ok: true, batch: await one() });
    }
  }

  if (res === "allocations") {
    const planFor = async (e: T.Environment) => {
      const pol = await activePolicy(db, e); if (!pol) throw deny("no_active_policy", 409, { message: "Propose a policy and have a second person approve it first." });
      const r = await readBalances(db, e), plan = T.planAllocation(policyOf(pol), r.b, r.unrecoveredLoss);
      return { pol, r, plan };
    };
    if (act === undefined && id === "plan" && method === "GET") {
      needRead(); const e = envOf(q.get("environment")), { pol, r, plan } = await planFor(e);
      return reply({ environment: e, policyVersion: pol.version, realizedProfitsCents: r.b.realizedProfits, unrecoveredLossCents: r.unrecoveredLoss, plan: plan.allocations, totalCents: plan.totalCents, note: "Preview only. Nothing is posted." });
    }
    if (!id && method === "POST") {
      if (!T.canAllocate(actor)) throw deny(); const e = envOf(body.environment), { pol, plan } = await planFor(e);
      if (plan.totalCents <= 0) throw deny("nothing_to_allocate", 409, { message: "The realized-profits pool is empty. Only reconciled profit batches fill it." });
      const eid = crypto.randomUUID();
      const posted = await postEntry(db, now, { id: eid, env: e, kind: "profit_allocation", actor: actor.id, reference: "alloc:" + eid, period: quarterOf(now), memo: JSON.stringify({ policyVersion: pol.version, plan: plan.allocations }), lines: T.allocationLines(plan.allocations), after: plan.lossRecoveredCents > 0 ? [db.prepare("UPDATE treasury_state SET unrecovered_loss_cents = unrecovered_loss_cents - ? WHERE environment = ?").bind(plan.lossRecoveredCents, e)] : [] });
      return reply({ ok: true, entry: view(posted), policyVersion: pol.version, allocations: plan.allocations, totalCents: plan.totalCents }, 201);
    }
  }

  if (res === "contributions" && !id && method === "POST") {
    if (!T.canContribute(actor)) throw deny(); const e = envOf(body.environment), account = str(body.account, 4);
    if (!(T.CONTRIBUTION_ACCOUNTS as readonly string[]).includes(account)) throw deny("invalid_account", 400, { allowed: T.CONTRIBUTION_ACCOUNTS, note: "Realized profits (1200) can only be filled by reconciled profit batches." });
    const c = cents(body.amountCents), reference = ref(body.reference, "ext:", true, e), eid = crypto.randomUUID();
    const posted = await postEntry(db, now, { id: eid, env: e, kind: "capital_contribution", actor: actor.id, reference, period: quarterOf(now), memo: JSON.stringify({ account, note: str(body.note, 300) }), lines: T.contributionLines(account, c) });
    return reply({ ok: true, entry: view(posted) }, 201);
  }

  if (res === "department-funding" && !id && method === "POST") {
    if (!T.canFundDepartment(actor)) throw deny(); const e = envOf(body.environment), c = cents(body.amountCents);
    const d = await db.prepare("SELECT * FROM company_departments WHERE id = ? OR code = ?").bind(str(body.departmentId, 64), str(body.departmentId, 64).toUpperCase()).first<any>();
    if (!d) throw deny("department_not_found", 404); if (d.status !== "active") throw deny("department_suspended", 409);
    const period = body.period ?? quarterOf(now); if (!validPeriod(period)) throw deny("invalid_period", 400);
    const pre = e === "actual" ? [{ stmt: db.prepare("INSERT INTO treasury_guard (policy_ok) SELECT 0 WHERE (SELECT COALESCE(SUM(l.debit_cents),0) FROM treasury_lines l JOIN treasury_entries en ON en.id = l.entry_id WHERE en.environment = 'actual' AND en.kind = 'department_funding' AND l.account_code = '1600' AND l.department_id = ? AND en.period = ?) + ? > (SELECT COALESCE(SUM(allocated_cents),0) FROM company_budgets WHERE department_id = ? AND period = ? AND status = 'approved')").bind(d.id, period, c, d.id, period) }] : [];
    const eid = crypto.randomUUID();
    const posted = await postEntry(db, now, { id: eid, env: e, kind: "department_funding", actor: actor.id, reference: null, period, memo: JSON.stringify({ department: d.id }), lines: T.fundDepartmentLines(d.id, c), pre, failCode: "exceeds_approved_budget" });
    return reply({ ok: true, entry: view(posted) }, 201);
  }

  if (res === "expenses" && id && act === "post" && method === "POST") {
    const x = await db.prepare("SELECT * FROM company_expenses WHERE id = ?").bind(id).first<any>(); if (!x) throw deny("expense_not_found", 404);
    if (!T.canPostExpense(actor, x.requested_by)) throw deny("not_authorized_to_post", 403, { reason: !actor.mfa ? "mfa_required" : "accountant_independent_of_requester_required" });
    if (x.status !== "paid") throw deny("expense_not_paid", 409, { status: x.status, message: "Only expenses recorded as paid in company management can be posted." });
    const eid = crypto.randomUUID();
    const posted = await postEntry(db, now, { id: eid, env: "actual", kind: "expense_payment", actor: actor.id, reference: "expense:" + id, period: x.period, memo: JSON.stringify({ expense: id, department: x.department_id, category: x.category, requestedBy: x.requested_by, approvedBy: x.decided_by, paidBy: x.paid_by }), lines: T.expensePaymentLines(x.department_id, x.amount_cents) });
    return reply({ ok: true, environment: "actual", entry: view(posted) }, 201);
  }

  if (res === "liabilities" && method === "POST" && (!id || id === "settle")) {
    const e = envOf(body.environment), c = cents(body.amountCents), eid = crypto.randomUUID();
    if (!id) {
      if (!T.canIncurLiability(actor)) throw deny(); const description = str(body.description, 300); if (!description) throw deny("description_required", 400);
      const posted = await postEntry(db, now, { id: eid, env: e, kind: "liability_incurred", actor: actor.id, reference: ref(body.reference, "liability:", true, e), period: quarterOf(now), memo: JSON.stringify({ description }), lines: T.liabilityIncurLines(c) });
      return reply({ ok: true, entry: view(posted) }, 201);
    }
    if (!T.canSettleLiability(actor)) throw deny();
    const posted = await postEntry(db, now, { id: eid, env: e, kind: "liability_settled", actor: actor.id, reference: ref(body.reference, "liability-settle:", true, e), period: quarterOf(now), memo: JSON.stringify({ note: str(body.note, 300) }), lines: T.liabilitySettleLines(c) });
    return reply({ ok: true, entry: view(posted) }, 201);
  }

  throw deny("not_found", 404);
}

/** Internals shared with the automatic profit engine (worker/profit). The engine posts through the same hash-chained, guarded path as the API. */
/** Test hook: forget the cached schema check so a fresh in-memory database is initialised. */
const resetSchemaCache = () => { ready = null; triggersPresent = false; };
export const treasuryInternals = { resetSchemaCache, ensureSchema, postEntry, readBalances, activePolicy, policyOf, loadActor, balanceView, verify, quarterOf };
export type { D1 as TreasuryD1 };
