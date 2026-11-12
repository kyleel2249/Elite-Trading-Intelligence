// ETI GLOBAL MARKET INTELLIGENCE: pure assembly of the daily report from already-collected evidence.
// Nothing here performs I/O. Every statement is derived from the CollectedData it is given; anything that could not be
// measured is reported as unavailable, never filled in. A validated setup is the only thing that may carry BUY/SELL.

export const REPORT_TITLE = "ETI GLOBAL MARKET INTELLIGENCE" as const;
export const REPORT_VERSION = "1.0.0";

export type AssetKey = "EURUSD" | "XAUUSD" | "BTCUSD" | "STOCK";
export type AssetStatus = "evaluated" | "partial" | "unavailable" | "deferred";
export type Dir = "BUY" | "SELL" | "NO TRADE";

export interface FactorLite { id: number; factor: string; rating: string; headline: string; detail: string[] }
export interface EventHitLite { title: string; impact: string; time: string; severity: string; phase: string }
export interface ClosureLite { exchange: string; date: string; name: string; kind: string }
export interface ReadinessLite {
  status: string; statusLabel: string; recommendation: string; reasons: string[]; blockers: string[]; caps: string[];
  evaluated: number; notEvaluated: string[]; factors: FactorLite[]; schedule: string[]; eventHits: EventHitLite[]; closures: ClosureLite[];
  liveConditionsApplied: boolean; label: string;
}
export interface SessionLite { session: string; label: string; activeNow: boolean; status: string; statusLabel: string; reason: string }
export interface ExchangeLite { exchange: string; name: string; open: boolean; reason: string; next: { at: string; event: string } | null; closureToday: string | null }
export interface SetupLite {
  source: "precision" | "signal-engine"; direction: Dir; lean: "BUY" | "SELL" | null; validated: boolean; blockers: string[];
  strategy: string; timeframe: string; entry: number | null; stop: number | null; targets: number[]; stopPct: number | null;
  rewardRisk: number | null; rewardRiskBasis: string; score: number | null; scoreBand: string | null; conviction: string | null; confidenceNote: string;
  winRate: number | null; samples: number; atrPercent: number | null; volatility: string | null; liquidity: string | null;
  invalidation: string[]; expiresAt: string | null; asOf: string | null; costsIncluded: boolean;
  hardChecks: { passed: number; failed: number; notEvaluated: number } | null;
}
export interface AssetResult {
  key: AssetKey; label: string; instrument: string; market: "forex" | "commodity" | "crypto" | "equities";
  status: AssetStatus; note: string | null; readiness: ReadinessLite | null; setup: SetupLite | null;
  price: { last: number; asOf: string | null; provider: string | null } | null; candidates?: string[];
}
export interface EventLite { title: string; impact: "low" | "medium" | "high"; category: string; time: string; currencies: string[]; markets: string[]; symbols: string[] }
export interface CalendarLite { status: string; error: string | null; sources: string[]; events: EventLite[] }
export interface CollectedData {
  now: number; calendar: CalendarLite; exchanges: ExchangeLite[]; sessions: { crypto: SessionLite[]; forex: SessionLite[] };
  assets: AssetResult[]; budget: { limit: number; used: number; deferred: string[] }; riskPerTradePct: number;
}

export interface ReportSection { number: number; title: string; status: "ok" | "partial" | "unavailable"; lines: string[] }
export interface OpportunityRow { asset: string; instrument: string; direction: Dir | "N/A"; setup: string; risk: string; verdict: string; validated: boolean; dataStatus: AssetStatus }
export interface DailyReport {
  title: typeof REPORT_TITLE; version: string; generatedAt: string; dateTimeUtc: string; date: string;
  tradingDay: { isTradingDay: boolean; note: string };
  sections: ReportSection[]; opportunities: OpportunityRow[];
  finalVerdict: { status: string; label: string; summary: string; actionable: number; assetsAssessed: number; assetsTotal: number };
  dataQuality: { complete: boolean; calendar: string; assets: { asset: string; status: AssetStatus; note: string | null }[]; budget: CollectedData["budget"] };
  disclaimers: string[]; markdown: string;
}

