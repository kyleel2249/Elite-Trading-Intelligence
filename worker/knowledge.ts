/**
 * Elite-trader knowledge API for the Worker.
 * Data comes from the Python registry (app/knowledge) via worker/knowledge.generated.json, so the FastAPI app
 * and the Worker share one source of truth. If that file is empty the built-in profiles are served instead,
 * and the response says so ("source": "built-in-fallback") rather than failing silently.
 */
import knowledgeData from "./knowledge.generated.json" with { type: "json" };
import { handleTraderDirectory, TRADER_PROFILES } from "./traders.ts";
import { MODULE_META } from "./strategies.ts";

type Freshness = { researchDate: string; netWorthLiveUpdatedAt: string | null; liveAsOf: Record<string, string> };
const data = knowledgeData as { generatedAt: string | null; source: string; profiles: any[]; strategies: any[]; freshness?: Freshness };
const STALE_AFTER_DAYS = 45;
const HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

export const LIMITATIONS = "No private algorithms, undisclosed positions, or unpublished win rates are claimed. Every performance, drawdown, win-rate and net-worth note carries a classification (verified, reported, estimate, speculation, not_documented); entries without a recorded source are shown as such. Educational research data, not financial advice.";
export const EVIDENCE_LEGEND = { verified: "confirmed by a primary or audited source", reported: "widely reported in credible secondary sources", estimate: "estimate by a publisher or analyst (e.g. Forbes, Bloomberg); dated in its source", speculation: "inference without direct evidence", not_documented: "no credible figure located; absence is not evidence of a low value" };

// The 25 required profile fields, mapped to the registry's keys.
const REQUIRED: [string, string[]][] = [
  ["name and biography", ["full_name", "biography"]], ["trading history", ["trading_history"]], ["markets traded", ["markets_traded"]],
  ["preferred instruments", ["preferred_instruments"]], ["philosophy", ["philosophy"]], ["documented patterns", ["documented_patterns"]],
  ["entry criteria", ["entry_criteria"]], ["exit criteria", ["exit_criteria"]], ["stop-loss methodology", ["stop_loss_methodology"]],
  ["position sizing", ["position_sizing"]], ["risk to reward", ["risk_reward"]], ["technical indicators", ["technical_indicators"]],
  ["fundamental methodology", ["fundamental_methodology"]], ["preferred conditions", ["preferred_conditions"]], ["avoid conditions", ["avoid_conditions"]],
  ["decision psychology", ["decision_psychology"]], ["historical returns", ["historical_returns"]], ["historical drawdowns", ["historical_drawdowns"]],
  ["win rates", ["win_rates"]], ["net worth", ["net_worth"]], ["famous successful trades", ["famous_successful_trades"]],
  ["famous unsuccessful trades", ["famous_unsuccessful_trades"]], ["predictions and outcomes", ["predictions_outcomes"]],
  ["strengths and weaknesses", ["strengths", "weaknesses"]], ["lessons for ETI", ["eti_lessons"]],
];
const filled = (v: unknown) => Array.isArray(v) ? v.length > 0 : typeof v === "string" ? v.trim().length > 0 : v != null;

// Template filler text that older profile files used to satisfy the schema. A field holding only these is
// reported as a placeholder, never as a completed field.
const FILLER = new Set([
  "aligned with documented philosophy", "per documented public methodology", "thesis or system exit", "often unpublished in precise form",
  "varies by firm/strategy", "firm/strategy specific", "not assumed without source", "see patterns", "see philosophy",
  "style-favorable regimes", "outside competence / no edge", "outside edge", "process discipline", "source-dependent",
  "usually not fully public", "media estimate if any", "see public case studies", "public case studies where available",
  "evaluate dated claims individually", "timestamped evaluation only", "regime sensitivity", "attribution only when evidence matches",
  "helena frost risk always applies",
]);
const FILLER_PREFIXES = ["modules:", "public career summary; deepen", "expand with primary sources"];
const textOf = (x: unknown): string => typeof x === "string" ? x : x && typeof (x as any).claim === "string" ? (x as any).claim : "";
const isFiller = (s: string) => { const t = s.trim().toLowerCase().replace(/\.$/, ""); return FILLER.has(t) || FILLER_PREFIXES.some(p => t.startsWith(p)); };
const substantive = (v: unknown) => Array.isArray(v) ? v.some(x => { const t = textOf(x); return t.trim().length > 0 && !isFiller(t); }) : typeof v === "string" ? v.trim().length > 0 && !isFiller(v) : v != null;

