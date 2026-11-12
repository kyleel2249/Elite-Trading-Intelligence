/**
 * Analytical agents (2-8). Deterministic statistics / rules over supplied or fetched data.
 * They are not language models and they never fabricate inputs: missing data => insufficient_data.
 */
import { INTERVAL_SECONDS } from "../market.ts";
import { makeReport, noData } from "./types.ts";
import type { AgentReport, Ctx, Evidence, Kline, TradeProposal } from "./types.ts";
import {
  atrSeries, autocorr1, beta, bookStats, clamp, correlation, ema, excessKurtosis, finite, lastFinite, logReturns,
  macd, maxDrawdown, mean, obj, rsi, skewness, sma, stdev, varianceRatio, wilson,
} from "./math.ts";

interface Vote { label: string; vote: number; weight: number; note?: string }
const score = (v: Vote[]) => { const w = v.reduce((s, x) => s + x.weight, 0); return w > 0 ? v.reduce((s, x) => s + x.vote * x.weight, 0) / w : 0; };
const voteEvidence = (v: Vote[]): Evidence[] => v.map((x) => ({ label: x.label, value: x.vote, note: x.note }));
const stanceOf = (s: number, th: number) => (s > th ? "bullish" as const : s < -th ? "bearish" as const : "neutral" as const);

// ---------------------------------------------------------------- 2. QUANT
function alignedReturns(a: Kline[], b: Kline[]) {
  const bm = new Map<number, number>(b.map((k) => [k[0], k[4]] as [number, number]));
  const ca: number[] = [], cb: number[] = [];
  for (const k of a) { const v = bm.get(k[0]); if (v !== undefined) { ca.push(k[4]); cb.push(v); } }
  return { ra: logReturns(ca), rb: logReturns(cb) };
}

export function quantitativeAnalyst(ctx: Ctx): AgentReport {
  const cs = ctx.market.candles;
  if (cs.length < 60) return noData("quant", `Need at least 60 candles; have ${cs.length}.`, ["candles>=60"], ctx.now);
  const close = cs.map((k) => k[4]), r = logReturns(close), win = r.slice(-100), n = win.length;
  const m = mean(win), s = stdev(win), t = s > 0 ? m / (s / Math.sqrt(n)) : 0;
  const ac1 = autocorr1(r.slice(-200)), vr4 = varianceRatio(r.slice(-200), 4);
  const sk = skewness(win), ku = excessKurtosis(win);
  const perYear = 31_536_000 / (INTERVAL_SECONDS[ctx.market.interval] ?? 3600);
  const last20 = close.slice(-20), sd20 = stdev(last20);
  const z20 = sd20 > 0 ? (close[close.length - 1] - mean(last20)) / sd20 : 0;
  const up = win.filter((x) => x > 0).length, [lo, hi] = wilson(up, n);
  const dd = maxDrawdown(close.slice(-100));
  const evidence: Evidence[] = [
    { label: "drift_t_stat_100", value: t, note: "mean log-return / standard error over the last 100 bars" },
    { label: "variance_ratio_q4", value: vr4, note: ">1 trending, <1 mean-reverting" },
    { label: "autocorr_lag1", value: ac1 }, { label: "annualised_vol_pct", value: s * Math.sqrt(perYear) * 100 },
    { label: "skew", value: sk }, { label: "excess_kurtosis", value: ku }, { label: "price_z_20", value: z20 },
    { label: "empirical_up_freq", value: up / n, note: `95% Wilson interval ${lo.toFixed(2)}–${hi.toFixed(2)} over ${n} bars` },
    { label: "max_drawdown_100_pct", value: dd * 100 },
  ];
  const warnings: string[] = [];
  if (ctx.market.benchmark) {
    const { ra, rb } = alignedReturns(cs, ctx.market.benchmark.candles);
    evidence.push({ label: `corr_vs_${ctx.market.benchmark.symbol}`, value: correlation(ra, rb) }, { label: `beta_vs_${ctx.market.benchmark.symbol}`, value: beta(ra, rb) });
  }
  if (Number.isFinite(ku) && ku > 5) warnings.push("Heavy-tailed returns: normal-theory t-statistics understate risk.");
  warnings.push("Statistics describe the past sample; they are not a forecast or a probability of profit.");
  const vr = Number.isFinite(vr4) ? vr4 : 1, meanRev = vr < 0.85;
  let stance: "bullish" | "bearish" | "neutral" = "neutral", conf = 0.15, why = "no statistically meaningful drift";
  if (t >= 1.5 && !meanRev) { stance = "bullish"; conf = clamp(Math.abs(t) / 4, 0.2, 0.8); why = `positive drift (t=${t.toFixed(2)}) in a non-mean-reverting regime`; }
  else if (t <= -1.5 && !meanRev) { stance = "bearish"; conf = clamp(Math.abs(t) / 4, 0.2, 0.8); why = `negative drift (t=${t.toFixed(2)}) in a non-mean-reverting regime`; }
  else if (meanRev && z20 <= -2) { stance = "bullish"; conf = 0.35; why = `mean-reverting regime (VR=${vr.toFixed(2)}) with price ${z20.toFixed(1)}σ below its 20-bar mean`; }
  else if (meanRev && z20 >= 2) { stance = "bearish"; conf = 0.35; why = `mean-reverting regime (VR=${vr.toFixed(2)}) with price ${z20.toFixed(1)}σ above its 20-bar mean`; }
  if (Number.isFinite(ku) && ku > 5) conf *= 0.8;
  return makeReport("quant", { stance, confidence: conf, summary: `Quant ${stance}: ${why}.`, evidence, warnings }, ctx.now);
}

