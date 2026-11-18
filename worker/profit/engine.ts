/**
 * Automatic profit management engine. Reads CONFIRMED realized results from the trade journal, recognises them in the treasury books,
 * recommends (and, for simulated money only, applies) the allocation, enforces the capital-protection thresholds, forecasts company
 * expenses and produces financial performance reports.
 *
 * Boundaries (see docs/PROFIT_MANAGEMENT.md):
 *  - Unrealized gains, open or resting orders, unknown outcomes, unknown fees, hand-typed trades and results still inside the confirmation
 *    window are never counted. They are reported as excluded, with the reason.
 *  - "simulated" books (paper/testnet): the engine posts automatically as system:profit-engine through the treasury's own hash-chained,
 *    guarded ledger path, and allocates per the active policy.
 *  - "actual" books: the engine only reports and recommends. Real funds still need the treasury's three-person batch workflow and a human
 *    allocation, because ETI holds no live exchange position and cannot confirm real settlement on its own.
 *  - It never moves funds, never places an order, and never writes anything outside the treasury ledger and its own bookkeeping tables.
 */
import { buildTrades } from "../journal/analytics.ts";
import { openJournal } from "../journal/store.ts";
import { runJournalCycle } from "../journal/sync.ts";
import { treasuryInternals as TI, type TreasuryD1 } from "../treasury/api.ts";
import * as T from "../treasury/model.ts";
import { SCHEMA as TREASURY_SCHEMA } from "../treasury/schema.ts";
import { SCHEMA as COMPANY_SCHEMA } from "../company/schema.ts";
import * as M from "./model.ts";
import { SCHEMA } from "./schema.ts";

export type ProfitEnv = { ETI_PORTFOLIO_DB?: any; ETI_EXECUTION_LOG?: any; [k: string]: any };
export const SYSTEM_ACTOR = "system:profit-engine";
export const CYCLE_INTERVAL_MS = 5 * 60_000;

export interface Settings { confirmMs: number; windowMs: number; maxDrawdownBps: number; autoAllocate: boolean; minAllocationCents: number; seedCapitalCents: number }
const int = (v: unknown, d: number, lo: number, hi: number) => { const n = Number(v); return Number.isFinite(n) && n >= lo && n <= hi ? Math.floor(n) : d; };
export function settingsOf(env: ProfitEnv): Settings {
  return {
    confirmMs: int(env.ETI_PROFIT_CONFIRM_MINUTES, 60, 0, 10_080) * 60_000,
    windowMs: int(env.ETI_PROFIT_DRAWDOWN_WINDOW_DAYS, 30, 1, 365) * 86_400_000,
    maxDrawdownBps: int(env.ETI_PROFIT_MAX_DRAWDOWN_BPS, 1000, 1, 10_000),
    autoAllocate: String(env.ETI_PROFIT_AUTO_ALLOCATE ?? "true").toLowerCase() !== "false",
    minAllocationCents: int(env.ETI_PROFIT_MIN_ALLOCATION_CENTS, 100, 0, 1_000_000_000),
    seedCapitalCents: int(env.ETI_PROFIT_SIM_CAPITAL_CENTS, 0, 0, 1_000_000_000_000),
  };
}

let ready: Promise<void> | null = null;
async function ensure(db: TreasuryD1): Promise<void> {
  if (!ready) ready = (async () => { await TI.ensureSchema(db); await db.batch(SCHEMA.map(s => db.prepare(s))); })().catch(e => { ready = null; throw e; });
  return ready;
}
export const resetForTests = () => { ready = null; TI.resetSchemaCache(); };

async function loadAllTrades(env: ProfitEnv) {
  const store = openJournal(env as any); if (!store) return null;
  const { entries, truncated } = await store.all();
  return { trades: buildTrades(entries), truncated };
}

export interface State {
  environment: T.Environment; at: number; settings: Settings; journal: { available: boolean; truncated: boolean };
  realized: M.Realized; pending: M.Realized; recognised: M.Realized;
  eligible: M.Eligible[]; excluded: M.Excluded[]; excludedByReason: Record<string, number>;
  balances: ReturnType<typeof TI.balanceView> | null; policy: (T.Policy & { id: string; version: number }) | null;
  protection: M.Protection; recommendation: M.Recommendation; distributableCents: number; notes: string[];
}
const reasonCounts = (x: M.Excluded[]) => x.reduce<Record<string, number>>((m, e) => { m[e.reason] = (m[e.reason] ?? 0) + 1; return m; }, {});

