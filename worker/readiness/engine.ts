// ETI MARKET READINESS ENGINE: decides whether trading is advisable for a market/symbol over a window
// (now, an hour, a session, or a whole day) and says so plainly, including "do not trade".
//
// Principles enforced here:
//  * A factor that cannot be measured is reported "not_evaluated" and CAPS the verdict. It is never assumed benign.
//  * Hard blockers (market closed, imminent high-impact release, abnormal market regime) outrank every positive factor.
//  * "Favourable" is never an entry signal. The recommendation always requires a valid, confirmed setup.
//  * Session/hour/weekday statistics describe measured activity (range, volume, directional efficiency) with sample sizes,
//    never profitability.
import { HOUR, DAY, MIN, exchangeStatus, fxOpen, fmtClock, holidayFlags, lseCalendar, nextChange, nyseCalendar, sessionActive, sessionActiveFor, sessionLabel, sessionWindow, structuralSessionFit,
  SESSION_IDS, type MarketKind, type SessionId } from "./calendar.ts";
import { currenciesOf, eventHits, worstSeverity, type EventHit, type EventSeverity, type EventsState, type MarketEvent } from "./events.ts";
import { summarizeEvidence, type EvidenceFile, type EvidenceSummary } from "./evidence.ts";
import type { HistoryStats, MarketSnapshot } from "./snapshot.ts";
import type { Strategy } from "../algo/timeframes.ts";

export type ReadinessStatus = "FAVOURABLE" | "SELECTIVELY_FAVOURABLE" | "UNCERTAIN" | "HIGH_RISK" | "AVOID_TRADING";
export const STATUS_ORDER: ReadinessStatus[] = ["FAVOURABLE", "SELECTIVELY_FAVOURABLE", "UNCERTAIN", "HIGH_RISK", "AVOID_TRADING"];
export const STATUS_LABEL: Record<ReadinessStatus, string> = { FAVOURABLE: "FAVOURABLE", SELECTIVELY_FAVOURABLE: "SELECTIVELY FAVOURABLE", UNCERTAIN: "UNCERTAIN", HIGH_RISK: "HIGH RISK", AVOID_TRADING: "AVOID TRADING" };
export type Rating = "supportive" | "neutral" | "caution" | "adverse" | "severe" | "not_evaluated";
export type Scope = "now" | "hour" | "session" | "day";
export interface FactorResult { id: number; factor: string; rating: Rating; headline: string; detail: string[] }
export interface Closure { exchange: string; date: string; name: string; kind: "closed" | "early_close" }

export interface AssessInput {
  now: number; at: number; scope: Scope; market: MarketKind; symbol: string; strategy: Strategy; session?: SessionId; dayKey?: string;
  snapshot: MarketSnapshot | null; events: EventsState; evidence: EvidenceFile | null;
}
export interface Assessment {
  scope: Scope; label: string; windowStart: number; windowEnd: number; status: ReadinessStatus; statusLabel: string; recommendation: string; reasons: string[]; blockers: string[];
  caps: string[]; factors: FactorResult[]; evaluated: number; notEvaluated: string[]; liveConditionsApplied: boolean; evidence: EvidenceSummary; eventHits: { title: string; impact: string; category: string; time: string; severity: EventSeverity; phase: string }[];
  closures: Closure[]; schedule: string[];
}

const iso = (ms: number) => new Date(ms).toISOString();
const utcClock = (ms: number) => `${iso(ms).slice(11, 16)} UTC`;
export const fmtDuration = (min: number) => { const m = Math.abs(Math.round(min)), h = Math.floor(m / 60); return h >= 48 ? `${Math.round(h / 24)} days` : h ? `${h}h ${m % 60}m` : `${m}m`; };
const idx = (s: ReadinessStatus) => STATUS_ORDER.indexOf(s);
const cap = (s: ReadinessStatus, limit: ReadinessStatus) => (idx(s) < idx(limit) ? limit : s);
const x = (v: number) => `${v.toFixed(2)}x`;