// ------------------------------------------------------------ 3. TECHNICAL
function pivots(cs: Kline[], look = 2, span = 120) {
  const highs: { i: number; p: number }[] = [], lows: { i: number; p: number }[] = [];
  for (let i = Math.max(look, cs.length - span); i < cs.length - look; i++) {
    let h = true, l = true;
    for (let j = 1; j <= look; j++) {
      if (!(cs[i][2] > cs[i - j][2] && cs[i][2] > cs[i + j][2])) h = false;
      if (!(cs[i][3] < cs[i - j][3] && cs[i][3] < cs[i + j][3])) l = false;
    }
    if (h) highs.push({ i, p: cs[i][2] });
    if (l) lows.push({ i, p: cs[i][3] });
  }
  return { highs, lows };
}

export function technicalAnalyst(ctx: Ctx): AgentReport {
  const cs = ctx.market.candles;
  if (cs.length < 60) return noData("technical", `Need at least 60 candles; have ${cs.length}.`, ["candles>=60"], ctx.now);
  const close = cs.map((k) => k[4]), vol = cs.map((k) => k[5]), L = close.length - 1;
  const e20 = ema(close, 20), e50 = ema(close, 50), e200 = ema(close, 200), rs = rsi(close, 14), at = atrSeries(cs, 14), mc = macd(close);
  const votes: Vote[] = [], warnings: string[] = [];
  if (close[L] > e20[L] && e20[L] > e50[L]) votes.push({ label: "ema_alignment", vote: 1, weight: 2, note: "close > EMA20 > EMA50" });
  else if (close[L] < e20[L] && e20[L] < e50[L]) votes.push({ label: "ema_alignment", vote: -1, weight: 2, note: "close < EMA20 < EMA50" });
  else votes.push({ label: "ema_alignment", vote: 0, weight: 2, note: "mixed EMA order" });
  if (Number.isFinite(e200[L])) votes.push({ label: "vs_ema200", vote: close[L] > e200[L] ? 0.5 : -0.5, weight: 1 });
  else warnings.push("EMA200 unavailable (<200 candles): long-term trend not assessed.");
  const slope = ((e50[L] - e50[L - 10]) / e50[L]) * 100;
  votes.push({ label: "ema50_slope_pct_10", vote: clamp(slope / 2, -1, 1), weight: 1, note: slope.toFixed(2) + "%" });
  const rv = rs[L];
  votes.push({ label: "rsi14", vote: rv >= 70 ? -0.3 : rv > 55 ? 0.5 : rv <= 30 ? 0.3 : rv < 45 ? -0.5 : 0, weight: 1, note: "RSI " + rv.toFixed(1) });
  const h = mc.hist[L], hp = mc.hist[L - 1];
  votes.push({ label: "macd_hist", vote: h > 0 ? (h >= hp ? 1 : 0.3) : (h <= hp ? -1 : -0.3), weight: 1 });
  const { highs, lows } = pivots(cs);
  let structure = 0, sNote = "insufficient swing points";
  if (highs.length >= 2 && lows.length >= 2) {
    const hh = highs[highs.length - 1].p > highs[highs.length - 2].p, hl = lows[lows.length - 1].p > lows[lows.length - 2].p;
    structure = hh && hl ? 1 : !hh && !hl ? -1 : 0; sNote = hh && hl ? "higher highs & higher lows" : !hh && !hl ? "lower highs & lower lows" : "mixed swings";
  }
  votes.push({ label: "market_structure", vote: structure, weight: 2, note: sNote });
  const prior = cs.slice(L - 20, L), hi20 = Math.max(...prior.map((k) => k[2])), lo20 = Math.min(...prior.map((k) => k[3]));
  votes.push({ label: "range_breakout_20", vote: close[L] > hi20 ? 1 : close[L] < lo20 ? -1 : 0, weight: 1 });
  const sc = score(votes), stance = stanceOf(sc, 0.25);
  let conf = clamp(Math.abs(sc), 0, 0.9); if (!Number.isFinite(e200[L])) conf *= 0.85;
  const sup = lows.map((x) => x.p).filter((p) => p < close[L]), res = highs.map((x) => x.p).filter((p) => p > close[L]);
  const relVol = vol[L - 1] / mean(vol.slice(L - 21, L - 1));
  const evidence: Evidence[] = [...voteEvidence(votes),
    { label: "confluence_score", value: sc }, { label: "atr14", value: at[L] }, { label: "atr_pct", value: (at[L] / close[L]) * 100 },
    { label: "support", value: sup.length ? Math.max(...sup) : lo20 }, { label: "resistance", value: res.length ? Math.min(...res) : hi20 },
    { label: "relative_volume_last_closed", value: relVol }];
  return makeReport("technical", { stance, confidence: conf, summary: `Technical ${stance} (confluence ${sc.toFixed(2)}): ${sNote}; RSI ${rv.toFixed(0)}.`, evidence, warnings }, ctx.now);
}

