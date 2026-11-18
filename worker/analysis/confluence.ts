// Multi-timeframe confluence. Combines per-timeframe SMC analyses (smc-intel.ts) into one transparent, weighted evidence score.
// Every contribution is listed with its points and maximum, so the score can be audited. Stale or missing timeframes are excluded
// (fail safe) and reported. The score is an evidence summary, not a probability, and nothing here can submit an order.
import { clamp, round } from "./types.ts";
import type { SmcAnalysis, SmcDetection } from "./smc-intel.ts";

export const CONFLUENCE_TIMEFRAMES = ["1M", "1w", "1d", "4h", "1h", "15m", "5m"] as const;
export type ConfluenceTf = typeof CONFLUENCE_TIMEFRAMES[number];
export const CONFLUENCE_WEIGHT: Record<ConfluenceTf, number> = { "1M": 3, "1w": 3, "1d": 3, "4h": 2.5, "1h": 2, "15m": 1.5, "5m": 1 };
export const CONFLUENCE_TF_SECS: Record<ConfluenceTf, number> = { "1M": 2629800, "1w": 604800, "1d": 86400, "4h": 14400, "1h": 3600, "15m": 900, "5m": 300 };
const HIGHER: ConfluenceTf[] = ["1M", "1w", "1d"], MID: ConfluenceTf[] = ["4h", "1h"];
/** A frame whose newest closed candle is older than this many periods is treated as stale and excluded. */
export const STALE_PERIODS = 3;
export const NEAR_ZONE_PCT = 0.005;

export type Dir = "bullish" | "bearish" | "neutral";
export interface ConfluenceOrderFlow { deltaPct: number; coverage: "exchange_trades" | "unavailable"; asOf: number; sampleTrades: number }
export interface ConfluenceInput {
  symbol: string;
  frames: Partial<Record<ConfluenceTf, SmcAnalysis>>;
  /** Optional per-timeframe momentum stance supplied by the technical engine. */
  momentum?: Partial<Record<ConfluenceTf, Dir>>;
  orderFlow?: ConfluenceOrderFlow | null;
  entryTimeframe?: ConfluenceTf;
  now: number;
  /** Maximum age of order-flow data in ms. */
  orderFlowMaxAgeMs?: number;
}
export interface EvidenceItem { id: string; label: string; timeframe?: ConfluenceTf; direction: Dir; points: number; max: number; detail: string }
export interface ZoneOverlap { direction: Dir; low: number; high: number; members: { id: string; kind: string; timeframe: string }[] }
export interface LiquidityTarget { side: "buy_side" | "sell_side"; price: number; timeframe: string; distancePct: number; touches: number }
export interface ConfluenceResult {
  symbol: string;
  status: "ready" | "insufficient";
  score: number;
  stance: "bullish" | "bearish" | "neutral" | "conflicted" | "insufficient";
  confidence: number; confidenceType: "evidence_quality_not_probability";
  coverage: number;
  usedTimeframes: ConfluenceTf[]; missingTimeframes: ConfluenceTf[]; staleTimeframes: ConfluenceTf[];
  evidence: EvidenceItem[]; conflicts: string[]; overlaps: ZoneOverlap[]; liquidityTargets: LiquidityTarget[];
  entry: { timeframe: ConfluenceTf | null; confirmed: boolean | null; detail: string };
  orderFlow: { used: boolean; detail: string };
  methodology: string;
  asOf: string;
  canTriggerTrade: false; submitsOrder: false; liveExecutionAllowed: false;
}

const sgn = (d: Dir) => (d === "bullish" ? 1 : d === "bearish" ? -1 : 0);
const dirOf = (s: string | undefined): Dir => (s === "bullish" || s === "uptrend" ? "bullish" : s === "bearish" || s === "downtrend" ? "bearish" : "neutral");
const live = (d: SmcDetection) => d.confirmation === "confirmed" && (d.state === "active" || d.state === "mitigated" || d.state === "open" || d.state === "partially_filled") && (d.kind === "order_block" || d.kind === "fair_value_gap" || d.kind === "inverse_fvg");