export function evaluationWindow(i: Pick<AssessInput, "scope" | "at" | "now" | "market" | "session" | "dayKey">): { start: number; end: number; label: string } {
  if (i.scope === "hour") { const s = Math.floor(i.at / HOUR) * HOUR; return { start: s, end: s + HOUR, label: `${utcClock(s)} hour` }; }
  if (i.scope === "day") { const s = Date.parse(`${i.dayKey}T00:00:00Z`); return { start: s, end: s + DAY, label: `${i.dayKey} (UTC day)` }; }
  if (i.scope === "session" && i.session) { const w = sessionWindow(i.market, i.session, i.at); if (w) return { start: w.start, end: w.end, label: `${sessionLabel(i.session)} (${w.active ? "current" : "next"}: ${utcClock(w.start)} to ${utcClock(w.end)})` }; return { start: i.at, end: i.at + HOUR, label: sessionLabel(i.session) }; }
  return { start: i.now, end: i.now + 2 * HOUR, label: "next 2 hours" };
}
const dataIn = (h: HistoryStats | null, i: AssessInput, w: { start: number; end: number }) => {
  if (!h) return null;
  if (i.scope === "session" && i.session) { const s = h.sessions.find(r => r.session === i.session); return s ? { kind: "session" as const, label: sessionLabel(i.session), range: s.rangeVsBaseline, volume: s.volumeVsBaseline, n: s.instances, ok: s.sampleOk, efficiency: s.efficiency } : null; }
  if (i.scope === "day") { const d = h.weekdays.find(r => r.dow === new Date(w.start).getUTCDay()); return d && d.days ? { kind: "weekday" as const, label: "this weekday", range: d.rangeVsBaseline, volume: d.volumeVsBaseline, n: d.days, ok: d.days >= 4, efficiency: null } : null; }
  const at = Math.max(w.start, i.scope === "now" ? i.now : w.start), hr = new Date(at).getUTCHours(), s = h.hours[hr], wd = new Date(at).getUTCDay();
  if (wd === 0 || wd === 6) { const d = h.weekdays.find(r => r.dow === wd); return d && d.days ? { kind: "weekday" as const, label: "this weekend day", range: d.rangeVsBaseline, volume: d.volumeVsBaseline, n: d.days, ok: d.days >= 4, efficiency: null } : null; } // hour statistics are weekday-only
  return s && s.bars ? { kind: "hour" as const, label: `${String(hr).padStart(2, "0")}:00 UTC hour`, range: s.rangeVsBaseline, volume: s.volumeVsBaseline, n: s.bars, ok: s.bars >= 20, efficiency: null } : null;
};

