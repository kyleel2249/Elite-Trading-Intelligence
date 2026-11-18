/**
 * /api/company/*: ETI company management (departments, roles, budgets, expenses, revenue attribution, objectives, metrics, audit, reports).
 * Signed-in ETI accounts act through company roles (see model.ts); the operator token can administer but never approves or pays.
 * Money is integer cents. Every state change and its audit record are written in one D1 batch, and approvals re-check budget,
 * status and segregation of duties inside the SQL itself, so concurrent requests cannot overspend a budget or approve twice.
 *
 *   GET  /me   POST /bootstrap
 *   GET/POST /departments   GET/PATCH /departments/<id|code>
 *   GET/POST /members   POST /members/<id>/deactivate
 *   GET/POST /budgets   POST /budgets/<id>/decision
 *   GET/POST /expenses   POST /expenses/<id>/decision | /pay | /cancel
 *   GET/POST /revenue   POST /revenue/<id>/verify
 *   GET/POST /objectives   PATCH /objectives/<id>
 *   GET/POST /metrics   GET /activity
 *   GET /reports/company?period=&format=csv|json   GET /reports/departments/<id|code>?period=
 */
import { authenticate, isOperator, rateLimit, type Auth } from "../auth/session.ts";
import * as M from "./model.ts";
import { SCHEMA } from "./schema.ts";

interface D1Stmt { bind(...v: unknown[]): D1Stmt; first<T = any>(): Promise<T | null>; all<T = any>(): Promise<{ results: T[] }>; run(): Promise<{ meta?: { changes?: number } }> }
interface D1 { prepare(sql: string): D1Stmt; batch(s: D1Stmt[]): Promise<Array<{ results?: any[]; meta?: { changes?: number } }>> }
export type CompanyEnv = { ETI_PORTFOLIO_DB?: D1; [k: string]: any };