function describe(p: any) {
  const status = REQUIRED.map(([label, keys]) => ({ label, present: keys.some(k => filled(p[k])), real: keys.some(k => substantive(p[k])) }));
  const missing = status.filter(s => !s.present).map(s => s.label);
  const placeholder = status.filter(s => s.present && !s.real).map(s => s.label);
  const perf = (k: string) => (p[k] || []) as { claim: string; classification: string; source: string | null }[];
  const counts: Record<string, number> = {};
  for (const k of ["historical_returns", "historical_drawdowns", "win_rates", "net_worth"]) for (const n of perf(k)) counts[n.classification] = (counts[n.classification] || 0) + 1;
  const nw = perf("net_worth");
  const hasDated = nw.some(n => /\$\d/.test(n.claim) && n.source && /(19|20)\d\d/.test(n.source));
  const netWorthStatus = hasDated ? "dated_estimate" : nw.some(n => /^deceased/i.test(n.claim)) ? "deceased" : nw.some(n => n.classification === "not_documented") ? "not_documented" : nw.length ? "undated_estimate" : "none";
  const sourced = ["historical_returns", "historical_drawdowns", "win_rates", "net_worth"].reduce((a, k) => a + perf(k).filter(n => n.source).length, 0);
  // fieldsPresent counts only substantive fields, so the dashboard shows an honest number.
  return { completeness: { fieldsPresent: status.filter(s => s.real).length, fieldsStructural: status.filter(s => s.present).length, fieldsRequired: REQUIRED.length, missing, placeholder }, evidenceCounts: counts, netWorthStatus, netWorthFreshness: freshnessOf(p), sourcedPerformanceNotes: sourced };
}

