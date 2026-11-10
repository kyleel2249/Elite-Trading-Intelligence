// Fundamental and news context. The engine never infers fundamentals or news from price. This module only
// validates context that an operator or data pipeline supplies (see stores.ts), judges its age, and scores it.
// Missing or stale context is reported as "unavailable"; it is never treated as an implied all-clear.
import type { ContextConfig, GateConfig } from "./config.ts";
import type { ContextStatus, NewsEventView } from "./types.ts";
import { HOUR_MS, MINUTE_MS, cleanText, clamp, isFiniteNumber, isRecord } from "./util.ts";

export interface FundamentalFactor { name: string; /** -1 bearish .. +1 bullish for the asset. */ bias: number; weight: number; note: string }
export interface FundamentalContext { asOf: string; source: string; factors: FundamentalFactor[] }
export interface NewsEvent { title: string; time: string; impact: "low" | "medium" | "high"; sentiment: number | null; scheduled: boolean; source: string | null; url: string | null }
export interface NewsContext { asOf: string; source: string; events: NewsEvent[] }

const validTime = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export function parseFundamentalContext(raw: unknown): FundamentalContext | null {
  if (!isRecord(raw)) return null;
  const asOf = validTime(raw.asOf), source = cleanText(raw.source, 120);
  if (!asOf || !source || !Array.isArray(raw.factors)) return null;
  const factors: FundamentalFactor[] = [];
  for (const f of raw.factors.slice(0, 20)) {
    if (!isRecord(f)) continue;
    const name = cleanText(f.name, 80);
    if (!name || !isFiniteNumber(f.bias) || f.bias < -1 || f.bias > 1) continue;
    const weight = f.weight === undefined ? 1 : f.weight;
    if (!isFiniteNumber(weight) || weight <= 0 || weight > 10) continue;
    factors.push({ name, bias: f.bias, weight, note: cleanText(f.note, 240) ?? "" });
  }
  return factors.length ? { asOf, source, factors } : null;
}

export function parseNewsContext(raw: unknown): NewsContext | null {
  if (!isRecord(raw)) return null;
  const asOf = validTime(raw.asOf), source = cleanText(raw.source, 120);
  if (!asOf || !source || !Array.isArray(raw.events)) return null;
  const events: NewsEvent[] = [];
  for (const e of raw.events.slice(0, 100)) {
    if (!isRecord(e)) continue;
    const title = cleanText(e.title, 200), time = validTime(e.time);
    if (!title || !time || (e.impact !== "low" && e.impact !== "medium" && e.impact !== "high")) continue;
    const sentiment = isFiniteNumber(e.sentiment) && e.sentiment >= -1 && e.sentiment <= 1 ? e.sentiment : null;
    const url = typeof e.url === "string" && /^https?:\/\/[^\s]{1,300}$/.test(e.url) ? e.url : null;
    events.push({ title, time, impact: e.impact, sentiment, scheduled: e.scheduled === true, source: cleanText(e.source, 80), url });
  }
  return { asOf, source, events };
}

/** Combine asset-specific news with market-wide events (for example scheduled macro releases), dropping exact duplicates. */
export function mergeNews(a: NewsContext | null, b: NewsContext | null): NewsContext | null {
  if (!a) return b;
  if (!b) return a;
  const seen = new Set<string>(), events: NewsEvent[] = [];
  for (const e of [...a.events, ...b.events]) { const k = e.time + "|" + e.title.toLowerCase(); if (!seen.has(k)) { seen.add(k); events.push(e); } }
  const older = Date.parse(a.asOf) <= Date.parse(b.asOf) ? a : b; // the combined view is only as fresh as its stalest input
  return { asOf: older.asOf, source: a.source === b.source ? a.source : `${a.source} + ${b.source}`, events };
}

export interface FundamentalAssessment { status: ContextStatus; score: number | null; asOf: string | null; source: string | null; points: string[] }

export function assessFundamentals(ctx: FundamentalContext | null | undefined, dir: 1 | -1, now: number, cfg: ContextConfig): FundamentalAssessment {
  if (!ctx) return { status: "unavailable", score: null, asOf: null, source: null, points: ["No fundamental data was supplied for this asset. The engine does not infer fundamentals from price, so this component is unscored."] };
  const age = now - Date.parse(ctx.asOf);
  if (!(age <= cfg.fundamentalsMaxAgeHours * HOUR_MS) || age < -5 * MINUTE_MS)
    return { status: "stale", score: null, asOf: ctx.asOf, source: ctx.source, points: [`Fundamental data from ${ctx.source} (as of ${ctx.asOf}) is outside the ${cfg.fundamentalsMaxAgeHours}h freshness limit and was not used.`] };
  let num = 0, den = 0;
  const points = ctx.factors.map(f => {
    num += f.weight * f.bias * dir; den += f.weight;
    const stance = f.bias * dir > 0.15 ? "supports" : f.bias * dir < -0.15 ? "opposes" : "is neutral for";
    return `${f.name} ${stance} this trade${f.note ? ": " + f.note : ""}`;
  });
  const score = clamp(50 + 50 * (num / den));
  points.push(`Source: ${ctx.source}, as of ${ctx.asOf}. Supplied context; ETI does not verify it.`);
  return { status: "available", score: Math.round(score * 10) / 10, asOf: ctx.asOf, source: ctx.source, points };
}