/** Entry at last close, stop 1.5×ATR(14), targets 1R/2R/3R. Shared by the Commander; the Risk Manager re-derives its own ATR. */
export function buildProposal(symbol: string, side: "buy" | "sell", cs: Kline[]): TradeProposal | null {
  const a = lastFinite(atrSeries(cs, 14)), entry = cs.length ? cs[cs.length - 1][4] : NaN;
  if (!Number.isFinite(a) || a <= 0 || !(entry > 0)) return null;
  const dist = 1.5 * a, d = side === "buy" ? 1 : -1, stop = entry - d * dist;
  if (!(stop > 0)) return null;
  return { symbol, side, entry, stop, targets: [entry + d * dist, entry + d * 2 * dist, entry + d * 3 * dist], atr: a, stopDistance: dist, basis: "Entry at last close; stop 1.5×ATR(14); targets 1R/2R/3R of stop distance." };
}

// ----------------------------------------------------------- 4. FUNDAMENTAL
export function fundamentalAnalyst(ctx: Ctx): AgentReport {
  const raw = obj(ctx.supplied.fundamentals);
  const missing = ["fundamentals.valuation (price, fairValue, revenueGrowthYoyPct, debtToEquity, freeCashFlowMarginPct, roePct) and/or fundamentals.tokenomics (marketCapUsd, fdvUsd, annualInflationPct, unlockNext90dPctOfCirculating, top10HolderPct, maxSupply, circulatingSupply, protocolRevenue30dUsd)"];
  if (!raw) return noData("fundamental", "No fundamentals supplied; none are fabricated and no fundamentals provider is configured.", missing, ctx.now);
  const val = obj(raw.valuation), tok = obj(raw.tokenomics), votes: Vote[] = [], warnings: string[] = [];
  const last = ctx.market.candles[ctx.market.candles.length - 1][4], price = finite(val?.price) ?? last;
  const fair = finite(val?.fairValue);
  if (fair && fair > 0) { const mos = (fair - price) / fair; votes.push({ label: "margin_of_safety", vote: clamp(mos / 0.25, -1, 1), weight: 2, note: `(fairValue-price)/fairValue = ${(mos * 100).toFixed(1)}%` }); warnings.push("fairValue is caller-supplied; its method and quality are not verified by ETI."); }
  const g = finite(val?.revenueGrowthYoyPct); if (g !== undefined) votes.push({ label: "revenue_growth", vote: g > 15 ? 0.5 : g < 0 ? -0.5 : 0, weight: 1 });
  const de = finite(val?.debtToEquity); if (de !== undefined) votes.push({ label: "leverage", vote: de > 2 ? -0.5 : de < 0.5 ? 0.2 : 0, weight: 1 });
  const fcf = finite(val?.freeCashFlowMarginPct); if (fcf !== undefined) votes.push({ label: "fcf_margin", vote: fcf > 10 ? 0.5 : fcf < 0 ? -0.5 : 0, weight: 1 });
  const roe = finite(val?.roePct); if (roe !== undefined) votes.push({ label: "roe", vote: roe > 15 ? 0.3 : roe < 5 ? -0.2 : 0, weight: 0.5 });
  const mc = finite(tok?.marketCapUsd), fdv = finite(tok?.fdvUsd);
  if (mc && fdv && mc > 0) { const r = fdv / mc; votes.push({ label: "fdv_to_mcap", vote: r > 3 ? -0.7 : r > 1.5 ? -0.3 : 0.1, weight: 1.5, note: "ratio " + r.toFixed(2) }); }
  const unlock = finite(tok?.unlockNext90dPctOfCirculating); if (unlock !== undefined) votes.push({ label: "unlock_overhang_90d", vote: unlock > 10 ? -0.7 : unlock > 5 ? -0.3 : 0, weight: 1.5 });
  const inf = finite(tok?.annualInflationPct); if (inf !== undefined) votes.push({ label: "supply_inflation", vote: inf > 10 ? -0.4 : inf < 2 ? 0.2 : 0, weight: 1 });
  const top = finite(tok?.top10HolderPct); if (top !== undefined) votes.push({ label: "holder_concentration", vote: top > 60 ? -0.5 : 0, weight: 1 });
  const rev = finite(tok?.protocolRevenue30dUsd); if (rev !== undefined && mc && mc > 0) votes.push({ label: "revenue_yield", vote: (rev * 12) / mc > 0.05 ? 0.5 : 0, weight: 1, note: `annualised revenue / market cap = ${(((rev * 12) / mc) * 100).toFixed(1)}%` });
  if (votes.length < 2) return noData("fundamental", "Fewer than two usable fundamental inputs were supplied.", missing, ctx.now);
  const sc = score(votes), stance = stanceOf(sc, 0.2);
  return makeReport("fundamental", { stance, confidence: clamp(Math.abs(sc) * 0.8, 0, 0.75), summary: `Fundamentals ${stance} (score ${sc.toFixed(2)}) from ${votes.length} supplied inputs.`, evidence: voteEvidence(votes), warnings }, ctx.now);
}