export function confluence(inp: ConfluenceInput): ConfluenceResult {
  const used: ConfluenceTf[] = [], missing: ConfluenceTf[] = [], stale: ConfluenceTf[] = [], ev: EvidenceItem[] = [], conflicts: string[] = [];
  const price = (() => { const t = inp.entryTimeframe && inp.frames[inp.entryTimeframe]?.price; if (t) return t; for (const tf of [...CONFLUENCE_TIMEFRAMES].reverse()) { const p = inp.frames[tf]?.price; if (p) return p; } return null; })();
  for (const tf of CONFLUENCE_TIMEFRAMES) {
    const f = inp.frames[tf];
    if (!f || f.status !== "ready" || f.lastClosedTime == null) { missing.push(tf); continue; }
    if (inp.now - f.lastClosedTime > STALE_PERIODS * CONFLUENCE_TF_SECS[tf] * 1000 + CONFLUENCE_TF_SECS[tf] * 1000) { stale.push(tf); continue; }
    used.push(tf);
  }
  const totalW = CONFLUENCE_TIMEFRAMES.reduce((s, t) => s + CONFLUENCE_WEIGHT[t], 0), usedW = used.reduce((s, t) => s + CONFLUENCE_WEIGHT[t], 0), coverage = usedW / totalW;
  const add = (e: EvidenceItem) => { ev.push({ ...e, points: round(e.points, 2), max: round(e.max, 2) }); };

  const stances = new Map<ConfluenceTf, Dir>();
  for (const tf of used) {
    const f = inp.frames[tf]!, w = CONFLUENCE_WEIGHT[tf], d = dirOf(f.stance === "bullish" || f.stance === "bearish" ? f.stance : f.trend);
    stances.set(tf, d);
    add({ id: `structure:${tf}`, label: "Structure", timeframe: tf, direction: d, points: sgn(d) * w, max: w, detail: `trend ${f.trend}, stance ${f.stance}` });
    const pd = f.premiumDiscount;
    if (pd) { const dd: Dir = pd.zone === "discount" ? "bullish" : pd.zone === "premium" ? "bearish" : "neutral"; add({ id: `zone:${tf}`, label: "Premium/discount", timeframe: tf, direction: dd, points: sgn(dd) * 0.5 * w, max: 0.5 * w, detail: `price at ${pd.positionPct}% of the ${tf} swing range (${pd.zone})` }); }
    const m = inp.momentum?.[tf];
    if (m) add({ id: `momentum:${tf}`, label: "Momentum", timeframe: tf, direction: m, points: sgn(m) * 0.5 * w, max: 0.5 * w, detail: `momentum ${m}` });
    // Active zone support / resistance near price.
    if (price) {
      let sup = 0, res = 0; const names: string[] = [];
      for (const d of f.detections.filter(live)) {
        const lo = d.zone.low * (1 - NEAR_ZONE_PCT), hi = d.zone.high * (1 + NEAR_ZONE_PCT);
        if (price < lo || price > hi) continue;
        if (d.direction === "bullish") sup++; else if (d.direction === "bearish") res++;
        names.push(`${d.direction} ${d.kind}`);
      }
      const dd: Dir = sup > res ? "bullish" : res > sup ? "bearish" : "neutral";
      add({ id: `zones-near:${tf}`, label: "Active zones at price", timeframe: tf, direction: dd, points: sgn(dd) * 0.75 * w, max: 0.75 * w, detail: names.length ? names.join(", ") : "no active zone within 0.5% of price" });
    }
    const sw = f.detections.filter(d => d.kind === "liquidity_sweep" && d.freshnessBars <= 10).sort((a, b) => a.freshnessBars - b.freshnessBars)[0];
    add({ id: `sweep:${tf}`, label: "Recent liquidity sweep", timeframe: tf, direction: sw ? (sw.direction as Dir) : "neutral", points: sw ? sgn(sw.direction as Dir) * 0.5 * w : 0, max: 0.5 * w, detail: sw ? `${sw.direction} reclaim ${sw.freshnessBars} bars ago` : "none in the last 10 bars" });
  }

  // Zone overlaps (same direction, intersecting ranges, from different detections).
  const zones: (SmcDetection & { tf: ConfluenceTf })[] = [];
  for (const tf of used) for (const d of inp.frames[tf]!.detections.filter(live)) zones.push({ ...d, tf });
  const overlaps: ZoneOverlap[] = [], seen = new Set<string>();
  for (let i = 0; i < zones.length; i++) for (let j = i + 1; j < zones.length; j++) {
    const a = zones[i], b = zones[j];
    if (a.direction !== b.direction || a.direction === "neutral") continue;
    const lo = Math.max(a.zone.low, b.zone.low), hi = Math.min(a.zone.high, b.zone.high);
    if (!(hi > lo)) continue;
    if (a.kind === b.kind && a.tf === b.tf) continue;
    const key = [a.id, b.id].sort().join("|"); if (seen.has(key)) continue; seen.add(key);
    overlaps.push({ direction: a.direction, low: lo, high: hi, members: [a, b].map(x => ({ id: x.id, kind: x.kind, timeframe: x.timeframe })) });
  }
  overlaps.sort((x, y) => y.members.reduce((s, m) => s + CONFLUENCE_WEIGHT[m.timeframe as ConfluenceTf], 0) - x.members.reduce((s, m) => s + CONFLUENCE_WEIGHT[m.timeframe as ConfluenceTf], 0));
  if (used.length) {
    const bull = overlaps.filter(o => o.direction === "bullish").length, bear = overlaps.filter(o => o.direction === "bearish").length;
    const d: Dir = bull > bear ? "bullish" : bear > bull ? "bearish" : "neutral", mag = Math.min(1, 0.5 * Math.abs(bull - bear));
    add({ id: "overlaps", label: "FVG / order-block overlap", direction: d, points: sgn(d) * mag, max: 1, detail: `${bull} bullish and ${bear} bearish cross-detection overlaps` });
  }

  // Order-flow confirmation: only fresh exchange-provided trade data counts.
  const ofMax = inp.orderFlowMaxAgeMs ?? 5 * 60_000;
  let ofNote = "No order-flow data supplied";
  let ofUsed = false;
  if (inp.orderFlow && inp.orderFlow.coverage === "exchange_trades" && inp.orderFlow.sampleTrades >= 50 && inp.now - inp.orderFlow.asOf <= ofMax && Number.isFinite(inp.orderFlow.deltaPct)) {
    const dp = clamp(inp.orderFlow.deltaPct, -100, 100), d: Dir = dp >= 10 ? "bullish" : dp <= -10 ? "bearish" : "neutral";
    add({ id: "orderflow", label: "Order-flow delta", direction: d, points: sgn(d) * 1.5 * Math.min(1, Math.abs(dp) / 50), max: 1.5, detail: `aggressor delta ${round(dp, 1)}% over ${inp.orderFlow.sampleTrades} trades (exchange trade tape)` });
    ofUsed = true; ofNote = `Delta ${round(dp, 1)}% from ${inp.orderFlow.sampleTrades} exchange trades`;
  } else if (inp.orderFlow) ofNote = inp.orderFlow.coverage !== "exchange_trades" ? "Order-flow coverage is unavailable; no estimate is substituted" : inp.orderFlow.sampleTrades < 50 ? "Too few trades for a reliable delta" : "Order-flow data is stale";

  // Conflicts between groups of timeframes.
  const groupDir = (tfs: ConfluenceTf[]): Dir => { let s = 0, w = 0; for (const t of tfs) { const d = stances.get(t); if (!d) continue; s += sgn(d) * CONFLUENCE_WEIGHT[t]; w += CONFLUENCE_WEIGHT[t]; } return !w ? "neutral" : s / w >= 0.3 ? "bullish" : s / w <= -0.3 ? "bearish" : "neutral"; };
  const entryTf = inp.entryTimeframe && used.includes(inp.entryTimeframe) ? inp.entryTimeframe : ([...used].reverse().find(t => t === "15m" || t === "5m") ?? null);
  const hd = groupDir(HIGHER), md = groupDir(MID), ed = entryTf ? stances.get(entryTf) ?? "neutral" : "neutral";
  if (sgn(hd) && sgn(md) && hd !== md) conflicts.push(`Higher timeframes are ${hd} but 4H/1H are ${md}`);
  if (sgn(hd) && sgn(ed) && hd !== ed) conflicts.push(`Higher timeframes are ${hd} but the ${entryTf} entry timeframe is ${ed}`);
  if (sgn(md) && sgn(ed) && md !== ed) conflicts.push(`4H/1H are ${md} but the ${entryTf} entry timeframe is ${ed}`);
  const bullSw = zones.filter(z => z.direction === "bullish" && z.freshnessBars <= 5).length, bearSw = zones.filter(z => z.direction === "bearish" && z.freshnessBars <= 5).length;
  if (bullSw && bearSw) conflicts.push(`Fresh bullish (${bullSw}) and bearish (${bearSw}) zones formed in the last 5 bars`);

  const consensus: Dir = (() => { const s = [...stances.entries()].reduce((a, [t, d]) => a + sgn(d) * CONFLUENCE_WEIGHT[t], 0); return s > 0 ? "bullish" : s < 0 ? "bearish" : "neutral"; })();
  const entryConfirmed = entryTf ? (sgn(consensus) === 0 ? null : ed === consensus) : null;
  const entryDetail = !entryTf ? "No usable entry timeframe (15m/5m) is available" : entryConfirmed === null ? `${entryTf} is ${ed}; higher-timeframe consensus is neutral` : entryConfirmed ? `${entryTf} entry timeframe agrees with the ${consensus} consensus` : `${entryTf} is ${ed} against the ${consensus} consensus`;
  if (entryTf && entryConfirmed !== null) add({ id: "entry", label: "Entry-timeframe confirmation", timeframe: entryTf, direction: entryConfirmed ? consensus : (ed === "neutral" ? "neutral" : ed), points: entryConfirmed ? sgn(consensus) : ed === "neutral" ? 0 : sgn(ed), max: 1, detail: entryDetail });

  const pts = ev.reduce((s, e) => s + e.points, 0), max = ev.reduce((s, e) => s + e.max, 0);
  const score = max > 0 ? clamp(round((100 * pts) / max, 1), -100, 100) : 0;
  const insufficient = coverage < 0.4 || used.length < 2;
  const stance: ConfluenceResult["stance"] = insufficient ? "insufficient" : conflicts.length >= 2 ? "conflicted" : score >= 25 ? "bullish" : score <= -25 ? "bearish" : "neutral";
  const confidence = insufficient ? 0 : clamp(Math.round(coverage * 100 * (1 - 0.15 * conflicts.length) * (ofUsed ? 1 : 0.9)), 0, 85);

  const targets: LiquidityTarget[] = [];
  if (price) for (const tf of used) for (const d of inp.frames[tf]!.detections) {
    if (d.kind !== "liquidity_pool" || d.state !== "open") continue;
    const side: LiquidityTarget["side"] = d.zone.high >= price ? "buy_side" : "sell_side";
    if ((side === "buy_side" && d.zone.high < price) || (side === "sell_side" && d.zone.low > price)) continue;
    const touches = Number(/^(\d+)/.exec(d.evidence[0] ?? "")?.[1] ?? 0);
    targets.push({ side, price: d.zone.high, timeframe: tf, distancePct: round(((d.zone.high - price) / price) * 100, 2), touches });
  }
  const above = targets.filter(t => t.side === "buy_side").sort((a, b) => a.distancePct - b.distancePct).slice(0, 3), below = targets.filter(t => t.side === "sell_side").sort((a, b) => b.distancePct - a.distancePct).slice(0, 3);
  return {
    symbol: inp.symbol, status: insufficient ? "insufficient" : "ready", score, stance, confidence, confidenceType: "evidence_quality_not_probability", coverage: round(coverage, 2),
    usedTimeframes: used, missingTimeframes: missing, staleTimeframes: stale, evidence: ev, conflicts, overlaps: overlaps.slice(0, 10), liquidityTargets: [...above, ...below],
    entry: { timeframe: entryTf, confirmed: entryConfirmed, detail: entryDetail }, orderFlow: { used: ofUsed, detail: ofNote },
    methodology: "Per-timeframe evidence (structure, premium/discount, momentum, active zones at price, recent sweeps) is weighted by timeframe (1M/1w/1d=3, 4H=2.5, 1H=2, 15m=1.5, 5m=1). Score = 100 x sum(points) / sum(max). Stale (> 4 periods old) or missing frames are excluded and reported. Order flow counts only when fresh exchange trade data is supplied. Two or more group conflicts make the stance 'conflicted'. Confidence reflects data coverage and conflicts, is capped at 85 and is not a probability.",
    asOf: new Date(inp.now).toISOString(), canTriggerTrade: false, submitsOrder: false, liveExecutionAllowed: false,
  };
}
