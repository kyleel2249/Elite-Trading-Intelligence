// Assembles complete readiness reports (overall verdict + every session + hour-by-hour grid) and renders the plain-text
// "ETI MARKET READINESS REPORT". Also rates assets per session from MEASURED activity only.
import { HOUR, SESSION_IDS, exchangeNextChange, exchangeStatus, sessionActiveFor, sessionLabel, structuralSessionFit, type MarketKind, type SessionId } from "./calendar.ts";
import { assess, type AssessInput, type Assessment, type ReadinessStatus } from "./engine.ts";
import type { HistoryStats, SessionStat } from "./snapshot.ts";

export interface SessionReport { session: SessionId; label: string; activeNow: boolean; assessment: Assessment; measured: SessionStat | null; structuralFit: "primary" | "partial" | "weak" | null; note: string }
export interface ExchangeRow { exchange: "NYSE" | "LSE" | "TSE"; name: string; open: boolean; reason: string; next: { at: string; event: "opens" | "closes" } | null; closureToday: string | null; holidaysKnown: boolean }
export interface HourRow { hourUtc: number; start: string; status: ReadinessStatus; statusLabel: string; topReason: string }
export interface ReadinessReport {
  title: "ETI MARKET READINESS REPORT"; generatedAt: string; date: string; market: MarketKind; symbol: string | null; strategy: string; scope: AssessInput["scope"];
  overall: Assessment; sessions: SessionReport[]; exchanges: ExchangeRow[]; exchangesAsOf: string; hours: HourRow[] | null; disclaimers: string[]; text: string;
}
export const NOT_A_PROMISE = "Session and hour statistics describe measured activity (range, volume, directional efficiency), not profitability. No session is assumed to be profitable. Readiness is decision support, not financial advice, and never an instruction to enter a trade.";

export function buildReport(p: Omit<AssessInput, "session"> & { session?: SessionId }): ReadinessReport {
  const overall = assess(p), dayStart = p.scope === "day" ? Date.parse(`${p.dayKey}T00:00:00Z`) : p.scope === "hour" ? Math.floor(p.at / HOUR) * HOUR : p.now;
  const hist = p.snapshot?.history ?? null;
  const sessions: SessionReport[] = SESSION_IDS.filter(id => p.market !== "equities" || id !== "sydney").map(id => {
    const a = assess({ ...p, scope: "session", session: id, at: p.scope === "day" ? Math.max(dayStart, p.now) : p.scope === "now" ? p.now : p.at });
    return { session: id, label: sessionLabel(id), activeNow: sessionActiveFor(p.market, id, p.now), assessment: a, measured: hist?.sessions.find(s => s.session === id) ?? null,
      structuralFit: p.market === "forex" && p.symbol ? structuralSessionFit(p.symbol, id) : null,
      note: "Measured activity only; this does not imply profitability." };
  });
  const hours: HourRow[] | null = p.scope === "day" ? Array.from({ length: 24 }, (_, h) => { const a = assess({ ...p, scope: "hour", at: dayStart + h * HOUR }); return { hourUtc: h, start: new Date(dayStart + h * HOUR).toISOString(), status: a.status, statusLabel: a.statusLabel, topReason: a.reasons[0] ?? "" }; }) : null;
  const ref = p.scope === "day" ? Math.max(dayStart, p.now) : p.scope === "now" ? p.now : p.at;
  const exchanges: ExchangeRow[] = (["NYSE", "LSE", "TSE"] as const).map(ex => { const st = exchangeStatus(ex, ref), n = exchangeNextChange(ex, ref); return { exchange: ex, name: st.name, open: st.open, reason: st.reason, next: n ? { at: new Date(n.at).toISOString(), event: n.becomes ? "opens" as const : "closes" as const } : null, closureToday: st.closure ? st.closure.name + (st.closure.kind === "early_close" ? " (early close)" : "") : null, holidaysKnown: st.holidaysKnown }; });
  const rep = { title: "ETI MARKET READINESS REPORT" as const, generatedAt: new Date(p.now).toISOString(), date: new Date(p.scope === "day" ? dayStart : p.now).toISOString().slice(0, 10), market: p.market, symbol: p.symbol || null, strategy: p.strategy, scope: p.scope, overall, sessions, exchanges, exchangesAsOf: new Date(ref).toISOString(), hours, disclaimers: [NOT_A_PROMISE] };
  return { ...rep, text: renderText(rep) };
}