/** Everything the dashboard and the cycle need, computed from confirmed data only. Read-only. */
export async function profitState(env: ProfitEnv, environment: T.Environment, now = Date.now()): Promise<State> {
  const db = env.ETI_PORTFOLIO_DB as TreasuryD1 | undefined; if (!db) throw new Error("storage_not_configured");
  await ensure(db);
  const s = settingsOf(env), journal = await loadAllTrades(env);
  const done = (await db.prepare("SELECT trade_id, closed_at, gross_cents, fees_cents, net_cents FROM profit_engine_trades WHERE environment = ?").bind(environment).all<any>()).results;
  const seen = new Set<string>(done.map((r: any) => r.trade_id));
  const cls = M.classifyTrades(journal?.trades ?? [], { environment, now, confirmMs: s.confirmMs, alreadyRecognised: seen });
  const recognisedRows: M.Eligible[] = done.map((r: any) => ({ tradeId: r.trade_id, symbol: null, closedAt: r.closed_at, grossCents: r.gross_cents, feesCents: r.fees_cents, netCents: r.net_cents, strategy: null }));
  const bal = await TI.readBalances(db, environment), pol = await TI.activePolicy(db, environment), policy = pol ? { id: pol.id as string, version: pol.version as number, ...TI.policyOf(pol) } : null;
  const pending = M.summarise(cls.eligible);
  // Planning view: confirmed-but-unposted results are applied to the balances they will hit (profit into the pool, a net loss against capital).
  const planBal: T.Balances = { ...bal.b, realizedProfits: bal.b.realizedProfits + Math.max(0, pending.netCents), tradingCapital: Math.max(0, bal.b.tradingCapital - Math.max(0, -pending.netCents)) };
  const planLoss = bal.unrecoveredLoss + Math.max(0, -pending.netCents);
  const protection = M.assessProtection({ policy, balances: planBal, unrecoveredLoss: planLoss, recent: [...recognisedRows, ...cls.eligible], now, windowMs: s.windowMs, maxDrawdownBps: s.maxDrawdownBps });
  const recommendation = M.recommend(policy, planBal, planLoss, planBal.realizedProfits, protection);
  const notes: string[] = [];
  if (!journal) notes.push("The trade journal is not available (no D1 or KV binding): nothing can be calculated.");
  if (journal?.truncated) notes.push("The journal read was truncated; older trades may be missing from this view.");
  if (environment === "actual") notes.push("Real-funds books: ETI places no live orders and cannot confirm live settlement, so nothing is recognised automatically. Record confirmed profit through the treasury's profit-batch workflow.");
  return { environment, at: now, settings: s, journal: { available: !!journal, truncated: !!journal?.truncated }, realized: M.summarise([...recognisedRows, ...cls.eligible]),
    pending, recognised: M.summarise(recognisedRows), eligible: cls.eligible, excluded: cls.excluded, excludedByReason: reasonCounts(cls.excluded),
    balances: TI.balanceView(environment, bal), policy, protection, recommendation, distributableCents: recommendation.totalCents, notes };
}