// ---------------------------------------------------------------- 5. MACRO
export function macroIntelligence(ctx: Ctx): AgentReport {
  const m = obj(ctx.supplied.macro);
  const missing = ["macro.expectedRateChangeBps, realYield10yChange30dBps, dxyChange30dPct, m2YoyPct, vix, cpiYoyPct, geopoliticalRisk (any two)"];
  if (!m) return noData("macro", "No macro indicators supplied; none are fabricated and no macro data provider is configured.", missing, ctx.now);
  const votes: Vote[] = [];
  const er = finite(m.expectedRateChangeBps); if (er !== undefined) votes.push({ label: "expected_policy_path", vote: clamp(-er / 50, -1, 1), weight: 2, note: "negative bps = easing priced in" });
  const ry = finite(m.realYield10yChange30dBps); if (ry !== undefined) votes.push({ label: "real_yield_change_30d", vote: clamp(-ry / 25, -1, 1), weight: 1.5 });
  const dx = finite(m.dxyChange30dPct); if (dx !== undefined) votes.push({ label: "dollar_change_30d", vote: clamp(-dx / 2, -1, 1), weight: 1.5 });
  const m2 = finite(m.m2YoyPct); if (m2 !== undefined) votes.push({ label: "global_liquidity_m2_yoy", vote: clamp((m2 - 3) / 5, -1, 1), weight: 1 });
  const vix = finite(m.vix); if (vix !== undefined) votes.push({ label: "vix", vote: vix > 30 ? -1 : vix > 20 ? -0.4 : vix < 15 ? 0.3 : 0, weight: 1 });
  const cpi = finite(m.cpiYoyPct); if (cpi !== undefined) votes.push({ label: "inflation", vote: cpi > 4 ? -0.4 : cpi < 2.5 ? 0.2 : 0, weight: 0.5 });
  const geo = m.geopoliticalRisk; if (geo === "low" || geo === "elevated" || geo === "high") votes.push({ label: "geopolitical_risk", vote: geo === "high" ? -0.7 : geo === "elevated" ? -0.3 : 0, weight: 1 });
  if (votes.length < 2) return noData("macro", "Fewer than two usable macro indicators were supplied.", missing, ctx.now);
  const sc = score(votes), stance = stanceOf(sc, 0.2);
  return makeReport("macro", { stance, confidence: clamp(Math.abs(sc) * 0.7, 0, 0.7), summary: `Macro backdrop ${stance} for risk assets (score ${sc.toFixed(2)}).`, evidence: voteEvidence(votes), warnings: ["Macro inputs are caller-supplied and their dates/sources are not verified by ETI."] }, ctx.now);
}