const RANK: Record<string, number> = { FAVOURABLE: 0, SELECTIVELY_FAVOURABLE: 1, UNCERTAIN: 2, HIGH_RISK: 3, AVOID_TRADING: 4 };
const LABEL: Record<string, string> = { FAVOURABLE: "FAVOURABLE", SELECTIVELY_FAVOURABLE: "SELECTIVELY FAVOURABLE", UNCERTAIN: "UNCERTAIN", HIGH_RISK: "HIGH RISK", AVOID_TRADING: "AVOID TRADING", NOT_ASSESSED: "NOT ASSESSED" };
const rank = (s: string | undefined | null) => (s && s in RANK ? RANK[s] : 99);
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const HOUR = 3_600_000, MIN = 60_000;

export const DISCLAIMERS = [
  "Research and decision support only. This is not investment advice and ETI cannot guarantee any outcome. Trading can lose money.",
  "A setup is called validated only when ETI's own gates pass: crypto uses the ETI Precision engine's hard risk gates; other markets need a high-conviction signal on fresh candles whose walk-forward replay has at least 20 resolved samples and a win rate above 50%. Replay excludes fees, slippage and market impact.",
  "Anything ETI could not measure is shown as unavailable or not evaluated and lowers the verdict. ETI never invents prices, events or statistics.",
  "No order is placed by this report. Orders can only be submitted through ETI's separate authenticated execution API, which is limited to paper and testnet venues and applies in-process safeguards (kill switch, validation, quantity cap, duplicate protection); live trading is disabled.",
];

const iso = (ms: number) => new Date(ms).toISOString();
const hhmm = (ms: number) => iso(ms).slice(11, 16);
const ymdhm = (ms: number) => iso(ms).slice(0, 16).replace("T", " ");
export const fmtPx = (n: number | null | undefined): string => n === null || n === undefined || !Number.isFinite(n) ? "n/a" : Math.abs(n) >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : Math.abs(n) >= 10 ? n.toFixed(3) : n.toFixed(5);
const pct = (n: number | null | undefined, d = 2) => n === null || n === undefined || !Number.isFinite(n) ? "n/a" : `${n.toFixed(d)}%`;
const cell = (s: string) => s.replace(/\|/g, "/").replace(/\s+/g, " ").trim();

export function tradingDayInfo(now: number): { isTradingDay: boolean; note: string } {
  const dow = new Date(now).getUTCDay(), weekday = dow >= 1 && dow <= 5;
  return { isTradingDay: weekday, note: weekday ? `${DAYS[dow]}: forex, US equities and crypto are scheduled to trade (exchange holidays and early closes are listed in section 3).` : `${DAYS[dow]}: forex and US equity markets are closed; only crypto trades. This report is informational for the next trading day.` };
}

const factor = (a: AssetResult, id: number) => a.readiness?.factors.find(f => f.id === id) ?? null;
const factorLine = (a: AssetResult, id: number, name: string): string => { const f = factor(a, id); return f ? `${name}: ${f.rating === "not_evaluated" ? "NOT EVALUATED, " : ""}${f.headline}` : `${name}: not assessed`; };
/** A setup is actionable only if it validated AND the market-readiness verdict is not HIGH RISK / AVOID TRADING. */
export const actionable = (a: AssetResult): boolean => !!a.setup && a.setup.validated && (a.setup.direction === "BUY" || a.setup.direction === "SELL") && !!a.readiness && rank(a.readiness.status) <= RANK.UNCERTAIN;
const usable = (a: AssetResult) => a.status === "evaluated" || a.status === "partial";

