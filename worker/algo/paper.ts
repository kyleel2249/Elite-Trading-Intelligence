// Paper execution engine. Simulated fills against supplied live prices; it never contacts a broker and has no
// withdrawal, transfer or funding concept. Every order must pass an injected risk-gate preflight, and a missing,
// failing or erroring preflight rejects the order (fail closed). It cannot grant itself permissions.
import { manageStop, type TradeLevels } from "./levels.ts";
import type { OmnisignalResult } from "./omnisignal.ts";
import type { ClosedTrade } from "./performance.ts";

export interface PaperConfig {
  startingEquity: number; feeRate: number; slippageBps: number; riskFraction: number; maxNotionalFraction: number; maxOpenPositions: number;
  /** Max distance (bps) a market price may sit outside the entry zone and still fill. */
  maxEntryDeviationBps: number; maxDailyLossPct: number; maxConsecutiveLosses: number; reentryCooldownMs: number;
  /** How long new entries stay paused after the loss streak limit is reached. A further loss re-triggers it. */
  lossPauseMs: number;
}
export const DEFAULT_PAPER_CONFIG: PaperConfig = { startingEquity: 10_000, feeRate: 0.001, slippageBps: 5, riskFraction: 0.005, maxNotionalFraction: 1, maxOpenPositions: 3, maxEntryDeviationBps: 15, maxDailyLossPct: 3, maxConsecutiveLosses: 4, reentryCooldownMs: 3_600_000, lossPauseMs: 86_400_000 };

export interface PreflightRequest { mode: "paper"; symbol: string; side: "buy" | "sell"; quantity: number; orderType: "limit"; limitPrice: number; clientOrderId: string; source: { actorType: "strategy"; actorId: string; signalGeneratedAt: string } }
export type Preflight = (req: PreflightRequest) => Promise<{ approved: boolean; reasons: string[] }>;

export interface PaperPosition {
  clientOrderId: string; symbol: string; direction: 1 | -1; qty: number; remainingQty: number; entry: number; stop: number; initialStop: number;
  targets: { label: "TP1" | "TP2" | "TP3"; price: number; fraction: number; hit: boolean }[]; hitTargets: number; highWater: number; trailDistance: number;
  realizedPnl: number; fees: number; slippage: number; openedAt: number; engine: ClosedTrade["engine"]; confidence: number; regime?: string; riskAmount: number;
}
export interface PaperState { equity: number; positions: PaperPosition[]; closed: ClosedTrade[]; orderIds: string[]; lastStopOut: Record<string, number>; killSwitch: boolean; dayKey: string; dayStartEquity: number; version: number }
export interface AuditEntry { ts: number; type: string; symbol?: string; clientOrderId?: string; detail: Record<string, unknown> }
export interface PaperStore { load(): Promise<PaperState | null>; save(s: PaperState): Promise<void>; audit(e: AuditEntry): Promise<void> }

export class MemoryPaperStore implements PaperStore {
  state: PaperState | null = null; log: AuditEntry[] = [];
  async load() { return this.state ? structuredClone(this.state) : null; }
  async save(s: PaperState) { this.state = structuredClone(s); }
  async audit(e: AuditEntry) { this.log.push(structuredClone(e)); }
}
/** Minimal Cloudflare KV-shaped adapter so the same engine persists on the Worker. Audit entries are individual keys with a TTL. */
export interface KVLike { get(k: string): Promise<string | null>; put(k: string, v: string, o?: { expirationTtl?: number }): Promise<void> }
export class KVPaperStore implements PaperStore {
  private kv: KVLike; private prefix: string;
  constructor(kv: KVLike, prefix = "eti:paper:") { this.kv = kv; this.prefix = prefix; }
  async load() { const v = await this.kv.get(this.prefix + "state"); return v ? JSON.parse(v) as PaperState : null; }
  async save(s: PaperState) { await this.kv.put(this.prefix + "state", JSON.stringify(s)); }
  async audit(e: AuditEntry) { await this.kv.put(`${this.prefix}audit:${e.ts}:${Math.random().toString(36).slice(2, 8)}`, JSON.stringify(e), { expirationTtl: 90 * 86400 }); }
}