// ---------------------------------------------------------------- 6. CRYPTO
export function cryptoIntelligence(ctx: Ctx): AgentReport {
  const book = ctx.market.depth ? bookStats(ctx.market.depth) : null, oc = obj(ctx.supplied.onchain);
  if (!book && !oc) return noData("crypto", "No order book or on-chain data available.", ["order book", "onchain.exchangeNetflow7dPct, activeAddresses30dChangePct, stablecoinSupply30dChangePct, tvl30dChangePct, top10HolderPct, contractAudit, hasMintAuthority, liquidityLockedPct"], ctx.now);
  const votes: Vote[] = [], evidence: Evidence[] = [], warnings: string[] = [];
  if (book) {
    evidence.push({ label: "spread_bps", value: book.spreadBps }, { label: "bid_depth_usd_1pct", value: book.bidUsd1pct }, { label: "ask_depth_usd_1pct", value: book.askUsd1pct }, { label: "book_imbalance", value: book.imbalance });
    votes.push({ label: "book_imbalance", vote: clamp(book.imbalance * 1.5, -1, 1), weight: 0.5, note: "Order books can be spoofed; low weight." });
  }
  const v = ctx.market.candles.map((k) => k[5]);
  if (v.length >= 41) evidence.push({ label: "volume_ratio_10_vs_prior_30", value: mean(v.slice(-11, -1)) / mean(v.slice(-41, -11)) });
  if (oc) {
    const nf = finite(oc.exchangeNetflow7dPct); if (nf !== undefined) votes.push({ label: "exchange_netflow_7d", vote: clamp(-nf / 10, -1, 1), weight: 1.5, note: "inflow to exchanges is bearish" });
    const aa = finite(oc.activeAddresses30dChangePct); if (aa !== undefined) votes.push({ label: "active_addresses_30d", vote: clamp(aa / 25, -1, 1), weight: 1 });
    const st = finite(oc.stablecoinSupply30dChangePct); if (st !== undefined) votes.push({ label: "stablecoin_supply_30d", vote: clamp(st / 10, -1, 1), weight: 1 });
    const tv = finite(oc.tvl30dChangePct); if (tv !== undefined) votes.push({ label: "tvl_30d", vote: clamp(tv / 25, -1, 1), weight: 1 });
    const t10 = finite(oc.top10HolderPct); if (t10 !== undefined && t10 > 60) warnings.push(`Top-10 holders control ${t10}% of supply.`);
    if (oc.contractAudit === "unaudited") warnings.push("Contract reported as unaudited.");
    if (oc.hasMintAuthority === true) warnings.push("Token retains mint authority.");
    const lk = finite(oc.liquidityLockedPct); if (lk !== undefined && lk < 50) warnings.push(`Only ${lk}% of liquidity is locked.`);
    warnings.push("On-chain inputs are caller-supplied and not independently verified by ETI.");
  }
  const sc = score(votes), stance = votes.length ? stanceOf(sc, 0.2) : "neutral";
  let conf = clamp(Math.abs(sc) * 0.7, 0, 0.7); if (!oc) conf = Math.min(conf, 0.25);
  return makeReport("crypto", { stance, confidence: conf, summary: `Crypto ${stance}: ${oc ? "on-chain + liquidity" : "order-book liquidity only (no on-chain data supplied)"}.`, evidence: [...evidence, ...voteEvidence(votes)], warnings, missingInputs: oc ? [] : ["onchain metrics"] }, ctx.now);
}