const MARKET_NAME: Record<MarketKind, string> = { crypto: "Crypto", forex: "Forex", equities: "Equities" };
function block(label: string, a: Assessment, max = 6): string[] {
  const lines = [`${label}: ${a.statusLabel}`, "", "Reason:", ...(a.reasons.length ? a.reasons.slice(0, max) : ["No factor could be evaluated."]).map(r => `- ${r}`)];
  if (a.caps.length) lines.push(...a.caps.map(c => `- ${c}`));
  lines.push("", "Recommendation:", a.recommendation);
  return lines;
}
export function renderText(r: Omit<ReadinessReport, "text">): string {
  const out = ["ETI MARKET READINESS REPORT", "", `Date: ${r.date}`, `Market: ${MARKET_NAME[r.market]}${r.symbol ? ` (${r.symbol})` : ""}`, `Window: ${r.overall.label}`, `Generated: ${r.generatedAt}`, "", ...block("Overall", r.overall, 8)];
  const interesting = r.sessions.filter(s => r.scope === "session" || r.scope === "day" || r.scope === "now" || s.activeNow);
  for (const s of interesting) out.push("", ...block(s.label + (s.activeNow ? " (active now)" : ""), s.assessment, 4));
  out.push("", `Exchange hours (as of ${r.exchangesAsOf.slice(0, 16).replace("T", " ")} UTC):`, ...r.exchanges.map(e => `- ${e.name}: ${e.open ? "OPEN" : "CLOSED"} (${e.reason})${e.next ? `; ${e.next.event} ${e.next.at.slice(0, 16).replace("T", " ")} UTC` : ""}${e.closureToday ? `; ${e.closureToday}` : ""}`));
  if (r.overall.notEvaluated.length) out.push("", `Not evaluated (${r.overall.notEvaluated.length} of 12): ${r.overall.notEvaluated.join("; ")}`);
  out.push("", "Do not enter simply because a session or day has been rated favourably. Wait for a valid setup and confirmation.", "", NOT_A_PROMISE);
  return out.join("\n");
}

// ----------------------------------------------------------- which assets suit each session (measured)
export type AssetCondition = "favourable" | "selective" | "unfavourable" | "insufficient_data";
export interface AssetSessionRow { symbol: string; condition: AssetCondition; rangeVsBaseline: number | null; volumeVsBaseline: number | null; efficiency: number | null; samples: number; reasons: string[] }
/** Rates one asset in one session from its own history. Relative to the asset's own weekday baseline, so assets are not compared on raw size. */
export function rateAssetSession(h: HistoryStats | null, id: SessionId, symbol: string): AssetSessionRow {
  const s = h?.sessions.find(r => r.session === id);
  if (!h || !s) return { symbol, condition: "insufficient_data", rangeVsBaseline: null, volumeVsBaseline: null, efficiency: null, samples: 0, reasons: ["No usable hourly history."] };
  const base = { symbol, rangeVsBaseline: s.rangeVsBaseline, volumeVsBaseline: s.volumeVsBaseline, efficiency: s.efficiency, samples: s.instances };
  if (!s.sampleOk) return { ...base, condition: "insufficient_data", reasons: [`Only ${s.instances} complete session instances measured (minimum 10).`] };
  if (!h.volumeKnown) return { ...base, condition: "insufficient_data", reasons: ["This price source supplies no volume, so participation cannot be rated."] };
  const effs = h.sessions.map(q => q.efficiency).filter((v): v is number => v !== null), avgEff = effs.reduce((a, b) => a + b, 0) / effs.length;
  const reasons = [`Volume ${s.volumeVsBaseline.toFixed(2)}x and range ${s.rangeVsBaseline.toFixed(2)}x the asset's own weekday baseline over ${s.instances} sessions.`];
  const dir = s.efficiency !== null && s.efficiency >= avgEff;
  if (s.efficiency !== null) reasons.push(`Directional efficiency ${s.efficiency.toFixed(2)} vs ${avgEff.toFixed(2)} across sessions (${dir ? "more" : "less"} directional than usual).`);
  const condition: AssetCondition = s.volumeVsBaseline < 0.8 ? "unfavourable" : s.rangeVsBaseline > 1.6 ? "selective" : s.volumeVsBaseline >= 1 && s.rangeVsBaseline >= 0.9 && dir ? "favourable" : "selective";
  if (condition === "unfavourable") reasons.push("Thin participation relative to the asset's norm.");
  if (s.rangeVsBaseline > 1.6) reasons.push("Unusually wide ranges: risk of erratic moves.");
  return { ...base, condition, reasons };
}
