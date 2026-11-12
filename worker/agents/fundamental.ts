import { makeReport, noData } from "./types.ts";
import type { AgentReport, Ctx, Evidence } from "./types.ts";
import { clamp, finite, obj } from "./math.ts";

/** 4. FUNDAMENTAL ANALYST (supersedes the version in analysts.ts; adds supply-structure votes so provider tokenomics alone can produce a view). */
interface Vote { label: string; vote: number; weight: number; note?: string }
export function fundamentalAnalyst(ctx: Ctx): AgentReport {
  const raw = obj(ctx.supplied.fundamentals);
  const missing = ["fundamentals.valuation (price, fairValue, revenueGrowthYoyPct, debtToEquity, freeCashFlowMarginPct, roePct) and/or fundamentals.tokenomics (marketCapUsd, fdvUsd, circulatingSupply, totalSupply, maxSupply, annualInflationPct, unlockNext90dPctOfCirculating, top10HolderPct, protocolRevenue30dUsd)"];
  if (!raw) return noData("fundamental", "No fundamentals available: none were supplied and the tokenomics provider returned nothing. None are fabricated.", missing, ctx.now);
  const val = obj(raw.valuation), tok = obj(raw.tokenomics), votes: Vote[] = [], warnings: string[] = [];
  const price = finite(val?.price) ?? ctx.market.candles[ctx.market.candles.length - 1][4], fair = finite(val?.fairValue);
  if (fair && fair > 0) { const mos = (fair - price) / fair; votes.push({ label: "margin_of_safety", vote: clamp(mos / 0.25, -1, 1), weight: 2, note: `(fairValue-price)/fairValue = ${(mos * 100).toFixed(1)}%` }); warnings.push("fairValue is caller-supplied; its method and quality are not verified by ETI."); }
  const g = finite(val?.revenueGrowthYoyPct); if (g !== undefined) votes.push({ label: "revenue_growth", vote: g > 15 ? 0.5 : g < 0 ? -0.5 : 0, weight: 1 });
  const de = finite(val?.debtToEquity); if (de !== undefined) votes.push({ label: "leverage", vote: de > 2 ? -0.5 : de < 0.5 ? 0.2 : 0, weight: 1 });
  const fcf = finite(val?.freeCashFlowMarginPct); if (fcf !== undefined) votes.push({ label: "fcf_margin", vote: fcf > 10 ? 0.5 : fcf < 0 ? -0.5 : 0, weight: 1 });
  const roe = finite(val?.roePct); if (roe !== undefined) votes.push({ label: "roe", vote: roe > 15 ? 0.3 : roe < 5 ? -0.2 : 0, weight: 0.5 });
  const mc = finite(tok?.marketCapUsd), fdv = finite(tok?.fdvUsd), circ = finite(tok?.circulatingSupply), tot = finite(tok?.totalSupply), mx = finite(tok?.maxSupply);
  if (mc && fdv && mc > 0) { const r = fdv / mc; votes.push({ label: "fdv_to_mcap", vote: r > 3 ? -0.7 : r > 1.5 ? -0.3 : 0.1, weight: 1.5, note: "ratio " + r.toFixed(2) }); }
  if (circ && tot && tot > 0) { const r = Math.min(1, circ / tot); votes.push({ label: "circulating_to_total_supply", vote: r < 0.5 ? -0.5 : r < 0.8 ? -0.2 : 0.1, weight: 1, note: `${(r * 100).toFixed(0)}% of total supply circulating; the rest is a potential dilution overhang` }); }
  if (circ && mx && mx > 0) { const r = Math.min(1, circ / mx); votes.push({ label: "circulating_to_max_supply", vote: r > 0.9 ? 0.3 : r < 0.5 ? -0.2 : 0, weight: 0.5, note: `${(r * 100).toFixed(0)}% of the fixed max supply is circulating` }); }
  const unlock = finite(tok?.unlockNext90dPctOfCirculating); if (unlock !== undefined) votes.push({ label: "unlock_overhang_90d", vote: unlock > 10 ? -0.7 : unlock > 5 ? -0.3 : 0, weight: 1.5 });
  const inf = finite(tok?.annualInflationPct); if (inf !== undefined) votes.push({ label: "supply_inflation", vote: inf > 10 ? -0.4 : inf < 2 ? 0.2 : 0, weight: 1 });
  const top = finite(tok?.top10HolderPct); if (top !== undefined) votes.push({ label: "holder_concentration", vote: top > 60 ? -0.5 : 0, weight: 1 });
  const rev = finite(tok?.protocolRevenue30dUsd); if (rev !== undefined && mc && mc > 0) votes.push({ label: "revenue_yield", vote: (rev * 12) / mc > 0.05 ? 0.5 : 0, weight: 1, note: `annualised revenue / market cap = ${(((rev * 12) / mc) * 100).toFixed(1)}%` });
  if (typeof raw.source === "string") warnings.push("Source: " + raw.source + " (third-party data, not independently verified).");
  if (votes.length < 2) return noData("fundamental", "Fewer than two usable fundamental inputs were available.", missing, ctx.now);
  const w = votes.reduce((s, v) => s + v.weight, 0), sc = votes.reduce((s, v) => s + v.vote * v.weight, 0) / w, stance = sc > 0.2 ? "bullish" as const : sc < -0.2 ? "bearish" as const : "neutral" as const;
  const evidence: Evidence[] = votes.map((v) => ({ label: v.label, value: v.vote, note: v.note }));
  return makeReport("fundamental", { stance, confidence: clamp(Math.abs(sc) * 0.8, 0, 0.75), summary: `Fundamentals ${stance} (score ${sc.toFixed(2)}) from ${votes.length} inputs.`, evidence, warnings }, ctx.now);
}