export function upcomingClosures(from: number, days = 14): Closure[] {
  const out: Closure[] = [], y0 = new Date(from).getUTCFullYear();
  for (const [ex, cal] of [["NYSE", nyseCalendar], ["LSE", lseCalendar]] as const) for (const y of [y0, y0 + 1]) for (const c of cal(y)) { const t = Date.parse(c.date + "T12:00:00Z"); if (t >= from - 12 * HOUR && t <= from + days * DAY) out.push({ exchange: ex, date: c.date, name: c.name, kind: c.kind }); }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function assess(i: AssessInput): Assessment {
  const w = evaluationWindow(i), snap = i.snapshot, forward = Math.max(w.start, i.now), future = w.start > i.now + 2 * HOUR, past = w.end <= i.now;
  const live = !!snap && snap.liveData && !future && !past, hist = snap?.history ?? null, stat = dataIn(hist, i, w);
  const ctx = { market: i.market, symbol: i.symbol || undefined, currencies: currenciesOf(i.market, i.symbol || undefined) };
  const factors: FactorResult[] = [], F = (id: number, factor: string, rating: Rating, headline: string, detail: string[] = []) => { factors.push({ id, factor, rating, headline, detail }); };
  const when = (e: MarketEvent) => { const d = (e.time - i.now) / MIN; return Math.abs(d) <= 24 * 60 ? `${utcClock(e.time)} (${d >= 0 ? "in " : ""}${fmtDuration(d)}${d < 0 ? " ago" : ""})` : `${iso(e.time).slice(0, 16).replace("T", " ")} UTC`; };
  const describe = (h: EventHit) => `${h.event.title} [${h.event.impact} impact] ${when(h.event)}: ${h.severity === "avoid" ? "inside the blackout window around the release" : h.severity === "high_risk" ? "inside the high-volatility window around the release" : "within the evaluated window"}`;
  const eventsOk = i.events.status === "loaded";
  const from = past ? w.start : forward, hitsFor = (cats: string[]) => eventsOk ? eventHits(i.events.events.filter(e => cats.includes(e.category)), ctx, from, i.scope === "now" ? from : Math.max(from, w.end), w.end, w.end - w.start > 2 * HOUR) : [];
  const allHits: EventHit[] = [];
  const rateHits = (hits: EventHit[]): Rating => { const s = worstSeverity(hits); return s === "avoid" ? "severe" : s === "high_risk" ? "adverse" : s === "caution" ? "caution" : "supportive"; };

  // 1. Economic announcements
  if (!eventsOk) F(1, "Major economic announcements", "not_evaluated", "Economic calendar is not connected: announcement risk is UNVERIFIED", [i.events.status === "error" ? `Event feed error: ${i.events.error}` : "Set ETI_EVENT_FEED_URL or ETI_EVENTS_JSON (see docs/READINESS.md). ETI does not invent calendar data.", "Check an official economic calendar before trading."]);
  else { const h = hitsFor(["economic", "central_bank", "other"]); allHits.push(...h); const r = rateHits(h), n = i.events.events.length;
    const next = i.events.events.filter(e => e.impact === "high" && e.time > from && eventHits([e], ctx, from, from).length === 0 && (e.currencies.length + e.markets.length + e.symbols.length === 0 || ctx.currencies.some(c => e.currencies.includes(c)) || e.markets.includes(i.market) || e.symbols.includes(i.symbol)))[0];
    F(1, "Major economic announcements", n === 0 ? "caution" : r, n === 0 ? "Event feed contains no events: verify it is current before trusting a clear calendar" : r === "severe" ? "High-impact announcement imminent or just released: stand aside" : r === "adverse" ? "High-impact announcement close enough to distort price" : r === "caution" ? "Announcements in or near the window: reduced confidence" : "Economic calendar relatively clear (per the configured feed)",
      [...h.map(describe), ...(next && !h.length ? [`Next high-impact event: ${next.title} ${when(next)}`] : []), `Calendar sources: ${i.events.sources.join(", ")}; ${n} events loaded, ${i.events.invalid} rejected.`]); }

  // 2. Expected volatility
  if (live && snap) { const v = snap.volatility, rg = snap.regime.regime, d: string[] = [`ATR ${v.atrPercent.toFixed(2)}% of price, ${(v.percentile * 100).toFixed(0)}th percentile of the last 100 hourly bars; regime ${rg} (confidence ${snap.regime.confidence}).`, ...snap.regime.reasons];
    if (stat && i.scope !== "now") d.push(`Typical activity for ${stat.label}: ${x(stat.range)} the weekday baseline (${stat.n} samples${stat.ok ? "" : ", small sample"}).`);
    const r: Rating = rg === "abnormal" ? "severe" : v.classification === "extreme" || rg === "high_volatility" ? "adverse" : v.classification === "high" || (stat && stat.ok && stat.range >= 1.5) || v.expansion ? "caution" : v.classification === "low" ? "neutral" : "supportive";
    F(2, "Expected volatility", r, r === "severe" ? "Abnormal market conditions (data or volatility anomaly)" : r === "adverse" ? "Unusually high volatility" : r === "caution" ? "Volatility elevated or expanding" : r === "neutral" ? "Volatility compressed: breakouts can be abrupt" : "Volatility within its normal range", d); }
  else if (stat) { const r: Rating = stat.ok && stat.range >= 1.5 ? "caution" : "neutral"; F(2, "Expected volatility", r, `Typically ${x(stat.range)} baseline volatility for ${stat.label}`, [`Measured over ${stat.n} samples${stat.ok ? "" : " (small sample: weak evidence)"}. This is typical behaviour, not a forecast.`, ...(future ? ["Live volatility is not used for a future window."] : [])]); }
  else F(2, "Expected volatility", "not_evaluated", i.market === "crypto" ? "Volatility could not be measured (no usable market data)" : `No ${i.market} price feed is connected: volatility cannot be measured`, i.market === "crypto" ? [] : ["ETI's connected price providers (Binance, Bybit, OKX) cover crypto only."]);

  // 3. Liquidity
  { const d: string[] = [], lt = new Date(w.start), wkend = i.market === "crypto" && [0, 6].includes(lt.getUTCDay()) && [0, 6].includes(new Date(w.end - 1).getUTCDay()); let r: Rating = "not_evaluated", head = "Liquidity could not be measured";
    const fl = holidayFlags(w.start); if (i.market !== "equities" && fl.length) d.push(...fl);
    if (stat) { r = stat.volume < 0.4 && stat.ok ? "adverse" : stat.volume < 0.65 && stat.ok ? "caution" : "supportive"; head = `${stat.label}: volume ${x(stat.volume)} the weekday baseline`; d.push(`Measured over ${stat.n} samples${stat.ok ? "" : " (small sample)"}.`); }
    if (wkend) { r = r === "adverse" ? r : "caution"; head = "Weekend: crypto liquidity is typically lower and moves can be erratic"; const wd = hist?.weekdays.find(q => q.dow === lt.getUTCDay()); if (wd?.days) d.push(`${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][wd.dow]} volume has averaged ${x(wd.volumeVsBaseline)} the weekday level (${wd.days} days).`); }
    if (live && snap?.liquidity) { const l = snap.liquidity; if (l.status === "blocked") { r = "adverse"; head = "Order book unusable (stale, incomplete or inconsistent)"; } else if (l.status === "degraded" && r !== "adverse") { r = "caution"; head = "Order-book liquidity degraded"; } d.push(...l.issues); }
    if (fl.length && i.market !== "equities" && (r === "supportive" || r === "not_evaluated")) { r = "caution"; head = "Holiday-affected liquidity"; }
    if (i.market === "forex" && !fxOpen(w.start).open && !fxOpen(Math.max(w.start, w.end - 1)).open) { r = "severe"; head = "FX market closed: no liquidity"; }
    F(3, "Liquidity", r, head, d); }

  // 4. Market structure
  if (live && snap) { const s = snap.structure, ranging = snap.regime.regime === "ranging";
    F(4, "Market structure", ranging ? "caution" : s.bias === "neutral" ? "neutral" : "supportive", ranging ? "Range-bound structure: trend entries are lower quality" : s.bias === "neutral" ? "No clear swing structure" : `${s.bias === "bull" ? "Higher highs and higher lows" : "Lower highs and lower lows"} on 1h swing structure`,
      [`Nearest support ${s.support ?? "n/a"}; nearest resistance ${s.resistance ?? "n/a"}.`]); }
  else F(4, "Market structure", "not_evaluated", future ? "Structure for a future window cannot be known in advance" : "Structure not evaluated (no price data)");

  // 5. Current trends
  if (live && snap) { const t = snap.trend, strong = Math.abs(t.weightedScore) >= 40, mixed = t.direction === "neutral" || t.conflicts.length >= 2;
    F(5, "Current trends", mixed ? "caution" : strong ? "supportive" : "neutral", mixed ? "Timeframes disagree or no trend: directional trades lack support" : `${strong ? "Strong" : "Moderate"} ${t.direction === "bull" ? "uptrend" : "downtrend"} across timeframes (score ${t.weightedScore.toFixed(0)})`,
      [...t.frames.map(f => `${f.timeframe}: ${f.trend} (ADX ${f.adx.toFixed(0)})`), ...t.conflicts, ...(t.unavailable.length ? [`Timeframes without enough data: ${t.unavailable.join(", ")}`] : [])]); }
  else F(5, "Current trends", "not_evaluated", future ? "Trend for a future window cannot be known in advance" : "Trend not evaluated (no price data)");

  // 6. Technical setups
  if (live && snap?.setup) { const s = snap.setup, ok = s.tradeable && (s.classification === "CONFIRMED" || s.classification === "HIGH_CONVICTION");
    F(6, "Technical setups", ok ? "supportive" : s.classification === "REJECTED" ? "caution" : "neutral", ok ? `Validated ${s.action} setup present (${s.classification}); it still needs your own confirmation and risk plan` : s.classification === "EARLY" ? "Early, unconfirmed lean only" : s.classification === "REJECTED" ? "Candidate setup rejected by independent validation" : "No valid setup right now: HOLD is a valid outcome",
      [`Heuristic evidence score ${s.confidence} (not a probability).`, ...s.notes]); }
  else F(6, "Technical setups", "not_evaluated", future ? "Setups only exist in live data; none can be assessed for a future window" : "Setup scan unavailable (no price data)");

  // 7 & 8. Fundamental and geopolitical developments
  for (const [id, name, cats, what] of [[7, "Fundamental developments", ["fundamental", "earnings"], "fundamental or earnings"], [8, "Geopolitical risks", ["geopolitical"], "geopolitical"]] as const) {
    if (!eventsOk) { F(id, name, "not_evaluated", `No ${what} feed connected: not assessed`, ["ETI does not infer news. Configure the event feed with category \"" + cats[0] + "\" items, and review news yourself."]); continue; }
    const h = hitsFor([...cats]); allHits.push(...h); const r = rateHits(h);
    F(id, name, r, h.length ? `${what[0].toUpperCase() + what.slice(1)} items in or near the window` : `No ${what} items in the configured feed`, [...h.map(describe), "Unscheduled shocks cannot be anticipated; this reflects only what the feed lists."]);
  }

  // 9. Market correlations
  if (live && snap?.correlation) { const c = snap.correlation, hi = c.corr >= 0.8, r: Rating = hi && (c.referenceVolPercentile ?? 0) >= 0.9 ? "caution" : "supportive";
    F(9, "Market correlations", r, hi ? `Moves closely track ${c.reference} (correlation ${c.corr.toFixed(2)}): positions in both are effectively one bet` : `Moderate correlation with ${c.reference} (${c.corr.toFixed(2)})`, [`Hourly-return correlation over ${c.bars} bars.`, ...(c.referenceVolPercentile !== null ? [`${c.reference} volatility is at the ${(c.referenceVolPercentile * 100).toFixed(0)}th percentile.`] : [])]); }
  else F(9, "Market correlations", "not_evaluated", "Cross-asset correlation not available for this market/window");

  // 10. Spreads and execution conditions
  if (live && snap?.liquidity && snap.liquidity.spreadBps !== null) { const l = snap.liquidity, worst = Math.max(l.slippageBuyBps ?? 0, l.slippageSellBps ?? 0), thin = l.slippageBuyBps === null || l.slippageSellBps === null;
    const r: Rating = l.status === "blocked" || worst > 30 ? "adverse" : l.status === "degraded" || worst > 10 || thin ? "caution" : "supportive";
    F(10, "Spreads and execution", r, `Spread ${l.spreadBps!.toFixed(1)} bps; est. slippage for ${l.referenceNotional.toLocaleString("en-US")} quote units ${thin ? "exceeds visible depth" : `up to ${worst.toFixed(1)} bps`}`, [`Book age ${Math.round(l.ageMs)} ms (REST snapshot, not guaranteed executable liquidity).`, ...l.issues]); }
  else F(10, "Spreads and execution", "not_evaluated", future ? "Live spreads cannot be known for a future window" : "No live order book: spreads and slippage unverified");

  // 11. Market closures / openings
  { const d: string[] = [], sched: string[] = []; let r: Rating = "supportive", head = "No closure affecting this window";
    const bump = (n: Rating, h: string) => { const order: Rating[] = ["supportive", "neutral", "caution", "adverse", "severe"]; if (order.indexOf(n) > order.indexOf(r)) { r = n; head = h; } };
    if (i.market === "forex") { const a = fxOpen(w.start), b = fxOpen(Math.max(w.start, w.end - 1)), nx = nextChange(t => fxOpen(t).open, Math.max(w.start, i.now), 60, 9, 360);
      if (!a.open && !b.open) bump("severe", "FX market is closed"); else if (a.open !== b.open) bump("caution", "FX opens or closes inside this window");
      if (nx) { const m = (nx.at - i.now) / MIN; sched.push(`FX ${nx.becomes ? "opens" : "closes"} ${iso(nx.at).slice(0, 16).replace("T", " ")} UTC (${m >= 0 ? "in " + fmtDuration(m) : "passed"})`); if (!nx.becomes && m <= 240 && m > 0) bump("caution", `FX closes in ${fmtDuration(m)}: weekend-gap risk, avoid holding positions through the close`); if (nx.becomes && m <= 120 && m > 0) bump("caution", `FX reopens in ${fmtDuration(m)}: reopening gaps and thin liquidity`); }
      d.push(a.reason); }
    if (i.market === "equities") { const s = exchangeStatus("NYSE", Math.max(w.start, i.now)), e = exchangeStatus("NYSE", Math.max(w.start, w.end - 1)); d.push(`NYSE/Nasdaq: ${s.reason}`); if (!s.open && !e.open) bump("severe", `US equity market closed (${s.reason})`); else if (s.open !== e.open || s.closure?.kind === "early_close") bump("caution", "US equity session opens, closes or closes early inside this window"); }
    if (i.market === "crypto") { sched.push("Crypto trades continuously; individual exchanges can still halt or run maintenance (not detectable here)."); const clos = upcomingClosures(w.start, 3).filter(c => c.kind === "closed" && c.date >= iso(w.start).slice(0, 10) && c.date <= iso(w.end - 1).slice(0, 10)); for (const c of clos) { bump("caution", `${c.exchange} holiday (${c.name}): traditional-market participation is lower`); } }
    const up = upcomingClosures(i.now, 7); if (up.length) d.push(`Upcoming closures: ${up.map(c => `${c.date} ${c.exchange} ${c.name}`).join("; ")}`);
    d.push(...sched, "Tokyo Stock Exchange holidays are not built in; verify them independently."); F(11, "Upcoming market closures", r, head, d); }

  // 12. Historical strategy performance under similar conditions
  const sess = i.session ?? (i.scope === "now" || i.scope === "hour" ? (SESSION_IDS.filter(s => s !== "sydney").find(s => sessionActiveFor(i.market, s, Math.max(w.start, i.now))) ?? null) : null);
  const ev = summarizeEvidence(i.evidence, i.market, sess, live && snap ? snap.regime.regime : null);
  F(12, "Historical strategy performance in similar conditions", ev.verdict === "no_data" ? "not_evaluated" : ev.verdict === "supportive" ? "supportive" : ev.verdict === "adverse" ? "adverse" : "neutral",
    ev.verdict === "no_data" ? "No recorded strategy results available for this symbol" : ev.verdict === "inconclusive" ? "Recorded results are inconclusive (sample too small or mixed)" : ev.verdict === "supportive" ? "Recorded trades in similar conditions had positive expectancy" : "Recorded trades in similar conditions had negative expectancy",
    [ev.note, ...ev.buckets.map(b => `${b.label}: ${b.trades} trades${b.status === "ok" ? `, win rate ${(b.winRate! * 100).toFixed(0)}% (95% CI ${(b.winRateInterval95!.low * 100).toFixed(0)}-${(b.winRateInterval95!.high * 100).toFixed(0)}%), expectancy ${b.expectancyR?.toFixed(2)}R` : " (below minimum sample: no rates shown)"}`)]);

  // ---------------------------------------------------------------- verdict
  const count = (r: Rating) => factors.filter(f => f.rating === r).length, severe = factors.filter(f => f.rating === "severe"), adverse = factors.filter(f => f.rating === "adverse"), cautions = factors.filter(f => f.rating === "caution");
  const evaluated = factors.filter(f => f.rating !== "not_evaluated").length, caps: string[] = [], by = (id: number) => factors.find(f => f.id === id)!;
  let status: ReadinessStatus = severe.length ? "AVOID_TRADING" : adverse.length ? "HIGH_RISK" : cautions.length >= 2 ? "UNCERTAIN" : cautions.length === 1 ? "SELECTIVELY_FAVOURABLE" : count("supportive") >= 4 && evaluated >= 7 ? "FAVOURABLE" : "SELECTIVELY_FAVOURABLE";
  const lim = (s: ReadinessStatus, why: string) => { const n = cap(status, s); if (n !== status) { status = n; caps.push(why); } };
  if (by(1).rating === "not_evaluated") lim("SELECTIVELY_FAVOURABLE", "Verdict capped at SELECTIVELY FAVOURABLE because announcement risk is unverified (no economic calendar connected).");
  if (live && (by(2).rating === "not_evaluated" || by(10).rating === "not_evaluated")) lim("UNCERTAIN", "Verdict capped at UNCERTAIN because live volatility or spread/execution data could not be verified.");
  if (!live && by(2).rating === "not_evaluated" && by(3).rating === "not_evaluated") lim("UNCERTAIN", "Verdict capped at UNCERTAIN because neither measured history nor live data exists for this window.");
  if (!past && evaluated < 5) lim("UNCERTAIN", "Verdict capped at UNCERTAIN because fewer than 5 of the 12 factors could be evaluated.");
  if (status === "FAVOURABLE" && (by(6).rating !== "supportive" && by(6).rating !== "not_evaluated")) status = "SELECTIVELY_FAVOURABLE";

  const blockers = [...severe, ...adverse].map(f => f.headline), reasonsOf = (rs: Rating[]) => factors.filter(f => rs.includes(f.rating)).map(f => f.headline);
  const reasons = status === "AVOID_TRADING" || status === "HIGH_RISK" ? [...reasonsOf(["severe", "adverse"]), ...reasonsOf(["caution"])] : status === "UNCERTAIN" ? [...reasonsOf(["caution"]), ...reasonsOf(["not_evaluated"]).map(h => `Unverified: ${h}`), ...reasonsOf(["supportive"])] : [...reasonsOf(["supportive"]), ...reasonsOf(["caution"]), ...reasonsOf(["neutral"]).slice(0, 2)];
  const REC: Record<ReadinessStatus, string> = {
    FAVOURABLE: "Conditions support trading. Still require a valid, confirmed setup with a defined stop and position size. Favourable conditions are not an entry signal.",
    SELECTIVELY_FAVOURABLE: "Wait for a valid setup and confirmation. Do not enter simply because the conditions have been rated favourably.",
    UNCERTAIN: "Stand aside or trade at reduced size, and only for exceptional, confirmed setups, until the uncertain factors resolve.",
    HIGH_RISK: "Avoid new entries. If you must trade, cut size sharply, widen nothing, and protect any open positions.",
    AVOID_TRADING: "Do not open new positions. Standing aside is a valid and often correct position."
  };
  const sched = factors.find(f => f.id === 11)!.detail.filter(d => /FX|Crypto|NYSE/.test(d));
  return { scope: i.scope, label: w.label, windowStart: w.start, windowEnd: w.end, status, statusLabel: STATUS_LABEL[status], recommendation: REC[status], reasons, blockers, caps, factors, evaluated, notEvaluated: factors.filter(f => f.rating === "not_evaluated").map(f => f.factor), liveConditionsApplied: live, evidence: ev,
    eventHits: allHits.map(h => ({ title: h.event.title, impact: h.event.impact, category: h.event.category, time: iso(h.event.time), severity: h.severity, phase: h.phase })), closures: upcomingClosures(w.start, 7), schedule: sched };
}

/** Structural (schedule-based, not measured) session fit for FX pairs, used when no FX price history is connected. */
export function structuralFit(pair: string) { return SESSION_IDS.map(id => ({ session: id, fit: structuralSessionFit(pair, id) })); }
export { sessionActive, fmtClock };