export type PaperEvent = { type: "REJECTED" | "OPENED" | "DUPLICATE" | "TP1" | "TP2" | "TP3" | "BREAKEVEN" | "STOP" | "CLOSED" | "KILL_SWITCH" | "HALTED"; symbol?: string; clientOrderId?: string; reasons?: string[]; price?: number; pnl?: number };
const dayOf = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export class PaperEngine {
  readonly cfg: PaperConfig; private store: PaperStore; private preflight: Preflight | null; state: PaperState;
  private constructor(cfg: PaperConfig, store: PaperStore, preflight: Preflight | null, state: PaperState) { this.cfg = cfg; this.store = store; this.preflight = preflight; this.state = state; }
  static async create(store: PaperStore, preflight: Preflight | null, cfg: Partial<PaperConfig> = {}, now = Date.now()): Promise<PaperEngine> {
    const c = { ...DEFAULT_PAPER_CONFIG, ...cfg };
    const restored = await store.load();
    return new PaperEngine(c, store, preflight, restored ?? { equity: c.startingEquity, positions: [], closed: [], orderIds: [], lastStopOut: {}, killSwitch: false, dayKey: dayOf(now), dayStartEquity: c.startingEquity, version: 1 });
  }
  private pending: Promise<void>[] = [];
  private queue(e: AuditEntry) { this.pending.push(this.store.audit(e)); }
  private async persist(e?: AuditEntry) { this.state.version++; if (e) this.queue(e); const q = this.pending; this.pending = []; await Promise.all([this.store.save(this.state), ...q]); }
  private rollDay(now: number) { const k = dayOf(now); if (k !== this.state.dayKey) { this.state.dayKey = k; this.state.dayStartEquity = this.state.equity; } }
  private async reject(plan: OmnisignalResult | null, reasons: string[], now: number, id?: string): Promise<PaperEvent> {
    await this.store.audit({ ts: now, type: "REJECTED", symbol: plan?.symbol, clientOrderId: id, detail: { reasons } });
    return { type: "REJECTED", symbol: plan?.symbol, clientOrderId: id, reasons };
  }
  async setKillSwitch(on: boolean, now = Date.now()): Promise<PaperEvent> { this.state.killSwitch = on; await this.persist({ ts: now, type: on ? "KILL_SWITCH_ON" : "KILL_SWITCH_OFF", detail: {} }); return { type: "KILL_SWITCH", reasons: [on ? "Global kill switch engaged: no new orders" : "Kill switch released"] }; }

  /** Open a paper position from an approved Omnisignal decision at the supplied live market price. */
  async open(plan: OmnisignalResult, marketPrice: number, now = Date.now()): Promise<PaperEvent> {
    this.rollDay(now);
    const s = this.state, id = `eti-paper-${plan.symbol}-${plan.fusion.direction}-${plan.generatedAt}`;
    if (s.orderIds.includes(id)) return { type: "DUPLICATE", symbol: plan.symbol, clientOrderId: id, reasons: ["Order with this idempotency key already exists; not resubmitted"] };
    if (s.killSwitch) return this.reject(plan, ["Kill switch is engaged"], now, id);
    if (plan.decision !== "BUY" && plan.decision !== "SELL") return this.reject(plan, [`Decision is ${plan.decision}; only BUY or SELL can open a position`], now, id);
    if (!plan.entryZone || plan.stopLoss === null || !plan.takeProfits || plan.takeProfits.length !== 3) return this.reject(plan, ["Trade plan is missing entry zone, stop or three targets"], now, id);
    if (plan.expiresAt && Date.parse(plan.expiresAt) < now) return this.reject(plan, ["Signal has expired"], now, id);
    if (!(marketPrice > 0) || !Number.isFinite(marketPrice)) return this.reject(plan, ["No valid live market price"], now, id);
    const dir = plan.decision === "BUY" ? 1 : -1;
    if (s.positions.some(p => p.symbol === plan.symbol)) return this.reject(plan, ["Position already open on this symbol: no averaging down or stacking"], now, id);
    if (s.positions.length >= this.cfg.maxOpenPositions) return this.reject(plan, [`Max open positions reached (${s.positions.length}/${this.cfg.maxOpenPositions})`], now, id);
    const dailyPct = (s.equity - s.dayStartEquity) / s.dayStartEquity * 100;
    if (dailyPct <= -this.cfg.maxDailyLossPct) return this.reject(plan, [`Daily loss limit hit (${dailyPct.toFixed(2)}%)`], now, id);
    const tail = s.closed.slice(-this.cfg.maxConsecutiveLosses);
    if (tail.length === this.cfg.maxConsecutiveLosses && tail.every(t => t.pnl < 0) && now - tail[tail.length - 1].closedAt < this.cfg.lossPauseMs) return this.reject(plan, [`${this.cfg.maxConsecutiveLosses} consecutive losses: new entries paused until ${new Date(tail[tail.length - 1].closedAt + this.cfg.lossPauseMs).toISOString()}`], now, id);
    const last = s.lastStopOut[plan.symbol]; if (last !== undefined && now - last < this.cfg.reentryCooldownMs) return this.reject(plan, ["Re-entry cooldown after a stop-out"], now, id);
    const [zl, zh] = plan.entryZone, dev = marketPrice < zl ? (zl - marketPrice) / zl : marketPrice > zh ? (marketPrice - zh) / zh : 0;
    if (dev * 1e4 > this.cfg.maxEntryDeviationBps) return this.reject(plan, [`Market price ${marketPrice} is ${(dev * 1e4).toFixed(1)} bps outside the entry zone (max ${this.cfg.maxEntryDeviationBps})`], now, id);
    const slipFactor = this.cfg.slippageBps / 1e4, fill = marketPrice * (1 + dir * slipFactor);
    const dist = Math.abs(fill - plan.stopLoss);
    if (!(dist > 0) || (fill - plan.stopLoss) * dir <= 0) return this.reject(plan, ["Stop is not on the protective side of the fill price"], now, id);
    const qty = Math.min((s.equity * this.cfg.riskFraction) / dist, (s.equity * this.cfg.maxNotionalFraction) / fill);
    if (!(qty > 0)) return this.reject(plan, ["Position size computes to zero"], now, id);

    // Mandatory risk-gate preflight. Fail closed on absence, rejection or any error.
    if (!this.preflight) return this.reject(plan, ["Risk gateway preflight is not configured"], now, id);
    let pf: Awaited<ReturnType<Preflight>>;
    try { pf = await this.preflight({ mode: "paper", symbol: plan.symbol, side: dir > 0 ? "buy" : "sell", quantity: qty, orderType: "limit", limitPrice: fill, clientOrderId: id, source: { actorType: "strategy", actorId: `omnisignal:${plan.fusion.acceptedEngine}`, signalGeneratedAt: plan.generatedAt } }); }
    catch (e) { return this.reject(plan, [`Risk gateway unreachable or errored (${e instanceof Error ? e.message : "unknown"}): order blocked`], now, id); }
    if (!pf || pf.approved !== true) return this.reject(plan, ["Risk gateway rejected the order", ...(pf?.reasons ?? [])], now, id);

    const fee = qty * fill * this.cfg.feeRate, fractions = [0.4, 0.3, 0.3];
    const pos: PaperPosition = { clientOrderId: id, symbol: plan.symbol, direction: dir, qty, remainingQty: qty, entry: fill, stop: plan.stopLoss, initialStop: plan.stopLoss, hitTargets: 0, highWater: fill, trailDistance: dist * 1.7,
      targets: plan.takeProfits.map((t, i) => ({ label: t.label, price: t.price, fraction: fractions[i], hit: false })), realizedPnl: -fee, fees: fee, slippage: Math.abs(fill - marketPrice) * qty, openedAt: now,
      engine: plan.fusion.acceptedEngine === "both" ? "combined" : (plan.fusion.acceptedEngine ?? "combined"), confidence: plan.confidence, regime: plan.fusion.swift.regime !== "unknown" ? plan.fusion.swift.regime : plan.fusion.gainz.regime, riskAmount: dist * qty };
    s.positions.push(pos); s.orderIds.push(id); s.equity -= fee;
    await this.persist({ ts: now, type: "OPENED", symbol: plan.symbol, clientOrderId: id, detail: { fill, qty, stop: plan.stopLoss, targets: plan.takeProfits, fee, riskAmount: pos.riskAmount, reasoning: plan.reasons.slice(0, 12), preflight: pf.reasons } });
    return { type: "OPENED", symbol: plan.symbol, clientOrderId: id, price: fill };
  }

  /** Advance a position with one completed or in-progress candle. Stop-first when stop and target are both touched in a bar. */
  async onBar(symbol: string, bar: { ts: number; high: number; low: number; close: number }): Promise<PaperEvent[]> {
    const ev: PaperEvent[] = [], s = this.state, p = s.positions.find(x => x.symbol === symbol);
    if (!p) return ev;
    const d = p.direction, slip = this.cfg.slippageBps / 1e4;
    const closeQty = (qty: number, px: number, kind: string) => {
      const exit = px * (1 - d * slip), gross = (exit - p.entry) * qty * d, fee = qty * exit * this.cfg.feeRate;
      p.remainingQty -= qty; p.realizedPnl += gross - fee; p.fees += fee; p.slippage += Math.abs(exit - px) * qty; s.equity += gross - fee;
      this.queue({ ts: bar.ts, type: kind, symbol, clientOrderId: p.clientOrderId, detail: { price: exit, qty, gross, fee, remaining: p.remainingQty } });
    };
    const finish = (stopped: boolean) => {
      const t: ClosedTrade = { id: p.clientOrderId, engine: p.engine, symbol, regime: p.regime, openedAt: p.openedAt, closedAt: bar.ts, pnl: p.realizedPnl, riskAmount: p.riskAmount, fees: p.fees, slippage: p.slippage, confidence: p.confidence };
      s.closed.push(t); s.positions = s.positions.filter(x => x !== p); if (stopped && p.realizedPnl < 0) s.lastStopOut[symbol] = bar.ts;
      ev.push({ type: "CLOSED", symbol, clientOrderId: p.clientOrderId, pnl: p.realizedPnl });
      this.queue({ ts: bar.ts, type: "CLOSED", symbol, clientOrderId: p.clientOrderId, detail: { pnl: p.realizedPnl, fees: p.fees, slippage: p.slippage } });
    };
    const stopHit = d > 0 ? bar.low <= p.stop : bar.high >= p.stop;
    if (stopHit) { closeQty(p.remainingQty, p.stop, "STOP"); ev.push({ type: "STOP", symbol, clientOrderId: p.clientOrderId, price: p.stop }); finish(true); await this.persist(); return ev; }
    for (const t of p.targets) {
      if (t.hit) continue;
      const hit = d > 0 ? bar.high >= t.price : bar.low <= t.price;
      if (!hit) break;
      const isLast = t.label === "TP3", q = isLast ? p.remainingQty : Math.min(p.remainingQty, p.qty * t.fraction);
      closeQty(q, t.price, t.label); t.hit = true; p.hitTargets++; ev.push({ type: t.label, symbol, clientOrderId: p.clientOrderId, price: t.price });
      if (p.remainingQty <= 1e-12) { finish(false); await this.persist(); return ev; }
    }
    // Stops only ever tighten: break-even after TP1 (covering fees), ATR-style trailing after TP2.
    const lv = { direction: d, entry: p.entry, trailDistance: p.trailDistance } as unknown as TradeLevels;
    const before = p.stop, m = manageStop(lv, { stop: p.stop, hitTargets: p.hitTargets, highWater: p.highWater }, d > 0 ? bar.high : bar.low, p.entry * this.cfg.feeRate * 2);
    p.stop = m.stop; p.highWater = m.highWater;
    if (p.stop !== before && p.hitTargets >= 1 && before === p.initialStop) ev.push({ type: "BREAKEVEN", symbol, clientOrderId: p.clientOrderId, price: p.stop });
    await this.persist();
    return ev;
  }
}