// ----------------------------------------------------------------- 7. NEWS
const POS = new Set(["surge", "surges", "rally", "rallies", "approve", "approves", "approval", "approved", "beat", "beats", "record", "growth", "upgrade", "upgrades", "partnership", "adoption", "inflow", "inflows", "bullish", "gain", "gains", "soar", "soars", "launch", "launches", "recovery", "profit"]);
const NEG = new Set(["hack", "hacked", "exploit", "exploited", "lawsuit", "sue", "sues", "ban", "bans", "crash", "plunge", "plunges", "fraud", "scam", "downgrade", "downgrades", "miss", "misses", "outflow", "outflows", "bearish", "loss", "losses", "delist", "delisting", "investigation", "probe", "liquidation", "liquidations", "bankruptcy", "default", "rug", "halt", "halts"]);
export interface NewsItem { headline: string; source?: string; publishedAt: number }
export interface EventHazard { active: boolean; events: { name: string; minutesUntil: number; impact: string }[] }
function parseTime(v: unknown): number { if (typeof v === "number" && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v; if (typeof v === "string") return Date.parse(v); return NaN; }

/** High-impact events from 15 minutes ago to 60 minutes ahead make the market hazardous; the Risk Manager vetoes on this. */
export function eventHazard(rawNews: unknown, now: number): EventHazard {
  const n = obj(rawNews), events = Array.isArray(n?.events) ? (n!.events as unknown[]).slice(0, 100) : [];
  const hits: EventHazard["events"] = [];
  for (const e of events) {
    const o = obj(e); if (!o) continue;
    const t = parseTime(o.time), mins = (t - now) / 60000;
    if (Number.isFinite(mins) && o.impact === "high" && mins >= -15 && mins <= 60) hits.push({ name: String(o.name ?? "event").slice(0, 120), minutesUntil: Math.round(mins), impact: "high" });
  }
  return { active: hits.length > 0, events: hits };
}

export function newsIntelligence(ctx: Ctx): AgentReport {
  const n = obj(ctx.supplied.news), missing = ["news.items[{headline, source, publishedAt}] and/or news.events[{name, time, impact}]"];
  if (!n) return noData("news", "No news or calendar data supplied; no live news feed is configured and none is fabricated.", missing, ctx.now);
  const items: NewsItem[] = []; let skipped = 0;
  for (const it of (Array.isArray(n.items) ? n.items : []).slice(0, 100)) {
    const o = obj(it), t = parseTime(o?.publishedAt);
    if (!o || typeof o.headline !== "string" || !Number.isFinite(t) || t > ctx.now + 300_000 || ctx.now - t > 48 * 3600_000) { skipped++; continue; }
    items.push({ headline: o.headline.slice(0, 300), source: typeof o.source === "string" ? o.source.slice(0, 80) : undefined, publishedAt: t });
  }
  const hz = eventHazard(n, ctx.now), warnings: string[] = [];
  if (skipped) warnings.push(`${skipped} item(s) skipped: invalid, future-dated or older than 48h.`);
  warnings.push("Lexicon-based sentiment is crude (no negation or context handling); treat as a weak signal.");
  const evidence: Evidence[] = [{ label: "fresh_items", value: items.length }, { label: "high_impact_events_in_window", value: hz.events.length }, ...hz.events.map((e) => ({ label: "event:" + e.name, value: e.minutesUntil, note: "minutes until (negative = already occurred)" }))];
  if (hz.active) warnings.push("High-impact event window active: " + hz.events.map((e) => e.name).join(", "));
  if (!items.length) {
    if (!hz.events.length && !Array.isArray(n.events)) return noData("news", "No usable, fresh news items supplied.", missing, ctx.now);
    return makeReport("news", { stance: "neutral", confidence: 0.1, summary: hz.active ? "No fresh headlines; high-impact event window active." : "No fresh headlines; no high-impact event in window.", evidence, warnings }, ctx.now);
  }
  let num = 0, den = 0;
  for (const it of items) {
    const toks = it.headline.toLowerCase().match(/[a-z]+/g) ?? []; let p = 0, q = 0;
    for (const w of toks) { if (POS.has(w)) p++; else if (NEG.has(w)) q++; }
    const s = (p - q) / Math.max(1, p + q), w = Math.exp(-((ctx.now - it.publishedAt) / 3600_000) / 12);
    num += w * s; den += w;
  }
  const avg = den > 0 ? num / den : 0, stance = stanceOf(avg, 0.2);
  evidence.push({ label: "recency_weighted_sentiment", value: avg });
  return makeReport("news", { stance, confidence: clamp(Math.min(0.7, 0.12 * items.length) * Math.abs(avg) + 0.05, 0, 0.7), summary: `News sentiment ${stance} (${avg.toFixed(2)}) across ${items.length} fresh headline(s).`, evidence, warnings }, ctx.now);
}

// ------------------------------------------------- 8. ELITE TRADER RESEARCHER
export function eliteTraderResearcher(ctx: Ctx): AgentReport {
  const cs = ctx.market.candles;
  if (cs.length < 21) return noData("researcher", `Need at least 21 candles; have ${cs.length}.`, ["candles>=21"], ctx.now);
  const close = cs.map((k) => k[4]), L = close.length - 1, votes: Vote[] = [], evidence: Evidence[] = [];
  const add = (label: string, vote: number, note: string) => { votes.push({ label, vote, weight: 1 }); evidence.push({ label, value: vote, note }); };
  const prior20 = cs.slice(L - 20, L), hi20 = Math.max(...prior20.map((k) => k[2])), lo20 = Math.min(...prior20.map((k) => k[3]));
  add("turtle_donchian_20", close[L] > hi20 ? 1 : close[L] < lo20 ? -1 : 0, "Donchian 20-bar breakout, as described in published Turtle-trading rules (Faith, 2007). Simplified.");
  if (cs.length >= 201) {
    const s200 = sma(close, 200), r2 = rsi(close, 2)[L];
    add("connors_rsi2", r2 < 10 && close[L] > s200[L] ? 1 : r2 > 90 && close[L] < s200[L] ? -1 : 0, `RSI(2)=${r2.toFixed(1)} vs 200-bar trend filter (Connors & Alvarez, 2008). Simplified.`);
    add("ptj_200_rule", close[L] > s200[L] ? 0.5 : -1, "Defensive stance below the 200-bar average, as publicly attributed to Paul Tudor Jones (Schwager, Market Wizards). Simplified.");
  }
  if (cs.length >= 230) {
    const s150 = sma(close, 150), s200 = sma(close, 200), w = close.slice(-Math.min(close.length, 250)), hiW = Math.max(...w), loW = Math.min(...w);
    const ok = close[L] > s150[L] && s150[L] > s200[L] && s200[L] > s200[L - 20] && close[L] >= 1.25 * loW && close[L] >= 0.75 * hiW;
    add("minervini_trend_template", ok ? 1 : close[L] < s200[L] ? -0.5 : 0, "Stage-2 uptrend checklist (Minervini, 2013), designed for daily stock charts; applied mechanically here.");
  }
  const evaluated = votes.length, avg = score(votes), stance = stanceOf(avg, 0.25);
  const agree = votes.filter((v) => Math.sign(v.vote) === Math.sign(avg) && v.vote !== 0).length;
  return makeReport("researcher", {
    stance, confidence: clamp(0.15 * evaluated + Math.abs(avg) * 0.3, 0, 0.6),
    summary: `${evaluated} documented methodology reading(s): ${agree} agree with the net ${stance} lean.`, evidence,
    warnings: ["Simplified mechanical readings of publicly documented rules; NOT the traders' actual systems, private methods or results. No performance claims are made."],
  }, ctx.now);
}