function setupText(a: AssetResult): string {
  const s = a.setup;
  if (!s) return a.status === "deferred" ? `Not evaluated: ${a.note ?? "subrequest budget reached"}` : `No setup could be computed${a.note ? `: ${a.note}` : ""}.`;
  if (actionable(a)) {
    const tps = s.targets.map((t, i) => `TP${i + 1} ${fmtPx(t)}`).join(" / ");
    return `${s.source === "precision" ? "ETI Precision" : "ETI signal engine"} ${s.strategy} on ${s.timeframe}: entry ${fmtPx(s.entry)}, stop ${fmtPx(s.stop)}, ${tps}; score ${s.score ?? "n/a"}${s.scoreBand ? ` (${s.scoreBand})` : ""}; ${s.confidenceNote}.`;
  }
  const why = s.blockers[0] ?? (a.readiness && rank(a.readiness.status) > RANK.UNCERTAIN ? `readiness is ${a.readiness.statusLabel}` : "no validated edge");
  return `No validated setup${s.lean ? ` (unvalidated ${s.lean} lean${s.conviction ? `, ${s.conviction} conviction` : ""})` : ""}: ${why}.`;
}
function riskText(a: AssetResult, riskPct: number): string {
  const s = a.setup;
  if (!s) return "Not calculated: no setup data.";
  const parts: string[] = [];
  if (actionable(a)) {
    parts.push(`stop distance ${pct(s.stopPct)} of price`);
    if (s.rewardRisk !== null) parts.push(`R:R ${s.rewardRisk.toFixed(2)} ${s.rewardRiskBasis}`);
    parts.push(s.costsIncluded ? "fees/slippage included" : "fees/slippage NOT included (no cost model for this market)");
    if (s.hardChecks) parts.push(`hard risk checks ${s.hardChecks.passed} passed / ${s.hardChecks.failed} failed`);
    parts.push(`size so the stop loses at most ${riskPct}% of equity (planning default, configurable)`);
  } else parts.push("no position to size");
  if (s.atrPercent !== null) parts.push(`ATR ${pct(s.atrPercent)}${s.volatility ? ` (${s.volatility})` : ""}`);
  if (s.liquidity) parts.push(`liquidity ${s.liquidity}`);
  return parts.join("; ") + ".";
}
function verdictText(a: AssetResult): string {
  if (!a.readiness) return a.status === "deferred" ? "NOT ASSESSED (deferred)" : "NOT ASSESSED: no data";
  const base = LABEL[a.readiness.status] ?? a.readiness.statusLabel;
  if (actionable(a)) return `${base}: validated ${a.setup!.direction} setup; wait for your own confirmation before entry`;
  if (rank(a.readiness.status) > RANK.UNCERTAIN) return `${base}: do not open new positions`;
  return `${base}: no validated setup, stand aside`;
}
function direction(a: AssetResult): Dir | "N/A" {
  if (!usable(a) || !a.readiness) return "N/A";
  if (!a.setup) return "N/A";
  return actionable(a) ? a.setup.direction : "NO TRADE";
}

export function opportunityRows(data: CollectedData): OpportunityRow[] {
  return data.assets.map(a => ({ asset: a.label, instrument: a.instrument, direction: direction(a), setup: setupText(a), risk: riskText(a, data.riskPerTradePct), verdict: verdictText(a), validated: actionable(a), dataStatus: a.status }));
}