export interface CycleResult { environment: T.Environment; ran: boolean; skipped?: string; recognised?: { batchId: string; trades: number; netCents: number; entryId: string }[]; blocked?: string; allocation?: { entryId: string; totalCents: number; mode: string } | null; seeded?: number }
const id = () => crypto.randomUUID();
const logRun = (db: TreasuryD1, environment: string, now: number, kind: string, detail: unknown, batchId: string | null = null, entryId: string | null = null) =>
  db.prepare("INSERT INTO profit_engine_runs (id, environment, at, kind, batch_id, entry_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id(), environment, now, kind, batchId, entryId, JSON.stringify(detail).slice(0, 4000)).run().catch(() => undefined);

/**
 * One pass for the simulated books: recognise newly confirmed results, then allocate per the active policy. Idempotent: a trade can enter the
 * books once (PRIMARY KEY), and the batch row, trade rows, ledger entry and balances commit together or not at all.
 */
export async function runProfitCycle(env: ProfitEnv, environment: T.Environment = "simulated", now = Date.now(), opts: { force?: boolean } = {}): Promise<CycleResult> {
  const db = env.ETI_PORTFOLIO_DB as TreasuryD1 | undefined;
  if (!db) return { environment, ran: false, skipped: "storage_not_configured" };
  if (environment !== "simulated") return { environment, ran: false, skipped: "actual_books_are_never_automatic" };
  await ensure(db);
  if (!opts.force) {
    const last = await db.prepare("SELECT v FROM profit_engine_meta WHERE k = ?").bind("lastCycle:" + environment).first<{ v: string }>();
    if (last && now - Number(last.v) < CYCLE_INTERVAL_MS) return { environment, ran: false, skipped: "throttled" };
  }
  await db.prepare("INSERT INTO profit_engine_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind("lastCycle:" + environment, String(now)).run();
  try { await runJournalCycle(env as any, now); } catch { /* the journal sync is best-effort; classification uses whatever is recorded */ }
  const out: CycleResult = { environment, ran: true, recognised: [] }, s = settingsOf(env);

  // Optional one-time simulated trading capital so simulated losses have capital to be charged against.
  if (s.seedCapitalCents > 0) {
    const bal = await TI.readBalances(db, environment), hasLedger = ((await db.prepare("SELECT COUNT(*) AS n FROM treasury_entries WHERE environment = ?").bind(environment).first<any>())?.n ?? 0) > 0;
    if (!hasLedger && bal.b.tradingCapital === 0) {
      try { await TI.postEntry(db, now, { id: id(), env: environment, kind: "capital_contribution", actor: SYSTEM_ACTOR, reference: "sim-seed:" + environment, period: TI.quarterOf(now), memo: JSON.stringify({ account: "1100", note: "Simulated trading capital (ETI_PROFIT_SIM_CAPITAL_CENTS). Not real money." }), lines: T.contributionLines("1100", s.seedCapitalCents) }); out.seeded = s.seedCapitalCents; } catch { /* already seeded concurrently */ }
    }
  }

  const st = await profitState(env, environment, now);
  // Recognise in chunks so every atomic batch stays small. Chunks are time-ordered so an early loss cannot hide behind a later profit.
  const rows = [...st.eligible].sort((a, b) => a.closedAt - b.closedAt);
  for (let i = 0; i < rows.length; i += 25) {
    const chunk = rows.slice(i, i + 25), sum = M.summarise(chunk), batchId = id(), entryId = id(), period = TI.quarterOf(now);
    if (sum.netCents === 0) {
      // Break-even chunk: nothing to post, but the trades are settled so they are not re-read forever.
      const stmts = chunk.map(r => db.prepare("INSERT OR IGNORE INTO profit_engine_trades (trade_id, environment, batch_id, closed_at, gross_cents, fees_cents, net_cents, strategy, symbol, recognised_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(r.tradeId, environment, batchId, r.closedAt, r.grossCents, r.feesCents, r.netCents, r.strategy, r.symbol, now));
      try { await db.batch(stmts); out.recognised!.push({ batchId, trades: chunk.length, netCents: 0, entryId: "" }); } catch { /* concurrent run already took them */ }
      continue;
    }
    const loss = sum.netCents < 0 ? -sum.netCents : 0;
    const batchInsert = db.prepare("INSERT INTO treasury_profit_batches (id, environment, period, source, description, gross_cents, fees_cents, net_cents, status, recorded_by, settled_by, settled_at, settlement_reference, reconciled_by, reconciled_at, reconciliation_reference, entry_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reconciled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(batchId, environment, period, "eti-auto:" + M.SOURCE + " (paper/testnet)", `${chunk.length} confirmed closed trade(s), simulated money`, sum.grossCents, sum.feesCents, sum.netCents,
        SYSTEM_ACTOR, "system:trade-journal", now, "journal:" + batchId, "system:profit-engine-check", now, "journal-chain:" + batchId, entryId, "Automatic: realized, closed, fee-confirmed trades only. Simulated environment: segregation of duties applies to actual funds.", now);
    const tradeStmts = chunk.map(r => db.prepare("INSERT INTO profit_engine_trades (trade_id, environment, batch_id, closed_at, gross_cents, fees_cents, net_cents, strategy, symbol, recognised_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(r.tradeId, environment, batchId, r.closedAt, r.grossCents, r.feesCents, r.netCents, r.strategy, r.symbol, now));
    try {
      await TI.postEntry(db, now, { id: entryId, env: environment, kind: loss ? "loss_recognition" : "profit_recognition", actor: SYSTEM_ACTOR, reference: "batch:" + batchId, period,
        memo: JSON.stringify({ batch: batchId, source: M.SOURCE, trades: chunk.length, gross: sum.grossCents, fees: sum.feesCents, automatic: true }),
        lines: loss ? T.lossRecognitionLines(loss) : T.profitRecognitionLines(sum.netCents),
        pre: [{ stmt: batchInsert }, ...tradeStmts.map(stmt => ({ stmt }))],
        after: loss ? [db.prepare("UPDATE treasury_state SET unrecovered_loss_cents = unrecovered_loss_cents + ? WHERE environment = ?").bind(loss, environment)] : [] });
      out.recognised!.push({ batchId, trades: chunk.length, netCents: sum.netCents, entryId });
      await logRun(db, environment, now, "recognised", { trades: chunk.length, netCents: sum.netCents, grossCents: sum.grossCents, feesCents: sum.feesCents }, batchId, entryId);
    } catch (e: any) {
      const code = e?.body?.error || e?.message || "failed";
      if (code === "insufficient_funds") { out.blocked = "A realized loss cannot be charged because simulated trading capital is too low. Contribute simulated trading capital (POST /api/treasury/contributions) or set ETI_PROFIT_SIM_CAPITAL_CENTS."; await logRun(db, environment, now, "blocked", { code, lossCents: loss }); break; }
      if (code === "reference_already_used") continue; // another run recognised these trades first
      out.blocked = String(code); await logRun(db, environment, now, "error", { code }); break;
    }
  }

  // Allocation per the active policy (simulated money only). Never from unrealized or unconfirmed amounts: the pool is the recognised realized-profits balance.
  if (!out.blocked && s.autoAllocate) {
    const fresh = await profitState(env, environment, now), rec = fresh.recommendation;
    if (fresh.policy && rec.mode !== "none" && rec.totalCents >= s.minAllocationCents && fresh.pending.trades === 0) {
      const eid = id(), pol = (await TI.activePolicy(db, environment)), bal = await TI.readBalances(db, environment);
      const plan = rec.mode === "capital_protection_hold" ? { allocations: rec.allocations, totalCents: rec.totalCents, lossRecoveredCents: 0 } : T.planAllocation(TI.policyOf(pol), bal.b, bal.unrecoveredLoss);
      if (plan.totalCents > 0) {
        try {
          const posted = await TI.postEntry(db, now, { id: eid, env: environment, kind: "profit_allocation", actor: SYSTEM_ACTOR, reference: "alloc:" + eid, period: TI.quarterOf(now),
            memo: JSON.stringify({ policyVersion: pol.version, plan: plan.allocations, mode: rec.mode, automatic: true, protection: fresh.protection.checks.map(c => c.name + ":" + (c.met ? "met" : "NOT_MET")) }), lines: T.allocationLines(plan.allocations),
            after: plan.lossRecoveredCents > 0 ? [db.prepare("UPDATE treasury_state SET unrecovered_loss_cents = unrecovered_loss_cents - ? WHERE environment = ?").bind(plan.lossRecoveredCents, environment)] : [] });
          out.allocation = { entryId: posted.id, totalCents: plan.totalCents, mode: rec.mode };
          await logRun(db, environment, now, "allocated", { totalCents: plan.totalCents, mode: rec.mode, plan: plan.allocations }, null, posted.id);
        } catch (e: any) { out.blocked = e?.body?.error || "allocation_failed"; await logRun(db, environment, now, "error", { stage: "allocation", code: out.blocked }); }
      }
    }
  }
  return out;
}

// ---- expense forecast ----
export async function expenseForecast(env: ProfitEnv, environment: T.Environment, months: number, now = Date.now()): Promise<M.Forecast> {
  const db = env.ETI_PORTFOLIO_DB as TreasuryD1 | undefined; if (!db) throw new Error("storage_not_configured");
  await ensure(db); try { await db.batch(COMPANY_SCHEMA.map(x => db.prepare(x))); } catch { /* exists */ }
  const paid = (await db.prepare("SELECT paid_at, amount_cents FROM company_expenses WHERE status = 'paid' AND paid_at IS NOT NULL AND paid_at >= ?").bind(now - 200 * 86_400_000).all<any>()).results.map((r: any) => ({ paidAt: r.paid_at, cents: r.amount_cents }));
  const q = TI.quarterOf(now), budget = (await db.prepare("SELECT COALESCE(SUM(allocated_cents),0) AS c, COUNT(*) AS n FROM company_budgets WHERE period = ? AND status = 'approved'").bind(q).first<any>()), bal = await TI.readBalances(db, environment);
  return M.forecastExpenses(paid, now, Math.max(1, Math.min(12, months)), T.liquidFunds(bal.b), bal.b.liabilities, budget && budget.n > 0 ? Math.round(budget.c / 3) : null);
}

// ---- financial performance report ----
export const periodRange = (period: string, now: number): { from: number; to: number; label: string } | null => {
  if (period === "all") return { from: 0, to: now + 1, label: "all time" };
  let m = /^(\d{4})-Q([1-4])$/.exec(period); if (m) { const y = +m[1], q = +m[2]; return { from: Date.UTC(y, (q - 1) * 3, 1), to: Date.UTC(y, q * 3, 1), label: period }; }
  m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period); if (m) { const y = +m[1], mo = +m[2]; return { from: Date.UTC(y, mo - 1, 1), to: Date.UTC(y, mo, 1), label: period }; }
  return null;
};

export async function financialReport(env: ProfitEnv, environment: T.Environment, period: string, now = Date.now()) {
  const range = periodRange(period, now); if (!range) throw new Error("invalid_period");
  const db = env.ETI_PORTFOLIO_DB as TreasuryD1, st = await profitState(env, environment, now);
  const rows = (await db.prepare("SELECT trade_id, closed_at, gross_cents, fees_cents, net_cents, strategy, symbol FROM profit_engine_trades WHERE environment = ? AND closed_at >= ? AND closed_at < ? ORDER BY closed_at").bind(environment, range.from, range.to).all<any>()).results;
  const el: M.Eligible[] = rows.map((r: any) => ({ tradeId: r.trade_id, symbol: r.symbol, closedAt: r.closed_at, grossCents: r.gross_cents, feesCents: r.fees_cents, netCents: r.net_cents, strategy: r.strategy }));
  const realized = M.summarise(el);
  const by = (k: (r: M.Eligible) => string) => { const m = new Map<string, M.Eligible[]>(); for (const r of el) (m.get(k(r)) ?? m.set(k(r), []).get(k(r))!).push(r); return [...m].map(([key, v]) => ({ key, ...M.summarise(v) })).sort((a, b) => b.netCents - a.netCents); };
  let cum = 0; const day = new Map<string, number>(); for (const r of el) { cum += r.netCents; day.set(new Date(r.closedAt).toISOString().slice(0, 10), cum); }
  const alloc = (await db.prepare("SELECT l.account_code AS account, SUM(l.debit_cents) AS cents FROM treasury_lines l JOIN treasury_entries e ON e.id = l.entry_id WHERE e.environment = ? AND e.kind = 'profit_allocation' AND e.at >= ? AND e.at < ? AND l.debit_cents > 0 GROUP BY l.account_code").bind(environment, range.from, range.to).all<any>()).results;
  const names: Record<string, string> = { "1100": "Trading capital", "1300": "Operating funds", "1400": "Emergency reserve", "1500": "Long-term investments" };
  const fc = await expenseForecast(env, environment, 3, now);
  const net = realized.netCents, fees = realized.feesCents;
  return {
    environment, funds: environment === "actual" ? "actual funds" : "SIMULATED - not real money", period: range.label, generatedAt: new Date(now).toISOString(),
    basis: "Realized, closed, fee-confirmed trades recognised in the books. Unrealized gains and unconfirmed items are excluded.",
    realized: { ...realized, costRatio: realized.grossCents > 0 ? fees / realized.grossCents : null, avgNetPerTradeCents: realized.trades ? Math.round(net / realized.trades) : null },
    byStrategy: by(r => r.strategy ?? "unattributed"), bySymbol: by(r => r.symbol ?? "unknown").slice(0, 15),
    equityCurve: [...day].map(([date, netCents]) => ({ date, cumulativeNetCents: netCents })),
    allocations: alloc.map((a: any) => ({ account: a.account, name: names[a.account] ?? a.account, cents: a.cents })),
    balances: st.balances, policy: st.policy, protection: st.protection, recommendation: st.recommendation,
    pendingConfirmation: { trades: st.pending.trades, netCents: st.pending.netCents }, excluded: st.excludedByReason,
    expenseForecast: fc,
    note: "Management report from internal records. Not audited financial statements. USDT results are treated as USD.",
  };
}

export function reportMarkdown(r: Awaited<ReturnType<typeof financialReport>>): string {
  const u = M.fmtUsd, L: string[] = [];
  L.push(`# ETI financial performance report: ${r.period}`, `Books: **${r.environment}** (${r.funds}). Generated ${r.generatedAt}.`, "", `> ${r.basis}`, "");
  L.push("## Realized results", `- Closed trades: ${r.realized.trades} (wins ${r.realized.wins}, losses ${r.realized.losses}, breakeven ${r.realized.breakeven})`,
    `- Gross: ${u(r.realized.grossCents)}  |  Fees and commissions: ${u(r.realized.feesCents)}  |  **Net: ${u(r.realized.netCents)}**`,
    `- Winning trades ${u(r.realized.winsCents)}, losing trades ${u(r.realized.lossesCents)}, profit factor ${r.realized.profitFactor == null ? "n/a" : r.realized.profitFactor.toFixed(2)}, win rate ${r.realized.winRate == null ? "n/a" : (r.realized.winRate * 100).toFixed(1) + "%"}`, "");
  L.push("## Allocations made", r.allocations.length ? r.allocations.map(a => `- ${a.name}: ${u(a.cents)}`).join("\n") : "- None in this period.", "");
  const b: any = r.balances?.buckets;
  if (b) L.push("## Balances now", `- Trading capital ${u(b.trading_capital)}, realized profit pool ${u(b.realized_profits)}, operating funds ${u(b.operating_funds)}, emergency reserve ${u(b.emergency_reserve)}, long-term investments ${u(b.long_term_investments)}, liabilities ${u(b.outstanding_liabilities ?? 0)}`, "");
  L.push("## Capital protection", ...r.protection.checks.map(c => `- ${c.met ? "OK " : "NOT MET "} ${c.name}: ${c.detail}`), r.protection.hold ? "- **Distributions on hold.**" : "", "");
  L.push("## Recommendation", `- ${r.recommendation.note}`, ...r.recommendation.allocations.map(a => `- ${a.account} ${u(a.cents)} (${a.reason})`), "");
  L.push("## Expense forecast", `- ${r.expenseForecast.method}; average ${u(r.expenseForecast.monthlyAverageCents)}/month over ${r.expenseForecast.historyMonths} month(s)`, ...r.expenseForecast.months.map(m => `- ${m.month}: ${u(m.baseCents)} (range ${u(m.lowCents)} to ${u(m.highCents)})`),
    `- Runway at base spend: ${r.expenseForecast.runwayMonths == null ? "n/a" : r.expenseForecast.runwayMonths + " months"}`, "");
  const ex = Object.entries(r.excluded); L.push("## Excluded from profit (not counted)", ex.length ? ex.map(([k, n]) => `- ${k}: ${n}`).join("\n") : "- Nothing excluded.", "", `_${r.note}_`);
  return L.join("\n");
}
export function reportCsv(r: Awaited<ReturnType<typeof financialReport>>): string {
  const rows: unknown[][] = [["section", "item", "value_cents_or_count"], ["realized", "closed_trades", r.realized.trades], ["realized", "gross_cents", r.realized.grossCents], ["realized", "fees_cents", r.realized.feesCents], ["realized", "net_cents", r.realized.netCents],
    ...r.allocations.map(a => ["allocation", a.name, a.cents]), ...r.byStrategy.map(s => ["strategy_net_cents", s.key, s.netCents]), ...r.expenseForecast.months.map(m => ["forecast_expense_base_cents", m.month, m.baseCents]),
    ...Object.entries(r.excluded).map(([k, n]) => ["excluded", k, n])];
  return rows.map(x => x.map(M.csvEscape).join(",")).join("\n") + "\n";
}