const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };
const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: H });
const cell = (v: unknown) => { let s = v === null || v === undefined ? "" : String(v); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const idOk = (s: string) => /^[A-Za-z0-9_-]{1,64}$/.test(s);
class HttpError extends Error { status: number; body: Record<string, unknown>; constructor(status: number, error: string, extra: Record<string, unknown> = {}) { super(error); this.status = status; this.body = { error, ...extra }; } }
const deny = (error = "forbidden", status = 403, extra: Record<string, unknown> = {}) => new HttpError(status, error, extra);

let schemaReady: Promise<void> | null = null;
function ensureSchema(db: D1): Promise<void> {
  if (!schemaReady) schemaReady = db.batch(SCHEMA.map(s => db.prepare(s))).then(() => undefined, e => { schemaReady = null; throw e; });
  return schemaReady;
}

async function loadActor(db: D1, auth: Auth, operator: boolean): Promise<M.Actor> {
  const id = auth.user ? auth.user.uid : "master", email = (auth.user?.email || "").toLowerCase();
  const rows = auth.user ? (await db.prepare("SELECT department_id, role FROM company_members WHERE active = 1 AND (user_id = ? OR user_id = ?)").bind(id, email || id).all<{ department_id: string; role: M.CompanyRole }>()).results : [];
  return { id, email, operator, mfa: !!auth.user?.mfa && !auth.user.limited, memberships: rows.map(r => ({ department: r.department_id, role: r.role })) };
}

async function getDept(db: D1, ref: string): Promise<any | null> {
  if (!ref || ref.length > 64) return null;
  return db.prepare("SELECT * FROM company_departments WHERE id = ? OR code = ?").bind(ref, ref.toUpperCase()).first<any>();
}

function summaryStmt(db: D1, dept: string, period: string): D1Stmt {
  return db.prepare(`SELECT
    (SELECT COALESCE(SUM(allocated_cents),0) FROM company_budgets WHERE department_id = ? AND period = ? AND status = 'approved') AS allocated_cents,
    (SELECT COALESCE(SUM(amount_cents),0) FROM company_expenses WHERE department_id = ? AND period = ? AND status IN ('approved','paid')) AS committed_cents,
    (SELECT COALESCE(SUM(amount_cents),0) FROM company_expenses WHERE department_id = ? AND period = ? AND status = 'paid') AS paid_cents,
    (SELECT COALESCE(SUM(amount_cents),0) FROM company_expenses WHERE department_id = ? AND period = ? AND status = 'pending') AS pending_cents,
    (SELECT COALESCE(SUM(amount_cents),0) FROM company_revenue WHERE department_id = ? AND period = ? AND status = 'verified') AS revenue_verified_cents,
    (SELECT COALESCE(SUM(amount_cents),0) FROM company_revenue WHERE department_id = ? AND period = ? AND status = 'recorded') AS revenue_unverified_cents`)
    .bind(dept, period, dept, period, dept, period, dept, period, dept, period, dept, period);
}
const withAvailable = (s: any) => ({ ...s, available_cents: s.allocated_cents - s.committed_cents });

function auditStmt(db: D1, now: number, a: M.Actor, dept: string, action: string, entity: string, entityId: string, detail: unknown, onlyIfChanged = false): D1Stmt {
  const role = a.memberships.length ? a.memberships.map(m => m.role + "@" + m.department).join(",").slice(0, 200) : a.operator ? "operator" : "";
  const cols = "INSERT INTO company_activity (id, at, actor, actor_role, department_id, action, entity, entity_id, detail)";
  const args = [crypto.randomUUID(), now, a.id, role, dept, action, entity, entityId, JSON.stringify(detail ?? {}).slice(0, 2000)];
  return db.prepare(onlyIfChanged ? cols + " SELECT ?,?,?,?,?,?,?,?,? WHERE changes() = 1" : cols + " VALUES (?,?,?,?,?,?,?,?,?)").bind(...args);
}
const changed = (r: { meta?: { changes?: number } } | undefined) => (r?.meta?.changes ?? 0) > 0;

export async function handleCompany(req: Request, env: CompanyEnv, now = Date.now()): Promise<Response> {
  const url = new URL(req.url), sub = url.pathname.replace(/\/+$/, "").slice("/api/company".length) || "/";
  try { return await route(req, env, url, sub, now); }
  catch (e) {
    if (e instanceof HttpError) return reply(e.body, e.status);
    console.error("company api", e instanceof Error ? e.message : e);
    return reply({ error: "internal_error" }, 500);
  }
}

async function route(req: Request, env: CompanyEnv, url: URL, sub: string, now: number): Promise<Response> {
  const auth = await authenticate(req, env as any, now), operator = isOperator(auth);
  if (!operator && !auth.user) throw deny("unauthorized", 401, { message: "Sign in with an ETI account. Execution sessions are not company identities." });
  const db = env.ETI_PORTFOLIO_DB;
  if (!db) throw deny("company_storage_not_configured", 503, { message: "Bind the ETI_PORTFOLIO_DB D1 database." });
  if (!auth.master) { const rl = await rateLimit(env as any, "co:" + (auth.user ? auth.user.uid : "op"), 240, 600, now); if (!rl.ok) throw deny("rate_limited", 429); }
  try { await ensureSchema(db); } catch { throw deny("company_schema_unavailable", 503); }
  const actor = await loadActor(db, auth, operator), limits = M.DEFAULT_LIMITS, q = url.searchParams, method = req.method;
  const [res, id, act] = sub.split("/").filter(Boolean);
  if (!["GET", "POST", "PATCH"].includes(method)) throw deny("method_not_allowed", 405);
  let body: any = {};
  if (method !== "GET") {
    const text = await req.text();
    if (text.length > 20_000) throw deny("payload_too_large", 413);
    try { body = text ? JSON.parse(text) : {}; } catch { throw deny("invalid_json", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) body = {};
  }
  if (id !== undefined && !idOk(id)) throw deny("invalid_id", 400);
  const limitOf = () => Math.min(200, Math.max(1, Number(q.get("limit")) || 100));
  const periodOf = (v: unknown) => { if (v === undefined || v === null || v === "") return M.periodOf(now); if (!M.validPeriod(v)) throw deny("invalid_period", 400, { expected: "YYYY-Qn" }); return v; };
  const deptOrFail = async (ref: unknown) => { const d = await getDept(db, str(ref, 64)); if (!d) throw deny("department_not_found", 404); return d; };
  const readableDept = async (ref: unknown) => { const d = await deptOrFail(ref); if (!M.canReadDept(actor, d.id)) throw deny(); return d; };
  const visible = async (): Promise<string[] | null> => {
    const ref = q.get("department");
    if (ref) return [(await readableDept(ref)).id];
    return M.seesAll(actor) ? null : [...new Set(actor.memberships.map(m => m.department))];
  };
  const inList = (ids: string[] | null, col = "department_id") => ids === null ? { sql: "", args: [] as string[] } : ids.length ? { sql: ` AND ${col} IN (${ids.map(() => "?").join(",")})`, args: ids } : { sql: " AND 1 = 0", args: [] as string[] };
  const activeDept = async (ref: unknown) => { const d = await deptOrFail(ref); if (d.status !== "active") throw deny("department_suspended", 409); return d; };

  if (res === "me" && method === "GET") return reply({ id: actor.id, email: actor.email, operator: actor.operator, mfa: actor.mfa, memberships: actor.memberships, canManage: M.canManageCompany(actor), seesAll: M.seesAll(actor), approvalLimitsCents: limits, period: M.periodOf(now) });

  if (res === "bootstrap" && method === "POST") {
    if (!actor.operator) throw deny("operator_only");
    const stmts = M.DEPARTMENTS.map(d => db.prepare("INSERT OR IGNORE INTO company_departments (id, code, name, mission, status, head_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', NULL, ?, ?)").bind(d.code.toLowerCase(), d.code, d.name, d.mission, now, now));
    stmts.push(auditStmt(db, now, actor, "*", "bootstrap", "company", "departments", { departments: M.DEPARTMENTS.length }));
    await db.batch(stmts);
    return reply({ ok: true, departments: (await db.prepare("SELECT * FROM company_departments ORDER BY code").all()).results });
  }

  if (res === "departments") {
    if (!id && method === "GET") {
      const ids = M.seesAll(actor) ? null : [...new Set(actor.memberships.map(m => m.department))], period = periodOf(q.get("period"));
      const l = inList(ids, "id"), rows = (await db.prepare(`SELECT * FROM company_departments WHERE 1 = 1${l.sql} ORDER BY code`).bind(...l.args).all<any>()).results;
      const sums = rows.length ? await db.batch(rows.map(d => summaryStmt(db, d.id, period))) : [];
      return reply({ period, departments: rows.map((d, i) => ({ ...d, budget: withAvailable(sums[i]?.results?.[0] ?? {}) })) });
    }
    if (!id && method === "POST") {
      if (!M.canManageCompany(actor)) throw deny();
      const code = str(body.code, 8).toUpperCase(), name = str(body.name, 80);
      if (!/^[A-Z]{2,8}$/.test(code) || !name) throw deny("code_and_name_required", 400);
      const dept = crypto.randomUUID();
      try { await db.batch([db.prepare("INSERT INTO company_departments (id, code, name, mission, status, head_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', NULL, ?, ?)").bind(dept, code, name, str(body.mission, 400), now, now), auditStmt(db, now, actor, dept, "department.create", "department", dept, { code, name })]); }
      catch (e) { if (/UNIQUE/i.test(String((e as Error).message))) throw deny("department_code_exists", 409); throw e; }
      return reply({ ok: true, department: await getDept(db, dept) }, 201);
    }
    if (id && !act && method === "GET") {
      const d = await readableDept(id), period = periodOf(q.get("period"));
      const [sum, members, objectives, metrics] = await db.batch([
        summaryStmt(db, d.id, period),
        db.prepare("SELECT id, user_id, role, display_name FROM company_members WHERE active = 1 AND (department_id = ? OR department_id = '*') ORDER BY role, user_id").bind(d.id),
        db.prepare("SELECT * FROM company_objectives WHERE department_id = ? ORDER BY created_at DESC LIMIT 100").bind(d.id),
        db.prepare("SELECT * FROM company_metrics WHERE department_id = ? ORDER BY created_at DESC LIMIT 200").bind(d.id),
      ]);
      const latest = new Map<string, any>(); for (const m of metrics.results ?? []) if (!latest.has(m.name)) latest.set(m.name, m);
      const activity = M.canViewAudit(actor, d.id) ? (await db.prepare("SELECT * FROM company_activity WHERE department_id = ? ORDER BY at DESC LIMIT 20").bind(d.id).all()).results : undefined;
      return reply({ department: d, period, budget: withAvailable(sum.results?.[0] ?? {}), members: members.results, objectives: (objectives.results ?? []).map((o: any) => ({ ...o, progress: M.progressOf(o.current_value, o.target_value) })), metrics: [...latest.values()], activity });
    }
    if (id && !act && method === "PATCH") {
      if (!M.canManageCompany(actor)) throw deny();
      const d = await deptOrFail(id), sets: string[] = [], args: unknown[] = [];
      if (body.name !== undefined) { const v = str(body.name, 80); if (!v) throw deny("invalid_name", 400); sets.push("name = ?"); args.push(v); }
      if (body.mission !== undefined) { sets.push("mission = ?"); args.push(str(body.mission, 400)); }
      if (body.status !== undefined) { if (!["active", "suspended"].includes(body.status)) throw deny("invalid_status", 400); sets.push("status = ?"); args.push(body.status); }
      if (body.headUserId !== undefined) {
        if (body.headUserId === null || body.headUserId === "") { sets.push("head_user_id = NULL"); }
        else {
          const uid = M.normalizeUserId(str(body.headUserId, 120));
          if (!(await db.prepare("SELECT 1 AS x FROM company_members WHERE user_id = ? AND department_id = ? AND role = 'department_head' AND active = 1").bind(uid, d.id).first())) throw deny("head_must_hold_department_head_role", 400);
          sets.push("head_user_id = ?"); args.push(uid);
        }
      }
      if (!sets.length) throw deny("nothing_to_update", 400);
      await db.batch([db.prepare(`UPDATE company_departments SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...args, now, d.id), auditStmt(db, now, actor, d.id, "department.update", "department", d.id, { fields: Object.keys(body) })]);
      return reply({ ok: true, department: await getDept(db, d.id) });
    }
  }

  if (res === "members") {
    if (!id && method === "GET") {
      const ids = await visible(), l = inList(ids, "department_id");
      const extra = ids === null ? "" : " OR department_id = '*'";
      const rows = (await db.prepare(`SELECT * FROM company_members WHERE active = 1 AND (1 = 1${l.sql}${extra}) ORDER BY department_id, role LIMIT ?`).bind(...l.args, limitOf()).all()).results;
      return reply({ members: rows });
    }
    if (!id && method === "POST") {
      if (!M.canManageCompany(actor)) throw deny();
      const userId = M.normalizeUserId(str(body.userId, 120)), role = body.role as M.CompanyRole;
      if (!userId || !(M.ROLES as readonly string[]).includes(role)) throw deny("userId_and_valid_role_required", 400, { roles: M.ROLES });
      let dept = M.GLOBAL_ROLES.includes(role) ? M.COMPANY_WIDE : (await deptOrFail(body.departmentId)).id;
      if (!M.roleScopeOk(role, dept)) throw deny("role_scope_mismatch", 400);
      const existing = (await db.prepare("SELECT role FROM company_members WHERE user_id = ? AND active = 1").bind(userId).all<{ role: M.CompanyRole }>()).results.map(r => r.role);
      const conflict = M.roleConflict(existing, role); if (conflict) throw deny(conflict, 409);
      const mid = crypto.randomUUID();
      await db.batch([db.prepare("INSERT INTO company_members (id, user_id, department_id, role, display_name, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?) ON CONFLICT (user_id, department_id, role) DO UPDATE SET active = 1, display_name = excluded.display_name").bind(mid, userId, dept, role, str(body.displayName, 80), now), auditStmt(db, now, actor, dept, "member.assign", "member", userId, { role })]);
      return reply({ ok: true, userId, department: dept, role }, 201);
    }
    if (id && act === "deactivate" && method === "POST") {
      if (!M.canManageCompany(actor)) throw deny();
      const m = await db.prepare("SELECT * FROM company_members WHERE id = ?").bind(id).first<any>(); if (!m) throw deny("member_not_found", 404);
      await db.batch([db.prepare("UPDATE company_members SET active = 0 WHERE id = ?").bind(id), auditStmt(db, now, actor, m.department_id, "member.deactivate", "member", m.user_id, { role: m.role }), db.prepare("UPDATE company_departments SET head_user_id = NULL WHERE id = ? AND head_user_id = ?").bind(m.department_id, m.user_id)]);
      return reply({ ok: true });
    }
  }

  if (res === "budgets") {
    if (!id && method === "GET") {
      const ids = await visible(), l = inList(ids), period = q.get("period"), status = q.get("status");
      const rows = (await db.prepare(`SELECT * FROM company_budgets WHERE 1 = 1${l.sql}${period ? " AND period = ?" : ""}${status ? " AND status = ?" : ""} ORDER BY created_at DESC LIMIT ?`).bind(...l.args, ...(period ? [period] : []), ...(status ? [status] : []), limitOf()).all()).results;
      return reply({ budgets: rows });
    }
    if (!id && method === "POST") {
      const d = await activeDept(body.departmentId); if (!M.canProposeBudget(actor, d.id)) throw deny();
      const cents = M.parseCents(body.allocatedCents, true); if (cents === null) throw deny("invalid_allocatedCents", 400);
      const period = periodOf(body.period), bid = crypto.randomUUID();
      await db.batch([db.prepare("INSERT INTO company_budgets (id, department_id, period, allocated_cents, note, status, proposed_by, created_at) VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?)").bind(bid, d.id, period, cents, str(body.note, 500), actor.id, now), auditStmt(db, now, actor, d.id, "budget.propose", "budget", bid, { period, allocatedCents: cents })]);
      return reply({ ok: true, budget: await db.prepare("SELECT * FROM company_budgets WHERE id = ?").bind(bid).first() }, 201);
    }
    if (id && act === "decision" && method === "POST") {
      const b = await db.prepare("SELECT * FROM company_budgets WHERE id = ?").bind(id).first<any>(); if (!b) throw deny("budget_not_found", 404);
      const decision = str(body.decision, 10), note = str(body.note, 500);
      if (!["approve", "reject"].includes(decision)) throw deny("invalid_decision", 400);
      if (decision === "reject" && !note) throw deny("rejection_note_required", 400);
      if (!M.canDecideBudget(actor, b.proposed_by)) throw deny("not_authorized_to_decide", 403, { reason: !actor.mfa ? "mfa_required" : actor.id === b.proposed_by ? "cannot_decide_own_proposal" : "no_approval_authority" });
      const status = decision === "approve" ? "approved" : "rejected";
      const r = await db.batch([db.prepare("UPDATE company_budgets SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'proposed' AND proposed_by <> ?").bind(status, actor.id, now, note, id, actor.id), auditStmt(db, now, actor, b.department_id, "budget." + decision, "budget", id, { period: b.period, allocatedCents: b.allocated_cents }, true)]);
      if (!changed(r[0])) throw deny("not_pending", 409);
      return reply({ ok: true, budget: await db.prepare("SELECT * FROM company_budgets WHERE id = ?").bind(id).first() });
    }
  }

  if (res === "expenses") {
    const one = async () => { const e = await db.prepare("SELECT * FROM company_expenses WHERE id = ?").bind(id).first<any>(); if (!e) throw deny("expense_not_found", 404); return e; };
    if (!id && method === "GET") {
      const ids = await visible(), l = inList(ids), period = q.get("period"), status = q.get("status");
      const rows = (await db.prepare(`SELECT * FROM company_expenses WHERE 1 = 1${l.sql}${period ? " AND period = ?" : ""}${status ? " AND status = ?" : ""} ORDER BY created_at DESC LIMIT ?`).bind(...l.args, ...(period ? [period] : []), ...(status ? [status] : []), limitOf()).all()).results;
      return reply({ expenses: rows });
    }
    if (!id && method === "POST") {
      const d = await activeDept(body.departmentId); if (!M.canSubmitExpense(actor, d.id)) throw deny();
      const cents = M.parseCents(body.amountCents), category = str(body.category, 40), description = str(body.description, 500);
      if (cents === null) throw deny("invalid_amountCents", 400);
      if (!(M.EXPENSE_CATEGORIES as readonly string[]).includes(category)) throw deny("invalid_category", 400, { categories: M.EXPENSE_CATEGORIES });
      if (!description) throw deny("description_required", 400);
      const period = periodOf(body.period), eid = crypto.randomUUID();
      await db.batch([db.prepare("INSERT INTO company_expenses (id, department_id, period, amount_cents, category, vendor, description, status, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)").bind(eid, d.id, period, cents, category, str(body.vendor, 120), description, actor.id, now), auditStmt(db, now, actor, d.id, "expense.submit", "expense", eid, { period, amountCents: cents, category })]);
      return reply({ ok: true, expense: await db.prepare("SELECT * FROM company_expenses WHERE id = ?").bind(eid).first() }, 201);
    }
    if (id && act === "decision" && method === "POST") {
      const e = await one(), decision = str(body.decision, 10), note = str(body.note, 500);
      if (!["approve", "reject"].includes(decision)) throw deny("invalid_decision", 400);
      if (decision === "reject" && !note) throw deny("rejection_note_required", 400);
      const block = M.expenseDecisionBlock(actor, { department: e.department_id, amountCents: e.amount_cents, requestedBy: e.requested_by }, limits);
      if (block) throw deny("not_authorized_to_decide", 403, { reason: block });
      const audit = auditStmt(db, now, actor, e.department_id, "expense." + decision, "expense", id, { amountCents: e.amount_cents, period: e.period }, true);
      const upd = decision === "approve"
        ? db.prepare(`UPDATE company_expenses SET status = 'approved', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'pending' AND requested_by <> ?
            AND amount_cents <= ((SELECT COALESCE(SUM(allocated_cents),0) FROM company_budgets WHERE department_id = ? AND period = ? AND status = 'approved')
              - (SELECT COALESCE(SUM(amount_cents),0) FROM company_expenses WHERE department_id = ? AND period = ? AND status IN ('approved','paid')))`).bind(actor.id, now, note, id, actor.id, e.department_id, e.period, e.department_id, e.period)
        : db.prepare("UPDATE company_expenses SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ? AND status = 'pending' AND requested_by <> ?").bind(actor.id, now, note, id, actor.id);
      const r = await db.batch([upd, audit]);
      if (!changed(r[0])) {
        const now2 = await one();
        if (now2.status !== "pending") throw deny("not_pending", 409, { status: now2.status });
        const s = await summaryStmt(db, e.department_id, e.period).first<any>();
        throw deny("insufficient_budget", 409, { amountCents: e.amount_cents, budget: withAvailable(s ?? {}) });
      }
      return reply({ ok: true, expense: await one() });
    }
    if (id && act === "pay" && method === "POST") {
      const e = await one();
      if (!M.canPay(actor, { requestedBy: e.requested_by, decidedBy: e.decided_by })) throw deny("not_authorized_to_pay", 403, { reason: !actor.mfa ? "mfa_required" : "accountant_independent_of_requester_and_approver_required" });
      const r = await db.batch([db.prepare("UPDATE company_expenses SET status = 'paid', paid_by = ?, paid_at = ?, payment_reference = ? WHERE id = ? AND status = 'approved' AND requested_by <> ? AND decided_by <> ?").bind(actor.id, now, str(body.reference, 120), id, actor.id, actor.id), auditStmt(db, now, actor, e.department_id, "expense.pay", "expense", id, { amountCents: e.amount_cents, recordOnly: true }, true)]);
      if (!changed(r[0])) throw deny("not_approved", 409);
      return reply({ ok: true, note: "Recorded as paid. ETI does not move funds from this endpoint.", expense: await one() });
    }
    if (id && act === "cancel" && method === "POST") {
      const e = await one();
      const r = await db.batch([db.prepare("UPDATE company_expenses SET status = 'cancelled' WHERE id = ? AND status = 'pending' AND requested_by = ?").bind(id, actor.id), auditStmt(db, now, actor, e.department_id, "expense.cancel", "expense", id, {}, true)]);
      if (!changed(r[0])) throw deny("only_the_requester_can_cancel_a_pending_expense", 409);
      return reply({ ok: true, expense: await one() });
    }
  }

  if (res === "revenue") {
    if (!id && method === "GET") {
      const ids = await visible(), l = inList(ids), period = q.get("period"), status = q.get("status");
      const rows = (await db.prepare(`SELECT * FROM company_revenue WHERE 1 = 1${l.sql}${period ? " AND period = ?" : ""}${status ? " AND status = ?" : ""} ORDER BY created_at DESC LIMIT ?`).bind(...l.args, ...(period ? [period] : []), ...(status ? [status] : []), limitOf()).all()).results;
      return reply({ revenue: rows });
    }
    if (!id && method === "POST") {
      const d = await activeDept(body.departmentId); if (!M.canRecordRevenue(actor, d.id)) throw deny();
      const cents = M.parseCents(body.amountCents), source = str(body.source, 120);
      if (cents === null) throw deny("invalid_amountCents", 400);
      if (!source) throw deny("source_required", 400);
      const period = periodOf(body.period), rid = crypto.randomUUID();
      await db.batch([db.prepare("INSERT INTO company_revenue (id, department_id, period, amount_cents, source, description, status, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 'recorded', ?, ?)").bind(rid, d.id, period, cents, source, str(body.description, 500), actor.id, now), auditStmt(db, now, actor, d.id, "revenue.record", "revenue", rid, { period, amountCents: cents, source })]);
      return reply({ ok: true, revenue: await db.prepare("SELECT * FROM company_revenue WHERE id = ?").bind(rid).first() }, 201);
    }
    if (id && act === "verify" && method === "POST") {
      const r0 = await db.prepare("SELECT * FROM company_revenue WHERE id = ?").bind(id).first<any>(); if (!r0) throw deny("revenue_not_found", 404);
      if (!M.canVerifyRevenue(actor, r0.recorded_by)) throw deny("not_authorized_to_verify", 403, { reason: !actor.mfa ? "mfa_required" : "independent_accountant_required" });
      const r = await db.batch([db.prepare("UPDATE company_revenue SET status = 'verified', verified_by = ?, verified_at = ? WHERE id = ? AND status = 'recorded' AND recorded_by <> ?").bind(actor.id, now, id, actor.id), auditStmt(db, now, actor, r0.department_id, "revenue.verify", "revenue", id, { amountCents: r0.amount_cents }, true)]);
      if (!changed(r[0])) throw deny("not_pending_verification", 409);
      return reply({ ok: true, revenue: await db.prepare("SELECT * FROM company_revenue WHERE id = ?").bind(id).first() });
    }
  }

  if (res === "objectives") {
    if (!id && method === "GET") {
      const ids = await visible(), l = inList(ids), status = q.get("status");
      const rows = (await db.prepare(`SELECT * FROM company_objectives WHERE 1 = 1${l.sql}${status ? " AND status = ?" : ""} ORDER BY created_at DESC LIMIT ?`).bind(...l.args, ...(status ? [status] : []), limitOf()).all<any>()).results;
      return reply({ objectives: rows.map(o => ({ ...o, progress: M.progressOf(o.current_value, o.target_value) })) });
    }
    if (!id && method === "POST") {
      const d = await activeDept(body.departmentId); if (!M.canManageObjectives(actor, d.id)) throw deny();
      const title = str(body.title, 160), target = Number(body.targetValue), due = body.dueDate == null || body.dueDate === "" ? null : str(body.dueDate, 10);
      if (!title || !Number.isFinite(target)) throw deny("title_and_numeric_targetValue_required", 400);
      if (due !== null && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw deny("invalid_dueDate", 400, { expected: "YYYY-MM-DD" });
      const oid = crypto.randomUUID();
      await db.batch([db.prepare("INSERT INTO company_objectives (id, department_id, title, metric, target_value, current_value, unit, due_date, status, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'active', ?, ?, ?)").bind(oid, d.id, title, str(body.metric, 80), target, str(body.unit, 20), due, actor.id, now, now), auditStmt(db, now, actor, d.id, "objective.create", "objective", oid, { title, target })]);
      return reply({ ok: true, objective: await db.prepare("SELECT * FROM company_objectives WHERE id = ?").bind(oid).first() }, 201);
    }
    if (id && !act && method === "PATCH") {
      const o = await db.prepare("SELECT * FROM company_objectives WHERE id = ?").bind(id).first<any>(); if (!o) throw deny("objective_not_found", 404);
      if (!M.canManageObjectives(actor, o.department_id) && !M.canRecordMetric(actor, o.department_id)) throw deny();
      const sets: string[] = [], args: unknown[] = [], manage = M.canManageObjectives(actor, o.department_id);
      if (body.currentValue !== undefined) { const v = Number(body.currentValue); if (!Number.isFinite(v)) throw deny("invalid_currentValue", 400); sets.push("current_value = ?"); args.push(v); }
      if (body.targetValue !== undefined || body.status !== undefined) {
        if (!manage) throw deny("only_heads_and_executives_change_targets_or_status");
        if (body.targetValue !== undefined) { const v = Number(body.targetValue); if (!Number.isFinite(v)) throw deny("invalid_targetValue", 400); sets.push("target_value = ?"); args.push(v); }
        if (body.status !== undefined) { if (!["active", "achieved", "missed", "cancelled"].includes(body.status)) throw deny("invalid_status", 400); sets.push("status = ?"); args.push(body.status); }
      }
      if (!sets.length) throw deny("nothing_to_update", 400);
      await db.batch([db.prepare(`UPDATE company_objectives SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`).bind(...args, now, id), auditStmt(db, now, actor, o.department_id, "objective.update", "objective", id, { fields: Object.keys(body) })]);
      const u = await db.prepare("SELECT * FROM company_objectives WHERE id = ?").bind(id).first<any>();
      return reply({ ok: true, objective: { ...u, progress: M.progressOf(u.current_value, u.target_value) } });
    }
  }

  if (res === "metrics") {
    if (!id && method === "GET") {
      const ids = await visible(), l = inList(ids), name = q.get("name");
      const rows = (await db.prepare(`SELECT * FROM company_metrics WHERE 1 = 1${l.sql}${name ? " AND name = ?" : ""} ORDER BY created_at DESC LIMIT ?`).bind(...l.args, ...(name ? [name] : []), limitOf()).all()).results;
      return reply({ metrics: rows });
    }
    if (!id && method === "POST") {
      const d = await activeDept(body.departmentId); if (!M.canRecordMetric(actor, d.id)) throw deny();
      const name = str(body.name, 80), value = Number(body.value);
      if (!name || !Number.isFinite(value)) throw deny("name_and_numeric_value_required", 400);
      const mid = crypto.randomUUID(), period = periodOf(body.period);
      await db.batch([db.prepare("INSERT INTO company_metrics (id, department_id, name, value, unit, period, recorded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(mid, d.id, name, value, str(body.unit, 20), period, actor.id, now), auditStmt(db, now, actor, d.id, "metric.record", "metric", mid, { name, value })]);
      return reply({ ok: true, id: mid }, 201);
    }
  }

  if (res === "activity" && !id && method === "GET") {
    const ref = q.get("department");
    let where = "1 = 1", args: unknown[] = [];
    if (ref) { const d = await deptOrFail(ref); if (!M.canViewAudit(actor, d.id)) throw deny(); where = "department_id = ?"; args = [d.id]; }
    else if (!(actor.operator || M.isGlobal(actor, "executive") || M.isGlobal(actor, "auditor") || M.isGlobal(actor, "accountant"))) throw deny("department_required", 400);
    return reply({ activity: (await db.prepare(`SELECT * FROM company_activity WHERE ${where} ORDER BY at DESC LIMIT ?`).bind(...args, limitOf()).all()).results });
  }

  if (res === "reports" && method === "GET") {
    const period = periodOf(q.get("period"));
    const note = "Internal management records. These are not audited financial statements.";
    if (id === "company" || !id) {
      const ids = await visible(), l = inList(ids, "id");
      const depts = (await db.prepare(`SELECT id, code, name, status FROM company_departments WHERE 1 = 1${l.sql} ORDER BY code`).bind(...l.args).all<any>()).results;
      const sums = depts.length ? await db.batch(depts.map(d => summaryStmt(db, d.id, period))) : [];
      const counts = (await db.prepare("SELECT department_id, status, COUNT(*) AS n FROM company_objectives GROUP BY department_id, status").all<any>()).results;
      const rows = depts.map((d, i) => ({ department: d, ...withAvailable(sums[i]?.results?.[0] ?? {}), objectives: Object.fromEntries(counts.filter(c => c.department_id === d.id).map(c => [c.status, c.n])) }));
      const total = (k: string) => rows.reduce((s, r: any) => s + (r[k] || 0), 0);
      const totals = { allocated_cents: total("allocated_cents"), committed_cents: total("committed_cents"), paid_cents: total("paid_cents"), pending_cents: total("pending_cents"), available_cents: total("available_cents"), revenue_verified_cents: total("revenue_verified_cents"), revenue_unverified_cents: total("revenue_unverified_cents") };
      if (q.get("format") === "csv") {
        const head = ["code", "department", "period", "allocated_cents", "committed_cents", "paid_cents", "pending_cents", "available_cents", "revenue_verified_cents", "revenue_unverified_cents"];
        const csv = [head.join(","), ...rows.map((r: any) => [r.department.code, r.department.name, period, r.allocated_cents, r.committed_cents, r.paid_cents, r.pending_cents, r.available_cents, r.revenue_verified_cents, r.revenue_unverified_cents].map(cell).join(","))].join("\n");
        return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="eti-company-${period}.csv"`, "cache-control": "no-store" } });
      }
      return reply({ period, generatedAt: now, note, totals, departments: rows });
    }
    if (id === "departments" && act) {
      const d = await readableDept(act), s = await summaryStmt(db, d.id, period).first<any>();
      const [exp, rev, bud, obj] = await db.batch([
        db.prepare("SELECT category, status, COUNT(*) AS n, SUM(amount_cents) AS cents FROM company_expenses WHERE department_id = ? AND period = ? GROUP BY category, status").bind(d.id, period),
        db.prepare("SELECT source, status, COUNT(*) AS n, SUM(amount_cents) AS cents FROM company_revenue WHERE department_id = ? AND period = ? GROUP BY source, status").bind(d.id, period),
        db.prepare("SELECT * FROM company_budgets WHERE department_id = ? AND period = ? ORDER BY created_at").bind(d.id, period),
        db.prepare("SELECT * FROM company_objectives WHERE department_id = ?").bind(d.id),
      ]);
      return reply({ period, generatedAt: now, note, department: { id: d.id, code: d.code, name: d.name }, budget: withAvailable(s ?? {}), expensesByCategory: exp.results, revenueBySource: rev.results, budgets: bud.results, objectives: (obj.results ?? []).map((o: any) => ({ ...o, progress: M.progressOf(o.current_value, o.target_value) })) });
    }
  }

  throw deny("not_found", 404);
}