function outlook(a: AssetResult | undefined, label: string): { status: ReportSection["status"]; lines: string[] } {
  if (!a) return { status: "unavailable", lines: [`${label}: not part of this report run.`] };
  const lines: string[] = [];
  if (a.status === "deferred") return { status: "unavailable", lines: [`${label}: NOT EVALUATED. ${a.note ?? "Skipped to stay inside the subrequest budget."}`] };
  if (!a.readiness) return { status: "unavailable", lines: [`${label}: DATA UNAVAILABLE${a.note ? `. ${a.note}` : ""}`] };
  lines.push(`${label} (${a.instrument}): readiness ${a.readiness.statusLabel}.`);
  if (a.price) lines.push(`Last price ${fmtPx(a.price.last)} (${a.price.provider ?? "provider n/a"}${a.price.asOf ? `, as of ${a.price.asOf.slice(0, 16).replace("T", " ")} UTC` : ""}).`);
  else lines.push("Last price: unavailable (no live price source for this instrument).");
  for (const [id, name] of [[5, "Trend"], [4, "Structure"], [2, "Volatility"], [6, "Technical setups"]] as const) lines.push(factorLine(a, id, name));
  lines.push(`Setup: ${setupText(a)}`);
  if (a.note) lines.push(`Note: ${a.note}`);
  const live = a.readiness.liveConditionsApplied;
  return { status: live && a.setup ? "ok" : "partial", lines };
}

const hasEvent = (data: CollectedData) => data.calendar.status === "loaded";
const calendarCaveat = (c: CalendarLite) => c.status === "loaded" ? null : c.status === "not_configured" ? "UNVERIFIED: no economic calendar is connected (set ETI_EVENT_FEED_URL or ETI_EVENTS_JSON). ETI does not invent announcements; check an official calendar before trading." : `UNVERIFIED: the economic calendar failed to load${c.error ? ` (${c.error})` : ""}.`;