function ageDays(iso: string | null | undefined): number | null {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.floor((Date.now() - t) / 86400000)) : null;
}
// Net-worth freshness: auto-refreshed profiles use their own refresh date, everything else the research-pass date.
function freshnessOf(p: any) {
  const f = data.freshness;
  const live = f?.liveAsOf?.[p.id] ?? null;
  const asOf = live ?? f?.researchDate ?? null;
  const age = ageDays(asOf);
  return { asOf, ageDays: age, stale: age === null || age > STALE_AFTER_DAYS, autoRefreshed: live !== null };
}
function overallFreshness() {
  const f = data.freshness;
  const age = ageDays(f?.netWorthLiveUpdatedAt ?? f?.researchDate);
  return {
    researchDate: f?.researchDate ?? null, netWorthLiveUpdatedAt: f?.netWorthLiveUpdatedAt ?? null, ageDays: age, staleAfterDays: STALE_AFTER_DAYS,
    stale: age === null || age > STALE_AFTER_DAYS, autoRefreshedProfiles: Object.keys(f?.liveAsOf ?? {}).length,
    schedule: "weekly (Mondays 05:17 UTC) via the GitHub Actions workflow refresh-net-worth.yml; a refresh is tested before it is committed and deployed",
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[-\s]+/g, "_");
function summary(p: any) {
  return { id: p.id, name: p.full_name, aliases: p.aliases, tags: p.tags, markets: p.markets_traded, philosophy: p.philosophy, strategyModules: p.strategy_module_ids, ...describe(p) };
}
function matches(p: any, q: string, tag: string, market: string) {
  const blob = [p.full_name, ...(p.aliases || []), ...(p.tags || []), p.philosophy, ...(p.documented_patterns || []), ...(p.eti_lessons || []), ...(p.strategy_module_ids || [])].join(" ").toLowerCase();
  if (q && !blob.includes(q)) return false;
  if (tag && !(p.tags || []).some((t: string) => t.toLowerCase() === tag)) return false;
  if (market && !(p.markets_traded || []).some((m: string) => m.toLowerCase() === market)) return false;
  return true;
}

// Data-quality report: which profiles are fully populated, which still hold placeholder or missing fields.
function coverageReport() {
  const rows = data.profiles.map(p => { const d = describe(p); return { id: p.id, name: p.full_name, fieldsPresent: d.completeness.fieldsPresent, placeholder: d.completeness.placeholder, missing: d.completeness.missing, netWorthStatus: d.netWorthStatus }; });
  const complete = rows.filter(r => r.fieldsPresent === 25);
  const netWorth: Record<string, number> = {};
  for (const r of rows) netWorth[r.netWorthStatus] = (netWorth[r.netWorthStatus] || 0) + 1;
  return {
    source: data.source, generatedAt: data.generatedAt, total: rows.length, fullyPopulated: complete.length,
    needsWork: rows.filter(r => r.fieldsPresent < 25).sort((a, b) => a.fieldsPresent - b.fieldsPresent),
    netWorthStatus: netWorth, freshness: overallFreshness(), limitations: LIMITATIONS,
    note: "fieldsPresent counts only substantive fields; template filler text is reported as placeholder.",
  };
}

export function handleKnowledge(req: Request): Response | null {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const isTraders = path === "/api/intelligence/traders" || path.startsWith("/api/intelligence/traders/");
  const isStrategies = path === "/api/intelligence/strategies";
  const isCoverage = path === "/api/intelligence/coverage";
  if (!isTraders && !isStrategies && !isCoverage) return null;
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const live = data.profiles.length > 0;

  if (isCoverage) {
    return live ? json(coverageReport()) : json({ source: "built-in-fallback", available: false, reason: "The generated registry is empty, so only the short built-in profiles are served. Rebuild with scripts/build-knowledge.mjs (needs python3).", limitations: LIMITATIONS }, 200);
  }

  if (isStrategies) {
    const runtime = new Map(MODULE_META.map(m => [m.id, m]));
    return json({
      source: live ? data.source : "built-in-fallback", generatedAt: data.generatedAt, limitations: LIMITATIONS,
      combinationRules: ["Trend regime (ADX>=25): range-reversal modules are suppressed", "Range regime (ADX<20): breakout modules are suppressed", "Transition: all active; disagreement lowers conviction one tier", "Macro and fundamental modules are not simulated on candle data (reported as not_applicable)", "Incompatible strategies are never averaged together blindly"],
      count: MODULE_META.length,
      modules: MODULE_META.map(m => {
        const reg = data.strategies.find((s: any) => s.id === m.id);
        return { id: m.id, name: m.name, inspiredBy: m.trader, principle: m.principle, family: m.family, candleTestable: !m.requires && m.family !== "validation", requires: m.requires || null, registry: reg ? { summary: reg.summary, principles: reg.principles, testableRules: reg.testable_rules, incompatibleWith: reg.incompatible_with, riskNotes: reg.risk_notes } : null, runtime: runtime.has(m.id) };
      }),
    });
  }

  if (!live) {
    const id = path.split("/")[4];
    if (!id) return handleTraderDirectory(req);
    const p = TRADER_PROFILES.find(t => norm(t.id) === norm(id) || norm(t.name) === norm(id));
    return p ? json({ source: "built-in-fallback", limitations: LIMITATIONS, profile: p }) : json({ error: "not_found", id }, 404);
  }

  const id = path.split("/")[4];
  if (id) {
    const key = norm(decodeURIComponent(id));
    const p = data.profiles.find(t => norm(t.id) === key || norm(t.full_name) === key);
    return p ? json({ source: data.source, generatedAt: data.generatedAt, limitations: LIMITATIONS, evidenceLegend: EVIDENCE_LEGEND, ...describe(p), profile: p }) : json({ error: "not_found", id }, 404);
  }
  const q = (url.searchParams.get("q") || "").toLowerCase().trim(), tag = (url.searchParams.get("tag") || "").toLowerCase(), market = (url.searchParams.get("market") || "").toLowerCase();
  const list = data.profiles.filter(p => matches(p, q, tag, market)).sort((a, b) => a.full_name.localeCompare(b.full_name));
  return json({ source: data.source, generatedAt: data.generatedAt, count: list.length, total: data.profiles.length, freshness: overallFreshness(), limitations: LIMITATIONS, evidenceLegend: EVIDENCE_LEGEND, profiles: list.map(summary) });
}