export interface NewsAssessment {
  status: ContextStatus; score: number | null; asOf: string | null; source: string | null;
  blackout: boolean; blackoutReason: string | null;
  /** Epoch ms of the next high-impact event after now, used to cap a signal's expiry. */
  nextHighImpactAt: number | null;
  events: NewsEventView[]; notes: string[];
}

export function assessNews(ctx: NewsContext | null | undefined, dir: 1 | -1, now: number, cfg: ContextConfig, gates: Pick<GateConfig, "newsBlackoutBeforeMin" | "newsBlackoutAfterMin">): NewsAssessment {
  const none = (status: ContextStatus, note: string, asOf: string | null = null, source: string | null = null): NewsAssessment =>
    ({ status, score: null, asOf, source, blackout: false, blackoutReason: null, nextHighImpactAt: null, events: [], notes: [note] });
  if (!ctx) return none("unavailable", "No news or event-calendar data was supplied. News risk cannot be assessed, so it is unscored and not assumed to be low.");
  const age = now - Date.parse(ctx.asOf);
  if (!(age <= cfg.newsMaxAgeHours * HOUR_MS) || age < -5 * MINUTE_MS)
    return none("stale", `News data from ${ctx.source} (as of ${ctx.asOf}) is outside the ${cfg.newsMaxAgeHours}h freshness limit and was not used.`, ctx.asOf, ctx.source);

  const lo = now - cfg.newsLookbackHours * HOUR_MS, hi = now + cfg.newsLookaheadHours * HOUR_MS;
  const rel = ctx.events.map(e => ({ e, t: Date.parse(e.time) })).filter(x => x.t >= lo && x.t <= hi).sort((a, b) => a.t - b.t);
  const inBlackout = rel.filter(x => x.e.impact === "high" && x.t >= now - gates.newsBlackoutAfterMin * MINUTE_MS && x.t <= now + gates.newsBlackoutBeforeMin * MINUTE_MS);
  const upcoming = rel.filter(x => x.t > now);
  const nextHigh = upcoming.find(x => x.e.impact === "high");

  let score = 100;
  const notes: string[] = [];
  const upHigh = upcoming.filter(x => x.e.impact === "high" && !inBlackout.includes(x)).length;
  const upMed = upcoming.filter(x => x.e.impact === "medium").length;
  const pastHigh = rel.filter(x => x.t <= now && x.e.impact === "high" && !inBlackout.includes(x)).length;
  score -= Math.min(60, upHigh * 35) + Math.min(30, upMed * 12) + Math.min(20, pastHigh * 10);

  const wt = { low: 1, medium: 2, high: 3 } as const;
  let sn = 0, sd = 0;
  for (const x of rel) if (x.t <= now && x.e.sentiment !== null) { sn += wt[x.e.impact] * x.e.sentiment; sd += wt[x.e.impact]; }
  if (sd > 0) { const aligned = (sn / sd) * dir; score += 20 * aligned; notes.push(`Recent supplied sentiment is ${aligned > 0.15 ? "aligned with" : aligned < -0.15 ? "against" : "neutral for"} this trade (${(aligned).toFixed(2)}).`); }
  if (upHigh) notes.push(`${upHigh} high-impact event(s) are scheduled within ${cfg.newsLookaheadHours}h.`);
  if (!rel.length) notes.push(`No events in the ${cfg.newsLookbackHours}h look-back / ${cfg.newsLookaheadHours}h look-ahead window of ${ctx.source}. ETI does not verify that source's completeness.`);

  const blackout = inBlackout.length > 0;
  const reason = blackout ? `High-impact event "${inBlackout[0].e.title}" at ${inBlackout[0].e.time} falls inside the news blackout window (${gates.newsBlackoutBeforeMin} min before to ${gates.newsBlackoutAfterMin} min after).` : null;
  if (reason) notes.unshift(reason);
  const views: NewsEventView[] = rel.slice(0, 20).map(({ e }) => ({ title: e.title, time: e.time, impact: e.impact, sentiment: e.sentiment, scheduled: e.scheduled, source: e.source, url: e.url }));
  return { status: "available", score: blackout ? 0 : Math.round(clamp(score) * 10) / 10, asOf: ctx.asOf, source: ctx.source, blackout, blackoutReason: reason, nextHighImpactAt: nextHigh ? nextHigh.t : null, events: views, notes };
}