export function buildDailyReport(data: CollectedData): DailyReport {
  const now = data.now, A = (k: AssetKey) => data.assets.find(x => x.key === k);
  const td = tradingDayInfo(now), sections: ReportSection[] = [];
  const S = (title: string, status: ReportSection["status"], lines: string[]) => sections.push({ number: sections.length + 1, title, status, lines: lines.length ? lines : ["Nothing to report."] });
  const rated = data.assets.filter(a => a.readiness), assessed = data.assets.filter(usable).length;
  const cav = calendarCaveat(data.calendar);

  // 1. Global market conditions
  { const l: string[] = [];
    if (rated.length) { const worst = rated.reduce((w, a) => (rank(a.readiness!.status) > rank(w.readiness!.status) ? a : w)); l.push(`Per-asset readiness: ${data.assets.map(a => `${a.label} ${a.readiness ? a.readiness.statusLabel : "NOT ASSESSED"}`).join("; ")}.`, `Most cautious reading: ${worst.label} (${worst.readiness!.statusLabel}).`); }
    else l.push("No asset could be assessed: market data was unavailable for every instrument.");
    for (const e of data.exchanges) l.push(`${e.name}: ${e.open ? "OPEN" : "CLOSED"} (${e.reason})${e.next ? `; ${e.next.event} ${e.next.at.slice(0, 16).replace("T", " ")} UTC` : ""}${e.closureToday ? `; ${e.closureToday}` : ""}.`);
    const act = [...data.sessions.forex, ...data.sessions.crypto].filter(s => s.activeNow).map(s => s.label);
    if (act.length) l.push(`Sessions active now: ${[...new Set(act)].join(", ")}.`);
    l.push(td.note);
    S("Global market conditions", rated.length ? (assessed === data.assets.length ? "ok" : "partial") : "unavailable", l); }

  // 2. Major economic developments (last 24 hours)
  { const l: string[] = [];
    if (cav) l.push(cav);
    else { const past = data.calendar.events.filter(e => Date.parse(e.time) <= now && Date.parse(e.time) >= now - 24 * HOUR && e.impact !== "low");
      if (!past.length) l.push(`No medium or high impact releases are recorded in the configured feed for the last 24 hours (${data.calendar.events.length} events loaded). Verify the feed is current.`);
      for (const e of past.slice(-12)) l.push(`${ymdhm(Date.parse(e.time))} UTC: ${e.title} [${e.impact} impact${e.currencies.length ? `, ${e.currencies.join("/")}` : ""}].`);
      l.push("Only releases listed by the configured feed are shown; ETI does not report results or surprises it was not given."); }
    S("Major economic developments", cav ? "unavailable" : "ok", l); }

  // 3. Important upcoming announcements (next 72 hours) and closures
  { const l: string[] = [];
    if (cav) l.push(cav);
    else { const up = data.calendar.events.filter(e => Date.parse(e.time) > now && Date.parse(e.time) <= now + 72 * HOUR && e.impact !== "low");
      if (!up.length) l.push("No medium or high impact announcements are listed for the next 72 hours in the configured feed.");
      for (const e of up.slice(0, 15)) l.push(`${ymdhm(Date.parse(e.time))} UTC: ${e.title} [${e.impact} impact${e.currencies.length ? `, ${e.currencies.join("/")}` : ""}${e.category !== "economic" ? `, ${e.category.replace("_", " ")}` : ""}].`); }
    const seen = new Set<string>(), closures: ClosureLite[] = [];
    for (const a of data.assets) for (const c of a.readiness?.closures ?? []) { const k = `${c.exchange}|${c.date}`; if (!seen.has(k)) { seen.add(k); closures.push(c); } }
    for (const c of closures.sort((x, y) => x.date.localeCompare(y.date))) l.push(`${c.date}: ${c.exchange} ${c.kind === "early_close" ? "early close" : "closed"} (${c.name}).`);
    if (closures.length) l.push("Holiday lists are rule-derived and cannot know one-off special closures: confirm with the exchange.");
    S("Important upcoming announcements", cav ? "partial" : "ok", l); }

  // 4-7. Market outlooks
  const fx = outlook(A("EURUSD"), "EUR/USD");
  { const l = [...fx.lines]; const fxs = data.sessions.forex.filter(s => s.activeNow); l.push(fxs.length ? `Active forex sessions: ${fxs.map(s => s.label).join(", ")}.` : "No major forex session is active right now.");
    l.push("Other FX pairs are not part of this report; use /api/readiness?market=forex&symbol=GBPUSD for any of the supported pairs.");
    S("Forex market outlook", fx.status, l); }
  const au = outlook(A("XAUUSD"), "Gold (XAU/USD)");
  S("Gold and commodities outlook", au.status, [...au.lines, "Silver, crude oil, natural gas, copper and other commodities: NOT ASSESSED. No connected ETI data source covers them."]);
  const bt = outlook(A("BTCUSD"), "Bitcoin (BTC/USD)");
  S("Cryptocurrency outlook", bt.status, [...bt.lines, "BTC/USD is analysed through BTCUSDT spot (USDT-quoted); USDT can trade slightly away from USD."]);
  { const st = A("STOCK"), o = outlook(st, st && st.instrument ? `Selected stock (${st.instrument})` : "Selected stock"); const l = [...o.lines];
    if (st?.candidates?.length) l.push(`Candidates evaluated from the configured watchlist: ${st.candidates.join("; ")}.`);
    const ny = data.exchanges.find(e => e.exchange === "NYSE"); if (ny) l.push(`US market: ${ny.open ? "OPEN" : "CLOSED"} (${ny.reason}).`);
    S("Stock market outlook", o.status, l); }

  // 8. Best researched opportunities
  const act = data.assets.filter(actionable).sort((x, y) => rank(x.readiness!.status) - rank(y.readiness!.status) || (y.setup!.score ?? 0) - (x.setup!.score ?? 0) || (y.setup!.rewardRisk ?? 0) - (x.setup!.rewardRisk ?? 0));
  { const l: string[] = act.length ? act.map((a, i) => `${i + 1}. ${a.label} ${a.setup!.direction}: ${setupText(a)} Verdict: ${verdictText(a)}.`) : ["No opportunity qualifies today. No assessed asset has a validated setup together with an acceptable readiness verdict. Standing aside is the researched outcome."];
    if (act.length) l.push("Ranked by readiness verdict, then opportunity score, then reward-to-risk. A ranking is not an entry signal.");
    S("Best researched opportunities", rated.length ? "ok" : "unavailable", l); }

  // 9. Assets to avoid
  { const l: string[] = [];
    for (const a of data.assets) {
      if (!a.readiness) l.push(`${a.label}: not assessable (${a.note ?? "no data"}). Do not rely on ETI for this asset today.`);
      else if (rank(a.readiness.status) > RANK.UNCERTAIN) l.push(`${a.label}: ${a.readiness.statusLabel}. ${a.readiness.blockers[0] ?? a.readiness.reasons[0] ?? ""}`.trim());
      else if (a.setup && !a.setup.validated && a.setup.blockers.length && a.setup.lean) l.push(`${a.label}: unvalidated ${a.setup.lean} lean only (${a.setup.blockers[0]}). Do not trade it on ETI's authority.`);
    }
    S("Assets to avoid", rated.length ? "ok" : "unavailable", l.length ? l : ["No assessed asset is rated HIGH RISK or AVOID TRADING, and none is a rejected lean."]); }

  // 10. Expected volatility
  S("Expected volatility", rated.length ? (assessed === data.assets.length ? "ok" : "partial") : "unavailable", data.assets.map(a => `${a.label}: ${factorLine(a, 2, "").replace(/^: /, "")}${a.setup?.atrPercent != null ? ` (ATR ${pct(a.setup.atrPercent)}${a.setup.volatility ? `, ${a.setup.volatility}` : ""})` : ""}`));

  // 11. Market liquidity
  { const l = data.assets.map(a => `${a.label}: ${factorLine(a, 3, "Liquidity").replace("Liquidity: ", "")}; ${factorLine(a, 10, "Spreads/execution").replace("Spreads/execution: ", "")}.`);
    S("Market liquidity", rated.length ? (assessed === data.assets.length ? "ok" : "partial") : "unavailable", l); }

  // 12. Trading-session recommendations
  { const l: string[] = []; let have = false;
    for (const [name, list] of [["Forex", data.sessions.forex], ["Crypto", data.sessions.crypto]] as const) {
      if (!list.length) { l.push(`${name}: session analysis unavailable.`); continue; }
      have = true;
      const good = list.filter(s => rank(s.status) <= RANK.SELECTIVELY_FAVOURABLE), bad = list.filter(s => rank(s.status) >= RANK.HIGH_RISK);
      l.push(`${name}: ${good.length ? `preferred ${good.map(s => `${s.label} (${s.statusLabel.toLowerCase()})`).join(", ")}` : "no session rates better than UNCERTAIN"}${bad.length ? `; avoid ${bad.map(s => s.label).join(", ")}` : ""}.`);
      for (const s of list) l.push(`  ${s.label}${s.activeNow ? " (active now)" : ""}: ${s.statusLabel}${s.reason ? ` - ${s.reason}` : ""}`);
    }
    l.push("Session ratings come from schedules, the event calendar and measured activity. They do not imply profitability.");
    S("Trading-session recommendations", have ? "ok" : "unavailable", l); }

  // 13. High-risk periods
  { const l: string[] = [];
    if (!cav) for (const e of data.calendar.events.filter(x => x.impact === "high" && Date.parse(x.time) > now - 2 * HOUR && Date.parse(x.time) <= now + 48 * HOUR)) { const t = Date.parse(e.time); l.push(`${e.title} at ${ymdhm(t)} UTC: no-trade blackout ${hhmm(t - 30 * MIN)}-${hhmm(t + 30 * MIN)} UTC, high-risk window ${hhmm(t - 120 * MIN)}-${hhmm(t + 120 * MIN)} UTC.`); }
    else if (cav) l.push(cav);
    const hits = new Map<string, string>(); for (const a of data.assets) for (const h of a.readiness?.eventHits ?? []) hits.set(`${a.label}|${h.title}`, `${a.label}: ${h.title} is ${h.severity.replace("_", " ")} (${h.phase}) for the next 2 hours.`);
    l.push(...hits.values());
    const sched = new Set<string>(); for (const a of data.assets) for (const s of a.readiness?.schedule ?? []) if (/FX (opens|closes)|NYSE/.test(s)) sched.add(s);
    l.push(...sched);
    for (const e of data.exchanges) if (!e.open && e.next) l.push(`${e.name} reopens ${e.next.at.slice(0, 16).replace("T", " ")} UTC: expect gaps and thin liquidity around the open.`);
    l.push("Weekend and holiday sessions typically have thinner crypto liquidity.");
    S("High-risk periods", cav ? "partial" : "ok", l); }

  // 14. Strongest validated strategy candidates
  { const l: string[] = [];
    if (act.length) for (const a of act) { const s = a.setup!; l.push(`${a.label} ${s.direction}: ${s.source === "precision" ? "ETI Precision engine" : "ETI signal engine"} (${s.strategy}, ${s.timeframe}). ${s.confidenceNote}.${s.hardChecks ? ` Hard risk checks: ${s.hardChecks.passed} passed, ${s.hardChecks.failed} failed, ${s.hardChecks.notEvaluated} not evaluated.` : ""}${s.winRate !== null ? ` Walk-forward replay: ${s.winRate}% TP1-before-stop over ${s.samples} samples (excludes fees and slippage).` : ""}${s.invalidation[0] ? ` Invalidation: ${s.invalidation[0]}` : ""}${s.expiresAt ? ` Valid until ${s.expiresAt.slice(0, 16).replace("T", " ")} UTC.` : ""}`); }
    else l.push("No validated strategy candidate today.");
    const leans = data.assets.filter(a => !actionable(a) && a.setup?.lean); if (leans.length) l.push(`Unvalidated leans (NOT candidates): ${leans.map(a => `${a.label} ${a.setup!.lean} (${a.setup!.blockers[0] ?? "failed validation"})`).join("; ")}.`);
    S("Strongest validated strategy candidates", rated.length ? "ok" : "unavailable", l); }

  // 15. Portfolio risk assessment
  { const l: string[] = [`Open positions and account equity are not read by this public report. Apply your own account limits.`];
    const n = act.length; l.push(`Validated candidates today: ${n}. If all were taken at the planning risk of ${data.riskPerTradePct}% of equity each, combined risk at the stops would be ${(n * data.riskPerTradePct).toFixed(2)}% of equity (assumes independent stops; correlated moves can hit several at once).`);
    const usd = act.filter(a => a.key === "EURUSD" || a.key === "XAUUSD").map(a => ({ a, short: a.setup!.direction === "BUY" })); const shortUsd = usd.filter(u => u.short), longUsd = usd.filter(u => !u.short);
    if (shortUsd.length > 1 || longUsd.length > 1) l.push(`Concentrated USD exposure: ${(shortUsd.length > 1 ? shortUsd : longUsd).map(u => u.a.label).join(" and ")} are the same dollar bet (${shortUsd.length > 1 ? "short" : "long"} USD). Treat them as one position for sizing.`);
    const corr = factor(A("BTCUSD") ?? ({} as AssetResult), 9); if (corr && corr.rating !== "not_evaluated") l.push(`Crypto correlation: ${corr.headline}.`);
    const worst = rated.filter(a => rank(a.readiness!.status) >= RANK.HIGH_RISK).map(a => a.label); if (worst.length) l.push(`Elevated-risk assets (reduce or avoid): ${worst.join(", ")}.`);
    const miss = data.assets.filter(a => !a.readiness).map(a => a.label); if (miss.length) l.push(`Risk not assessed for: ${miss.join(", ")}.`);
    S("Portfolio risk assessment", rated.length ? "ok" : "unavailable", l); }

  // 16. Final market-readiness verdict
  const finalVerdict = ((): DailyReport["finalVerdict"] => {
    if (!rated.length) return { status: "NOT_ASSESSED", label: LABEL.NOT_ASSESSED, summary: "No market could be assessed because live data was unavailable. Do not trade on this report.", actionable: 0, assetsAssessed: 0, assetsTotal: data.assets.length };
    let worst = Math.max(...rated.map(a => rank(a.readiness!.status))); const reasons: string[] = [];
    if (assessed < data.assets.length && worst < RANK.UNCERTAIN) { worst = RANK.UNCERTAIN; reasons.push(`${data.assets.length - assessed} of ${data.assets.length} assets could not be fully assessed`); }
    if (!hasEvent(data) && worst < RANK.UNCERTAIN) { worst = RANK.UNCERTAIN; reasons.push("economic calendar unverified"); }
    const status = Object.keys(RANK).find(k => RANK[k] === worst)!;
    const summary = `${LABEL[status]}: ${act.length ? `${act.length} validated candidate${act.length > 1 ? "s" : ""} (${act.map(a => `${a.label} ${a.setup!.direction}`).join(", ")}); each still needs confirmation and a defined stop.` : "no validated candidate; standing aside is the correct default."}${reasons.length ? ` Capped because ${reasons.join(" and ")}.` : ""} The verdict follows the most cautious assessed asset.`;
    return { status, label: LABEL[status], summary, actionable: act.length, assetsAssessed: assessed, assetsTotal: data.assets.length };
  })();
  S("Final market-readiness verdict", rated.length ? "ok" : "unavailable", [finalVerdict.summary, "A favourable rating is never an entry signal: wait for a valid setup, confirmation and a defined stop."]);

  const opportunities = opportunityRows(data), complete = data.assets.every(a => a.status === "evaluated") && hasEvent(data);
  const report: Omit<DailyReport, "markdown"> = {
    title: REPORT_TITLE, version: REPORT_VERSION, generatedAt: iso(now), dateTimeUtc: `${ymdhm(now)} UTC (${DAYS[new Date(now).getUTCDay()]})`, date: iso(now).slice(0, 10), tradingDay: td, sections, opportunities, finalVerdict,
    dataQuality: { complete, calendar: data.calendar.status, assets: data.assets.map(a => ({ asset: a.label, status: a.status, note: a.note })), budget: data.budget }, disclaimers: DISCLAIMERS,
  };
  return { ...report, markdown: renderMarkdown(report) };
}

