/**
 * Elite-trader knowledge API for the Worker.
 * Data comes from the Python registry (app/knowledge) via worker/knowledge.generated.json, so the FastAPI app
 * and the Worker share one source of truth. If that file is empty the built-in profiles are served instead,
 * and the response says so ("source": "built-in-fallback") rather than failing silently.
 */
import knowledgeData from "./knowledge.generated.json" with { type: "json" };
import { handleTraderDirectory, TRADER_PROFILES } from "./traders.ts";
import { MODULE_META } from "./strategies.ts";

const data = knowledgeData as { generatedAt: string | null; source: string; profiles: any[]; strategies: any[] };
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

function describe(p: any) {
  const missing = REQUIRED.filter(([, keys]) => !keys.some(k => filled(p[k]))).map(([label]) => label);
  const perf = (k: string) => (p[k] || []) as { claim: string; classification: string; source: string | null }[];
  const counts: Record<string, number> = {};
  for (const k of ["historical_returns", "historical_drawdowns", "win_rates", "net_worth"]) for (const n of perf(k)) counts[n.classification] = (counts[n.classification] || 0) + 1;
  const nw = perf("net_worth");
  const hasDated = nw.some(n => /\$\d/.test(n.claim) && n.source && /(19|20)\d\d/.test(n.source));
  const netWorthStatus = hasDated ? "dated_estimate" : nw.some(n => /^deceased/i.test(n.claim)) ? "deceased" : nw.some(n => n.classification === "not_documented") ? "not_documented" : nw.length ? "undated_estimate" : "none";
  const sourced = ["historical_returns", "historical_drawdowns", "win_rates", "net_worth"].reduce((a, k) => a + perf(k).filter(n => n.source).length, 0);
  return { completeness: { fieldsPresent: REQUIRED.length - missing.length, fieldsRequired: REQUIRED.length, missing }, evidenceCounts: counts, netWorthStatus, sourcedPerformanceNotes: sourced };
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

export function handleKnowledge(req: Request): Response | null {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const isTraders = path === "/api/intelligence/traders" || path.startsWith("/api/intelligence/traders/");
  const isStrategies = path === "/api/intelligence/strategies";
  if (!isTraders && !isStrategies) return null;
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  const live = data.profiles.length > 0;

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
  return json({ source: data.source, generatedAt: data.generatedAt, count: list.length, total: data.profiles.length, limitations: LIMITATIONS, evidenceLegend: EVIDENCE_LEGEND, profiles: list.map(summary) });
}