export function renderMarkdown(r: Omit<DailyReport, "markdown">): string {
  const out: string[] = [`# ${r.title}`, "", `**Date and time:** ${r.dateTimeUtc}`, "", `*${r.tradingDay.note}*`, ""];
  for (const s of r.sections) { out.push(`## ${s.number}. ${s.title}`, ""); if (s.status !== "ok") out.push(`_Data status: ${s.status}._`, ""); for (const l of s.lines) out.push(l.startsWith("  ") ? `  - ${l.trim()}` : `- ${l}`); out.push(""); }
  out.push("## Opportunity table", "", "| Asset | Direction | Setup | Risk | ETI verdict |", "|---|---|---|---|---|");
  for (const o of r.opportunities) out.push(`| ${cell(o.asset)} | ${o.direction} | ${cell(o.setup)} | ${cell(o.risk)} | ${cell(o.verdict)} |`);
  out.push("", "## Data quality", "", `- Economic calendar: ${r.dataQuality.calendar}.`, ...r.dataQuality.assets.map(a => `- ${a.asset}: ${a.status}${a.note ? ` (${a.note})` : ""}`), `- Subrequest budget: ${r.dataQuality.budget.used} of ${r.dataQuality.budget.limit} used${r.dataQuality.budget.deferred.length ? `; deferred: ${r.dataQuality.budget.deferred.join(", ")}` : ""}.`, "", "---", "", ...r.disclaimers.map(d => `> ${d}`), "", `Generated ${r.generatedAt} by ETI report engine v${r.version}.`);
  return out.join("\n");
}
